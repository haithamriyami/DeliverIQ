import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireOwner, setAuthCookie, clearAuthCookie, publicUser, activeUser } from '../middleware/auth.js';
import * as authService from '../services/authService.js';
import { env } from '../config/env.js';
import { sendgridKeyConfigured } from '../config/sendgrid.js';
import { sendGridSettings } from '../services/sendgridService.js';
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
    // Not needed when the invited email already has an account.
    name: z.string().optional(),
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
      keyConfigured: sendgridKeyConfigured,
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
    const user = await activeUser(await authService.registerOwner(req.validated.body));
    setAuthCookie(res, user);
    res.status(201).json({ user: publicUser(user) });
  }),
];

export const login = [
  validate(credentialsSchema),
  asyncHandler(async (req, res) => {
    const user = await activeUser(await authService.login(req.validated.body));
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
      workspaces: await authService.listWorkspacesForUser(req.user.id),
      sendgrid: await sendGridSettings(req.user.workspaceId),
      google: await gmailService.gmailStatus(req.user.id, req.user.workspaceId),
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
    existingAccount: await authService.inviteHasAccount(invite),
  });
});

export const acceptInvite = [
  validate(acceptSchema),
  asyncHandler(async (req, res) => {
    const joined = await authService.acceptInvite(req.validated.body);
    const user = await activeUser(joined, joined.workspaceId);
    setAuthCookie(res, user, user.workspaceId);
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

const workspaceNameSchema = z.object({
  body: z.object({ name: z.string().trim().min(1).max(80) }),
  params: z.any().optional(),
  query: z.any().optional(),
});

const switchSchema = z.object({
  body: z.object({ workspaceId: z.string().uuid() }),
  params: z.any().optional(),
  query: z.any().optional(),
});

/** Workspaces the logged in user belongs to, and which one is active. */
export const workspaces = [
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      activeWorkspaceId: req.user.workspaceId,
      workspaces: await authService.listWorkspacesForUser(req.user.id),
    });
  }),
];

/** Create a new empty workspace and switch to it. */
export const createWorkspace = [
  requireAuth,
  validate(workspaceNameSchema),
  asyncHandler(async (req, res) => {
    const workspace = await authService.createWorkspace(req.user.id, req.validated.body.name);
    await authService.switchWorkspace(req.user.id, workspace.id);
    const user = await activeUser(req.user, workspace.id);
    setAuthCookie(res, user, workspace.id);
    res.status(201).json({ user: publicUser(user), workspace: { id: workspace.id, name: workspace.name, role: 'owner' } });
  }),
];

/** Switch the active workspace for this session. */
export const switchWorkspace = [
  requireAuth,
  validate(switchSchema),
  asyncHandler(async (req, res) => {
    const membership = await authService.switchWorkspace(req.user.id, req.validated.body.workspaceId);
    const user = await activeUser(req.user, membership.workspaceId);
    setAuthCookie(res, user, membership.workspaceId);
    res.json({ user: publicUser(user) });
  }),
];

/** Rename the active workspace. Owners only. */
export const renameWorkspace = [
  requireAuth,
  requireOwner,
  validate(workspaceNameSchema),
  asyncHandler(async (req, res) => {
    const workspace = await authService.renameWorkspace(req.user.workspaceId, req.validated.body.name);
    res.json({ id: workspace.id, name: workspace.name });
  }),
];
