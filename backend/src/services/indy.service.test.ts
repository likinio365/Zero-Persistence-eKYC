import axios, { AxiosError, AxiosInstance } from 'axios';
import {
  IndyService,
  buildCredentialPreview,
  extractAcapyMessage,
} from './indy.service';

// ── module mocks ──────────────────────────────────────────────────────────────

jest.mock('../config', () => ({
  config: {
    acapy: { adminUrl: 'http://localhost:8031', apiKey: '' },
  },
}));

jest.mock('../config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── test helpers ──────────────────────────────────────────────────────────────

type MockClient = { get: jest.Mock; post: jest.Mock };

function makeClient(): MockClient {
  return { get: jest.fn(), post: jest.fn() };
}

function makeService(client: MockClient): IndyService {
  return new IndyService(client as unknown as AxiosInstance);
}

function acapyError(detail: string, status = 400): AxiosError {
  const err = new axios.AxiosError(detail);
  err.isAxiosError = true;
  err.response = {
    data: { detail },
    status,
    statusText: 'Bad Request',
    headers: {},
    config: {} as never,
  };
  return err;
}

function networkError(msg = 'ECONNREFUSED'): AxiosError {
  const err = new axios.AxiosError(msg);
  err.isAxiosError = true;
  return err;
}

// Canned response fixtures
const FAKE_CONNECTION = {
  connection_id: 'conn-abc',
  state: 'active',
  their_did: 'did:indy:test:Alice',
};

const FAKE_CRED_EX = {
  cred_ex_id: 'ex-123',
  connection_id: 'conn-abc',
  state: 'offer-sent',
};

// ── createDID ─────────────────────────────────────────────────────────────────

describe('IndyService.createDID', () => {
  it('returns did and verkey from the nested result field', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({
      data: {
        result: { did: 'did:sov:Wg123', verkey: '~key456', posture: 'wallet_only', key_type: 'ed25519', method: 'sov' },
      },
    });

    const result = await makeService(client).createDID();

    expect(result).toEqual({ did: 'did:sov:Wg123', verkey: '~key456' });
  });

  it('POSTs to /wallet/did/create with sov method and ed25519 key type', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({
      data: { result: { did: 'did:sov:X', verkey: 'vk', posture: 'wallet_only', key_type: 'ed25519', method: 'sov' } },
    });

    await makeService(client).createDID();

    expect(client.post).toHaveBeenCalledWith(
      '/wallet/did/create',
      expect.objectContaining({
        method: 'sov',
        options: { key_type: 'ed25519' },
      }),
    );
  });

  it('throws with operation name on ACA-Py error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('wallet not found'));

    await expect(makeService(client).createDID())
      .rejects.toThrow('createDID');
  });

  it('includes the ACA-Py detail message in the error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('wallet not found'));

    await expect(makeService(client).createDID())
      .rejects.toThrow('wallet not found');
  });

  it('re-throws non-Axios errors unchanged', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(new Error('unexpected'));

    await expect(makeService(client).createDID())
      .rejects.toThrow('unexpected');
  });
});

// ── resolveDID ────────────────────────────────────────────────────────────────

describe('IndyService.resolveDID', () => {
  const DID_DOC = {
    id: 'did:indy:test:Alice',
    verificationMethod: [],
    authentication: [],
  };

  it('returns the did_document from the response', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { did_document: DID_DOC, metadata: {} } });

    const doc = await makeService(client).resolveDID('did:indy:test:Alice');

    expect(doc).toEqual(DID_DOC);
  });

  it('percent-encodes colons in the DID path segment', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { did_document: DID_DOC, metadata: {} } });

    await makeService(client).resolveDID('did:indy:test:Alice');

    const [urlPath] = client.get.mock.calls[0] as [string];
    // Colons become %3A so the path is unambiguous
    expect(urlPath).toBe('/resolver/resolve/did%3Aindy%3Atest%3AAlice');
  });

  it('throws on resolution failure', async () => {
    const client = makeClient();
    client.get.mockRejectedValueOnce(acapyError('DID not found on ledger', 404));

    await expect(makeService(client).resolveDID('did:indy:test:Ghost'))
      .rejects.toThrow('DID not found on ledger');
  });
});

// ── issueCredential ───────────────────────────────────────────────────────────

