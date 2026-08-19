import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { FabricService } from '../services/fabric.service';
import { IndyService } from '../services/indy.service';
import { IpfsService } from '../services/ipfs.service';
import { validateSubmitKYC, validateResubmitKYC, validateVerifyKYC } from '../middleware/validation.middleware';
import { authMiddleware, requireVerifier } from '../middleware/auth.middleware';
import { VaultService } from '../services/vault.service';
import { logger } from '../config/logger';
import type { SubmitKYCRequest, VerifyKYCRequest } from '../types/kyc.types';

const router = Router();
const fabricService = new FabricService();
const indyService = new IndyService();
const ipfsService = new IpfsService();
const vaultService = new VaultService();

// ── GET /api/kyc?status= ───────────────────────────────────────────────────────
router.get('/', authMiddleware, requireVerifier, async (req: Request, res: Response) => {
  const status = (req.query.status as string | undefined)?.toUpperCase();
  if (!status) return res.status(400).json({ error: 'status query parameter is required' });
  try {
    const records = await fabricService.queryByStatus(status);
    res.json(records);
  } catch (err) {
    logger.error('queryByStatus failed', { status, err });
    res.status(500).json({ error: 'Failed to query KYC records' });
  }
});

// ── GET /api/kyc/:id/my-data ──────────────────────────────────────────────────
// Authenticated user: decrypts and returns their own documents (GDPR Art. 15).
router.get('/:id/my-data', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status === 'DELETED') return res.status(410).json({ error: 'This record has been erased' });

    const manifestBuf = await ipfsService.download(record.ipfsHash);
    const manifestPlain = await vaultService.decrypt(JSON.parse(manifestBuf.toString('utf8')));
    const manifest = JSON.parse(manifestPlain.toString('utf8')) as {
      documents: Array<{ type: string; fileName: string; cid: string }>;
    };

    const docs = await Promise.all(
      manifest.documents.map(async (doc) => {
        const encBuf = await ipfsService.download(doc.cid);
        const plain = await vaultService.decrypt(JSON.parse(encBuf.toString('utf8')));
        return { type: doc.type, fileName: doc.fileName, contentBase64: plain.toString('base64') };
      }),
    );

    res.json(docs);
  } catch (err) {
    logger.error('getMyData failed', { id, err });
    res.status(500).json({ error: 'Failed to retrieve your data' });
  }
});

// ── DELETE /api/kyc/:id ───────────────────────────────────────────────────────
// Authenticated user: erases KYC data — unpin IPFS, delete Vault key, mark DELETED (GDPR Art. 17).
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status === 'DELETED') return res.status(409).json({ error: 'Record already erased' });

    // Download manifest to collect all document CIDs before unpinning.
    let documentCids: string[] = [];
    try {
      const manifestBuf = await ipfsService.download(record.ipfsHash);
      const manifestPlain = await vaultService.decrypt(JSON.parse(manifestBuf.toString('utf8')));
      const manifest = JSON.parse(manifestPlain.toString('utf8')) as {
        documents: Array<{ cid: string }>;
      };
      documentCids = manifest.documents.map(d => d.cid);
    } catch (e) {
      logger.warn('Could not read manifest during erasure — proceeding without doc unpin', { id, e });
    }

    // Unpin all document blobs and the manifest from IPFS.
    await Promise.allSettled([
      ...documentCids.map(cid => ipfsService.unpin(cid)),
      ipfsService.unpin(record.ipfsHash),
    ]);

    // Delete the Vault transit key — ciphertext in IPFS becomes permanently undecryptable.
    await vaultService.deleteKey(id);

    // Revoke the VC in ACA-Py so the wallet credential becomes invalid (GDPR Art. 17).
    if (record.credentialExchangeId) {
      try {
        await indyService.revokeCredential(record.credentialExchangeId);
        logger.info('VC revoked during erasure', { id, credExId: record.credentialExchangeId });
      } catch (vcErr) {
        logger.warn('VC revocation failed during erasure (non-fatal)', {
          id, credExId: record.credentialExchangeId,
          err: vcErr instanceof Error ? vcErr.message : String(vcErr),
        });
      }
    }

    // Record the erasure on-chain (clears ipfsHash, credDefId, credentialExchangeId, rejectionReason).
    await fabricService.eraseKYC(id);

    logger.info('KYC erased (GDPR Art. 17)', { id });
    res.json({ id, erased: true });
  } catch (err) {
    logger.error('KYC erasure failed', { id, err });
    res.status(500).json({ error: 'KYC erasure failed' });
  }
});

