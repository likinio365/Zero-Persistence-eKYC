import dotenv from 'dotenv';
dotenv.config();

// Vault bootstrap must run before any module that reads `config` is imported.
// All subsequent imports are dynamic so Node's module cache is populated only
// after process.env has been populated with Vault secrets.
(async () => {
  if (process.env.VAULT_ENABLED === 'true') {
    const { bootstrapVaultSecrets } = await import('./bootstrap');
    await bootstrapVaultSecrets();
  }

  const { default: express } = await import('express');
  const { default: cors } = await import('cors');
  const { config, validateConfig } = await import('./config');
  validateConfig();
  const { logger } = await import('./config/logger');
  const { authMiddleware } = await import('./middleware/auth.middleware');
  const { default: authRouter } = await import('./routes/auth.routes');
  const { default: kycRouter } = await import('./routes/kyc.routes');
  const { default: didRouter } = await import('./routes/did.routes');
  const { default: documentRouter } = await import('./routes/document.routes');
  const { default: bankRouter } = await import('./routes/bank.routes');

  const app = express();

  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost')
    .split(',').map(o => o.trim());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.some(o => origin.startsWith(o))),
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  app.use(authMiddleware);

  app.use('/api/kyc', kycRouter);
  app.use('/api/did', didRouter);
  app.use('/api/documents', documentRouter);
  app.use('/api/bank', bankRouter);

  app.listen(config.port, () => {
    logger.info(`KYC backend listening on port ${config.port}`);
  });
})().catch((err) => {
  console.error('Fatal: failed to start server', err);
  process.exit(1);
});
