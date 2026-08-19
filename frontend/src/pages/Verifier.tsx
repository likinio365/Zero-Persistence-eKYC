import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/api';
import type { KYCRecord } from '../types/kyc';

function mimeFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg'; // safe fallback for unknown image types
}

type Tab = 'PENDING' | 'VERIFIED' | 'REJECTED';
type ActionModal =
  | { type: 'approve'; id: string; did: string }
  | { type: 'reject';  id: string; did: string }
  | { type: 'revoke';  id: string; did: string };

interface DocEntry { type: string; fileName: string; contentBase64: string; }
type DocsModal = { id: string; docs: DocEntry[] | null; loading: boolean; error: string | null };

export default function Verifier() {
  const [tab, setTab] = useState<Tab>('PENDING');
  const [records, setRecords] = useState<KYCRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ActionModal | null>(null);
  const [credDefId, setCredDefId] = useState('');
  const [credExId, setCredExId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [docsModal, setDocsModal] = useState<DocsModal | null>(null);

  const load = useCallback(async (status: Tab) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.listKYCByStatus(status);
      setRecords(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load records');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setActionSuccess(null);
    setError(null);
  };

  const openModal = (m: ActionModal) => {
    setModal(m);
    setActionError(null);
    setCredDefId('');
    setCredExId('');
    setRejectReason('');
  };

  const handleAction = async () => {
    if (!modal) return;
    setActing(true);
    setActionError(null);
    try {
      if (modal.type === 'approve') {
        const defaultCredDefId = process.env.REACT_APP_CRED_DEF_ID ?? '';
        await apiClient.verifyKYC(modal.id, credDefId || defaultCredDefId, {
          kyc_id: modal.id,
          verification_date: new Date().toISOString().split('T')[0],
        });
        setActionSuccess(`Record ${modal.id.slice(0, 8)}… approved.`);
      } else if (modal.type === 'reject') {
        await apiClient.rejectKYC(modal.id, rejectReason);
        setActionSuccess(`Record ${modal.id.slice(0, 8)}… rejected.`);
      } else {
        await apiClient.revokeKYC(modal.id, credExId || undefined);
        setActionSuccess(`Record ${modal.id.slice(0, 8)}… revoked.`);
      }
      setModal(null);
      await load(tab);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActing(false);
    }
  };

  const isApprove = modal?.type === 'approve';
  const isReject  = modal?.type === 'reject';

  const openDocs = async (id: string) => {
    const requestId = id;
    setDocsModal({ id, docs: null, loading: true, error: null });
    try {
      const docs = await apiClient.getKYCDocuments(id);
      setDocsModal(prev => prev?.id === requestId ? { id, docs, loading: false, error: null } : prev);
    } catch (err) {
      setDocsModal(prev => prev?.id === requestId
        ? { id, docs: null, loading: false, error: err instanceof Error ? err.message : 'Failed to load documents' }
        : prev);
    }
  };

  return (
    <div className="verifier-page">
      <div className="verifier-header">
        <h2>Verifier Dashboard</h2>
        <button className="btn btn-outline" onClick={() => load(tab)} disabled={isLoading}>
          {isLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {(['PENDING', 'VERIFIED', 'REJECTED'] as Tab[]).map(t => (
          <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => switchTab(t)}>
            {t === 'PENDING' ? 'Pending Review' : t === 'VERIFIED' ? 'Verified' : 'Rejected'}
          </button>
        ))}
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {actionSuccess && <p className="alert alert-success" role="status">{actionSuccess}</p>}

      {!isLoading && records.length === 0 && !error && (
        <p className="empty-state">No {tab.toLowerCase()} applications.</p>
      )}

      {records.length > 0 && (
        <table className="kyc-table">
          <thead>
            <tr>
              <th>Application ID</th>
              <th>DID</th>
              <th>Submitted</th>
              <th>IPFS CID</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {records.map(rec => (
              <tr key={rec.id}>
                <td className="monospace">{rec.id}</td>
                <td className="monospace">{rec.did}</td>
                <td>{new Date(rec.createdAt).toLocaleString()}</td>
                <td className="monospace truncate">{rec.ipfsHash}</td>
                <td>
                  {tab === 'PENDING' ? (
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button className="btn btn-outline btn-sm"
                        onClick={() => openDocs(rec.id)}>
                        View Docs
                      </button>
                      <button className="btn btn-primary btn-sm"
                        onClick={() => openModal({ type: 'approve', id: rec.id, did: rec.did })}>
                        Approve
                      </button>
                      <button className="btn btn-danger btn-sm"
                        onClick={() => openModal({ type: 'reject', id: rec.id, did: rec.did })}>
                        Reject
                      </button>
                    </div>
                  ) : tab === 'VERIFIED' ? (
                    <button className="btn btn-danger btn-sm"
                      onClick={() => openModal({ type: 'revoke', id: rec.id, did: rec.did })}>
                      Revoke
                    </button>
                  ) : (
                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Terminal</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Action modal */}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{isApprove ? 'Approve KYC' : isReject ? 'Reject KYC' : 'Revoke KYC'}</h3>
            <p><strong>ID:</strong> {modal.id}</p>
            <p><strong>DID:</strong> {modal.did}</p>

            {isApprove ? (
              <div className="field">
                <label htmlFor="cred-def-id">
                  Credential Definition ID <span className="hint">(optional)</span>
                </label>
                <input
                  id="cred-def-id"
                  type="text"
                  value={credDefId}
                  onChange={e => setCredDefId(e.target.value)}
                  placeholder="Rdo8fFM4jjjubFVkfdFH2L:3:CL:3193353:default"
                  disabled={acting}
                />
                <small>Leave empty to transition ledger state only.</small>
              </div>
            ) : isReject ? (
              <div className="field">
                <label htmlFor="reject-reason">
                  Rejection Reason <span className="hint">(optional)</span>
                </label>
                <input
                  id="reject-reason"
                  type="text"
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  placeholder="e.g. Documents unclear, Passport expired"
                  disabled={acting}
                />
                <small>Stored on-chain alongside the REJECTED status.</small>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="cred-ex-id">
                  Credential Exchange ID <span className="hint">(optional)</span>
                </label>
                <input
                  id="cred-ex-id"
                  type="text"
                  value={credExId}
                  onChange={e => setCredExId(e.target.value)}
                  placeholder="e.g. ex-abc123"
                  disabled={acting}
                />
                <small>Required only if you want to also revoke the issued VC on the Indy ledger.</small>
              </div>
            )}

            {actionError && <p className="form-error" role="alert">{actionError}</p>}

            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setModal(null)} disabled={acting}>
                Cancel
              </button>
              <button
                className={`btn ${isApprove ? 'btn-primary' : 'btn-danger'}`}

                onClick={handleAction}
                disabled={acting}
              >
                {acting
                  ? <><span className="spinner" aria-hidden="true" /> {isApprove ? 'Approving…' : isReject ? 'Rejecting…' : 'Revoking…'}</>
                  : isApprove ? 'Confirm Approve' : isReject ? 'Confirm Reject' : 'Confirm Revoke'
                }
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Document viewer modal */}
      {docsModal && (
        <div className="modal-overlay" onClick={() => setDocsModal(null)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <h3>Submitted Documents</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>KYC ID: {docsModal.id}</p>

            {docsModal.loading && <p>Loading documents…</p>}
            {docsModal.error && <p className="form-error">{docsModal.error}</p>}

            {docsModal.docs && (
              <div className="doc-grid">
                {docsModal.docs.map(doc => {
                  const isPdf = doc.fileName.toLowerCase().endsWith('.pdf');
                  const mime = isPdf ? 'application/pdf' : mimeFromFileName(doc.fileName);
                  const src = `data:${mime};base64,${doc.contentBase64}`;
                  return (
                    <div key={doc.type} className="doc-item">
                      <p className="doc-label">{doc.type.replaceAll('_', ' ').toUpperCase()} — {doc.fileName}</p>
                      {isPdf ? (
                        <a href={src} download={doc.fileName} className="btn btn-outline btn-sm">
                          Download PDF
                        </a>
                      ) : (
                        <img
                          src={src}
                          alt={doc.type}
                          className="doc-preview"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setDocsModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
