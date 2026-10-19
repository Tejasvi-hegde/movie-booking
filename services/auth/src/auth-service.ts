import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  UnauthorizedError,
  withTransaction,
  type Logger,
  type Pool,
  type Role,
} from '@showtime/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: Date;
}

export interface Session {
  user: User;
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthServiceOptions {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
}

const BCRYPT_ROUNDS = 10;
// Compared against when the email does not exist, so "unknown email" and "wrong password"
// take the same time and cannot be told apart (prevents account enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at.toISOString() });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly opts: AuthServiceOptions,
    private readonly logger: Logger,
  ) {}

  async register(input: { name: string; email: string; password: string }, userAgent?: string, role: Role = 'USER'): Promise<Session> {
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [randomUUID(), input.email.trim(), input.name.trim(), hash, role],
      );
      return this.startSession(toUser(rows[0]!), userAgent);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
  }

  async login(email: string, password: string, userAgent?: string): Promise<Session> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    const row = rows[0];
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new UnauthorizedError('Invalid email or password');
    return this.startSession(toUser(row), userAgent);
  }

  async getUser(id: string): Promise<User> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundError('User');
    return toUser(rows[0]);
  }

  /**
   * Refresh-token rotation with reuse detection.
   *
   * Every refresh returns a NEW refresh token and revokes the old one. If an already-revoked
   * token is presented again, someone is replaying a stolen token (or the legit user is, after
   * the thief already used it). We cannot tell which, so the whole family (that login session)
   * is revoked and both must sign in again.
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<Session> {
    const hash = sha256(refreshToken);
    const result = await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null }>(
        'SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [hash],
      );
      const token = rows[0];
      if (!token) return { error: 'Invalid refresh token' } as const;

      if (token.revoked_at) {
        await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [token.family_id]);
        this.logger.warn({ userId: token.user_id, familyId: token.family_id }, 'Refresh token reuse detected; session family revoked');
        return { error: 'Session expired, please sign in again' } as const;
      }
      if (token.expires_at.getTime() < Date.now()) return { error: 'Session expired, please sign in again' } as const;

      const next = await this.insertRefreshToken(tx, token.user_id, token.family_id, userAgent);
      await tx.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [token.id, next.id]);
      return { userId: token.user_id, next } as const;
    });

    // Committed outside the transaction so the family revocation sticks even though we reject.
    if ('error' in result) throw new UnauthorizedError(result.error);
    const user = await this.getUser(result.userId);
    return { user, ...this.accessToken(user), refreshToken: result.next.token, refreshTokenExpiresAt: result.next.expiresAt };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
  }

  /** Creates the user if missing (used to seed the admin and demo accounts). */
  async ensureUser(email: string, password: string, name: string, role: Role): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
    if (rowCount) return;
    await this.register({ email, password, name }, 'seed', role).catch((err) => {
      if (!(err instanceof ConflictError)) throw err;
    });
    this.logger.info({ email, role }, 'Seeded user');
  }

  private async startSession(user: User, userAgent?: string): Promise<Session> {
    const rt = await this.insertRefreshToken(this.pool, user.id, randomUUID(), userAgent);
    return { user, ...this.accessToken(user), refreshToken: rt.token, refreshTokenExpiresAt: rt.expiresAt };
  }

  private accessToken(user: User) {
    const accessToken = jwt.sign({ role: user.role, email: user.email, name: user.name }, this.opts.jwtSecret, {
      subject: user.id,
      expiresIn: this.opts.accessTokenTtlSeconds,
      issuer: 'showtime-auth',
      audience: 'showtime',
      algorithm: 'HS256',
    });
    return { accessToken, accessTokenExpiresIn: this.opts.accessTokenTtlSeconds };
  }

  private async insertRefreshToken(db: Pick<Pool, 'query'>, userId: string, familyId: string, userAgent?: string) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.opts.refreshTokenTtlDays * 86_400_000);
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, familyId, sha256(token), expiresAt, userAgent?.slice(0, 255) ?? null],
    );
    return { id, token, expiresAt };
  }
}
