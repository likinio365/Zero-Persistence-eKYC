import request from 'supertest';
import express from 'express';
import type { DIDDocument } from '../services/indy.service';

// ── mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockIndy = {
  createDID: jest.fn(),
  publishDID: jest.fn(),
  resolveDID: jest.fn(),
  getCredentials: jest.fn(),
  createInvitation: jest.fn(),
  getConnectionStatus: jest.fn(),
};

jest.mock('../services/indy.service', () => ({
  IndyService: jest.fn(() => mockIndy),
}));

import didRouter from './did.routes';

// ── test app ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/did', didRouter);

// ── fixtures ──────────────────────────────────────────────────────────────────

const DID_DOC: DIDDocument = {
  id: 'did:indy:test:Alice',
  verificationMethod: [],
  authentication: ['did:indy:test:Alice#key-1'],
};

const VC = { credentialId: 'ex-1', credentialExchangeId: 'ex-1', state: 'done', did: 'did:indy:test:Alice' };

beforeEach(() => {
  jest.clearAllMocks();
  mockIndy.createDID.mockResolvedValue({ did: 'did:sov:Wg123', verkey: '~vk456' });
  mockIndy.publishDID.mockResolvedValue(undefined);
  mockIndy.resolveDID.mockResolvedValue(DID_DOC);
  mockIndy.getCredentials.mockResolvedValue([VC]);
  mockIndy.createInvitation.mockResolvedValue({ invitationUrl: 'https://example.com?oob=eyJ...', oobId: 'oob-123' });
  mockIndy.getConnectionStatus.mockResolvedValue({ connected: true, state: 'active', connectionId: 'conn-abc' });
});

// ── POST /api/did ──────────────────────────────────────────────────────────────

describe('POST /api/did', () => {
  it('returns 201 with did and verkey', async () => {
    const res = await request(app).post('/api/did').send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ did: 'did:sov:Wg123', verkey: '~vk456', published: true });
  });

  it('calls indyService.createDID()', async () => {
    await request(app).post('/api/did').send({});
    expect(mockIndy.createDID).toHaveBeenCalledTimes(1);
  });

  it('returns 500 on service error', async () => {
    mockIndy.createDID.mockRejectedValueOnce(new Error('wallet locked'));
    const res = await request(app).post('/api/did').send({});
    expect(res.status).toBe(500);
  });
});

// ── GET /api/did/:did ──────────────────────────────────────────────────────────

describe('GET /api/did/:did', () => {
  it('returns 200 with the DID document', async () => {
    const res = await request(app).get('/api/did/did:indy:test:Alice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DID_DOC);
  });

  it('passes the decoded DID to resolveDID', async () => {
    await request(app).get('/api/did/did%3Aindy%3Atest%3AAlice');
    expect(mockIndy.resolveDID).toHaveBeenCalledWith('did:indy:test:Alice');
  });

  it('returns 404 when ACA-Py signals not found', async () => {
    mockIndy.resolveDID.mockRejectedValueOnce(new Error('ACA-Py resolveDID failed: DID not found'));
    const res = await request(app).get('/api/did/did:indy:test:Ghost');
    expect(res.status).toBe(404);
  });

  it('returns 404 when ACA-Py signals not resolvable', async () => {
    mockIndy.resolveDID.mockRejectedValueOnce(new Error('not resolvable on this ledger'));
    const res = await request(app).get('/api/did/did:indy:test:Ghost');
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockIndy.resolveDID.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app).get('/api/did/did:indy:test:Alice');
    expect(res.status).toBe(500);
  });
});

// ── POST /api/did/:did/connect ─────────────────────────────────────────────────

describe('POST /api/did/:did/connect', () => {
  it('returns 201 with invitationUrl and oobId', async () => {
    const res = await request(app).post('/api/did/did:indy:test:Alice/connect').send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      did: 'did:indy:test:Alice',
      invitationUrl: 'https://example.com?oob=eyJ...',
      oobId: 'oob-123',
    });
  });

  it('calls indyService.createInvitation()', async () => {
    await request(app).post('/api/did/did:indy:test:Alice/connect').send({});
    expect(mockIndy.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('decodes a percent-encoded DID in the response', async () => {
    const res = await request(app).post('/api/did/did%3Aindy%3Atest%3AAlice/connect').send({});
    expect(res.body.did).toBe('did:indy:test:Alice');
  });

  it('returns 500 on service error', async () => {
    mockIndy.createInvitation.mockRejectedValueOnce(new Error('acapy down'));
    const res = await request(app).post('/api/did/did:indy:test:Alice/connect').send({});
    expect(res.status).toBe(500);
  });
});

// ── GET /api/did/:did/connection-status ───────────────────────────────────────

describe('GET /api/did/:did/connection-status', () => {
  it('returns 200 with connection status', async () => {
    const res = await request(app).get('/api/did/did:indy:test:Alice/connection-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      did: 'did:indy:test:Alice',
      connected: true,
      state: 'active',
      connectionId: 'conn-abc',
    });
  });

  it('returns connected:false when no connection', async () => {
    mockIndy.getConnectionStatus.mockResolvedValueOnce({ connected: false, state: null, connectionId: null });
    const res = await request(app).get('/api/did/did:indy:test:Nobody/connection-status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it('passes the decoded DID to getConnectionStatus', async () => {
    await request(app).get('/api/did/did%3Aindy%3Atest%3AAlice/connection-status');
    expect(mockIndy.getConnectionStatus).toHaveBeenCalledWith('did:indy:test:Alice');
  });

  it('returns 500 on service error', async () => {
    mockIndy.getConnectionStatus.mockRejectedValueOnce(new Error('acapy down'));
    const res = await request(app).get('/api/did/did:indy:test:Alice/connection-status');
    expect(res.status).toBe(500);
  });
});

// ── GET /api/did/:did/credentials ──────────────────────────────────────────────

describe('GET /api/did/:did/credentials', () => {
  it('returns 200 with the credentials array', async () => {
    const res = await request(app).get('/api/did/did:indy:test:Alice/credentials');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([VC]);
  });

  it('returns an empty array when no credentials exist', async () => {
    mockIndy.getCredentials.mockResolvedValueOnce([]);
    const res = await request(app).get('/api/did/did:indy:test:Alice/credentials');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('passes the decoded DID to getCredentials', async () => {
    await request(app).get('/api/did/did%3Aindy%3Atest%3AAlice/credentials');
    expect(mockIndy.getCredentials).toHaveBeenCalledWith('did:indy:test:Alice');
  });

  it('returns 500 on service error', async () => {
    mockIndy.getCredentials.mockRejectedValueOnce(new Error('storage unavailable'));
    const res = await request(app).get('/api/did/did:indy:test:Alice/credentials');
    expect(res.status).toBe(500);
  });
});
