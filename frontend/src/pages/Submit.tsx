import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import KYCForm from '../components/KYCForm';
import { apiClient } from '../services/api';
import type { SubmitKYCRequest } from '../types/kyc';

export default function Submit() {
  const [searchParams] = useSearchParams();
  const resubmitId = searchParams.get('resubmit');

  const [isLoading, setIsLoading] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existingDid, setExistingDid] = useState('');

  useEffect(() => {
    if (!resubmitId) return;
    apiClient.getKYCRecord(resubmitId)
      .then(r => setExistingDid(r.did))
      .catch(() => setError('Could not load existing record'));
  }, [resubmitId]);

  const handleSubmit = async (request: SubmitKYCRequest) => {
    setIsLoading(true);
    setError(null);
    try {
      if (resubmitId) {
        await apiClient.resubmitKYC(resubmitId, {
          documents: request.documents,
          dateOfBirth: request.dateOfBirth,
        });
        setSubmittedId(resubmitId);
      } else {
        const { id } = await apiClient.submitKYC(request);
        setSubmittedId(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setIsLoading(false);
    }
  };

  if (submittedId) {
    return (
      <div className="success-panel">
        <h2>{resubmitId ? 'Documents Updated' : 'Application Submitted'}</h2>
        <p>
          {resubmitId
            ? 'Your updated documents have been submitted for re-review.'
            : 'Your KYC application has been recorded on the blockchain.'}
        </p>
        <p>Application ID:</p>
        <div className="id-display">{submittedId}</div>
        {!resubmitId && <p>Save this ID — you will need it to check your verification status.</p>}
        <Link to={`/status/${submittedId}`} className="btn btn-primary">
          Check Status
        </Link>
      </div>
    );
  }

  return (
    <>
      <h2>{resubmitId ? 'Update KYC Documents' : 'Submit KYC Application'}</h2>
      {resubmitId && (
        <p className="alert" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
          Uploading new documents for application <strong>{resubmitId}</strong>.
          The record will return to <em>Pending Review</em>.
        </p>
      )}
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <KYCForm
        onSubmit={handleSubmit}
        isLoading={isLoading}
        initialDid={existingDid}
        lockDid={!!resubmitId}
      />
    </>
  );
}
