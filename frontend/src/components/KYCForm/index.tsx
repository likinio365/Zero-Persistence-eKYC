import React, { useState, useCallback, useEffect } from 'react';
import type { DocumentType, SubmitKYCRequest } from '../../types/kyc';
import DocumentUpload from '../DocumentUpload';
import { apiClient } from '../../services/api';

interface DocumentConfig {
  type: DocumentType;
  label: string;
  required: boolean;
  accept: string;
}

const DOCUMENT_CONFIGS: DocumentConfig[] = [
  { type: 'passport',        label: 'Passport',         required: true,  accept: 'image/*,.pdf' },
  { type: 'selfie',          label: 'Selfie / Photo',   required: true,  accept: 'image/*' },
  { type: 'national_id',     label: 'National ID',      required: false, accept: 'image/*,.pdf' },
  { type: 'drivers_license', label: "Driver's License", required: false, accept: 'image/*,.pdf' },
];

interface Props {
  onSubmit: (request: SubmitKYCRequest) => Promise<void>;
  isLoading?: boolean;
  initialDid?: string;
  lockDid?: boolean;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix — backend expects raw base64.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export default function KYCForm({ onSubmit, isLoading = false, initialDid = '', lockDid = false }: Props) {
  const [did, setDid] = useState(initialDid);
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [files, setFiles] = useState<Partial<Record<DocumentType, File>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [generatingDid, setGeneratingDid] = useState(false);

  useEffect(() => {
    if (initialDid) setDid(initialDid);
  }, [initialDid]);

  const handleGenerateDid = async () => {
    setGeneratingDid(true);
    setFormError(null);
    try {
      const { did: raw } = await apiClient.createDID();
      setDid(raw.startsWith('did:') ? raw : `did:indy:test:${raw}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to generate DID');
    } finally {
      setGeneratingDid(false);
    }
  };

  const handleFileSelected = useCallback((file: File, type: DocumentType) => {
    setFiles(prev => ({ ...prev, [type]: file }));
  }, []);

  const requiredMissing = DOCUMENT_CONFIGS
    .filter(c => c.required && !files[c.type])
    .map(c => c.label);

  const canSubmit =
    !isLoading &&
    did.trim().startsWith('did:') &&
    requiredMissing.length === 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!did.trim().startsWith('did:')) {
      setFormError('DID must start with "did:" (e.g. did:indy:test:ABC123)');
      return;
    }
    if (requiredMissing.length > 0) {
      setFormError(`Missing required documents: ${requiredMissing.join(', ')}`);
      return;
    }

    try {
      const documents = await Promise.all(
        (Object.entries(files) as [DocumentType, File][]).map(async ([type, file]) => ({
          type,
          fileName: file.name,
          contentBase64: await fileToBase64(file),
        })),
      );
      await onSubmit({ did: did.trim(), documents, ...(dateOfBirth && { dateOfBirth }) });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Submission failed');
    }
  };

  return (
    <form className="kyc-form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="did-input">
          Decentralized Identifier (DID)
          <span className="required" aria-hidden="true">*</span>
        </label>
        <input
          id="did-input"
          type="text"
          value={did}
          onChange={e => setDid(e.target.value)}
          placeholder="did:indy:test:ABC123"
          disabled={isLoading || lockDid}
          autoComplete="off"
          aria-describedby="did-hint"
        />
        <small id="did-hint">
          Your self-sovereign identity.{' '}
          {!lockDid && (
            <button
              type="button"
              className="btn-link"
              onClick={handleGenerateDid}
              disabled={isLoading || generatingDid}
            >
              {generatingDid ? 'Generating…' : 'Generate one for me'}
            </button>
          )}
        </small>
      </div>

      <div className="field">
        <label htmlFor="dob-input">
          Date of Birth
          <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}> (required for age verification)</span>
        </label>
        <input
          id="dob-input"
          type="date"
          value={dateOfBirth}
          onChange={e => setDateOfBirth(e.target.value)}
          disabled={isLoading}
          max={new Date().toISOString().split('T')[0]}
        />
      </div>

      <fieldset disabled={isLoading}>
        <legend>
          Identity Documents
          <span className="required" aria-hidden="true"> (Passport and Selfie required)</span>
        </legend>

        {DOCUMENT_CONFIGS.map(doc => (
          <DocumentUpload
            key={doc.type}
            label={doc.label}
            documentType={doc.type}
            required={doc.required}
            accept={doc.accept}
            onFileSelected={handleFileSelected}
            disabled={isLoading}
          />
        ))}
      </fieldset>

      {formError && (
        <p className="form-error" role="alert">{formError}</p>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
      >
        {isLoading
          ? <><span className="spinner" aria-hidden="true" /> Submitting…</>
          : 'Submit KYC Application'
        }
      </button>
    </form>
  );
}
