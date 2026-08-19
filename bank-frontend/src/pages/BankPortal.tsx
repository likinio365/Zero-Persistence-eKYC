import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL ?? 'http://localhost:3000';

type Step = 'idle' | 'waiting-scan' | 'waiting-proof' | 'verified' | 'failed' | 'error';

interface Props { token: string; }

export default function BankPortal({ token }: Props) {
  const [step, setStep] = useState<Step>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [oobId, setOobId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const client = axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${token}` },
  });

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPoll(), []);

  const startVerification = async () => {
    stopPoll();
    setStep('idle');
    setQrDataUrl('');
    setErrorMsg('');
    try {
      const { data: inv } = await client.post<{ oobId: string; invitationUrl: string }>('/api/bank/invitation');
      setOobId(inv.oobId);
      const dataUrl = await QRCode.toDataURL(inv.invitationUrl, { width: 300, margin: 2 });
      setQrDataUrl(dataUrl);
      setStep('waiting-scan');

      pollRef.current = setInterval(async () => {
        try {
          const { data: conn } = await client.get<{ connected: boolean; connectionId: string | null }>(
            `/api/bank/connection/${inv.oobId}`
          );
          if (conn.connected && conn.connectionId) {
            stopPoll();
            setStep('waiting-proof');
            const { data: pr } = await client.post<{ presExId: string }>(
              '/api/bank/proof-request', { connectionId: conn.connectionId }
            );
            pollRef.current = setInterval(async () => {
              try {
                const { data: result } = await client.get<{ state: string; verified: boolean; done: boolean }>(
                  `/api/bank/proof-result/${pr.presExId}`
                );
                if (result.done) { stopPoll(); setStep(result.verified ? 'verified' : 'failed'); }
              } catch { /* keep polling */ }
            }, 2000);
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.error ?? err?.message ?? 'Unknown error');
      setStep('error');
    }
  };

  return (
    <div>
      <h2 style={{ color: '#1a237e', marginTop: 0 }}>Customer KYC Verification</h2>
      <p style={{ color: '#555', marginBottom: '1.5rem' }}>
        Verify a customer's identity using their self-sovereign KYC credential.
        The bank verifies the ZKP proof directly against the Indy ledger — no contact with the KYC provider's servers.
      </p>

      {step === 'idle' && (
        <button onClick={startVerification} style={{
          padding: '0.75rem 2rem', background: '#1a237e', color: 'white',
          border: 'none', borderRadius: 6, fontSize: '1rem', fontWeight: 600, cursor: 'pointer'
        }}>
          Start Customer Verification
        </button>
      )}

      {step === 'waiting-scan' && (
        <div style={{ textAlign: 'center' }}>
          <p><strong>Step 1:</strong> Customer scans this QR with their BC Wallet</p>
          {qrDataUrl && <img src={qrDataUrl} alt="DIDComm invitation QR" style={{ borderRadius: 8, display: 'block', margin: '1rem auto' }} />}
          <p style={{ color: '#777', fontSize: '0.9rem' }}>⏳ Waiting for customer to scan…</p>
          <button onClick={startVerification} style={{ marginTop: '0.5rem', padding: '0.4rem 1rem', cursor: 'pointer' }}>Reset</button>
        </div>
      )}

      {step === 'waiting-proof' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '2rem' }}>🔗</div>
          <p><strong>Customer connected.</strong></p>
          <p style={{ color: '#555' }}>Step 2: Proof request sent to wallet — waiting for customer to approve…</p>
        </div>
      )}

      {step === 'verified' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '4rem' }}>✅</div>
          <h3 style={{ color: '#2e7d32' }}>Identity Verified</h3>
          <ul style={{ textAlign: 'left', display: 'inline-block', color: '#444', lineHeight: 1.8 }}>
            <li>KYC credential is valid and unrevoked</li>
            <li>Age ≥ 18 confirmed via zero-knowledge proof</li>
            <li>Verified against Hyperledger Indy public ledger</li>
            <li>Exact age was <strong>not</strong> revealed to the bank</li>
          </ul>
          <div style={{ marginTop: '1.5rem' }}>
            <button onClick={startVerification} style={{
              padding: '0.65rem 2rem', background: '#1a237e', color: 'white',
              border: 'none', borderRadius: 6, fontSize: '1rem', cursor: 'pointer'
            }}>Verify Another Customer</button>
          </div>
        </div>
      )}

      {step === 'failed' && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '4rem' }}>❌</div>
          <h3 style={{ color: '#c62828' }}>Verification Failed</h3>
          <p>The credential is invalid, revoked, or age predicate not satisfied.</p>
          <button onClick={startVerification} style={{ marginTop: '1rem', padding: '0.65rem 2rem', cursor: 'pointer' }}>Try Again</button>
        </div>
      )}

      {step === 'error' && (
        <div>
          <p style={{ color: '#c62828' }}>Error: {errorMsg}</p>
          <button onClick={startVerification}>Retry</button>
        </div>
      )}
    </div>
  );
}
