import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../config/logger';
import type { Role } from '../middleware/auth.middleware';

const router = Router();

// POST /api/auth/login — returns a signed JWT
// Body: { username: string, password: string }
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const role = resolveRole(username, password);
  if (!role) {
    logger.warn('Failed login attempt', { username });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { sub: username, role } satisfies { sub: string; role: Role },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn },
  );

  logger.info('Login successful', { username, role });
  res.json({ token, role, expiresIn: config.auth.jwtExpiresIn });
});

function resolveRole(username: string, password: string): Role | null {
  if (username === config.auth.verifier.username && password === config.auth.verifier.password) {
    return 'verifier';
  }
  if (username === config.auth.user.username && password === config.auth.user.password) {
    return 'user';
  }
  if (username === config.auth.bank.username && password === config.auth.bank.password) {
    return 'bank';
  }
  return null;
}

export default router;
