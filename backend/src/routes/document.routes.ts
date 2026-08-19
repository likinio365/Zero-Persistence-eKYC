import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { IpfsService } from '../services/ipfs.service';
import { VaultService } from '../services/vault.service';
import { logger } from '../config/logger';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const ipfsService = new IpfsService();
const vaultService = new VaultService();

// ── POST /api/documents/upload ─────────────────────────────────────────────────
// Encrypts the file via Vault Transit (per-document key) and pins it to IPFS.
// Returns the IPFS CID and the documentId needed for later decryption.
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const { originalname, buffer } = req.file;
  const documentId = uuid();

  try {
    await vaultService.createKey(documentId, 'doc');
    const encrypted = await vaultService.encrypt(documentId, buffer, 'doc');
    const cid = await ipfsService.upload(
      Buffer.from(JSON.stringify(encrypted)),
      `${originalname}.enc`,
    );
    logger.info('Document uploaded', { documentId, cid, fileName: originalname });
    res.status(201).json({ cid, documentId });
  } catch (err) {
    logger.error('Document upload failed', { documentId, err });
    res.status(500).json({ error: 'Document upload failed' });
  }
});

// ── GET /api/documents/:cid?documentId=<uuid> ──────────────────────────────────
// Fetches the encrypted blob from IPFS and decrypts it via Vault Transit.
router.get('/:cid', async (req: Request, res: Response) => {
  const { cid } = req.params;
  const documentId = req.query.documentId as string | undefined;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId query parameter is required' });
  }

  let encryptedBuffer: Buffer;
  try {
    encryptedBuffer = await ipfsService.download(cid);
  } catch (err) {
    return res.status(404).json({ error: `Document ${cid} not found in IPFS` });
  }

  try {
    const payload = JSON.parse(encryptedBuffer.toString('utf8'));
    const decrypted = await vaultService.decrypt(payload);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${cid}.bin"`);
    res.send(decrypted);
  } catch (err) {
    logger.error('Document decryption failed', { cid, documentId, err });
    res.status(500).json({ error: 'Document decryption failed' });
  }
});

export default router;
