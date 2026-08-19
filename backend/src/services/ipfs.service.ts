import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { config } from '../config';
import { logger } from '../config/logger';

// Shape of the JSON object Kubo returns from /api/v0/add
interface AddResponse {
  Hash: string;
  Name: string;
  Size: string;
}

// Shape of Kubo error bodies (HTTP 500)
interface KuboError {
  Message: string;
  Code: number;
  Type: string;
}

export class IpfsService {
  // The client is injectable so tests can pass a mock without monkey-patching axios.
  constructor(
    private readonly client: AxiosInstance = axios.create({
      baseURL: config.ipfs.apiUrl,
      timeout: 30_000,
    }),
  ) {}

  // Adds data to IPFS, pins it, and returns the CIDv1 string.
  async upload(data: Buffer, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('file', data, {
      filename: fileName,
      contentType: 'application/octet-stream',
      knownLength: data.length,
    });

    const response = await this.client
      .post<AddResponse>('/api/v0/add', form, {
        headers: form.getHeaders(),
        // pin=true keeps the content alive; cid-version=1 uses the modern base32 CID format.
        params: { pin: true, 'cid-version': 1 },
      })
      .catch(wrapJsonError(`upload(${fileName})`));

    const cid = response.data.Hash;
    logger.debug('IPFS upload complete', { fileName, cid, size: response.data.Size });
    return cid;
  }

  // Fetches raw content by CID and returns it as a Buffer.
  async download(cid: string): Promise<Buffer> {
    try {
      const response = await this.client.post('/api/v0/cat', null, {
        params: { arg: cid },
        // Kubo streams the raw bytes; arraybuffer collects the whole response.
        responseType: 'arraybuffer',
      });
      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.data != null) {
        // Kubo sends a JSON error body even when arraybuffer was requested; decode manually.
        const raw = Buffer.from(err.response.data as ArrayBuffer).toString('utf-8');
        throw new Error(`IPFS download(${cid}) failed: ${kuboMessage(raw)}`);
      }
      throw err;
    }
  }

  // Explicitly pins content so it is not removed by garbage collection.
  async pin(cid: string): Promise<void> {
    await this.client
      .post<{ Pins: string[] }>('/api/v0/pin/add', null, { params: { arg: cid } })
      .catch(wrapJsonError(`pin(${cid})`));
    logger.debug('IPFS pinned', { cid });
  }

  // Removes a pin; the content may be GC'd on the next run.
  async unpin(cid: string): Promise<void> {
    await this.client
      .post<{ Pins: string[] }>('/api/v0/pin/rm', null, { params: { arg: cid } })
      .catch(wrapJsonError(`unpin(${cid})`));
    logger.debug('IPFS unpinned', { cid });
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

// Returns a catch handler that converts Axios errors into IpfsService errors.
// Only use this where the response body is JSON (upload, pin, unpin).
// For arraybuffer responses (download) use the inline try-catch instead.
function wrapJsonError(operation: string) {
  return (err: unknown): never => {
    if (axios.isAxiosError(err)) {
      const body = err.response?.data as KuboError | undefined;
      const msg = body?.Message ?? err.message;
      throw new Error(`IPFS ${operation} failed: ${msg}`);
    }
    throw err;
  };
}

// Attempts to extract the Message field from a Kubo JSON error string.
function kuboMessage(raw: string): string {
  try {
    return (JSON.parse(raw) as KuboError).Message;
  } catch {
    return raw;
  }
}
