import { parse, requireUser, UnauthorizedError } from '@showtime/common';
import { Router } from 'express';
import { z } from 'zod';

const REFRESH_COOKIE = 'st_refresh';

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function authRoutes(auth, cookie) {
  const router = Router();

  // The refresh token lives in an httpOnly cookie: JavaScript (and therefore XSS) cannot read it.
  // The short-lived access token is returned in the body and kept in memory by the frontend.
  const sendSession = (res, session, status = 200) => {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'lax',
      path: cookie.path,
      expires: session.refreshTokenExpiresAt,
    });
    res.status(status).json({
      user: session.user,
      accessToken: session.accessToken,
      expiresIn: session.accessTokenExpiresIn,
    });
  };

  const refreshTokenFrom = (req) =>
    readCookie(req, REFRESH_COOKIE) ?? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);

  router.post('/register', async (req, res) => {
    const body = parse(registerSchema, req.body);
    sendSession(res, await auth.register(body, req.header('user-agent')), 201);
  });

  router.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body);
    sendSession(res, await auth.login(body.email, body.password, req.header('user-agent')));
  });

  router.post('/refresh', async (req, res) => {
    const token = refreshTokenFrom(req);
    if (!token) throw new UnauthorizedError('No refresh token');
    try {
      sendSession(res, await auth.refresh(token, req.header('user-agent')));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { path: cookie.path });
      throw err;
    }
  });

  router.post('/logout', async (req, res) => {
    const token = refreshTokenFrom(req);
    if (token) await auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: cookie.path });
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    const user = requireUser(req);
    res.json({ user: await auth.getUser(user.id) });
  });

  return router;
}
