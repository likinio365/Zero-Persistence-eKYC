import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiClient } from '../services/api';

type Step = 'idle' | 'waiting-scan' | 'waiting-proof' | 'verified' | 'failed' | 'error';

export default function Bank() {
  const [step, setStep] = useState<Step>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [oobId, setOobId] = useState('');
  const [presExId, setPresExId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => () => stopPoll(), []);

  const startVerification = async () => {
    setStep('idle');
    setQrDataUrl('');
    setErrorMsg('');
    stopPoll();
    try {
      const { oobId: id, invitationUrl: url } = await apiClient.bankCreateInvitation();
      setOobId(id);
      const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
      setQrDataUrl(dataUrl);
      setStep('waiting-scan');

      // Poll for connection
      pollRef.current = setInterval(async () => {
        try {
          const { connected, connectionId } = await apiClient.bankCheckConnection(id);
          if (connected && connectionId) {
            stopPoll();
            setStep('waiting-proof');
            const { presExId: pex } = await apiClient.bankSendProofRequest(connectionId);
            setPresExId(pex);
            // Poll proof result
            pollRef.current = setInterval(async () => {
              try {
                const result = await apiClient.bankGetProofResult(pex);
                if (result.done) {
                  stopPoll();
                  setStep(result.verified ? 'verified' : 'failed');
                }
              } catch { /* keep polling */ }
            }, 2000);
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStep('error');
    }
  };

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '2rem 1rem' }}>
      <h2>Bank — KYC Verification</h2>
      <p style={{ color: '#555', marginBottom: '1.5rem' }}>
        Verify a customer's identity using their self-sovereign KYC credential.
        The bank verifies the proof directly against the Indy ledger — no contact
        with the KYC provider's backend.
      </p>

      {step === 'idle' && (
        <button className="btn-primary" onClick={startVerification}>
          Start New Verification
        </button>
      )}

      {step === 'waiting-scan' && (
        <div>
          <p><strong>Step 1:</strong> Ask the customer to scan this QR code with their BC Wallet.</p>
          {qrDataUrl && (
            <img src={qrDataUrl} alt="DIDComm OOB invitation" style={{ display: 'block', margin: '1rem 0', borderRadius: 8 }} />
          )}
          <p style={{ color: '#888' }}>⏳ Waiting for customer to scan…</p>
          <button className="btn-secondary" onClick={startVerification} style={{ marginTop: '1rem' }}>
            Reset
          </button>
        </div>
      )}

      {step === 'waiting-proof' && (
        <div>
          <p>✅ Customer connected. <strong>Step 2:</strong> Proof request sent to wallet.</p>
          <p style={{ color: '#888' }}>⏳ Waiting for customer to approve in their wallet…</p>
        </div>
      )}

      {step === 'verified' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '4rem' }}>✅</div>
          <h3 style={{ color: '#2e7d32', marginTop: '0.5rem' }}>Identity Verified</h3>
          <p>The customer has presented a valid KYC credential.</p>
          <ul style={{ textAlign: 'left', display: 'inline-block', color: '#444', marginTop: '0.5rem' }}>
            <li>KYC credential is valid and unrevoked</li>
            <li>Age ≥ 18 confirmed via zero-knowledge proof</li>
          </ul>
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.75rem' }}>
            Proof verified against the Indy public ledger — actual age not revealed.
          </p>
          <button className="btn-primary" onClick={startVerification} style={{ marginTop: '1.5rem' }}>
            Verify Another Customer
          </button>
        </div>
      )}

      {step === 'failed' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '4rem' }}>❌</div>
          <h3 style={{ color: '#c62828', marginTop: '0.5rem' }}>Verification Failed</h3>
          <p>The proof was rejected or the credential is not valid.</p>
          <button className="btn-primary" onClick={startVerification} style={{ marginTop: '1.5rem' }}>
            Try Again
          </button>
        </div>
      )}

      {step === 'error' && (
        <div>
          <p style={{ color: '#c62828' }}>Error: {errorMsg}</p>
          <button className="btn-primary" onClick={startVerification}>Retry</button>
        </div>
      )}
    </div>
  );
}
