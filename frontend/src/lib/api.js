export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The access token lives only in memory (never localStorage, where any XSS could read it).
// The refresh token is an httpOnly cookie the browser sends to /api/auth/* automatically.
let accessToken = null;
let refreshing = null;
const listeners = new Set();

export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSession(session) {
  accessToken = session?.accessToken ?? null;
  for (const fn of listeners) fn(session?.user ?? null);
}

/** One refresh at a time: if five requests get a 401 together, they all wait for the same refresh. */
export function refreshSession() {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (r) => (r.ok ? await r.json() : null))
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

export async function api(path, opts = {}, retried = false) {
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
    if (s) return api(path, opts, true);
  }
  if (res.status === 204) return undefined;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data;
}

export const auth = {
  async login(email, password) {
    const s = await api('/auth/login', { method: 'POST', body: { email, password } });
    setSession(s);
    return s.user;
  },
  async register(name, email, password) {
    const s = await api('/auth/register', { method: 'POST', body: { name, email, password } });
    setSession(s);
    return s.user;
  },
  async logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
  },
};

export const newIdempotencyKey = () => crypto.randomUUID();