describe('IndyService.issueCredential', () => {
  const ATTRS = { full_name: 'Alice Smith', date_of_birth: '1990-01-01' };

  it('returns a VerifiableCredential with the exchange ID and state', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } }); // findConnectionByDID
    client.post.mockResolvedValueOnce({ data: FAKE_CRED_EX });                   // send

    const vc = await makeService(client).issueCredential('did:indy:test:Alice', 'cred-def-1', ATTRS);

    expect(vc).toEqual({
      credentialId: 'ex-123',
      credentialExchangeId: 'ex-123',
      state: 'offer-sent',
      did: 'did:indy:test:Alice',
    });
  });

  it('first GETs /connections with their_did and state=active', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } });
    client.post.mockResolvedValueOnce({ data: FAKE_CRED_EX });

    await makeService(client).issueCredential('did:indy:test:Alice', 'cred-def-1', ATTRS);

    expect(client.get).toHaveBeenCalledWith(
      '/connections',
      expect.objectContaining({ params: { their_did: 'did:indy:test:Alice' } }),
    );
  });

  it('POSTs to /issue-credential-2.0/send with connection_id and cred_def_id', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } });
    client.post.mockResolvedValueOnce({ data: FAKE_CRED_EX });

    await makeService(client).issueCredential('did:indy:test:Alice', 'cred-def-99', ATTRS);

    expect(client.post).toHaveBeenCalledWith(
      '/issue-credential-2.0/send',
      expect.objectContaining({
        connection_id: 'conn-abc',
        filter: { indy: { cred_def_id: 'cred-def-99' } },
        auto_remove: false,
      }),
    );
  });

  it('includes a credential_preview with all attributes', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } });
    client.post.mockResolvedValueOnce({ data: FAKE_CRED_EX });

    await makeService(client).issueCredential('did:indy:test:Alice', 'cred-def-1', ATTRS);

    const [, body] = client.post.mock.calls[0] as [string, Record<string, unknown>];
    const preview = body.credential_preview as { '@type': string; attributes: { name: string; value: string; mime_type: string }[] };
    expect(preview['@type']).toBe('issue-credential/2.0/credential-preview');
    expect(preview.attributes).toContainEqual({ name: 'full_name', value: 'Alice Smith', mime_type: 'text/plain' });
    expect(preview.attributes).toContainEqual({ name: 'date_of_birth', value: '1990-01-01', mime_type: 'text/plain' });
  });

  it('throws when no active connection exists for the DID', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } });

    await expect(makeService(client).issueCredential('did:indy:test:Unknown', 'cred-def-1', ATTRS))
      .rejects.toThrow('No active DIDComm connection');
  });

  it('includes the missing DID in the no-connection error message', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } });

    await expect(makeService(client).issueCredential('did:indy:test:Unknown', 'cred-def-1', ATTRS))
      .rejects.toThrow('did:indy:test:Unknown');
  });

  it('throws on ACA-Py send error', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } });
    client.post.mockRejectedValueOnce(acapyError('cred def not found'));

    await expect(makeService(client).issueCredential('did:indy:test:Alice', 'bad-def', ATTRS))
      .rejects.toThrow('cred def not found');
  });
});

// ── revokeCredential ──────────────────────────────────────────────────────────

describe('IndyService.revokeCredential', () => {
  it('resolves to undefined on success', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: {} });

    await expect(makeService(client).revokeCredential('ex-123')).resolves.toBeUndefined();
  });

  it('POSTs to /revocation/revoke with cred_ex_id and publish=true', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: {} });

    await makeService(client).revokeCredential('ex-123');

    expect(client.post).toHaveBeenCalledWith(
      '/revocation/revoke',
      { cred_ex_id: 'ex-123', publish: true },
    );
  });

  it('throws with operation context on error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('credential not revocable'));

    await expect(makeService(client).revokeCredential('ex-123'))
      .rejects.toThrow('revokeCredential(ex-123)');
  });

  it('includes the ACA-Py detail in the error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('credential not revocable'));

    await expect(makeService(client).revokeCredential('ex-123'))
      .rejects.toThrow('credential not revocable');
  });
});

describe('IndyService.revokeCredential (rev_reg_id return)', () => {
  it('returns the rev_reg_id when the exchange record carries revocation metadata', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { indy: { cred_rev_id: '7', rev_reg_id: 'rr:1' } } });
    client.post.mockResolvedValueOnce({ data: {} });

    await expect(makeService(client).revokeCredential('ex-123')).resolves.toBe('rr:1');
  });

  it('POSTs /revocation/revoke by cred_rev_id + rev_reg_id when known', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { indy: { cred_rev_id: '7', rev_reg_id: 'rr:1' } } });
    client.post.mockResolvedValueOnce({ data: {} });

    await makeService(client).revokeCredential('ex-123');

    expect(client.post).toHaveBeenCalledWith(
      '/revocation/revoke',
      { cred_rev_id: '7', rev_reg_id: 'rr:1', publish: true },
    );
  });
});

// ── publishRevocationEntry ────────────────────────────────────────────────────

