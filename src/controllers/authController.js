import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireOwner, setAuthCookie, clearAuthCookie, publicUser } from '../middleware/auth.js';
import * as authService from '../services/authService.js';
import { env } from '../config/env.js';
import { sendgridEnabled } from '../config/sendgrid.js';
import * as gmailService from '../services/gmailService.js';
import { isPrivateAppUrl } from '../utils/tracking.js';

const credentialsSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const passwordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const registerSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    workspaceName: z.string().min(1).optional(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const inviteSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const acceptSchema = z.object({
  body: z.object({
    token: z.string().min(8),
    name: z.string().min(1),
    password: z.string().min(8),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const status = asyncHandler(async (_req, res) => {
  const setup = await authService.setupStatus();
  res.json({
    ...setup,
    sendgrid: {
      enabled: sendgridEnabled,
      dryRun: env.sendgrid.dryRun,
      fromEmail: env.sendgrid.fromEmail,
      fromName: env.sendgrid.fromName,
    },
    google: {
      configured: gmailService.googleConfigured(),
      redirectUri: env.google.redirectUri,
    },
  });
});

export const register = [
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.registerOwner(req.validated.body);
    setAuthCookie(res, user);
    res.status(201).json({ user: publicUser(user) });
  }),
];

export const login = [
  validate(credentialsSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.login(req.validated.body);
    setAuthCookie(res, user);
    res.json({ user: publicUser(user) });
  }),
];

export const logout = asyncHandler(async (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

export const changePassword = [
  requireAuth,
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    await authService.updatePassword(req.user.id, req.validated.body);
    res.json({ ok: true });
  }),
];

export const me = [
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      user: publicUser(req.user),
      sendgrid: {
        enabled: sendgridEnabled,
        dryRun: env.sendgrid.dryRun,
        fromEmail: env.sendgrid.fromEmail,
        fromName: env.sendgrid.fromName,
      },
      google: await gmailService.gmailStatus(req.user.workspaceId),
      tracking: {
        appUrl: env.appUrl,
        public: !isPrivateAppUrl(env.appUrl),
      },
    });
  }),
];

export const invite = [
  requireAuth,
  requireOwner,
  validate(inviteSchema),
  asyncHandler(async (req, res) => {
    const invite = await authService.createInvite({
      email: req.validated.body.email,
      workspaceId: req.user.workspaceId,
      invitedById: req.user.id,
    });
    res.status(201).json(invite);
  }),
];

export const invitePreview = asyncHandler(async (req, res) => {
  const invite = await authService.getInvite(String(req.query.token || ''));
  res.json({
    email: invite.email,
    workspaceName: invite.workspace.name,
  });
});

export const acceptInvite = [
  validate(acceptSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.acceptInvite(req.validated.body);
    setAuthCookie(res, user);
    res.json({ user: publicUser(user) });
  }),
];

export const team = [
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await authService.listTeam(req.user.workspaceId);
    res.json(team);
  }),
];
