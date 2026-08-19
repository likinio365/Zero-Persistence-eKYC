import { connect, Contract, Gateway, signers } from '@hyperledger/fabric-gateway';
import * as grpc from '@grpc/grpc-js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../config/logger';
import { KYCRecord } from '../types/kyc.types';

export class FabricService {
  private grpcClient: grpc.Client | null = null;
  private gateway: Gateway | null = null;
  private live: Contract | null = null;
  private connecting: Promise<void> | null = null;

  // An optional pre-built Contract injected for unit tests.
  constructor(private readonly testContract?: Contract) {}

  async connect(): Promise<void> {
    if (this.live) return;
    if (this.connecting) return this.connecting;

    this.connecting = this._doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async _doConnect(): Promise<void> {
    const tlsCACert = readTlsCACert(config.fabric.cryptoConfigPath);
    const credentials = grpc.credentials.createSsl(Buffer.from(tlsCACert));

    const grpcClient = new grpc.Client('peer0.org1.example.com:7051', credentials, {
      'grpc.ssl_target_name_override': 'peer0.org1.example.com',
    });

    let gateway: Gateway;
    try {
      const identity = readIdentity(config.fabric.cryptoConfigPath, config.fabric.mspId);
      const signer = createSigner(config.fabric.cryptoConfigPath);

      gateway = connect({
        client: grpcClient,
        identity,
        signer,
        evaluateOptions:     () => ({ deadline: Date.now() + 300_000 }),
        endorseOptions:      () => ({ deadline: Date.now() + 300_000 }),
        submitOptions:       () => ({ deadline: Date.now() + 300_000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 300_000 }),
      });
    } catch (err) {
      grpcClient.close();
      throw err;
    }

    const network = gateway.getNetwork(config.fabric.channel);
    this.grpcClient = grpcClient;
    this.gateway = gateway;
    this.live = network.getContract(config.fabric.chaincode);

    logger.info('Connected to Fabric network', {
      channel: config.fabric.channel,
      chaincode: config.fabric.chaincode,
      peer: 'peer0.org1.example.com',
    });
  }

  disconnect(): void {
    this.gateway?.close();
    this.grpcClient?.close();
    this.live = null;
    this.gateway = null;
    this.grpcClient = null;
  }

  // ── KYC lifecycle transactions ─────────────────────────────────────────────

  async submitKYC(id: string, did: string, ipfsHash: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('SubmitKYC', id, did, ipfsHash);
    logger.debug('SubmitKYC committed', { id, did });
  }

  async verifyKYC(id: string, credDefId: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('VerifyKYC', id, credDefId);
    logger.debug('VerifyKYC committed', { id });
  }

  async rejectKYC(id: string, reason: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('RejectKYC', id, reason);
    logger.debug('RejectKYC committed', { id });
  }

  async revokeKYC(id: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('RevokeKYC', id);
    logger.debug('RevokeKYC committed', { id });
  }

  async resubmitKYC(id: string, newManifestCid: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('ResubmitKYC', id, newManifestCid);
    logger.debug('ResubmitKYC committed', { id });
  }

  async storeCredExchangeId(id: string, credExchangeId: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('StoreCredExchangeID', id, credExchangeId);
    logger.debug('StoreCredExchangeID committed', { id });
  }

  async eraseKYC(id: string): Promise<void> {
    const cc = await this.contract();
    await cc.submitTransaction('EraseKYC', id);
    logger.debug('EraseKYC committed', { id });
  }

  async getKYCHistory(id: string): Promise<unknown[]> {
    const cc = await this.contract();
    const result = await cc.evaluateTransaction('GetKYCHistory', id);
    return parseRecordList<unknown>(result);
  }

  // ── KYC queries ────────────────────────────────────────────────────────────

  async getKYC(id: string): Promise<KYCRecord | null> {
    const cc = await this.contract();
    try {
      const result = await cc.evaluateTransaction('GetKYC', id);
      return parseRecord<KYCRecord>(result);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async queryByDID(did: string): Promise<KYCRecord[]> {
    const cc = await this.contract();
    const result = await cc.evaluateTransaction('QueryByDID', did);
    return parseRecordList<KYCRecord>(result);
  }

  async queryByStatus(status: string): Promise<KYCRecord[]> {
    const cc = await this.contract();
    const result = await cc.evaluateTransaction('QueryByStatus', status);
    return parseRecordList<KYCRecord>(result);
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async contract(): Promise<Contract> {
    if (this.testContract) return this.testContract;
    if (!this.live) await this.connect();
    return this.live!;
  }
}

// ── module-level helpers (exported for unit tests) ────────────────────────────

export function readTlsCACert(cryptoConfigPath: string): string {
  const certPath = path.join(
    path.resolve(cryptoConfigPath),
    'peerOrganizations',
    'org1.example.com',
    'peers',
    'peer0.org1.example.com',
    'tls',
    'ca.crt',
  );
  return fs.readFileSync(certPath, 'utf8');
}

export function readIdentity(cryptoConfigPath: string, mspId: string): { mspId: string; credentials: Uint8Array } {
  const mspBase = path.join(
    path.resolve(cryptoConfigPath),
    'peerOrganizations',
    'org1.example.com',
    'users',
    'Admin@org1.example.com',
    'msp',
  );
  const certDir = path.join(mspBase, 'signcerts');
  const certFiles = fs.readdirSync(certDir).filter(f => f.endsWith('.pem'));
  if (certFiles.length === 0) throw new Error(`No .pem certificate found in ${certDir}`);
  const credentials = fs.readFileSync(path.join(certDir, certFiles[0]));
  return { mspId, credentials };
}

export function createSigner(cryptoConfigPath: string): ReturnType<typeof signers.newPrivateKeySigner> {
  const mspBase = path.join(
    path.resolve(cryptoConfigPath),
    'peerOrganizations',
    'org1.example.com',
    'users',
    'Admin@org1.example.com',
    'msp',
  );
  const keyDir = path.join(mspBase, 'keystore');
  const keyFiles = fs.readdirSync(keyDir).filter(f => !f.startsWith('.'));
  if (keyFiles.length === 0) throw new Error(`No private key found in ${keyDir}`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(keyDir, keyFiles[0])));
  return signers.newPrivateKeySigner(privateKey);
}

export function parseRecord<T>(result: Uint8Array): T {
  return JSON.parse(Buffer.from(result).toString('utf8')) as T;
}

export function parseRecordList<T>(result: Uint8Array): T[] {
  const json = Buffer.from(result).toString('utf8').trim();
  if (!json || json === 'null') return [];
  return JSON.parse(json) as T[];
}

export function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /KYC record "[^"]+" not found/i.test(msg);
}
