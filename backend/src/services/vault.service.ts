import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../config/logger';

export interface VaultEncryptedPayload {
  type: 'vault';
  keyName: string;
  ciphertext: string; // vault:v1:...
}

export class VaultService {
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.vault.address,
      headers: { 'X-Vault-Token': config.vault.token },
      timeout: 10_000,
    });
  }

  // Creates a transit key if it does not already exist.
  // namespace defaults to 'kyc'; use 'doc' for standalone document keys.
  async createKey(id: string, namespace = 'kyc'): Promise<void> {
    const keyName = this.keyName(id, namespace);
    try {
      await this.client.post(`/v1/transit/keys/${keyName}`, { type: 'aes256-gcm96' });
      logger.info('Vault transit key created', { keyName });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        // Key already exists — idempotent, not an error.
        return;
      }
      throw new Error(`Vault createKey(${keyName}) failed: ${errorMessage(err)}`);
    }
  }

  // Encrypts plaintext via Vault Transit. Returns a VaultEncryptedPayload.
  async encrypt(id: string, plaintext: Buffer, namespace = 'kyc'): Promise<VaultEncryptedPayload> {
    const keyName = this.keyName(id, namespace);
    try {
      const response = await this.client.post<{ data: { ciphertext: string } }>(
        `/v1/transit/encrypt/${keyName}`,
        { plaintext: plaintext.toString('base64') },
      );
      return { type: 'vault', keyName, ciphertext: response.data.data.ciphertext };
    } catch (err) {
      throw new Error(`Vault encrypt(${keyName}) failed: ${errorMessage(err)}`);
    }
  }

  // Decrypts a VaultEncryptedPayload via Vault Transit. Returns the original plaintext.
  async decrypt(payload: VaultEncryptedPayload): Promise<Buffer> {
    try {
      const response = await this.client.post<{ data: { plaintext: string } }>(
        `/v1/transit/decrypt/${payload.keyName}`,
        { ciphertext: payload.ciphertext },
      );
      return Buffer.from(response.data.data.plaintext, 'base64');
    } catch (err) {
      throw new Error(`Vault decrypt(${payload.keyName}) failed: ${errorMessage(err)}`);
    }
  }

  // Deletes the transit key (e.g. on KYC revocation).
  async deleteKey(id: string, namespace = 'kyc'): Promise<void> {
    const keyName = this.keyName(id, namespace);
    try {
      // Must enable deletion first, then delete.
      await this.client.post(`/v1/transit/keys/${keyName}/config`, { deletion_allowed: true });
      await this.client.delete(`/v1/transit/keys/${keyName}`);
      logger.info('Vault transit key deleted', { keyName });
    } catch (err) {
      logger.warn('Vault deleteKey failed (non-fatal)', { keyName, err: errorMessage(err) });
    }
  }

  private keyName(id: string, namespace: string): string {
    return `${namespace}-${id}`;
  }
}

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { errors?: string[] } | undefined;
    return data?.errors?.[0] ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
