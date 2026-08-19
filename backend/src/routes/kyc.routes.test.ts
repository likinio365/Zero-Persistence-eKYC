import request from 'supertest';
import express from 'express';
import type { KYCRecord } from '../types/kyc.types';

// ── service mocks (must precede the router import) ────────────────────────────

jest.mock('../config', () => ({
  config: {
    ipfs: { apiUrl: 'http://localhost:5001' },
    acapy: { adminUrl: 'http://localhost:8031', apiKey: '' },
    fabric: {
      channel: 'kycchannel', chaincode: 'kyccc',
      cryptoConfigPath: './cc', mspId: 'Org1MSP', asLocalhost: false,
    },
  },
}));
jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockVault  = { createKey: jest.fn(), encrypt: jest.fn(), decrypt: jest.fn() };
const mockFabric = { submitKYC: jest.fn(), getKYC: jest.fn(), verifyKYC: jest.fn(), revokeKYC: jest.fn(), queryByDID: jest.fn() };
const mockIndy   = { issueCredential: jest.fn(), revokeCredential: jest.fn() };
const mockIpfs   = { upload: jest.fn(), download: jest.fn() };

jest.mock('../services/vault.service',  () => ({ VaultService:  jest.fn(() => mockVault) }));
jest.mock('../services/fabric.service', () => ({ FabricService: jest.fn(() => mockFabric) }));
jest.mock('../services/indy.service',   () => ({ IndyService:   jest.fn(() => mockIndy) }));
jest.mock('../services/ipfs.service',   () => ({ IpfsService:   jest.fn(() => mockIpfs) }));
// Auth is tested separately — make guards pass-through here.
jest.mock('../middleware/auth.middleware', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireVerifier: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import kycRouter from './kyc.routes';

// ── test app ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/kyc', kycRouter);

// ── fixtures ──────────────────────────────────────────────────────────────────

const PENDING_RECORD: KYCRecord = {
  id: 'kyc-1', did: 'did:indy:test:Alice', status: 'PENDING',
  ipfsHash: 'bafyManifest', credDefId: '', rejectionReason: '',
  createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
};
const VERIFIED_RECORD: KYCRecord = { ...PENDING_RECORD, status: 'VERIFIED', credDefId: 'cred-def-1' };
const VAULT_PAYLOAD = { type: 'vault', keyName: 'kyc-kyc-1', ciphertext: 'vault:v1:abc123' };
const SUBMIT_BODY = {
  did: 'did:indy:test:Alice',
  documents: [
    { type: 'passport', fileName: 'pass.jpg', contentBase64: Buffer.from('photo').toString('base64') },
    { type: 'selfie',   fileName: 'self.jpg', contentBase64: Buffer.from('selfie').toString('base64') },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVault.createKey.mockResolvedValue(undefined);
  mockVault.encrypt.mockResolvedValue(VAULT_PAYLOAD);
  mockVault.decrypt.mockResolvedValue(Buffer.from('{}'));
  mockIpfs.upload.mockResolvedValue('bafyXXX');
  mockIpfs.download.mockResolvedValue(Buffer.from(JSON.stringify(VAULT_PAYLOAD)));
  mockFabric.submitKYC.mockResolvedValue(undefined);
  mockFabric.getKYC.mockResolvedValue(PENDING_RECORD);
  mockFabric.verifyKYC.mockResolvedValue(undefined);
  mockFabric.revokeKYC.mockResolvedValue(undefined);
  mockFabric.queryByDID.mockResolvedValue([PENDING_RECORD]);
  mockIndy.issueCredential.mockResolvedValue({ credentialId: 'ex-1', credentialExchangeId: 'ex-1', state: 'offer-sent', did: 'did:indy:test:Alice' });
  mockIndy.revokeCredential.mockResolvedValue(undefined);
});

// ── POST /api/kyc ──────────────────────────────────────────────────────────────

describe('POST /api/kyc', () => {
  it('returns 201 with a generated id', async () => {
    const res = await request(app).post('/api/kyc').send(SUBMIT_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(typeof res.body.id).toBe('string');
  });

  it('creates a Vault transit key for the new kycId', async () => {
    const res = await request(app).post('/api/kyc').send(SUBMIT_BODY);
    const kycId = res.body.id as string;
    expect(mockVault.createKey).toHaveBeenCalledWith(kycId);
  });

  it('calls vault.encrypt once per document plus once for the manifest', async () => {
    await request(app).post('/api/kyc').send(SUBMIT_BODY);
    // 2 documents (passport + selfie) + 1 manifest = 3 encrypt calls
    expect(mockVault.encrypt).toHaveBeenCalledTimes(3);
  });

  it('encrypts all payloads under the per-KYC key', async () => {
    const res = await request(app).post('/api/kyc').send(SUBMIT_BODY);
    const kycId = res.body.id as string;
    for (const call of mockVault.encrypt.mock.calls as [string, Buffer][]) {
      expect(call[0]).toBe(kycId);
    }
  });

  it('calls ipfsService.upload once per document plus once for the manifest', async () => {
    await request(app).post('/api/kyc').send(SUBMIT_BODY);
    // 2 documents + 1 manifest = 3 uploads
    expect(mockIpfs.upload).toHaveBeenCalledTimes(3);
  });

  it('calls fabricService.submitKYC with the generated kycId, did, and manifest CID', async () => {
    const res = await request(app).post('/api/kyc').send(SUBMIT_BODY);
    const kycId = res.body.id as string;
    expect(mockFabric.submitKYC).toHaveBeenCalledWith(kycId, SUBMIT_BODY.did, 'bafyXXX');
  });

  it('returns 400 when documents array is missing', async () => {
    const res = await request(app).post('/api/kyc').send({ did: 'did:indy:test:Alice' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when did is missing', async () => {
    const res = await request(app).post('/api/kyc').send({ documents: SUBMIT_BODY.documents });
    expect(res.status).toBe(400);
  });

  it('returns 500 when fabricService.submitKYC throws', async () => {
    mockFabric.submitKYC.mockRejectedValueOnce(new Error('peer unreachable'));
    const res = await request(app).post('/api/kyc').send(SUBMIT_BODY);
    expect(res.status).toBe(500);
  });
});

// ── GET /api/kyc/:id ───────────────────────────────────────────────────────────

describe('GET /api/kyc/:id', () => {
  it('returns 200 with the KYC record', async () => {
    const res = await request(app).get('/api/kyc/kyc-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PENDING_RECORD);
  });

  it('returns 404 when getKYC returns null', async () => {
    mockFabric.getKYC.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/kyc/missing');
    expect(res.status).toBe(404);
  });

  it('returns 500 on ledger error', async () => {
    mockFabric.getKYC.mockRejectedValueOnce(new Error('ledger down'));
    const res = await request(app).get('/api/kyc/kyc-1');
    expect(res.status).toBe(500);
  });
});

// ── PUT /api/kyc/:id/verify ────────────────────────────────────────────────────

describe('PUT /api/kyc/:id/verify', () => {
  const VERIFY_BODY = { credDefId: 'cred-def-1' };

  it('returns 200 with credentialExchangeId and state', async () => {
    const res = await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'kyc-1', verified: true, credentialExchangeId: 'ex-1', state: 'offer-sent' });
  });

  it('calls fabricService.verifyKYC with id and credDefId', async () => {
    await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    expect(mockFabric.verifyKYC).toHaveBeenCalledWith('kyc-1', 'cred-def-1');
  });

  it('calls indyService.issueCredential with the record DID', async () => {
    await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    expect(mockIndy.issueCredential).toHaveBeenCalledWith(
      'did:indy:test:Alice',
      'cred-def-1',
      expect.any(Object),
    );
  });

  it('uses caller-supplied attributes for the VC when provided', async () => {
    const attrs = { full_name: 'Alice', date_of_birth: '1990-01-01' };
    await request(app).put('/api/kyc/kyc-1/verify').send({ ...VERIFY_BODY, attributes: attrs });
    const [,, calledAttrs] = mockIndy.issueCredential.mock.calls[0] as [string, string, Record<string, string>];
    expect(calledAttrs).toEqual(attrs);
  });

  it('falls back to minimal default attributes when none provided', async () => {
    await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    const [,, calledAttrs] = mockIndy.issueCredential.mock.calls[0] as [string, string, Record<string, string>];
    expect(calledAttrs).toHaveProperty('kyc_id', 'kyc-1');
    expect(calledAttrs).toHaveProperty('verification_date');
  });

  it('returns 404 when record not found', async () => {
    mockFabric.getKYC.mockResolvedValueOnce(null);
    const res = await request(app).put('/api/kyc/missing/verify').send(VERIFY_BODY);
    expect(res.status).toBe(404);
  });

  it('returns 409 when record is not PENDING', async () => {
    mockFabric.getKYC.mockResolvedValueOnce(VERIFIED_RECORD);
    const res = await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    expect(res.status).toBe(409);
  });

  it('returns 400 when credDefId is missing', async () => {
    const res = await request(app).put('/api/kyc/kyc-1/verify').send({});
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockFabric.verifyKYC.mockRejectedValueOnce(new Error('chaincode error'));
    const res = await request(app).put('/api/kyc/kyc-1/verify').send(VERIFY_BODY);
    expect(res.status).toBe(500);
  });
});

// ── PUT /api/kyc/:id/revoke ────────────────────────────────────────────────────

describe('PUT /api/kyc/:id/revoke', () => {
  beforeEach(() => {
    mockFabric.getKYC.mockResolvedValue(VERIFIED_RECORD);
  });

  it('returns 200 with revoked:true', async () => {
    const res = await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'kyc-1', revoked: true });
  });

  it('calls fabricService.revokeKYC', async () => {
    await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(mockFabric.revokeKYC).toHaveBeenCalledWith('kyc-1');
  });

  it('also revokes the VC when credentialExchangeId is on the record', async () => {
    mockFabric.getKYC.mockResolvedValueOnce({ ...VERIFIED_RECORD, credentialExchangeId: 'ex-99' });
    await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(mockIndy.revokeCredential).toHaveBeenCalledWith('ex-99');
  });

  it('skips VC revocation when credentialExchangeId is absent', async () => {
    await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(mockIndy.revokeCredential).not.toHaveBeenCalled();
  });

  it('returns 404 when record not found', async () => {
    mockFabric.getKYC.mockResolvedValueOnce(null);
    const res = await request(app).put('/api/kyc/missing/revoke').send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 when record is not VERIFIED', async () => {
    mockFabric.getKYC.mockResolvedValueOnce(PENDING_RECORD);
    const res = await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(res.status).toBe(409);
  });

  it('returns 500 on service error', async () => {
    mockFabric.revokeKYC.mockRejectedValueOnce(new Error('ledger error'));
    const res = await request(app).put('/api/kyc/kyc-1/revoke').send({});
    expect(res.status).toBe(500);
  });
});

// ── GET /api/kyc/did/:did ──────────────────────────────────────────────────────

describe('GET /api/kyc/did/:did', () => {
  it('returns 200 with the records array', async () => {
    const res = await request(app).get('/api/kyc/did/did:indy:test:Alice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([PENDING_RECORD]);
  });

  it('passes the decoded DID to queryByDID', async () => {
    await request(app).get('/api/kyc/did/did%3Aindy%3Atest%3AAlice');
    expect(mockFabric.queryByDID).toHaveBeenCalledWith('did:indy:test:Alice');
  });

  it('returns an empty array when no records exist', async () => {
    mockFabric.queryByDID.mockResolvedValueOnce([]);
    const res = await request(app).get('/api/kyc/did/did:indy:test:Nobody');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 on ledger error', async () => {
    mockFabric.queryByDID.mockRejectedValueOnce(new Error('couchdb down'));
    const res = await request(app).get('/api/kyc/did/did:indy:test:Alice');
    expect(res.status).toBe(500);
  });
});
