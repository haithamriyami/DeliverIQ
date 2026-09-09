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

export async function registerOwner({ name, email, password, workspaceName }) {
  const existing = await prisma.user.count();
  if (existing > 0) {
    throw new HttpError(409, 'Workspace already exists. Ask the owner for an invite.');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: workspaceName || 'DeliverIQ' },
    });

    return tx.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash,
        role: 'owner',
        workspaceId: workspace.id,
      },
      include: { workspace: true },
    });
  });
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

export async function createInvite({ email, workspaceId, invitedById }) {
  const normalized = email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    throw new HttpError(409, 'That email already has an account');
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

export async function acceptInvite({ token, name, password }) {
  const invite = await getInvite(token);
  const existing = await prisma.user.findUnique({
    where: { email: invite.email },
  });
  if (existing) {
    throw new HttpError(409, 'That email already has an account');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name,
        email: invite.email,
        passwordHash,
        role: invite.role,
        workspaceId: invite.workspaceId,
      },
      include: { workspace: true },
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
  const [users, invites] = await Promise.all([
    prisma.user.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    }),
    prisma.invite.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { users, invites };
}
