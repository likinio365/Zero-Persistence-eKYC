import type { Contract } from '@hyperledger/fabric-gateway';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  FabricService,
  readIdentity,
  createSigner,
  isNotFoundError,
  parseRecord,
  parseRecordList,
} from './fabric.service';
import type { KYCRecord } from '../types/kyc.types';

// ── module mocks ──────────────────────────────────────────────────────────────

jest.mock('../config', () => ({
  config: {
    fabric: {
      channel: 'kycchannel',
      chaincode: 'kyccc',
      cryptoConfigPath: './crypto-config',
      mspId: 'Org1MSP',
      asLocalhost: false,
    },
  },
}));

jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── test helpers ──────────────────────────────────────────────────────────────

type MockContract = {
  submitTransaction: jest.Mock;
  evaluateTransaction: jest.Mock;
};

function makeContract(): MockContract {
  return {
    submitTransaction: jest.fn(),
    evaluateTransaction: jest.fn(),
  };
}

function makeService(contract: MockContract): FabricService {
  return new FabricService(contract as unknown as Contract);
}

const RECORD: KYCRecord = {
  id: 'kyc-1',
  did: 'did:indy:test:Alice',
  status: 'PENDING',
  ipfsHash: 'bafybeiabc',
  credDefId: '',
  rejectionReason: '',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function asBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

// ── submitKYC ─────────────────────────────────────────────────────────────────

describe('FabricService.submitKYC', () => {
  it('calls submitTransaction with SubmitKYC and the three arguments', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await makeService(contract).submitKYC('kyc-1', 'did:indy:test:Alice', 'bafybeiabc');

    expect(contract.submitTransaction).toHaveBeenCalledWith(
      'SubmitKYC',
      'kyc-1',
      'did:indy:test:Alice',
      'bafybeiabc',
    );
  });

  it('resolves to void on success', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await expect(
      makeService(contract).submitKYC('kyc-1', 'did:indy:test:Alice', 'bafybeiabc'),
    ).resolves.toBeUndefined();
  });

  it('propagates chaincode errors', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockRejectedValueOnce(
      new Error('KYC record "kyc-1" already exists'),
    );

    await expect(
      makeService(contract).submitKYC('kyc-1', 'did:indy:test:Alice', 'bafybeiabc'),
    ).rejects.toThrow('already exists');
  });

  it('propagates state-machine transition errors', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockRejectedValueOnce(
      new Error('cannot transition from "VERIFIED" to "VERIFIED"'),
    );

    await expect(makeService(contract).submitKYC('kyc-1', 'did:indy:test:Alice', 'hash'))
      .rejects.toThrow('cannot transition');
  });
});

// ── verifyKYC ─────────────────────────────────────────────────────────────────

describe('FabricService.verifyKYC', () => {
  it('calls submitTransaction with VerifyKYC, id, and credDefId', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await makeService(contract).verifyKYC('kyc-1', 'cred-def-abc');

    expect(contract.submitTransaction).toHaveBeenCalledWith(
      'VerifyKYC',
      'kyc-1',
      'cred-def-abc',
    );
  });

  it('resolves to void on success', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await expect(makeService(contract).verifyKYC('kyc-1', 'cred-def-abc'))
      .resolves.toBeUndefined();
  });

  it('propagates chaincode errors', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockRejectedValueOnce(
      new Error('cannot transition from "REVOKED" to "VERIFIED"'),
    );

    await expect(makeService(contract).verifyKYC('kyc-1', 'cred-def-abc'))
      .rejects.toThrow('cannot transition');
  });
});

// ── revokeKYC ─────────────────────────────────────────────────────────────────

describe('FabricService.revokeKYC', () => {
  it('calls submitTransaction with RevokeKYC and only the id', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await makeService(contract).revokeKYC('kyc-1');

    expect(contract.submitTransaction).toHaveBeenCalledWith('RevokeKYC', 'kyc-1');
  });

  it('resolves to void on success', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    await expect(makeService(contract).revokeKYC('kyc-1')).resolves.toBeUndefined();
  });

  it('propagates chaincode errors', async () => {
    const contract = makeContract();
    contract.submitTransaction.mockRejectedValueOnce(
      new Error('cannot transition from "PENDING" to "REVOKED"'),
    );

    await expect(makeService(contract).revokeKYC('kyc-1')).rejects.toThrow('PENDING');
  });
});

// ── getKYC ────────────────────────────────────────────────────────────────────

describe('FabricService.getKYC', () => {
  it('evaluates GetKYC and returns the parsed KYCRecord', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(asBuffer(RECORD));

    const result = await makeService(contract).getKYC('kyc-1');

    expect(result).toEqual(RECORD);
  });

  it('calls evaluateTransaction with GetKYC and the id', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(asBuffer(RECORD));

    await makeService(contract).getKYC('kyc-1');

    expect(contract.evaluateTransaction).toHaveBeenCalledWith('GetKYC', 'kyc-1');
  });

  it('returns null when the chaincode signals record not found', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockRejectedValueOnce(
      new Error('KYC record "kyc-99" not found'),
    );

    const result = await makeService(contract).getKYC('kyc-99');

    expect(result).toBeNull();
  });

  it('propagates non-not-found errors unchanged', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(makeService(contract).getKYC('kyc-1')).rejects.toThrow('ledger unavailable');
  });

  it('returns null when the error matches the chaincode not-found pattern', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockRejectedValueOnce(new Error('KYC record "x" not found'));

    expect(await makeService(contract).getKYC('x')).toBeNull();
  });
});