describe('IndyService.publishRevocationEntry', () => {
  it('POSTs to /revocation/registry/{id}/entry', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: {} });

    await makeService(client).publishRevocationEntry('rr:1');

    expect(client.post).toHaveBeenCalledWith('/revocation/registry/rr:1/entry', {});
  });

  it('throws with operation context on ACA-Py error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('ledger unavailable'));

    await expect(makeService(client).publishRevocationEntry('rr:1'))
      .rejects.toThrow('publishRevocationEntry(rr:1)');
  });
});

// ── revokeCredentialAndPublish ────────────────────────────────────────────────

describe('IndyService.revokeCredentialAndPublish', () => {
  it('revokes then publishes the accumulator entry', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { indy: { cred_rev_id: '7', rev_reg_id: 'rr:1' } } });
    client.post
      .mockResolvedValueOnce({ data: {} })  // /revocation/revoke
      .mockResolvedValueOnce({ data: {} }); // /revocation/registry/rr:1/entry

    await makeService(client).revokeCredentialAndPublish('ex-123');

    expect(client.post).toHaveBeenNthCalledWith(2, '/revocation/registry/rr:1/entry', {});
  });

  it('skips the entry publish when no rev_reg_id is known', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: {} }); // no indy block
    client.post.mockResolvedValueOnce({ data: {} });

    await makeService(client).revokeCredentialAndPublish('ex-123');

    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the entry publish fails', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { indy: { cred_rev_id: '7', rev_reg_id: 'rr:1' } } });
    client.post
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(acapyError('ledger unavailable'));

    await expect(makeService(client).revokeCredentialAndPublish('ex-123')).resolves.toBeUndefined();
  });
});

// ── revokeCredentialsForDID ───────────────────────────────────────────────────

describe('IndyService.revokeCredentialsForDID', () => {
  it('returns 0 and revokes nothing when no connection exists for the DID', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } }); // findConnectionByDID

    const n = await makeService(client).revokeCredentialsForDID('did:indy:test:Nobody');

    expect(n).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('revokes every credential exchange record on the DID connection', async () => {
    const client = makeClient();
    client.get
      .mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } })                 // findConnectionByDID
      .mockResolvedValueOnce({ data: { results: [{ cred_ex_id: 'ex-1' }, { cred_ex_id: 'ex-2' }] } }) // records list
      .mockResolvedValueOnce({ data: { indy: { cred_rev_id: '1', rev_reg_id: 'rr:1' } } })  // revoke ex-1 lookup
      .mockResolvedValueOnce({ data: { indy: { cred_rev_id: '2', rev_reg_id: 'rr:1' } } }); // revoke ex-2 lookup
    client.post.mockResolvedValue({ data: {} });

    const n = await makeService(client).revokeCredentialsForDID('did:indy:test:Alice');

    expect(n).toBe(2);
  });

  it('returns 0 when the records lookup fails', async () => {
    const client = makeClient();
    client.get
      .mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } })
      .mockRejectedValueOnce(acapyError('storage not configured'));

    const n = await makeService(client).revokeCredentialsForDID('did:indy:test:Alice');

    expect(n).toBe(0);
  });
});

// ── getCredentials ────────────────────────────────────────────────────────────

describe('IndyService.getCredentials', () => {
  it('returns empty array when no connection found for DID', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } });

    const result = await makeService(client).getCredentials('did:indy:test:Nobody');

    expect(result).toEqual([]);
  });

  it('does not call /issue-credential-2.0/records when no connection', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } });

    await makeService(client).getCredentials('did:indy:test:Nobody');

    // Only one GET call (findConnectionByDID); the records call is skipped
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('returns mapped VerifiableCredential objects for found records', async () => {
    const client = makeClient();
    client.get
      .mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } })  // findConnectionByDID
      .mockResolvedValueOnce({
        data: {
          results: [
            { cred_ex_id: 'ex-1', connection_id: 'conn-abc', state: 'credential-issued' },
            { cred_ex_id: 'ex-2', connection_id: 'conn-abc', state: 'done' },
          ],
        },
      });

    const vcs = await makeService(client).getCredentials('did:indy:test:Alice');

    expect(vcs).toHaveLength(2);
    expect(vcs[0]).toEqual({ credentialId: 'ex-1', credentialExchangeId: 'ex-1', state: 'credential-issued', did: 'did:indy:test:Alice' });
    expect(vcs[1]).toEqual({ credentialId: 'ex-2', credentialExchangeId: 'ex-2', state: 'done', did: 'did:indy:test:Alice' });
  });

  it('filters records by the connection_id from findConnectionByDID', async () => {
    const client = makeClient();
    client.get
      .mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } })
      .mockResolvedValueOnce({ data: { results: [] } });

    await makeService(client).getCredentials('did:indy:test:Alice');

    const [, callConfig] = client.get.mock.calls[1] as [string, { params: Record<string, string> }];
    expect(callConfig.params.connection_id).toBe('conn-abc');
  });

  it('throws on ACA-Py records error', async () => {
    const client = makeClient();
    client.get
      .mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } })
      .mockRejectedValueOnce(acapyError('storage not configured'));

    await expect(makeService(client).getCredentials('did:indy:test:Alice'))
      .rejects.toThrow('storage not configured');
  });
});

