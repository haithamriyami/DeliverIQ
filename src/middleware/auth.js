import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from './errorHandler.js';

const COOKIE = 'deliveriq_token';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function signUserToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role, workspaceId: user.workspaceId },
    env.sessionSecret,
    { expiresIn: '7d' }
  );
}

export function setAuthCookie(res, user) {
  res.cookie(COOKIE, signUserToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(env.appUrl).startsWith('https:'),
    maxAge: WEEK_MS,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workspaceId: user.workspaceId,
    workspace: user.workspace
      ? { id: user.workspace.id, name: user.workspace.name }
      : undefined,
  };
}

export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) {
      throw new HttpError(401, 'Please log in');
    }

    let payload;
    try {
      payload = jwt.verify(token, env.sessionSecret);
    } catch {
      throw new HttpError(401, 'Session expired. Please log in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { workspace: true },
    });

    if (!user) {
      throw new HttpError(401, 'Please log in');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireOwner(req, _res, next) {
  if (req.user?.role !== 'owner') {
    return next(new HttpError(403, 'Only the workspace owner can do that'));
  }
  next();
}
