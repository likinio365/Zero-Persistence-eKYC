import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../config/logger';

// ── public types ──────────────────────────────────────────────────────────────

export interface DIDDocument {
  id: string;
  verificationMethod: unknown[];
  authentication: string[];
  [key: string]: unknown;
}

export interface VerifiableCredential {
  credentialId: string;
  credentialExchangeId: string;
  state: string;
  did: string;
}

// ── ACA-Py raw response shapes ────────────────────────────────────────────────

interface AcapyDIDCreateResponse {
  result: {
    did: string;
    verkey: string;
    posture: string;
    key_type: string;
    method: string;
  };
}

interface AcapyResolveResponse {
  did_document: DIDDocument;
  metadata: Record<string, unknown>;
}

interface AcapyConnection {
  connection_id: string;
  state: string;
  their_did?: string;
  their_label?: string;
}

interface AcapyConnectionList {
  results: AcapyConnection[];
}

interface AcapyCredExRecord {
  cred_ex_id: string;
  connection_id: string;
  state: string;
  thread_id?: string;
  indy?: {
    cred_rev_id?: string;
    rev_reg_id?: string;
  };
}

interface AcapyCredExList {
  results: AcapyCredExRecord[];
}

interface AcapyOOBInvitation {
  oob_id: string;
  invitation: Record<string, unknown>;
  invitation_url: string;
}

export interface ConnectionStatus {
  connected: boolean;
  state: string | null;
  connectionId: string | null;
}

// ── service ───────────────────────────────────────────────────────────────────

export class IndyService {
  // Injectable so tests can pass a mock without monkey-patching axios.
  constructor(
    private readonly client: AxiosInstance = axios.create({
      baseURL: config.acapy.adminUrl,
      timeout: 30_000,
      headers: config.acapy.apiKey ? { 'X-API-Key': config.acapy.apiKey } : {},
    }),
  ) {}

  // Creates a new local DID in the ACA-Py wallet (not yet published to ledger).
  async createDID(): Promise<{ did: string; verkey: string }> {
    const response = await this.client
      .post<AcapyDIDCreateResponse>('/wallet/did/create', {
        method: 'sov',
        options: { key_type: 'ed25519' },
      })
      .catch(wrapError('createDID'));

    if (!response.data.result) {
      throw new Error('ACA-Py createDID returned null result — wallet may not be initialized');
    }
    const { did, verkey } = response.data.result;
    logger.info('Created DID', { did });
    return { did, verkey };
  }

  // Publishes a DID to the Indy ledger via a NYM transaction signed by the agent's public DID.
  // Role is left empty (USER) — enough for holders. Requires the agent to have a public DID.
  async publishDID(did: string, verkey: string): Promise<void> {
    await this.client
      .post('/ledger/register-nym', null, {
        params: { did, verkey, role: '' },
      })
      .catch(wrapError(`publishDID(${did})`));

    logger.info('DID published to ledger', { did });
  }

  // Resolves a DID to its DID Document using the ACA-Py universal resolver.
  async resolveDID(did: string): Promise<DIDDocument> {
    // Colons in the DID must be percent-encoded when embedded in a URL path.
    const encoded = encodeURIComponent(did);
    const response = await this.client
      .get<AcapyResolveResponse>(`/resolver/resolve/${encoded}`)
      .catch(wrapError(`resolveDID(${did})`));

    return response.data.did_document;
  }

  // Issues an Indy Verifiable Credential to the holder over an existing DIDComm connection.
  // Throws if no active connection exists for holderDID — establish one via the OOB/invitation
  // flow before calling this.
  async issueCredential(
    holderDID: string,
    credDefId: string,
    attributes: Record<string, string>,
  ): Promise<VerifiableCredential> {
    const connection = await this.findConnectionByDID(holderDID);
    if (!connection) {
      throw new Error(
        `No active DIDComm connection found for DID ${holderDID}. ` +
          'Establish a connection via the invitation flow before issuing.',
      );
    }

    const response = await this.client
      .post<AcapyCredExRecord>('/issue-credential-2.0/send', {
        connection_id: connection.connection_id,
        filter: { indy: { cred_def_id: credDefId } },
        credential_preview: buildCredentialPreview(attributes),
        auto_remove: false,
        trace: false,
      })
      .catch(wrapError(`issueCredential(${holderDID})`));

    const rec = response.data;
    logger.info('Credential issued', { credExId: rec.cred_ex_id, holderDID, credDefId });
    return {
      credentialId: rec.cred_ex_id,
      credentialExchangeId: rec.cred_ex_id,
      state: rec.state,
      did: holderDID,
    };
  }

