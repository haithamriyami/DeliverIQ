import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from './errorHandler.js';

const COOKIE = 'deliveriq_token';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The token carries the active workspace. Pass workspaceId to switch; otherwise the
 * user's current workspaceId (their default, or the active one set by requireAuth) is used.
 */
export function signUserToken(user, workspaceId = user.workspaceId) {
  return jwt.sign(
    { userId: user.id, workspaceId },
    env.sessionSecret,
    { expiresIn: '7d' }
  );
}

export function setAuthCookie(res, user, workspaceId = user.workspaceId) {
  res.cookie(COOKIE, signUserToken(user, workspaceId), {
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
    });

    if (!user) {
      throw new HttpError(401, 'Please log in');
    }

    // Everything downstream reads req.user.workspaceId and req.user.role, so they always
    // describe the active workspace and the role in it, never another workspace.
    req.user = await activeUser(user, payload.workspaceId);
    req.workspaceId = req.user.workspaceId;

    // The page sends the workspace it is showing. If another tab switched workspace since,
    // refuse instead of silently writing into the other workspace.
    const shown = req.get?.('x-workspace-id');
    if (shown && shown !== req.workspaceId) {
      throw new HttpError(409, 'You switched workspace in another tab. Reload this page to continue.');
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** The user as seen inside one workspace: workspaceId and role come from the membership. */
export async function activeUser(user, requestedWorkspaceId) {
  const membership = await resolveMembership(user, requestedWorkspaceId);
  if (!membership) {
    throw new HttpError(403, 'You are not a member of any workspace. Ask an owner to invite you.');
  }
  return {
    ...user,
    defaultWorkspaceId: user.workspaceId,
    workspaceId: membership.workspaceId,
    role: membership.role,
    workspace: membership.workspace,
  };
}

/**
 * The membership for the requested workspace. If the user is no longer a member of it
 * (or the token has none), fall back to their default workspace, then any membership.
 */
export async function resolveMembership(user, requestedWorkspaceId) {
  const include = { workspace: true };
  for (const workspaceId of [requestedWorkspaceId, user.workspaceId]) {
    if (!workspaceId) continue;
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      include,
    });
    if (membership) return membership;
  }
  return prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    include,
  });
}

export function requireOwner(req, _res, next) {
  if (req.user?.role !== 'owner') {
    return next(new HttpError(403, 'Only the workspace owner can do that'));
  }
  next();
}
