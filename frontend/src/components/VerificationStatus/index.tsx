import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import type { HistoryEntry, KYCRecord, KYCStatus } from '../../types/kyc';
import { apiClient } from '../../services/api';

const STATUS_CONFIG: Record<KYCStatus, { label: string; className: string }> = {
  PENDING:  { label: 'Pending Review', className: 'status-pending'  },
  VERIFIED: { label: 'Verified',       className: 'status-verified' },
  REVOKED:  { label: 'Revoked',        className: 'status-revoked'  },
  REJECTED: { label: 'Rejected',       className: 'status-rejected' },
  DELETED:  { label: 'Erased',         className: 'status-revoked'  },
};

interface Props {
  record: KYCRecord;
}

export default function VerificationStatus({ record }: Props) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Download my data (GDPR Art. 15)
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Request erasure (GDPR Art. 17)
  const [eraseStep, setEraseStep] = useState<'idle' | 'confirm' | 'loading' | 'done' | 'error'>('idle');
  const [eraseError, setEraseError] = useState<string | null>(null);
  const [eraseWarning, setEraseWarning] = useState<string | null>(null);

  // Wallet credential flow
  const [walletStep, setWalletStep] = useState<'idle' | 'loading' | 'qr' | 'connected' | 'issued' | 'error'>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [oobId, setOobId] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { label, className } = STATUS_CONFIG[record.status] ?? { label: record.status, className: '' };

  const copyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(record.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
  }, [record.id]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await apiClient.getKYCHistory(record.id);
      setHistory(data);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [record.id]);

  useEffect(() => {
    if (showHistory && history === null) loadHistory();
  }, [showHistory, history, loadHistory]);

  const startWalletFlow = useCallback(async () => {
    setWalletStep('loading');
    setWalletError(null);
    try {
      const { oobId: id, invitationUrl } = await apiClient.getWalletInvitation(record.id);
      const dataUrl = await QRCode.toDataURL(invitationUrl, { width: 280, margin: 2 });
      setOobId(id);
      setQrDataUrl(dataUrl);
      setWalletStep('qr');

      // Poll every 3s for wallet connection, then auto-issue
      pollRef.current = setInterval(async () => {
        try {
          const { connected } = await apiClient.checkWalletConnection(record.id, id);
          if (connected) {
            setWalletStep('connected');
            clearInterval(pollRef.current!);

            const result = await apiClient.sendCredentialToWallet(record.id, id);
            if (result.connected) setWalletStep('issued');
          }
        } catch { /* ignore poll errors */ }
      }, 3000);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to create invitation');
      setWalletStep('error');
    }
  }, [record.id]);

  // Clean up poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const downloadMyData = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const docs = await apiClient.getMyData(record.id);
      for (const doc of docs) {
        const bytes = Uint8Array.from(atob(doc.contentBase64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [record.id]);

  const requestErasure = useCallback(async () => {
    setEraseStep('loading');
    setEraseError(null);
    setEraseWarning(null);
    try {
      const result = await apiClient.requestErasure(record.id);
      setEraseWarning(result.vcWarning ?? null);
      setEraseStep('done');
    } catch (err) {
      setEraseError(err instanceof Error ? err.message : 'Erasure failed');
      setEraseStep('error');
    }
  }, [record.id]);

  return (
    <div className={`status-card ${className}`} data-testid="status-card" data-status={record.status}>
      <div className="status-header">
        <span className="status-badge" role="status" aria-label={`Status: ${label}`}>
          {label}
        </span>
        <span className="status-id">
          {record.id}
          <button type="button" className="btn-copy" onClick={copyId} title="Copy ID">
            {copied ? '✓' : '⧉'}
          </button>
        </span>
      </div>

      <dl className="record-details">
        <dt>DID</dt>
        <dd className="mono">{record.did}</dd>

        <dt>IPFS CID</dt>
        <dd className="mono">{record.ipfsHash}</dd>

        {record.credDefId && (
          <>
            <dt>Credential Def</dt>
            <dd className="mono">{record.credDefId}</dd>
          </>
        )}

        {record.rejectionReason && (
          <>
            <dt>Rejection Reason</dt>
            <dd>{record.rejectionReason}</dd>
          </>
        )}

        <dt>Submitted</dt>
        <dd>{new Date(record.createdAt).toLocaleString()}</dd>

        <dt>Last Updated</dt>
        <dd>{new Date(record.updatedAt).toLocaleString()}</dd>
      </dl>

      {record.status === 'VERIFIED' && (
        <div className="vc-notice" role="note" style={{ padding: '1rem' }}>
          <strong>KYC verified on the Fabric ledger.</strong>
          <div style={{ marginTop: '0.75rem' }}>
            {walletStep === 'idle' && (
              <button className="btn btn-primary btn-sm" onClick={startWalletFlow}>
                Receive Credential in BC Wallet
              </button>
            )}
            {walletStep === 'loading' && <span>Creating invitation…</span>}
            {(walletStep === 'qr' || walletStep === 'connected') && qrDataUrl && (
              <div style={{ textAlign: 'center' }}>
                <p style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                  {walletStep === 'connected'
                    ? '✓ Wallet connected — sending credential…'
                    : 'Scan with BC Wallet to receive your Verifiable Credential'}
                </p>
                <img src={qrDataUrl} alt="DIDComm OOB invitation QR" style={{ borderRadius: '8px' }} />
                <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
                  Waiting for wallet connection…
                </p>
              </div>
            )}
            {walletStep === 'issued' && (
              <div style={{ color: 'green', fontWeight: 600 }}>
                ✓ Verifiable Credential sent to your wallet! Check BC Wallet to accept it.
              </div>
            )}
            {walletStep === 'error' && (
              <div>
                <span style={{ color: 'red' }}>Error: {walletError}</span>
                <button className="btn btn-outline btn-sm" onClick={startWalletFlow} style={{ marginLeft: '0.5rem' }}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {record.status === 'REVOKED' && (
        <div className="revoke-notice" role="note">
          This credential has been revoked and is no longer valid.
        </div>
      )}
      {record.status === 'REJECTED' && (
        <div className="revoke-notice" role="note">
          This application was rejected.
          {record.rejectionReason && ` Reason: ${record.rejectionReason}`}
        </div>
      )}

      {/* Re-submission */}
      {(record.status === 'VERIFIED' || record.status === 'REJECTED') && (
        <div style={{ marginTop: '1rem' }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => navigate(`/submit?resubmit=${record.id}`)}
          >
            Update Documents
          </button>
          <small style={{ marginLeft: '0.5rem', color: 'var(--muted)' }}>
            {record.status === 'REJECTED'
              ? 'Re-submit with new documents (will return to Pending Review)'
              : 'Replace documents — e.g. if you have a new ID card'}
          </small>
        </div>
      )}

      {/* GDPR — Download my data (Art. 15) */}
      {record.status !== 'DELETED' && (
        <div style={{ marginTop: '1rem' }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={downloadMyData}
            disabled={downloading}
          >
            {downloading ? 'Downloading…' : 'Download My Data'}
          </button>
          <small style={{ marginLeft: '0.5rem', color: 'var(--muted)' }}>
            Download your submitted documents (GDPR Art. 15)
          </small>
          {downloadError && (
            <p className="alert alert-error" role="alert" style={{ marginTop: '0.5rem' }}>{downloadError}</p>
          )}
        </div>
      )}

      {/* GDPR — Request erasure (Art. 17) */}
      {record.status !== 'DELETED' && (
        <div style={{ marginTop: '1rem' }}>
          {eraseStep === 'idle' && (
            <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger, #c0392b)' }}
              onClick={() => setEraseStep('confirm')}>
              Request Deletion
            </button>
          )}
          {eraseStep === 'confirm' && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.9rem' }}>
                This will permanently delete your documents and encryption key. The action cannot be undone.
              </span>
              <button className="btn btn-sm" style={{ background: '#c0392b', color: '#fff' }}
                onClick={requestErasure}>
                Confirm Deletion
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setEraseStep('idle')}>
                Cancel
              </button>
            </div>
          )}
          {eraseStep === 'loading' && <span style={{ fontSize: '0.9rem' }}>Erasing data…</span>}
          {eraseStep === 'done' && (
            <>
              <p style={{ color: 'green', fontSize: '0.9rem' }}>
                Your data has been permanently erased. The record on the ledger has been marked as DELETED.
              </p>
              {eraseWarning && (
                <p style={{ color: '#b45309', fontSize: '0.85rem' }}>
                  Note: {eraseWarning}
                </p>
              )}
            </>
          )}
          {eraseStep === 'error' && (
            <div>
              <span style={{ color: 'red', fontSize: '0.9rem' }}>Error: {eraseError}</span>
              <button className="btn btn-outline btn-sm" onClick={() => setEraseStep('idle')}
                style={{ marginLeft: '0.5rem' }}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {record.status === 'DELETED' && (
        <div className="revoke-notice" role="note">
          Your personal data has been erased upon your request. Only the anonymised audit record remains on the ledger.
        </div>
      )}

      {/* Transaction history */}
      <div className="history-section">
        <button
          className="btn btn-outline btn-sm"
          onClick={() => setShowHistory(h => !h)}
          disabled={historyLoading}
        >
          {historyLoading ? 'Loading…' : showHistory ? 'Hide History' : 'Show History'}
        </button>

        {showHistory && historyError && (
          <p className="alert alert-error" role="alert">{historyError}</p>
        )}

        {showHistory && history && !historyError && (
          <table className="history-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>Timestamp</th>
                <th>Tx ID</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, i) => (
                <tr key={entry.txId}>
                  <td>{i + 1}</td>
                  <td>{entry.isDelete ? '(deleted)' : entry.record?.status ?? '—'}</td>
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  <td className="monospace truncate" title={entry.txId}>{entry.txId}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No history available.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