  // Revokes a previously issued credential and immediately publishes to the ledger.
  // Looks up cred_rev_id + rev_reg_id from the exchange record so revocation works
  // even if ACA-Py auto-removed the record (in that case we fall back to cred_ex_id).
  // Returns the rev_reg_id that was touched (when known) so the caller can force an
  // explicit accumulator publish — see publishRevocationEntry().
  async revokeCredential(credentialExchangeId: string): Promise<string | undefined> {
    let revRegId: string | undefined;
    let revPayload: Record<string, unknown> = { cred_ex_id: credentialExchangeId, publish: true };

    try {
      const rec = await this.client.get<{
        indy?: { cred_rev_id?: string; rev_reg_id?: string };
      }>(`/issue-credential-2.0/records/${credentialExchangeId}`);
      const { cred_rev_id, rev_reg_id } = rec.data.indy ?? {};
      if (cred_rev_id && rev_reg_id) {
        revRegId = rev_reg_id;
        revPayload = { cred_rev_id, rev_reg_id, publish: true };
        logger.info('Revoking by cred_rev_id', { credentialExchangeId, cred_rev_id, rev_reg_id });
      }
    } catch {
      logger.warn('Exchange record not found — falling back to cred_ex_id', { credentialExchangeId });
    }

    await this.client
      .post('/revocation/revoke', revPayload)
      .catch(wrapError(`revokeCredential(${credentialExchangeId})`));

    logger.info('Credential revoked', { credentialExchangeId });
    return revRegId;
  }

  // Forces the revocation registry accumulator delta onto the Indy ledger.
  // ACA-Py's `publish: true` on /revocation/revoke is unreliable on BCovrin — the
  // ledger write can throw internally and be swallowed, leaving the accumulator
  // stale so verifiers still see the credential as valid. An explicit registry
  // entry publish is the belt-and-braces follow-up.
  async publishRevocationEntry(revRegId: string): Promise<void> {
    await this.client
      .post(`/revocation/registry/${revRegId}/entry`, {})
      .catch(wrapError(`publishRevocationEntry(${revRegId})`));

    logger.info('Revocation registry entry published to ledger', { revRegId });
  }

