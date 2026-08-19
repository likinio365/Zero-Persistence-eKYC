import axios, { AxiosError, AxiosInstance } from 'axios';
import { IpfsService } from './ipfs.service';

// ── module mocks ──────────────────────────────────────────────────────────────

jest.mock('../config', () => ({
  config: { ipfs: { apiUrl: 'http://localhost:5001' } },
}));

jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── test helpers ──────────────────────────────────────────────────────────────

type MockClient = { post: jest.Mock };

function makeClient(): MockClient {
  return { post: jest.fn() };
}

function makeService(client: MockClient): IpfsService {
  return new IpfsService(client as unknown as AxiosInstance);
}

// Build an AxiosError with a JSON response body (upload / pin / unpin errors)
function kuboJsonError(message: string, status = 500): AxiosError {
  const err = new axios.AxiosError(message);
  err.isAxiosError = true;
  err.response = {
    data: { Message: message, Code: 0, Type: 'error' },
    status,
    statusText: 'Internal Server Error',
    headers: {},
    config: {} as never,
  };
  return err;
}

// Build an AxiosError with an ArrayBuffer body (download errors)
function kuboArrayBufferError(message: string, status = 500): AxiosError {
  const body = Buffer.from(JSON.stringify({ Message: message, Code: 0, Type: 'error' }));
  const err = new axios.AxiosError(message);
  err.isAxiosError = true;
  err.response = {
    data: body,        // Buffer is also an ArrayBuffer-like; Buffer.from(buf) works
    status,
    statusText: 'Internal Server Error',
    headers: {},
    config: {} as never,
  };
  return err;
}

// Build a network-level AxiosError (no response)
function networkError(message = 'Network Error'): AxiosError {
  const err = new axios.AxiosError(message);
  err.isAxiosError = true;
  return err;
}

// ── upload ────────────────────────────────────────────────────────────────────

describe('IpfsService.upload', () => {
  it('returns the CID from the Kubo /add response', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({
      data: { Hash: 'bafybeiabc123', Name: 'doc.bin', Size: '16' },
    });

    const cid = await makeService(client).upload(Buffer.from('hello IPFS'), 'doc.bin');

    expect(cid).toBe('bafybeiabc123');
  });

  it('POSTs to /api/v0/add', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Hash: 'bafyXXX', Name: 'f', Size: '1' } });

    await makeService(client).upload(Buffer.from('x'), 'f');

    expect(client.post).toHaveBeenCalledWith(
      '/api/v0/add',
      expect.anything(),             // FormData body
      expect.objectContaining({
        params: expect.objectContaining({ pin: true, 'cid-version': 1 }),
      }),
    );
  });

  it('includes Content-Type multipart header from FormData', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Hash: 'bafyXXX', Name: 'f', Size: '1' } });

    await makeService(client).upload(Buffer.from('data'), 'file.bin');

    const [, , callConfig] = client.post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(callConfig.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('throws a descriptive error on Kubo error response', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('context deadline exceeded'));

    await expect(makeService(client).upload(Buffer.from('x'), 'f.bin'))
      .rejects.toThrow('context deadline exceeded');
  });

  it('re-throws non-Axios errors unchanged', async () => {
    const client = makeClient();
    const boom = new Error('disk full');
    client.post.mockRejectedValueOnce(boom);

    await expect(makeService(client).upload(Buffer.from('x'), 'f.bin'))
      .rejects.toThrow('disk full');
  });

  it('uses the Kubo Message field, not the HTTP message, in the error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('file too large'));

    await expect(makeService(client).upload(Buffer.from('x'), 'f.bin'))
      .rejects.toThrow('file too large');
  });
});

// ── download ──────────────────────────────────────────────────────────────────

describe('IpfsService.download', () => {
  it('returns a Buffer containing the response bytes', async () => {
    const client = makeClient();
    const content = Buffer.from('secret encrypted bytes');
    client.post.mockResolvedValueOnce({ data: content });

    const result = await makeService(client).download('bafybeiabc123');

    expect(result).toEqual(content);
  });

  it('POSTs to /api/v0/cat with the CID as the arg param', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: Buffer.alloc(0) });

    await makeService(client).download('bafyXXX');

    expect(client.post).toHaveBeenCalledWith(
      '/api/v0/cat',
      null,
      expect.objectContaining({
        params: { arg: 'bafyXXX' },
        responseType: 'arraybuffer',
      }),
    );
  });

  it('decodes the Kubo error Message from the arraybuffer body', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboArrayBufferError('no link named "x"'));

    await expect(makeService(client).download('bafyXXX'))
      .rejects.toThrow('no link named "x"');
  });

  it('includes the CID in the error message', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboArrayBufferError('not found'));

    await expect(makeService(client).download('bafyMissing'))
      .rejects.toThrow('download(bafyMissing)');
  });

  it('re-throws network errors without wrapping', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(networkError('ECONNREFUSED'));

    await expect(makeService(client).download('bafyXXX'))
      .rejects.toThrow('ECONNREFUSED');
  });

  it('handles non-JSON arraybuffer error body gracefully', async () => {
    const client = makeClient();
    const err = new axios.AxiosError('bad gateway');
    err.isAxiosError = true;
    err.response = {
      data: Buffer.from('Bad Gateway'),
      status: 502,
      statusText: 'Bad Gateway',
      headers: {},
      config: {} as never,
    };
    client.post.mockRejectedValueOnce(err);

    await expect(makeService(client).download('bafyXXX'))
      .rejects.toThrow('Bad Gateway');
  });
});

// ── pin ───────────────────────────────────────────────────────────────────────

describe('IpfsService.pin', () => {
  it('resolves without a return value on success', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Pins: ['bafyXXX'] } });

    await expect(makeService(client).pin('bafyXXX')).resolves.toBeUndefined();
  });

  it('POSTs to /api/v0/pin/add with the CID', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Pins: ['bafyXXX'] } });

    await makeService(client).pin('bafyXXX');

    expect(client.post).toHaveBeenCalledWith(
      '/api/v0/pin/add',
      null,
      expect.objectContaining({ params: { arg: 'bafyXXX' } }),
    );
  });

  it('throws on Kubo error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('already pinned'));

    await expect(makeService(client).pin('bafyXXX'))
      .rejects.toThrow('already pinned');
  });

  it('includes operation name in error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('some error'));

    await expect(makeService(client).pin('bafyXXX'))
      .rejects.toThrow('pin(bafyXXX)');
  });
});

// ── unpin ─────────────────────────────────────────────────────────────────────

describe('IpfsService.unpin', () => {
  it('resolves without a return value on success', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Pins: ['bafyXXX'] } });

    await expect(makeService(client).unpin('bafyXXX')).resolves.toBeUndefined();
  });

  it('POSTs to /api/v0/pin/rm with the CID', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: { Pins: ['bafyXXX'] } });

    await makeService(client).unpin('bafyXXX');

    expect(client.post).toHaveBeenCalledWith(
      '/api/v0/pin/rm',
      null,
      expect.objectContaining({ params: { arg: 'bafyXXX' } }),
    );
  });

  it('throws on Kubo error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('not pinned'));

    await expect(makeService(client).unpin('bafyXXX'))
      .rejects.toThrow('not pinned');
  });

  it('includes operation name in error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(kuboJsonError('some error'));

    await expect(makeService(client).unpin('bafyXXX'))
      .rejects.toThrow('unpin(bafyXXX)');
  });
});

// ── constructor ───────────────────────────────────────────────────────────────

describe('IpfsService constructor', () => {
  it('creates an instance without throwing', () => {
    expect(() => new IpfsService()).not.toThrow();
  });
});