// ── GET /api/kyc/:id/documents ────────────────────────────────────────────────
router.get('/:id/documents', requireVerifier, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });

    const manifestBuf = await ipfsService.download(record.ipfsHash);
    const manifestPlain = await vaultService.decrypt(JSON.parse(manifestBuf.toString('utf8')));
    const manifest = JSON.parse(manifestPlain.toString('utf8')) as {
      documents: Array<{ type: string; fileName: string; cid: string }>;
    };

    const docs = await Promise.all(
      manifest.documents.map(async (doc) => {
        const encBuf = await ipfsService.download(doc.cid);
        const plain = await vaultService.decrypt(JSON.parse(encBuf.toString('utf8')));
        return {
          type: doc.type,
          fileName: doc.fileName,
          contentBase64: plain.toString('base64'),
        };
      }),
    );

    res.json(docs);
  } catch (err) {
    logger.error('getDocuments failed', { id, err });
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// ── GET /api/kyc/did/:did ──────────────────────────────────────────────────────
router.get('/did/:did', async (req: Request, res: Response) => {
  const did = decodeURIComponent(req.params.did);
  try {
    const records = await fabricService.queryByDID(did);
    res.json(records);
  } catch (err) {
    logger.error('queryByDID failed', { did, err });
    res.status(500).json({ error: 'Failed to query KYC records' });
  }
});

// ── POST /api/kyc ──────────────────────────────────────────────────────────────
router.post('/', validateSubmitKYC, async (req: Request, res: Response) => {
  const { did, documents, dateOfBirth } = req.body as SubmitKYCRequest;
  const kycId = uuid();

  try {
    await vaultService.createKey(kycId);

    const entries: Array<{ type: string; fileName: string; cid: string }> = [];
    for (const doc of documents) {
      const encrypted = await vaultService.encrypt(kycId, Buffer.from(doc.contentBase64, 'base64'));
      const cid = await ipfsService.upload(
        Buffer.from(JSON.stringify(encrypted)),
        `${doc.fileName}.enc`,
      );
      entries.push({ type: doc.type, fileName: doc.fileName, cid });
    }

    const manifest = {
      kycId,
      did,
      documents: entries,
      submittedAt: new Date().toISOString(),
      ...(dateOfBirth && { dateOfBirth }),
    };
    const encryptedManifest = await vaultService.encrypt(kycId, Buffer.from(JSON.stringify(manifest)));
    const manifestCid = await ipfsService.upload(
      Buffer.from(JSON.stringify(encryptedManifest)),
      'manifest.enc',
    );

    await fabricService.submitKYC(kycId, did, manifestCid);

    logger.info('KYC submitted', { kycId, did, manifestCid });
    res.status(201).json({ id: kycId });
  } catch (err) {
    logger.error('KYC submission failed', { kycId, did, err });
    res.status(500).json({ error: 'KYC submission failed' });
  }
});

// ── GET /api/kyc/:id ───────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const record = await fabricService.getKYC(req.params.id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    res.json(record);
  } catch (err) {
    logger.error('getKYC failed', { id: req.params.id, err });
    res.status(500).json({ error: 'Failed to retrieve KYC record' });
  }
});

