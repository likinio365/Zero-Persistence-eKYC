export type KYCStatus = 'PENDING' | 'VERIFIED' | 'REVOKED' | 'REJECTED' | 'DELETED';

export interface KYCRecord {
  id: string;
  did: string;
  status: KYCStatus;
  ipfsHash: string;
  credDefId: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  txId: string;
  timestamp: string;
  isDelete: boolean;
  record?: KYCRecord;
}

export type DocumentType = 'passport' | 'national_id' | 'drivers_license' | 'selfie';

export interface SubmitKYCRequest {
  did: string;
  dateOfBirth?: string;
  documents: {
    type: DocumentType;
    fileName: string;
    contentBase64: string;
  }[];
}

export interface ResubmitKYCRequest {
  documents: {
    type: DocumentType;
    fileName: string;
    contentBase64: string;
  }[];
  dateOfBirth?: string;
}

export interface UploadResponse {
  cid: string;
  documentId: string;
}

export interface DIDDocument {
  id: string;
  verificationMethod: unknown[];
  authentication: string[];
  [key: string]: unknown;
}
