/**
 * Shared-secret check for internal node APIs. The manager generates a random
 * 256-bit token at startup and hands it to each child process through its
 * environment; nodes reject any request that does not carry it.
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Constant-time string comparison, so a token cannot be guessed byte by byte from response timing. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Express middleware requiring `x-vault-token`; a no-op when no token is configured (unit tests). */
export function requireNodeToken(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) { next(); return; }
    const got = req.header('x-vault-token') ?? '';
    if (!safeEqual(got, token)) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
}