// ── PUT /api/kyc/:id/verify ────────────────────────────────────────────────────
router.put('/:id/verify', requireVerifier, validateVerifyKYC, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { credDefId, attributes } = req.body as VerifyKYCRequest;

  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'PENDING') {
      return res.status(409).json({ error: `Record is ${record.status}, expected PENDING` });
    }

    await fabricService.verifyKYC(id, credDefId);
    logger.info('KYC verified on ledger', { id });

    let vcInfo: { credentialExchangeId?: string; state?: string; vcWarning?: string } = {};
    try {
      let ageAttr: string | undefined;
      if (!attributes) {
        try {
          const manifestBuf = await ipfsService.download(record.ipfsHash);
          const manifestPlain = await vaultService.decrypt(JSON.parse(manifestBuf.toString('utf8')));
          const manifestData = JSON.parse(manifestPlain.toString('utf8')) as { dateOfBirth?: string };
          if (manifestData.dateOfBirth) {
            ageAttr = String(calculateAge(manifestData.dateOfBirth));
          }
        } catch (e) {
          logger.warn('Could not read dateOfBirth from manifest for age attr', { id, e });
        }
      }

      const vcAttributes = attributes ?? {
        kyc_id: id,
        verification_date: new Date().toISOString().split('T')[0],
        ...(ageAttr !== undefined && { age: ageAttr }),
      };
      const vc = await indyService.issueCredential(record.did, credDefId, vcAttributes);
      vcInfo = { credentialExchangeId: vc.credentialExchangeId, state: vc.state };
      logger.info('VC issued', { id, credExId: vc.credentialExchangeId });

      // Persist the exchange ID on-chain so EraseKYC can revoke the VC later.
      if (vc.credentialExchangeId) {
        try {
          await fabricService.storeCredExchangeId(id, vc.credentialExchangeId);
        } catch (e) {
          logger.warn('Failed to store credentialExchangeId on-chain (non-fatal)', { id, e });
        }
      }
    } catch (vcErr) {
      const msg = vcErr instanceof Error ? vcErr.message : String(vcErr);
      logger.warn('VC issuance skipped (no active DIDComm connection or missing cred def)', { id, msg });
      vcInfo = { vcWarning: msg };
    }

    res.json({ id, verified: true, ...vcInfo });
  } catch (err) {
    logger.error('KYC verification failed', { id, err });
    res.status(500).json({ error: 'KYC verification failed' });
  }
});

// ── PUT /api/kyc/:id/reject ────────────────────────────────────────────────────
router.put('/:id/reject', requireVerifier, async (req: Request, res: Response) => {
  const { id } = req.params;
  const reason: string = req.body?.reason ?? '';

  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'PENDING') {
      return res.status(409).json({ error: `Record is ${record.status}, expected PENDING` });
    }

    await fabricService.rejectKYC(id, reason);

    logger.info('KYC rejected', { id, reason });
    res.json({ id, rejected: true, reason });
  } catch (err) {
    logger.error('KYC rejection failed', { id, err });
    res.status(500).json({ error: 'KYC rejection failed' });
  }
});

// ── GET /api/kyc/:id/wallet-invitation ────────────────────────────────────────
router.get('/:id/wallet-invitation', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'VERIFIED') {
      return res.status(409).json({ error: 'Only VERIFIED records can issue wallet credentials' });
    }
    const inv = await indyService.createInvitation(`kyc-vc-${id}`);
    logger.info('Wallet invitation created', { id, oobId: inv.oobId, msgId: inv.invitationMsgId });
    res.json({ oobId: inv.invitationMsgId, invitationUrl: inv.invitationUrl });
  } catch (err) {
    logger.error('wallet-invitation failed', { id, err });
    res.status(500).json({ error: 'Failed to create wallet invitation' });
  }
});

// ── GET /api/kyc/:id/wallet-connection/:oobId ─────────────────────────────────
router.get('/:id/wallet-connection/:oobId', authMiddleware, async (req: Request, res: Response) => {
  const { oobId } = req.params;
  try {
    const conn = await indyService.findConnectionByOobId(oobId);
    res.json({ connected: !!conn, connectionId: conn?.connection_id ?? null });
  } catch (err) {
    logger.error('wallet-connection check failed', { oobId, err });
    res.status(500).json({ error: 'Failed to check wallet connection' });
  }
});

// ── POST /api/kyc/:id/send-credential ─────────────────────────────────────────
router.post('/:id/send-credential', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { oobId } = req.body as { oobId?: string };
  if (!oobId) return res.status(400).json({ error: 'oobId is required' });

  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'VERIFIED') {
      return res.status(409).json({ error: 'Record is not VERIFIED' });
    }

    const conn = await indyService.findConnectionByOobId(oobId);
    if (!conn) return res.json({ connected: false });

    const credDefId = process.env.KYC_CRED_DEF_ID ?? '';
    if (!credDefId) return res.status(500).json({ error: 'KYC_CRED_DEF_ID not configured' });

    let ageAttr: string | undefined;
    try {
      const manifestBuf = await ipfsService.download(record.ipfsHash);
      const manifestPlain = await vaultService.decrypt(JSON.parse(manifestBuf.toString('utf8')));
      const manifestData = JSON.parse(manifestPlain.toString('utf8')) as { dateOfBirth?: string };
      if (manifestData.dateOfBirth) ageAttr = String(calculateAge(manifestData.dateOfBirth));
    } catch { /* age optional */ }

    const vc = await indyService.issueCredentialToConnection(conn.connection_id, credDefId, {
      kyc_id: id,
      verification_date: new Date().toISOString().split('T')[0],
      ...(ageAttr !== undefined && { age: ageAttr }),
    });

    logger.info('VC sent to wallet', { id, credExId: vc.credentialExchangeId });
    res.json({ connected: true, credentialExchangeId: vc.credentialExchangeId });
  } catch (err) {
    logger.error('send-credential failed', { id, err });
    res.status(500).json({ error: 'Failed to issue credential to wallet' });
  }
});