  // Revokes a credential and then forces its accumulator delta onto the ledger.
  // The entry publish is best-effort: revocation itself has already been requested,
  // so a publish failure is logged but not propagated.
  async revokeCredentialAndPublish(credentialExchangeId: string): Promise<void> {
    const revRegId = await this.revokeCredential(credentialExchangeId);
    if (!revRegId) return;
    try {
      await this.publishRevocationEntry(revRegId);
    } catch (err) {
      logger.warn('Accumulator entry publish after revoke failed (non-fatal)', {
        credentialExchangeId,
        revRegId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Best-effort: revoke every credential ACA-Py has issued to `did` over its
  // DIDComm connection. Used by GDPR erasure as a fallback when the on-chain
  // credentialExchangeId was never persisted (the wallet-issuance flow). Returns
  // the number of credentials revoked; a silent 0 means nothing matched.
  async revokeCredentialsForDID(did: string): Promise<number> {
    let connection: AcapyConnection | null = null;
    try {
      connection = await this.findConnectionByDID(did);
    } catch (err) {
      logger.warn('revokeCredentialsForDID: connection lookup failed', {
        did, err: err instanceof Error ? err.message : String(err),
      });
    }
    if (!connection) {
      logger.warn('revokeCredentialsForDID: no active connection for DID — nothing revoked', { did });
      return 0;
    }

    let records: AcapyCredExRecord[] = [];
    try {
      const resp = await this.client.get<AcapyCredExList>('/issue-credential-2.0/records', {
        params: { connection_id: connection.connection_id },
      });
      records = resp.data.results ?? [];
    } catch (err) {
      logger.warn('revokeCredentialsForDID: records lookup failed', {
        did, err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let revoked = 0;
    for (const rec of records) {
      if (!rec.cred_ex_id) continue;
      try {
        await this.revokeCredentialAndPublish(rec.cred_ex_id);
        revoked += 1;
      } catch (err) {
        logger.warn('revokeCredentialsForDID: one revoke failed', {
          did, credExId: rec.cred_ex_id, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('revokeCredentialsForDID complete', { did, revoked });
    return revoked;
  }

  // Returns all credential exchange records issued to the given DID.
  async getCredentials(did: string): Promise<VerifiableCredential[]> {
    const connection = await this.findConnectionByDID(did);
    if (!connection) {
      return [];
    }

    const response = await this.client
      .get<AcapyCredExList>('/issue-credential-2.0/records', {
        params: { connection_id: connection.connection_id },
      })
      .catch(wrapError(`getCredentials(${did})`));

    return response.data.results.map((rec) => ({
      credentialId: rec.cred_ex_id,
      credentialExchangeId: rec.cred_ex_id,
      state: rec.state,
      did,
    }));
  }

  // Creates an OOB invitation the holder can scan with their wallet app.
  // Returns invitationMsgId = invitation['@id'], which is what ACA-Py stores as
  // invitation_msg_id on the resulting connection record (NOT the same as oob_id).
  async createInvitation(alias?: string): Promise<{ invitationUrl: string; oobId: string; invitationMsgId: string }> {
    const response = await this.client
      .post<AcapyOOBInvitation>('/out-of-band/create-invitation', {
        handshake_protocols: ['https://didcomm.org/didexchange/1.0'],
        use_public_did: false,
        my_label: 'KYC Verifier',
        ...(alias && { alias }),
      })
      .catch(wrapError('createInvitation'));

    const { invitation_url, oob_id, invitation } = response.data;
    const invitationMsgId = (invitation as Record<string, unknown>)['@id'] as string ?? oob_id;
    logger.info('OOB invitation created', { oobId: oob_id, invitationMsgId, alias });
    return { invitationUrl: invitation_url, oobId: oob_id, invitationMsgId };
  }

  // Returns whether a completed DIDComm connection exists for the given DID.
  async getConnectionStatus(did: string): Promise<ConnectionStatus> {
    const connection = await this.findConnectionByDID(did);
    const connected = connection?.state === 'completed' || connection?.state === 'active';
    return {
      connected,
      state: connection?.state ?? null,
      connectionId: connection?.connection_id ?? null,
    };
  }

  // Looks up an active DIDComm connection by OOB invitation ID.
  async findConnectionByOobId(oobId: string): Promise<AcapyConnection | null> {
    const response = await this.client
      .get<AcapyConnectionList>('/connections', {
        params: { invitation_msg_id: oobId },
      })
      .catch(wrapError(`findConnectionByOobId(${oobId})`));

    return response.data.results.find(
      c => c.state === 'completed' || c.state === 'active' || c.state === 'response',
    ) ?? null;
  }

  // Issues a credential directly to a known connectionId (no DID lookup required).
  async issueCredentialToConnection(
    connectionId: string,
    credDefId: string,
    attributes: Record<string, string>,
  ): Promise<VerifiableCredential> {
    const response = await this.client
      .post<AcapyCredExRecord>('/issue-credential-2.0/send', {
        connection_id: connectionId,
        filter: { indy: { cred_def_id: credDefId } },
        credential_preview: buildCredentialPreview(attributes),
        auto_remove: false,
        trace: false,
      })
      .catch(wrapError(`issueCredentialToConnection(${connectionId})`));

    const rec = response.data;
    logger.info('Credential issued to connection', { credExId: rec.cred_ex_id, connectionId, credDefId });
    return { credentialId: rec.cred_ex_id, credentialExchangeId: rec.cred_ex_id, state: rec.state, did: '' };
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  // Returns the first usable DIDComm connection for `did` (completed or active), or null.
  private async findConnectionByDID(did: string): Promise<AcapyConnection | null> {
    const response = await this.client
      .get<AcapyConnectionList>('/connections', {
        params: { their_did: did },
      })
      .catch(wrapError(`findConnectionByDID(${did})`));

    const connections = response.data.results.filter(
      c => c.state === 'completed' || c.state === 'active',
    );
    if (connections.length === 0) return null;
    if (connections.length > 1) {
      logger.warn('Multiple usable connections for DID; using first', {
        did,
        count: connections.length,
      });
    }
    return connections[0];
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

// Builds the indy credential-preview body expected by /issue-credential-2.0/send.
export function buildCredentialPreview(attributes: Record<string, string>): object {
  return {
    '@type': 'issue-credential/2.0/credential-preview',
    attributes: Object.entries(attributes).map(([name, value]) => ({
      name,
      value,
      mime_type: 'text/plain',
    })),
  };
}

// Returns a .catch() handler that enriches ACA-Py errors with operation context.
function wrapError(operation: string) {
  return (err: unknown): never => {
    if (axios.isAxiosError(err)) {
      const msg = extractAcapyMessage(err.response?.data) ?? err.message;
      throw new Error(`ACA-Py ${operation} failed: ${msg}`);
    }
    throw err;
  };
}

// Extracts the human-readable message from ACA-Py's varied error body shapes.
// ACA-Py uses "detail" (string or validation-error array) or "message".
export function extractAcapyMessage(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = (data as Record<string, unknown>).detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d.length > 0) {
    const first = d[0] as { msg?: string };
    return first.msg ?? JSON.stringify(d);
  }
  const m = (data as Record<string, unknown>).message;
  if (typeof m === 'string') return m;
  return undefined;
}
