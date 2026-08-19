import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import VerificationStatus from '../components/VerificationStatus';
import { apiClient } from '../services/api';
import type { KYCRecord } from '../types/kyc';

export default function Status() {
  const { id: urlId } = useParams<{ id?: string }>();
  const [inputId, setInputId] = useState(urlId ?? '');
  const [record, setRecord] = useState<KYCRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getKYCRecord(id);
      setRecord(data);
    } catch (err) {
      setRecord(null);
      setError(err instanceof Error ? err.message : 'Record not found');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (urlId) lookup(urlId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlId]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputId.trim()) lookup(inputId.trim());
  };

  return (
    <>
      <h2>Check KYC Status</h2>

      <form className="search-form" onSubmit={handleSearch}>
        <input
          type="text"
          value={inputId}
          onChange={e => setInputId(e.target.value)}
          placeholder="Paste your Application ID"
          aria-label="Application ID"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={isLoading}>
          {isLoading
            ? <><span className="spinner" aria-hidden="true" /> Looking up…</>
            : 'Look Up'
          }
        </button>
      </form>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
          {error.toLowerCase().includes('not found') && (
            <> — <Link to="/submit">Submit a new application</Link></>
          )}
        </p>
      )}

      {record && <VerificationStatus record={record} />}
    </>
  );
}
