import axios, { AxiosInstance } from 'axios';
import type { DIDDocument, HistoryEntry, KYCRecord, ResubmitKYCRequest, SubmitKYCRequest, UploadResponse } from '../types/kyc';

const TOKEN_KEY = 'kyc_token';
const ROLE_KEY  = 'kyc_role';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredRole(): string | null {
  return localStorage.getItem(ROLE_KEY);
}

export function storeToken(token: string, role: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  window.dispatchEvent(new Event('auth-change'));
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  window.dispatchEvent(new Event('auth-change'));
}

function makeDefaultClient(): AxiosInstance {
  const http = axios.create({
    baseURL: process.env.REACT_APP_API_URL ?? 'http://localhost:3000',
    headers: { 'Content-Type': 'application/json' },
  });

  // Attach the JWT from localStorage to every request.
  http.interceptors.request.use(config => {
    const token = getStoredToken();
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    return config;
  });

  // Extract { error } bodies as plain Errors; clear token on 401.
  http.interceptors.response.use(
    res => res,
    err => {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 401) clearToken();
        const apiMsg = (err.response?.data as { error?: string })?.error;
        if (apiMsg) return Promise.reject(new Error(apiMsg));
      }
      return Promise.reject(err);
    },
  );

  return http;
}

export class APIClient {
  constructor(private readonly http: AxiosInstance = makeDefaultClient()) {}

  async login(username: string, password: string): Promise<{ token: string; role: string }> {
    const { data } = await this.http.post<{ token: string; role: string; expiresIn: string }>(
      '/api/auth/login',
      { username, password },
    );
    storeToken(data.token, data.role);
    return data;
  }

  async submitKYC(request: SubmitKYCRequest): Promise<{ id: string }> {
    const { data } = await this.http.post<{ id: string }>('/api/kyc', request);
    return data;
  }

  async getKYCRecord(id: string): Promise<KYCRecord> {
    const { data } = await this.http.get<KYCRecord>(`/api/kyc/${encodeURIComponent(id)}`);
    return data;
  }

  async getKYCByDID(did: string): Promise<KYCRecord[]> {
    const { data } = await this.http.get<KYCRecord[]>(
      `/api/kyc/did/${encodeURIComponent(did)}`,
    );
    return data;
  }

  async listKYCByStatus(status: string): Promise<KYCRecord[]> {
    const { data } = await this.http.get<KYCRecord[]>('/api/kyc', { params: { status } });
    return data;
  }

  async verifyKYC(id: string, credDefId: string, attributes?: Record<string, string>): Promise<void> {
    await this.http.put(`/api/kyc/${encodeURIComponent(id)}/verify`, { credDefId, attributes });
  }

  async rejectKYC(id: string, reason?: string): Promise<void> {
    await this.http.put(`/api/kyc/${encodeURIComponent(id)}/reject`, { reason: reason ?? '' });
  }

  async revokeKYC(id: string, credentialExchangeId?: string): Promise<void> {
    await this.http.put(`/api/kyc/${encodeURIComponent(id)}/revoke`, { credentialExchangeId });
  }

  async resubmitKYC(id: string, request: ResubmitKYCRequest): Promise<void> {
    await this.http.put(`/api/kyc/${encodeURIComponent(id)}/resubmit`, request);
  }

  async getKYCHistory(id: string): Promise<HistoryEntry[]> {
    const { data } = await this.http.get<HistoryEntry[]>(`/api/kyc/${encodeURIComponent(id)}/history`);
    return data;
  }

  async getKYCDocuments(id: string): Promise<Array<{ type: string; fileName: string; contentBase64: string }>> {
    const { data } = await this.http.get(`/api/kyc/${encodeURIComponent(id)}/documents`);
    return data;
  }

  async getMyData(id: string): Promise<Array<{ type: string; fileName: string; contentBase64: string }>> {
    const { data } = await this.http.get(`/api/kyc/${encodeURIComponent(id)}/my-data`);
    return data;
  }

  async requestErasure(id: string): Promise<{ erased: boolean; vcWarning?: string }> {
    const { data } = await this.http.delete<{ erased: boolean; vcWarning?: string }>(
      `/api/kyc/${encodeURIComponent(id)}`,
    );
    return data;
  }

  async uploadDocument(file: File): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const { data } = await this.http.post<UploadResponse>('/api/documents/upload', formData);
    return data;
  }

  async createDID(): Promise<{ did: string; verkey: string }> {
    const { data } = await this.http.post<{ did: string; verkey: string }>('/api/did');
    return data;
  }

  async resolveDID(did: string): Promise<DIDDocument> {
    const { data } = await this.http.get<DIDDocument>(
      `/api/did/${encodeURIComponent(did)}`,
    );
    return data;
  }

  async getWalletInvitation(kycId: string): Promise<{ oobId: string; invitationUrl: string }> {
    const { data } = await this.http.get<{ oobId: string; invitationUrl: string }>(
      `/api/kyc/${encodeURIComponent(kycId)}/wallet-invitation`,
    );
    return data;
  }

  async checkWalletConnection(kycId: string, oobId: string): Promise<{ connected: boolean; connectionId: string | null }> {
    const { data } = await this.http.get<{ connected: boolean; connectionId: string | null }>(
      `/api/kyc/${encodeURIComponent(kycId)}/wallet-connection/${encodeURIComponent(oobId)}`,
    );
    return data;
  }

  async sendCredentialToWallet(kycId: string, oobId: string): Promise<{ connected: boolean; credentialExchangeId?: string }> {
    const { data } = await this.http.post<{ connected: boolean; credentialExchangeId?: string }>(
      `/api/kyc/${encodeURIComponent(kycId)}/send-credential`,
      { oobId },
    );
    return data;
  }

  async bankCreateInvitation(): Promise<{ oobId: string; invitationUrl: string }> {
    const { data } = await this.http.post<{ oobId: string; invitationUrl: string }>('/api/bank/invitation');
    return data;
  }

  async bankCheckConnection(oobId: string): Promise<{ connected: boolean; connectionId: string | null }> {
    const { data } = await this.http.get<{ connected: boolean; connectionId: string | null }>(
      `/api/bank/connection/${encodeURIComponent(oobId)}`,
    );
    return data;
  }

  async bankSendProofRequest(connectionId: string): Promise<{ presExId: string }> {
    const { data } = await this.http.post<{ presExId: string }>('/api/bank/proof-request', { connectionId });
    return data;
  }

  async bankGetProofResult(presExId: string): Promise<{ state: string; verified: boolean; done: boolean }> {
    const { data } = await this.http.get<{ state: string; verified: boolean; done: boolean }>(
      `/api/bank/proof-result/${encodeURIComponent(presExId)}`,
    );
    return data;
  }
}

export const apiClient = new APIClient();
