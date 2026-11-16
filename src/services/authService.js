import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';

const SALT_ROUNDS = 10;

export async function setupStatus() {
  const userCount = await prisma.user.count();
  return { setupRequired: userCount === 0 };
}

/**
 * Sign up. Every new account gets its own workspace and owns it. Joining someone else's
 * workspace only happens through an invite.
 */
export async function registerOwner({ name, email, password, workspaceName }) {
  const emailNormalized = email.toLowerCase();
  const already = await prisma.user.findUnique({ where: { email: emailNormalized } });
  if (already) {
    throw new HttpError(409, 'That email already has an account. Log in instead.');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: String(workspaceName || '').trim() || `${name}'s workspace` },
    });

    const user = await tx.user.create({
      data: {
        name,
        email: emailNormalized,
        passwordHash,
        role: 'owner',
        workspaceId: workspace.id,
      },
      include: { workspace: true },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
    });
    return user;
  });
}

/** Workspaces this user belongs to, with their role in each. */
export async function listWorkspacesForUser(userId) {
  const rows = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true, createdAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    role: row.role,
    createdAt: row.workspace.createdAt,
  }));
}

/** Create a new, empty workspace. The creator owns it. */
export async function createWorkspace(userId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'Workspace name is required');
  }
  const mine = await listWorkspacesForUser(userId);
  if (mine.some((ws) => ws.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new HttpError(409, `You already have a workspace named ${trimmed}`);
  }
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: trimmed } });
    await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role: 'owner' } });
    return workspace;
  });
}

/** Check membership before switching. Also remembers it as the user's default workspace. */
export async function switchWorkspace(userId, workspaceId) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: true },
  });
  if (!membership) {
    throw new HttpError(404, 'Workspace not found');
  }
  await prisma.user.update({ where: { id: userId }, data: { workspaceId } });
  return membership;
}

export async function renameWorkspace(workspaceId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'Workspace name is required');
  }
  return prisma.workspace.update({ where: { id: workspaceId }, data: { name: trimmed } });
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { workspace: true },
  });

  if (!user) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new HttpError(401, 'Invalid email or password');
  }

  return user;
}

export async function updatePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) {
    throw new HttpError(400, 'Current password is incorrect');
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return { ok: true };
}

/**
 * Invite someone into this workspace. People who already have a DeliverIQ account can be
 * invited too: they keep their own workspaces and gain this one, with its own role.
 */
export async function createInvite({ email, workspaceId, invitedById }) {
  const normalized = email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
    });
    if (member) {
      throw new HttpError(409, 'That person is already a member of this workspace');
    }
  }

  await prisma.invite.updateMany({
    where: { email: normalized, workspaceId, acceptedAt: null },
    data: { expiresAt: new Date() },
  });

  const invite = await prisma.invite.create({
    data: {
      email: normalized,
      token: crypto.randomBytes(24).toString('hex'),
      role: 'member',
      workspaceId,
      invitedById,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    ...invite,
    existingAccount: Boolean(existingUser),
    inviteUrl: `${env.appUrl}/#invite=${invite.token}`,
  };
}

export async function getInvite(token) {
  const invite = await prisma.invite.findUnique({
    where: { token },
    include: { workspace: true },
  });

  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    throw new HttpError(400, 'Invite is invalid or expired');
  }

  return invite;
}

/** Whether the invited email already has an account (they then join with their password). */
export async function inviteHasAccount(invite) {
  return Boolean(await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } }));
}

/**
 * Accept an invite. A new person creates their account here. Someone who already has an
 * account confirms with their existing password and is added to this workspace as well;
 * their other workspaces are untouched.
 */
export async function acceptInvite({ token, name, password }) {
  const invite = await getInvite(token);
  const existing = await prisma.user.findUnique({
    where: { email: invite.email },
  });

  if (existing) {
    const ok = await bcrypt.compare(password, existing.passwordHash);
    if (!ok) {
      throw new HttpError(401, 'Enter your existing DeliverIQ password to join this workspace');
    }
    return prisma.$transaction(async (tx) => {
      const already = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: existing.id } },
      });
      if (!already) {
        await tx.workspaceMember.create({
          data: { workspaceId: invite.workspaceId, userId: existing.id, role: invite.role },
        });
      }
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      return tx.user.update({
        where: { id: existing.id },
        data: { workspaceId: invite.workspaceId },
        include: { workspace: true },
      });
    });
  }

  if (!String(name || '').trim()) {
    throw new HttpError(400, 'Your name is required');
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: String(name).trim(),
        email: invite.email,
        passwordHash,
        role: invite.role,
        workspaceId: invite.workspaceId,
      },
      include: { workspace: true },
    });

    await tx.workspaceMember.create({
      data: { workspaceId: invite.workspaceId, userId: created.id, role: invite.role },
    });

    await tx.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    return created;
  });

  return user;
}

export async function listTeam(workspaceId) {
  const [members, invites] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true, createdAt: true } } },
    }),
    prisma.invite.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const users = members.map((row) => ({
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    createdAt: row.user.createdAt,
  }));
  return { users, invites };
}