// ── createInvitation ──────────────────────────────────────────────────────────

describe('IndyService.createInvitation', () => {
  const FAKE_INVITATION = {
    oob_id: 'oob-123',
    invitation: { '@type': 'out-of-band/1.0/invitation' },
    invitation_url: 'https://example.com?oob=eyJ...',
  };

  it('returns invitationUrl and oobId', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: FAKE_INVITATION });

    const result = await makeService(client).createInvitation();

    expect(result).toEqual({ invitationUrl: 'https://example.com?oob=eyJ...', oobId: 'oob-123', invitationMsgId: 'oob-123' });
  });

  it('POSTs to /out-of-band/create-invitation with didexchange protocol', async () => {
    const client = makeClient();
    client.post.mockResolvedValueOnce({ data: FAKE_INVITATION });

    await makeService(client).createInvitation();

    expect(client.post).toHaveBeenCalledWith(
      '/out-of-band/create-invitation',
      expect.objectContaining({
        handshake_protocols: ['https://didcomm.org/didexchange/1.0'],
        use_public_did: false,
      }),
    );
  });

  it('throws with operation context on ACA-Py error', async () => {
    const client = makeClient();
    client.post.mockRejectedValueOnce(acapyError('wallet not ready'));

    await expect(makeService(client).createInvitation())
      .rejects.toThrow('createInvitation');
  });
});

// ── getConnectionStatus ───────────────────────────────────────────────────────

describe('IndyService.getConnectionStatus', () => {
  it('returns connected:true when an active connection exists', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [FAKE_CONNECTION] } });

    const status = await makeService(client).getConnectionStatus('did:indy:test:Alice');

    expect(status).toEqual({ connected: true, state: 'active', connectionId: 'conn-abc' });
  });

  it('returns connected:false when no connection exists', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({ data: { results: [] } });

    const status = await makeService(client).getConnectionStatus('did:indy:test:Nobody');

    expect(status).toEqual({ connected: false, state: null, connectionId: null });
  });

  it('returns connected:false for a non-active state', async () => {
    const client = makeClient();
    client.get.mockResolvedValueOnce({
      data: { results: [{ ...FAKE_CONNECTION, state: 'request-received' }] },
    });

    const status = await makeService(client).getConnectionStatus('did:indy:test:Alice');

    expect(status.connected).toBe(false);
    expect(status.state).toBe(null);
  });
});

// ── buildCredentialPreview ────────────────────────────────────────────────────

describe('buildCredentialPreview', () => {
  it('sets the correct @type', () => {
    const preview = buildCredentialPreview({ x: 'y' }) as Record<string, unknown>;
    expect(preview['@type']).toBe('issue-credential/2.0/credential-preview');
  });

  it('maps each key-value pair to a named attribute with mime_type text/plain', () => {
    const preview = buildCredentialPreview({ full_name: 'Alice', dob: '1990' }) as {
      attributes: { name: string; value: string; mime_type: string }[];
    };
    expect(preview.attributes).toContainEqual({ name: 'full_name', value: 'Alice', mime_type: 'text/plain' });
    expect(preview.attributes).toContainEqual({ name: 'dob', value: '1990', mime_type: 'text/plain' });
  });

  it('produces an empty attributes array for an empty input object', () => {
    const preview = buildCredentialPreview({}) as { attributes: unknown[] };
    expect(preview.attributes).toEqual([]);
  });
});

// ── extractAcapyMessage ───────────────────────────────────────────────────────

describe('extractAcapyMessage', () => {
  it('extracts a string detail field', () => {
    expect(extractAcapyMessage({ detail: 'record not found' })).toBe('record not found');
  });

  it('extracts msg from a validation-error array detail', () => {
    expect(extractAcapyMessage({ detail: [{ msg: 'field required', type: 'missing' }] }))
      .toBe('field required');
  });

  it('extracts a string message field when detail is absent', () => {
    expect(extractAcapyMessage({ message: 'internal error' })).toBe('internal error');
  });

  it('returns undefined for null', () => {
    expect(extractAcapyMessage(null)).toBeUndefined();
  });

  it('returns undefined for non-object', () => {
    expect(extractAcapyMessage('plain string')).toBeUndefined();
  });

  it('returns undefined when neither detail nor message exists', () => {
    expect(extractAcapyMessage({ code: 500 })).toBeUndefined();
  });
});

// ── constructor ───────────────────────────────────────────────────────────────

describe('IndyService constructor', () => {
  it('creates an instance without throwing', () => {
    expect(() => new IndyService()).not.toThrow();
  });
});
