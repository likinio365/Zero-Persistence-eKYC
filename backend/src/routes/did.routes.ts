import { Router, Request, Response } from 'express';
import { IndyService } from '../services/indy.service';
import { logger } from '../config/logger';

const router = Router();
const indyService = new IndyService();

// ── POST /api/did ──────────────────────────────────────────────────────────────
router.post('/', async (_req: Request, res: Response) => {
  try {
    const { did, verkey } = await indyService.createDID();
    logger.info('DID created', { did });

    // Publish the DID to the Indy ledger so it is publicly resolvable.
    // Best-effort: ledger write failures do not block DID creation.
    let published = false;
    try {
      await indyService.publishDID(did, verkey);
      published = true;
    } catch (pubErr) {
      const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
      logger.warn('DID ledger publication failed (non-fatal)', { did, msg });
    }

    res.status(201).json({ did, verkey, published });
  } catch (err) {
    logger.error('createDID failed', { err });
    res.status(500).json({ error: 'Failed to create DID' });
  }
});

// ── POST /api/did/:did/connect ─────────────────────────────────────────────────
// Creates an OOB DIDComm invitation. The holder scans the returned invitationUrl
// with their wallet app to establish a connection — required before /verify.
router.post('/:did/connect', async (req: Request, res: Response) => {
  const did = decodeURIComponent(req.params.did);
  try {
    const { invitationUrl, oobId } = await indyService.createInvitation(did);
    logger.info('OOB invitation created', { did, oobId });
    res.status(201).json({ did, invitationUrl, oobId });
  } catch (err) {
    logger.error('createInvitation failed', { did, err });
    res.status(500).json({ error: 'Failed to create DIDComm invitation' });
  }
});

// ── GET /api/did/:did/connection-status ───────────────────────────────────────
router.get('/:did/connection-status', async (req: Request, res: Response) => {
  const did = decodeURIComponent(req.params.did);
  try {
    const status = await indyService.getConnectionStatus(did);
    res.json({ did, ...status });
  } catch (err) {
    logger.error('getConnectionStatus failed', { did, err });
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// ── GET /api/did/:did/credentials ──────────────────────────────────────────────
router.get('/:did/credentials', async (req: Request, res: Response) => {
  const did = decodeURIComponent(req.params.did);
  try {
    const credentials = await indyService.getCredentials(did);
    res.json(credentials);
  } catch (err) {
    logger.error('getCredentials failed', { did, err });
    res.status(500).json({ error: 'Failed to retrieve credentials' });
  }
});

// ── GET /api/did/:did ──────────────────────────────────────────────────────────
// Kept last — catch-all for plain DID resolution so the sub-paths above match first.
router.get('/:did', async (req: Request, res: Response) => {
  const did = decodeURIComponent(req.params.did);
  try {
    const doc = await indyService.resolveDID(did);
    res.json(doc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('not resolvable')) {
      return res.status(404).json({ error: `DID ${did} could not be resolved` });
    }
    logger.error('resolveDID failed', { did, err });
    res.status(500).json({ error: 'Failed to resolve DID' });
  }
});

export default router;
