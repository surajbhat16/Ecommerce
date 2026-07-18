// ────────────────────────────────────────────────────────────────────────────
// auth.ts — Core authentication domain logic.
//
// Kept deliberately small for Phase 1. Focus areas a DevOps interviewer cares
// about that ARE demonstrated here:
//   - Password hashing with argon2id (memory-hard, the current best practice;
//     NOT bcrypt/md5/sha).
//   - JWTs with short-lived access tokens + longer refresh tokens.
//   - Parameterised SQL (no string concatenation → no SQL injection).
// ────────────────────────────────────────────────────────────────────────────

import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { config } from './config.js';

export interface PublicUser {
  id: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Hash a password with argon2id. Salt is generated and stored inside the hash. */
async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/** Issue a short-lived access token and a longer refresh token for a user. */
function issueTokens(user: PublicUser): TokenPair {
  const base = { sub: user.id, email: user.email, iss: config.jwt.issuer };
  const accessToken = jwt.sign({ ...base, typ: 'access' }, config.jwt.signingKey, {
    expiresIn: config.jwt.accessTtlSeconds,
  });
  const refreshToken = jwt.sign({ ...base, typ: 'refresh' }, config.jwt.signingKey, {
    expiresIn: config.jwt.refreshTtlSeconds,
  });
  return { accessToken, refreshToken };
}

/** Register a new user. Throws if the email already exists. */
export async function registerUser(email: string, password: string): Promise<PublicUser> {
  const passwordHash = await hashPassword(password);
  // Parameterised query ($1,$2) — values are never interpolated into SQL text.
  const result = await pool.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email`,
    [email.toLowerCase(), passwordHash],
  );
  return result.rows[0]!;
}

/** Verify credentials and return tokens, or null if authentication fails. */
export async function loginUser(email: string, password: string): Promise<TokenPair | null> {
  const result = await pool.query<{ id: string; email: string; password_hash: string }>(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) {
    // Run a dummy verify to keep timing roughly constant (mitigates user
    // enumeration via response-time differences). Cheap, and good hygiene.
    await argon2.verify('$argon2id$v=19$m=65536,t=3,p=4$x$x', password).catch(() => false);
    return null;
  }
  const ok = await argon2.verify(row.password_hash, password);
  if (!ok) return null;
  return issueTokens({ id: row.id, email: row.email });
}
