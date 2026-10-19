import type { User } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Session {
  user: User;
  accessToken: string;
  expiresIn: number;
}

// The access token lives only in memory (never localStorage, where any XSS could read it).
// The refresh token is an httpOnly cookie the browser sends to /api/auth/* automatically.
let accessToken: string | null = null;
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<(user: User | null) => void>();

export function onSessionChange(fn: (user: User | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSession(session: Session | null) {
  accessToken = session?.accessToken ?? null;
  for (const fn of listeners) fn(session?.user ?? null);
}

/** One refresh at a time: if five requests get a 401 together, they all wait for the same refresh. */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (r) => (r.ok ? ((await r.json()) as Session) : null))
    .catch(() => null)
    .then((s) => {
      setSession(s);
      return s;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    signal: opts.signal,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    const s = await refreshSession();
    if (s) return api<T>(path, opts, true);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const auth = {
  async login(email: string, password: string) {
    const s = await api<Session>('/auth/login', { method: 'POST', body: { email, password } });
    setSession(s);
    return s.user;
  },
  async register(name: string, email: string, password: string) {
    const s = await api<Session>('/auth/register', { method: 'POST', body: { name, email, password } });
    setSession(s);
    return s.user;
  },
  async logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
  },
};

export const newIdempotencyKey = () => crypto.randomUUID();
