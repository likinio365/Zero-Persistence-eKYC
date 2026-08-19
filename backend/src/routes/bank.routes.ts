import { Router, Request, Response } from 'express';
import axios from 'axios';
import { requireBank } from '../middleware/auth.middleware';
import { config } from '../config';
import { logger } from '../config/logger';

const router = Router();

// All bank routes require bank role
router.use(requireBank);

const bankClient = () =>
  axios.create({ baseURL: config.bankAcapy.adminUrl, timeout: 30_000 });

// ── POST /api/bank/invitation ──────────────────────────────────────────────
// Creates a DIDComm OOB invitation. The customer scans the QR code with their
// wallet app; once connected the bank can send a proof request.
router.post('/invitation', async (_req: Request, res: Response) => {
  try {
    const resp = await bankClient().post('/out-of-band/create-invitation', {
      handshake_protocols: ['https://didcomm.org/didexchange/1.0'],
      use_public_did: false,
      my_label: 'Demo Bank — KYC Verification',
    });
    const { oob_id, invitation_url, invitation } = resp.data as {
      oob_id: string; invitation_url: string; invitation: Record<string, unknown>;
    };
    // Use invitation['@id'] for connection lookup — oob_id != invitation_msg_id on connections
    const invitationMsgId = (invitation?.['@id'] as string) ?? oob_id;
    logger.info('Bank OOB invitation created', { oobId: oob_id, invitationMsgId });
    res.status(201).json({ oobId: invitationMsgId, invitationUrl: invitation_url });
  } catch (err) {
    logger.error('Bank invitation failed', { err });
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// ── GET /api/bank/connection/:oobId ───────────────────────────────────────
// Polls whether the customer has accepted the invitation and a connection exists.
router.get('/connection/:oobId', async (req: Request, res: Response) => {
  const { oobId } = req.params;
  try {
    const resp = await bankClient().get('/connections', {
      params: { invitation_msg_id: oobId },
    });
    const connections = (resp.data as { results: Array<{ connection_id: string; state: string }> }).results;
    // 'response' is included because BC Wallet (DIDExchange 1.1) may not send the final
    // "complete" ACK, leaving the state at 'response' rather than 'completed'.
    // The connection is functional for proof requests at this point.
    const active = connections.find(c => ['completed', 'active', 'response'].includes(c.state));
    res.json({ connected: !!active, connectionId: active?.connection_id ?? null });
  } catch (err) {
    logger.error('Bank connection poll failed', { oobId, err });
    res.status(500).json({ error: 'Failed to check connection' });
  }
});

// ── POST /api/bank/proof-request ──────────────────────────────────────────
// Sends a proof request to the customer asking them to present their KYC VC.
// Body: { connectionId: string }
router.post('/proof-request', async (req: Request, res: Response) => {
  const { connectionId } = req.body as { connectionId?: string };
  if (!connectionId) {
    res.status(400).json({ error: 'connectionId is required' });
    return;
  }

  const credDefId = process.env.KYC_CRED_DEF_ID ?? '';
  if (!credDefId) {
    res.status(500).json({ error: 'KYC_CRED_DEF_ID not configured' });
    return;
  }

  try {
    const resp = await bankClient().post('/present-proof-2.0/send-request', {
      connection_id: connectionId,
      presentation_request: {
        indy: {
          name: 'KYC Identity Verification',
          version: '1.0',
          non_revoked: { to: Math.floor(Date.now() / 1000) },
          requested_attributes: {
            kyc_id: {
              name: 'kyc_id',
              restrictions: [{ cred_def_id: credDefId }],
            },
            verification_date: {
              name: 'verification_date',
              restrictions: [{ cred_def_id: credDefId }],
            },
          },
          requested_predicates: {
            age_over_18: {
              name: 'age',
              p_type: '>=',
              p_value: 18,
              restrictions: [{ cred_def_id: credDefId }],
            },
          },
        },
      },
    });
    const { pres_ex_id } = resp.data as { pres_ex_id: string };
    logger.info('Bank proof request sent', { connectionId, presExId: pres_ex_id });
    res.status(201).json({ presExId: pres_ex_id });
  } catch (err) {
    logger.error('Bank proof request failed', { connectionId, err });
    res.status(500).json({ error: 'Failed to send proof request' });
  }
});

// ── GET /api/bank/proof-result/:presExId ──────────────────────────────────
// Polls the result of a presentation exchange.
// Returns { state, verified } — verified=true when the wallet has responded
// and the proof is cryptographically valid against the Indy ledger.
router.get('/proof-result/:presExId', async (req: Request, res: Response) => {
  const { presExId } = req.params;
  try {
    const client = bankClient();
    const resp = await client.get(`/present-proof-2.0/records/${presExId}`);
    let record = resp.data as { state: string; verified?: string };

    // ACA-Py requires explicit verification call after receiving presentation
    if (record.state === 'presentation-received') {
      try {
        const verifyResp = await client.post(`/present-proof-2.0/records/${presExId}/verify-presentation`);
        record = verifyResp.data as { state: string; verified?: string };
        logger.info('Bank proof verified', { presExId, verified: record.verified });
      } catch (verifyErr) {
        logger.warn('Auto-verify failed', { presExId, verifyErr });
      }
    }

    res.json({
      state: record.state,
      verified: record.verified === 'true',
      done: ['done', 'abandoned', 'deleted'].includes(record.state),
    });
  } catch (err) {
    logger.error('Bank proof result poll failed', { presExId, err });
    res.status(500).json({ error: 'Failed to get proof result' });
  }
});

export default router;
