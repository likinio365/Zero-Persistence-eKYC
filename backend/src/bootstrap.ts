import axios from 'axios';

// Fetches secrets from Vault KV (secret/kyc) and injects them into process.env.
// Must be called before any module that reads config is imported.
// Falls back gracefully if Vault is unreachable — env vars are used as-is.
export async function bootstrapVaultSecrets(): Promise<void> {
  const addr = process.env.VAULT_ADDR ?? 'http://vault:8200';
  const token = process.env.VAULT_TOKEN ?? 'root';

  try {
    const resp = await axios.get<{ data: { data: Record<string, string> } }>(
      `${addr}/v1/secret/data/kyc`,
      { headers: { 'X-Vault-Token': token }, timeout: 10_000 },
    );

    const secrets = resp.data?.data?.data ?? {};
    const mapping: Record<string, string> = {
      jwt_secret: 'JWT_SECRET',
      verifier_password: 'VERIFIER_PASSWORD',
      user_password: 'USER_PASSWORD',
      bank_password: 'BANK_PASSWORD',
    };

    for (const [vaultKey, envKey] of Object.entries(mapping)) {
      const val = secrets[vaultKey];
      if (val) process.env[envKey] = val;
    }

    console.log('[vault] Secrets loaded from Vault KV (secret/kyc)');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vault] Failed to load secrets from Vault: ${msg} — falling back to env vars`);
  }
}
