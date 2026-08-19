import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  fabric: {
    channel: process.env.FABRIC_CHANNEL ?? 'kycchannel',
    chaincode: process.env.FABRIC_CHAINCODE ?? 'kyccc',
    // Path to the crypto-config directory (mounted at /app/crypto-config in Docker)
    cryptoConfigPath: process.env.FABRIC_CRYPTO_CONFIG_PATH ?? './crypto-config',
    mspId: process.env.FABRIC_MSP_ID ?? 'Org1MSP',
    // Set true when running backend outside Docker so peer hostnames resolve to localhost
    asLocalhost: process.env.FABRIC_AS_LOCALHOST === 'true',
  },

  acapy: {
    adminUrl: process.env.ACAPY_ADMIN_URL ?? 'http://localhost:8031',
    apiKey: process.env.ACAPY_API_KEY ?? '',
  },

  bankAcapy: {
    adminUrl: process.env.BANK_ACAPY_ADMIN_URL ?? 'http://bank-acapy:8041',
  },

  ipfs: {
    apiUrl: process.env.IPFS_API_URL ?? 'http://localhost:5001',
  },

  vault: {
    address: process.env.VAULT_ADDR ?? 'http://vault:8200',
    token: process.env.VAULT_TOKEN ?? 'root',
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'change-me-jwt-secret',
    jwtExpiresIn: '24h',
    verifier: {
      username: process.env.VERIFIER_USERNAME ?? 'verifier',
      password: process.env.VERIFIER_PASSWORD ?? 'verifier-pass',
    },
    user: {
      username: process.env.USER_USERNAME ?? 'user',
      password: process.env.USER_PASSWORD ?? 'user-pass',
    },
    bank: {
      username: process.env.BANK_USERNAME ?? 'bank',
      password: process.env.BANK_PASSWORD ?? 'bank-pass',
    },
  },
} as const;

export function validateConfig(): void {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'change-me-jwt-secret') {
    throw new Error('JWT_SECRET must be set to a non-default value before starting the server');
  }
  if (process.env.VAULT_ENABLED !== 'true') {
    throw new Error('VAULT_ENABLED must be "true" — all encryption goes through Vault Transit');
  }
  if (!process.env.VAULT_ADDR) {
    throw new Error('VAULT_ADDR must be set');
  }
  if (!process.env.VAULT_TOKEN) {
    throw new Error('VAULT_TOKEN must be set');
  }
}
