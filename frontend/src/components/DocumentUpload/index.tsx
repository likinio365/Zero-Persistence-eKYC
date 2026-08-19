import React, { useRef, useState, useEffect } from 'react';
import type { DocumentType } from '../../types/kyc';

interface Props {
  label: string;
  documentType: DocumentType;
  onFileSelected: (file: File, type: DocumentType) => void;
  required?: boolean;
  accept?: string;
  disabled?: boolean;
}

export default function DocumentUpload({
  label,
  documentType,
  onFileSelected,
  required = false,
  accept = 'image/*,.pdf',
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Revoke the object URL when it changes or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);

    onFileSelected(file, documentType);
  };

  return (
    <div className={`document-upload ${fileName ? 'has-file' : ''}`}>
      <div className="doc-label">
        {label}
        {required && <span className="required" aria-hidden="true">*</span>}
      </div>

      <div className="doc-controls">
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-label={`Choose file for ${label}`}
        >
          {fileName ?? 'Choose file'}
        </button>

        {previewUrl && (
          <img
            src={previewUrl}
            alt={`${label} preview`}
            className="doc-preview"
          />
        )}

        {fileName && !previewUrl && (
          <span className="doc-filename" title={fileName}>{fileName}</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        disabled={disabled}
        style={{ display: 'none' }}
        data-testid={`file-input-${documentType}`}
      />
    </div>
  );
}
