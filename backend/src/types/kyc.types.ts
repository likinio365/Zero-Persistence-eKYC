export type KYCStatus = 'PENDING' | 'VERIFIED' | 'REVOKED' | 'REJECTED' | 'DELETED';

export interface KYCRecord {
  id: string;
  did: string;
  status: KYCStatus;
  ipfsHash: string;
  credDefId: string;
  credentialExchangeId?: string;
  rejectionReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  txId: string;
  timestamp: string;
  isDelete: boolean;
  record?: KYCRecord;
}

export interface SubmitKYCRequest {
  did: string;
  dateOfBirth?: string;
  documents: DocumentEntry[];
}

export interface DocumentEntry {
  type: 'passport' | 'national_id' | 'drivers_license' | 'selfie';
  fileName: string;
  contentBase64: string;
}

export interface VerifyKYCRequest {
  credDefId: string;
  // Optional VC attributes. If omitted, the route uses a minimal default set.
  attributes?: Record<string, string>;
}