// ── queryByDID ────────────────────────────────────────────────────────────────

describe('FabricService.queryByDID', () => {
  it('evaluates QueryByDID and returns the parsed array', async () => {
    const records: KYCRecord[] = [RECORD, { ...RECORD, id: 'kyc-2' }];
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(asBuffer(records));

    const result = await makeService(contract).queryByDID('did:indy:test:Alice');

    expect(result).toEqual(records);
  });

  it('calls evaluateTransaction with QueryByDID and the DID', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(asBuffer([]));

    await makeService(contract).queryByDID('did:indy:test:Alice');

    expect(contract.evaluateTransaction).toHaveBeenCalledWith(
      'QueryByDID',
      'did:indy:test:Alice',
    );
  });

  it('returns an empty array when the chaincode returns null (no results in Go)', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(Buffer.from('null'));

    expect(await makeService(contract).queryByDID('did:indy:test:Alice')).toEqual([]);
  });

  it('returns an empty array when the result buffer is empty', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockResolvedValueOnce(Buffer.alloc(0));

    expect(await makeService(contract).queryByDID('did:indy:test:Alice')).toEqual([]);
  });

  it('propagates errors', async () => {
    const contract = makeContract();
    contract.evaluateTransaction.mockRejectedValueOnce(new Error('couchdb unavailable'));

    await expect(makeService(contract).queryByDID('did:indy:test:Alice'))
      .rejects.toThrow('couchdb unavailable');
  });
});

// ── parseRecord ───────────────────────────────────────────────────────────────

describe('parseRecord', () => {
  it('parses a Buffer containing a JSON KYCRecord', () => {
    expect(parseRecord<KYCRecord>(asBuffer(RECORD))).toEqual(RECORD);
  });

  it('parses a Uint8Array (not just Buffer)', () => {
    const buf = Buffer.from(JSON.stringify({ id: 'x' }));
    expect(parseRecord<{ id: string }>(new Uint8Array(buf))).toEqual({ id: 'x' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRecord(Buffer.from('not-json'))).toThrow();
  });
});

// ── parseRecordList ───────────────────────────────────────────────────────────

describe('parseRecordList', () => {
  it('parses a JSON array of records', () => {
    const records = [RECORD];
    expect(parseRecordList<KYCRecord>(asBuffer(records))).toEqual(records);
  });

  it('returns empty array for JSON null (Go nil slice)', () => {
    expect(parseRecordList(Buffer.from('null'))).toEqual([]);
  });

  it('returns empty array for an empty buffer', () => {
    expect(parseRecordList(Buffer.alloc(0))).toEqual([]);
  });

  it('returns empty array for a whitespace-only buffer', () => {
    expect(parseRecordList(Buffer.from('   '))).toEqual([]);
  });

  it('returns empty array for a JSON empty array', () => {
    expect(parseRecordList(Buffer.from('[]'))).toEqual([]);
  });
});

// ── isNotFoundError ───────────────────────────────────────────────────────────

describe('isNotFoundError', () => {
  it('returns true for chaincode not-found error messages', () => {
    expect(isNotFoundError(new Error('KYC record "abc" not found'))).toBe(true);
  });

  it('is case-insensitive for the chaincode pattern', () => {
    expect(isNotFoundError(new Error('KYC RECORD "abc" NOT FOUND'))).toBe(true);
    expect(isNotFoundError(new Error('kyc record "abc" not found'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isNotFoundError(new Error('ledger unavailable'))).toBe(false);
    expect(isNotFoundError(new Error('cannot transition from "PENDING"'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isNotFoundError('KYC record "abc" not found')).toBe(true);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});

// ── readIdentity / createSigner ───────────────────────────────────────────────

describe('readIdentity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-fabric-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildSigncerts(base: string, cert: string) {
    const signcerts = path.join(
      base,
      'peerOrganizations', 'org1.example.com',
      'users', 'Admin@org1.example.com', 'msp', 'signcerts',
    );
    fs.mkdirSync(signcerts, { recursive: true });
    fs.writeFileSync(path.join(signcerts, 'Admin@org1.example.com-cert.pem'), cert);
  }

  it('reads the certificate bytes and sets mspId', () => {
    buildSigncerts(tmpDir, 'CERT_DATA');

    const identity = readIdentity(tmpDir, 'Org1MSP');

    expect(identity.mspId).toBe('Org1MSP');
    expect(Buffer.from(identity.credentials).toString()).toBe('CERT_DATA');
  });

  it('throws when the signcerts directory is empty', () => {
    const signcerts = path.join(
      tmpDir,
      'peerOrganizations', 'org1.example.com',
      'users', 'Admin@org1.example.com', 'msp', 'signcerts',
    );
    fs.mkdirSync(signcerts, { recursive: true });

    expect(() => readIdentity(tmpDir, 'Org1MSP')).toThrow(/No .pem/);
  });
});

describe('createSigner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-fabric-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when the keystore directory is empty', () => {
    const keystore = path.join(
      tmpDir,
      'peerOrganizations', 'org1.example.com',
      'users', 'Admin@org1.example.com', 'msp', 'keystore',
    );
    fs.mkdirSync(keystore, { recursive: true });

    expect(() => createSigner(tmpDir)).toThrow(/No private key/);
  });
});
