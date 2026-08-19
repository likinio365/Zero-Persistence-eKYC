import { AxiosInstance } from 'axios';
import { APIClient } from './api';
import type { KYCRecord, SubmitKYCRequest } from '../types/kyc';

// ── helpers ───────────────────────────────────────────────────────────────────

type MockHttp = { get: jest.Mock; post: jest.Mock };

function makeHttp(): MockHttp {
  return { get: jest.fn(), post: jest.fn() };
}

function makeClient(http: MockHttp): APIClient {
  return new APIClient(http as unknown as AxiosInstance);
}

const RECORD: KYCRecord = {
  id: 'kyc-1', did: 'did:indy:test:Alice', status: 'PENDING',
  ipfsHash: 'bafyXXX', credDefId: '', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
};

const SUBMIT_REQUEST: SubmitKYCRequest = {
  did: 'did:indy:test:Alice',
  documents: [{ type: 'passport', fileName: 'pass.jpg', contentBase64: 'base64data' }],
};

// ── submitKYC ─────────────────────────────────────────────────────────────────

describe('APIClient.submitKYC', () => {
  it('POSTs to /api/kyc and returns { id }', async () => {
    const http = makeHttp();
    http.post.mockResolvedValueOnce({ data: { id: 'kyc-1' } });

    const result = await makeClient(http).submitKYC(SUBMIT_REQUEST);

    expect(result).toEqual({ id: 'kyc-1' });
    expect(http.post).toHaveBeenCalledWith('/api/kyc', SUBMIT_REQUEST);
  });

  it('propagates errors', async () => {
    const http = makeHttp();
    http.post.mockRejectedValueOnce(new Error('KYC submission failed'));

    await expect(makeClient(http).submitKYC(SUBMIT_REQUEST)).rejects.toThrow('KYC submission failed');
  });
});

// ── getKYCRecord ──────────────────────────────────────────────────────────────

describe('APIClient.getKYCRecord', () => {
  it('GETs /api/kyc/:id and returns the record', async () => {
    const http = makeHttp();
    http.get.mockResolvedValueOnce({ data: RECORD });

    const result = await makeClient(http).getKYCRecord('kyc-1');

    expect(result).toEqual(RECORD);
    expect(http.get).toHaveBeenCalledWith('/api/kyc/kyc-1');
  });

  it('percent-encodes the id', async () => {
    const http = makeHttp();
    http.get.mockResolvedValueOnce({ data: RECORD });

    await makeClient(http).getKYCRecord('kyc/with/slashes');

    expect(http.get).toHaveBeenCalledWith('/api/kyc/kyc%2Fwith%2Fslashes');
  });

  it('propagates not-found errors', async () => {
    const http = makeHttp();
    http.get.mockRejectedValueOnce(new Error('KYC record not found'));

    await expect(makeClient(http).getKYCRecord('ghost')).rejects.toThrow('not found');
  });
});

// ── getKYCByDID ───────────────────────────────────────────────────────────────

describe('APIClient.getKYCByDID', () => {
  it('GETs /api/kyc/did/:did and returns the array', async () => {
    const http = makeHttp();
    http.get.mockResolvedValueOnce({ data: [RECORD] });

    const result = await makeClient(http).getKYCByDID('did:indy:test:Alice');

    expect(result).toEqual([RECORD]);
    expect(http.get).toHaveBeenCalledWith('/api/kyc/did/did%3Aindy%3Atest%3AAlice');
  });
});

// ── uploadDocument ────────────────────────────────────────────────────────────

describe('APIClient.uploadDocument', () => {
  it('POSTs to /api/documents/upload with FormData', async () => {
    const http = makeHttp();
    http.post.mockResolvedValueOnce({ data: { cid: 'bafyDoc', documentId: 'uuid-1' } });
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });

    const result = await makeClient(http).uploadDocument(file);

    expect(result).toEqual({ cid: 'bafyDoc', documentId: 'uuid-1' });
    const [url, body, cfg] = http.post.mock.calls[0] as [string, FormData, { headers: Record<string, string> }];
    expect(url).toBe('/api/documents/upload');
    expect(body).toBeInstanceOf(FormData);
    expect(cfg.headers['Content-Type']).toBe('multipart/form-data');
  });
});

// ── resolveDID ────────────────────────────────────────────────────────────────

describe('APIClient.resolveDID', () => {
  it('GETs /api/did/:encoded_did and returns the document', async () => {
    const http = makeHttp();
    const doc = { id: 'did:indy:test:Alice', verificationMethod: [], authentication: [] };
    http.get.mockResolvedValueOnce({ data: doc });

    const result = await makeClient(http).resolveDID('did:indy:test:Alice');

    expect(result).toEqual(doc);
    expect(http.get).toHaveBeenCalledWith('/api/did/did%3Aindy%3Atest%3AAlice');
  });

  it('propagates resolution errors', async () => {
    const http = makeHttp();
    http.get.mockRejectedValueOnce(new Error('DID could not be resolved'));

    await expect(makeClient(http).resolveDID('did:indy:test:Ghost'))
      .rejects.toThrow('could not be resolved');
  });
});
