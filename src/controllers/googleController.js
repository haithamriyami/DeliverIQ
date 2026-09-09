import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import * as gmailService from '../services/gmailService.js';

function signGoogleState(user) {
  return jwt.sign(
    { userId: user.id, workspaceId: user.workspaceId },
    env.sessionSecret,
    { expiresIn: '10m' }
  );
}

function requestHost(req) {
  return String(req.get('host') || '').split(':')[0];
}

function appHost() {
  try {
    return new URL(env.appUrl).hostname;
  } catch {
    return '';
  }
}

export const start = [
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const expected = appHost();
    const actual = requestHost(req);
    if (expected && actual && expected !== actual && expected !== '127.0.0.1' && expected !== 'localhost') {
      return res.redirect(`${env.appUrl}/auth/google`);
    }
    res.redirect(gmailService.gmailAuthUrl(signGoogleState(req.user)));
  }),
];

export const callback = asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    throw new HttpError(400, `Google authorization failed: ${error}`);
  }
  if (!code || !state) {
    throw new HttpError(400, 'Missing Google authorization code');
  }

  let payload;
  try {
    payload = jwt.verify(String(state), env.sessionSecret);
  } catch {
    throw new HttpError(400, 'Google sign-in expired. Try Connect Gmail again.');
  }

  await gmailService.connectGmail({
    workspaceId: payload.workspaceId,
    code: String(code),
  });

  res.redirect('/#settings');
});

export const disconnect = [
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    await gmailService.disconnectGmail(req.user.workspaceId);
    res.json({ ok: true });
  }),
];
