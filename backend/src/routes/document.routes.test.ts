import request from 'supertest';
import express from 'express';

// ── mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../config', () => ({
  config: {
    ipfs: { apiUrl: 'http://localhost:5001' },
  },
}));
jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockIpfs  = { upload: jest.fn(), download: jest.fn() };
const mockVault = { createKey: jest.fn(), encrypt: jest.fn(), decrypt: jest.fn() };

jest.mock('../services/ipfs.service',  () => ({ IpfsService:  jest.fn(() => mockIpfs) }));
jest.mock('../services/vault.service', () => ({ VaultService: jest.fn(() => mockVault) }));

import documentRouter from './document.routes';

// ── test app ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/documents', documentRouter);

const VAULT_PAYLOAD = { type: 'vault', keyName: 'doc-some-uuid', ciphertext: 'vault:v1:abc123' };
const DECRYPTED_CONTENT = Buffer.from('raw file content');

beforeEach(() => {
  jest.clearAllMocks();
  mockVault.createKey.mockResolvedValue(undefined);
  mockVault.encrypt.mockResolvedValue(VAULT_PAYLOAD);
  mockVault.decrypt.mockResolvedValue(DECRYPTED_CONTENT);
  mockIpfs.upload.mockResolvedValue('bafyDocCID');
  mockIpfs.download.mockResolvedValue(Buffer.from(JSON.stringify(VAULT_PAYLOAD)));
});

// ── POST /api/documents/upload ─────────────────────────────────────────────────

describe('POST /api/documents/upload', () => {
  it('returns 201 with cid and documentId', async () => {
    const res = await request(app)
      .post('/api/documents/upload')
      .attach('file', Buffer.from('photo data'), 'photo.jpg');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('cid', 'bafyDocCID');
    expect(res.body).toHaveProperty('documentId');
    expect(typeof res.body.documentId).toBe('string');
  });

  it('creates a Vault transit key with doc namespace', async () => {
    const res = await request(app)
      .post('/api/documents/upload')
      .attach('file', Buffer.from('data'), 'f.bin');

    const docId: string = res.body.documentId;
    expect(mockVault.createKey).toHaveBeenCalledWith(docId, 'doc');
  });

  it('encrypts via Vault with doc namespace', async () => {
    const fileContent = Buffer.from('document bytes');
    const res = await request(app)
      .post('/api/documents/upload')
      .attach('file', fileContent, 'doc.pdf');

    const docId: string = res.body.documentId;
    expect(mockVault.encrypt).toHaveBeenCalledWith(docId, fileContent, 'doc');
  });

  it('uploads the encrypted payload JSON to IPFS', async () => {
    await request(app)
      .post('/api/documents/upload')
      .attach('file', Buffer.from('data'), 'f.bin');

    const [uploadedBuffer] = mockIpfs.upload.mock.calls[0] as [Buffer, string];
    expect(JSON.parse(uploadedBuffer.toString('utf8'))).toEqual(VAULT_PAYLOAD);
  });

  it('generates a unique documentId for each upload', async () => {
    const [r1, r2] = await Promise.all([
      request(app).post('/api/documents/upload').attach('file', Buffer.from('a'), 'a.bin'),
      request(app).post('/api/documents/upload').attach('file', Buffer.from('b'), 'b.bin'),
    ]);
    expect(r1.body.documentId).not.toBe(r2.body.documentId);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app).post('/api/documents/upload');
    expect(res.status).toBe(400);
  });

  it('returns 500 on IPFS upload error', async () => {
    mockIpfs.upload.mockRejectedValueOnce(new Error('IPFS unreachable'));
    const res = await request(app)
      .post('/api/documents/upload')
      .attach('file', Buffer.from('x'), 'x.bin');
    expect(res.status).toBe(500);
  });
});

// ── GET /api/documents/:cid ────────────────────────────────────────────────────

describe('GET /api/documents/:cid', () => {
  it('returns 200 with the decrypted file bytes', async () => {
    const res = await request(app)
      .get('/api/documents/bafyDocCID')
      .query({ documentId: 'doc-uuid-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DECRYPTED_CONTENT);
  });

  it('calls ipfsService.download with the CID', async () => {
    await request(app).get('/api/documents/bafyDocCID').query({ documentId: 'doc-uuid-123' });
    expect(mockIpfs.download).toHaveBeenCalledWith('bafyDocCID');
  });

  it('calls vault.decrypt with the parsed payload', async () => {
    await request(app).get('/api/documents/bafyDocCID').query({ documentId: 'doc-uuid-123' });
    expect(mockVault.decrypt).toHaveBeenCalledWith(VAULT_PAYLOAD);
  });

  it('sets Content-Type to application/octet-stream', async () => {
    const res = await request(app)
      .get('/api/documents/bafyDocCID')
      .query({ documentId: 'doc-uuid-123' });
    expect(res.headers['content-type']).toMatch(/octet-stream/);
  });

  it('returns 400 when documentId query param is missing', async () => {
    const res = await request(app).get('/api/documents/bafyDocCID');
    expect(res.status).toBe(400);
  });

  it('returns 404 when IPFS download fails', async () => {
    mockIpfs.download.mockRejectedValueOnce(new Error('not found'));
    const res = await request(app)
      .get('/api/documents/bafyXXX')
      .query({ documentId: 'doc-uuid-123' });
    expect(res.status).toBe(404);
  });

  it('returns 500 on Vault decryption error', async () => {
    mockVault.decrypt.mockRejectedValueOnce(new Error('auth tag mismatch'));
    const res = await request(app)
      .get('/api/documents/bafyDocCID')
      .query({ documentId: 'doc-uuid-123' });
    expect(res.status).toBe(500);
  });
});