// ── GET /api/kyc/:id/history ───────────────────────────────────────────────────
router.get('/:id/history', authMiddleware, async (req: Request, res: Response) => {
  try {
    const history = await fabricService.getKYCHistory(req.params.id);
    res.json(history);
  } catch (err) {
    logger.error('getKYCHistory failed', { id: req.params.id, err });
    res.status(500).json({ error: 'Failed to retrieve KYC history' });
  }
});

// ── PUT /api/kyc/:id/revoke ────────────────────────────────────────────────────
router.put('/:id/revoke', requireVerifier, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'VERIFIED') {
      return res.status(409).json({ error: `Record is ${record.status}, expected VERIFIED` });
    }

    await fabricService.revokeKYC(id);
    logger.info('KYC revoked on ledger', { id });

    // credentialExchangeId is read from the on-chain record, not the request body.
    const credentialExchangeId = record.credentialExchangeId;
    let vcWarning: string | undefined;
    if (credentialExchangeId) {
      try {
        await indyService.revokeCredential(credentialExchangeId);
        logger.info('VC revoked', { id, credentialExchangeId });
      } catch (vcErr) {
        const msg = vcErr instanceof Error ? vcErr.message : String(vcErr);
        logger.warn('VC revocation skipped', { id, msg });
        vcWarning = msg;
      }
    } else {
      logger.warn('No credentialExchangeId on record — VC revocation skipped', { id });
    }

    res.json({ id, revoked: true, ...(vcWarning && { vcWarning }) });
  } catch (err) {
    logger.error('KYC revocation failed', { id, err });
    res.status(500).json({ error: 'KYC revocation failed' });
  }
});

// ── PUT /api/kyc/:id/resubmit ─────────────────────────────────────────────────
router.put('/:id/resubmit', validateResubmitKYC, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { documents, dateOfBirth } = req.body as SubmitKYCRequest;

  try {
    const record = await fabricService.getKYC(id);
    if (!record) return res.status(404).json({ error: 'KYC record not found' });
    if (record.status !== 'VERIFIED' && record.status !== 'REJECTED') {
      return res.status(409).json({ error: `Record is ${record.status}, expected VERIFIED or REJECTED` });
    }

    // Revoke the VC if the record was VERIFIED — the user is replacing their documents
    // so the previously issued credential must no longer be valid at the bank.
    if (record.status === 'VERIFIED' && record.credentialExchangeId) {
      try {
        await indyService.revokeCredential(record.credentialExchangeId);
        logger.info('VC revoked on resubmit', { id, credentialExchangeId: record.credentialExchangeId });
      } catch (err) {
        logger.warn('VC revocation during resubmit failed (non-fatal)', { id, err });
      }
    }

    const entries: Array<{ type: string; fileName: string; cid: string }> = [];
    for (const doc of documents) {
      const encrypted = await vaultService.encrypt(id, Buffer.from(doc.contentBase64, 'base64'));
      const cid = await ipfsService.upload(
        Buffer.from(JSON.stringify(encrypted)),
        `${doc.fileName}.enc`,
      );
      entries.push({ type: doc.type, fileName: doc.fileName, cid });
    }

    const manifest = {
      kycId: id,
      did: record.did,
      documents: entries,
      submittedAt: new Date().toISOString(),
      ...(dateOfBirth && { dateOfBirth }),
    };
    const encryptedManifest = await vaultService.encrypt(id, Buffer.from(JSON.stringify(manifest)));
    const manifestCid = await ipfsService.upload(
      Buffer.from(JSON.stringify(encryptedManifest)),
      'manifest.enc',
    );

    await fabricService.resubmitKYC(id, manifestCid);

    logger.info('KYC resubmitted', { id, manifestCid });
    res.json({ id, resubmitted: true });
  } catch (err) {
    logger.error('KYC resubmission failed', { id, err });
    res.status(500).json({ error: 'KYC resubmission failed' });
  }
});

function calculateAge(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

export default router;
