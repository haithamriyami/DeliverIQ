import { prisma } from '../../src/lib/prisma.js';

/**
 * Link a Gmail address for a member in one workspace, the way Connect Gmail does.
 * Reuses the gmail_accounts row if the address is already connected elsewhere.
 */
export async function linkGmail({ userId, workspaceId, email, refreshToken = 'enc', ...extra }) {
  const address = email.toLowerCase();
  const account = await prisma.gmailAccount.upsert({
    where: { email: address },
    create: { email: address, refreshToken, connectedAt: new Date(), connectedById: userId, ...extra },
    update: { refreshToken, ...extra },
  });
  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { gmailAccountId: account.id },
  });
  return account;
}
