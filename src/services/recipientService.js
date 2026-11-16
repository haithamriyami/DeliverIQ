import { parse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { isValidEmailSyntax, checkEmailDomain, normalizeEmail } from '../utils/emailValidation.js';
import { resolveImportListTarget } from '../utils/listSort.js';

/**
 * Every function here works inside one workspace. Contacts, lists and campaigns of other
 * workspaces are never read or changed. A missing workspace is a programming error.
 */
function requireWorkspace(workspaceId) {
  if (!workspaceId) {
    throw new HttpError(500, 'Workspace is missing for this request');
  }
  return workspaceId;
}

export async function createRecipient({ workspaceId, email, name, timezone, notes, listId }) {
  requireWorkspace(workspaceId);
  const normalized = normalizeEmail(email);
  
  if (!isValidEmailSyntax(normalized)) {
    throw new HttpError(400, 'Invalid email address syntax');
  }
  
  const dnsCheck = await checkEmailDomain(normalized);
  if (!dnsCheck.valid) {
    throw new HttpError(400, `Email address is not deliverable: ${dnsCheck.reason}`);
  }
  
  const list = await getContactListById(listId, workspaceId);
  const existing = await prisma.recipient.findUnique({
    where: { workspaceId_email: { workspaceId, email: normalized } },
    include: { list: { select: { id: true, name: true } } },
  });

  if (existing) {
    throw new HttpError(
      409,
      existing.listId === list.id
        ? 'Recipient already exists on this list'
        : `That email is already on ${existing.list?.name || 'another list'}`
    );
  }

  return prisma.recipient.create({
    data: {
      workspaceId,
      email: normalized,
      name,
      timezone: timezone || 'UTC',
      notes: notes || '',
      listId: list.id,
    },
    include: { list: { select: { id: true, name: true } } },
  });
}

export async function listRecipients(workspaceId, status, q, listId) {
  const where = { workspaceId: requireWorkspace(workspaceId) };
  if (status) {
    where.status = status;
  }
  if (listId) {
    where.listId = listId;
  }
  const query = String(q || '').trim();
  if (query) {
    where.OR = [
      { email: { contains: query, mode: 'insensitive' } },
      { name: { contains: query, mode: 'insensitive' } },
      { notes: { contains: query, mode: 'insensitive' } },
    ];
  }
  return prisma.recipient.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { list: { select: { id: true, name: true } } },
  }).then(async (recipients) => {
    const assignments = await campaignAssignmentsForRecipients(recipients.map((row) => row.id), workspaceId);
    return recipients.map((row) => ({
      ...row,
      inCampaigns: assignments.get(row.id) || [],
    }));
  });
}

export async function campaignAssignmentsForRecipients(recipientIds, workspaceId) {
  const map = new Map();
  if (!recipientIds.length) {
    return map;
  }

  const idSet = new Set(recipientIds);
  const [campaigns, rows] = await Promise.all([
    prisma.campaign.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      select: { id: true, name: true, status: true, recipientIds: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.campaignRecipient.findMany({
      where: { recipientId: { in: recipientIds }, ...(workspaceId ? { campaign: { workspaceId } } : {}) },
      select: {
        recipientId: true,
        campaign: { select: { id: true, name: true, status: true } },
      },
    }),
  ]);

  const add = (recipientId, campaign) => {
    if (!campaign || !idSet.has(recipientId)) {
      return;
    }
    if (!map.has(recipientId)) {
      map.set(recipientId, []);
    }
    if (!map.get(recipientId).some((item) => item.id === campaign.id)) {
      map.get(recipientId).push({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
      });
    }
  };

  for (const campaign of campaigns) {
    for (const id of campaign.recipientIds) {
      add(id, campaign);
    }
  }
  for (const row of rows) {
    add(row.recipientId, row.campaign);
  }

  return map;
}

export async function getContactListById(id, workspaceId) {
  requireWorkspace(workspaceId);
  if (!id) {
    throw new HttpError(400, 'Pick a list first, such as Agencies or Restaurants');
  }
  const list = await prisma.contactList.findFirst({ where: { id: String(id), workspaceId } });
  if (!list) {
    throw new HttpError(404, 'List not found');
  }
  return list;
}

export async function ensureDefaultLists(workspaceId) {
  requireWorkspace(workspaceId);
  const existing = await prisma.contactList.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  if (existing.length) {
    return existing;
  }

  await prisma.contactList.createMany({
    data: [{ name: 'Agencies', workspaceId }, { name: 'Restaurants', workspaceId }],
    skipDuplicates: true,
  });
  return prisma.contactList.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

export async function listContactLists(workspaceId) {
  const lists = await ensureDefaultLists(workspaceId);
  const grouped = await prisma.recipient.groupBy({
    by: ['listId'],
    where: { workspaceId },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.listId, row._count._all]));
  return lists.map((list) => ({
    ...list,
    recipientCount: counts.get(list.id) || 0,
  }));
}

export async function createContactList(workspaceId, name) {
  requireWorkspace(workspaceId);
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'List name is required');
  }

  const clash = await prisma.contactList.findFirst({
    where: { workspaceId, name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (clash) {
    throw new HttpError(409, `A list named ${clash.name} already exists`);
  }

  return prisma.contactList.create({ data: { name: trimmed, workspaceId } });
}
/** Find a list by name (case insensitive) or create it. */
export async function ensureListByName(workspaceId, name) {
  requireWorkspace(workspaceId);
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'List name is required');
  }
  const existing = await prisma.contactList.findFirst({
    where: { workspaceId, name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (existing) return existing;
  try {
    return await prisma.contactList.create({ data: { name: trimmed, workspaceId } });
  } catch {
    return prisma.contactList.findFirst({
      where: { workspaceId, name: { equals: trimmed, mode: 'insensitive' } },
    });
  }
}


export async function moveRecipient(workspaceId, id, listId) {
  await getRecipientById(id, workspaceId);
  const list = await getContactListById(listId, workspaceId);
  return prisma.recipient.update({
    where: { id },
    data: { listId: list.id },
    include: { list: { select: { id: true, name: true } } },
  });
}

export async function deleteBouncedRecipients(workspaceId, listId) {
  const result = await prisma.recipient.deleteMany({
    where: {
      workspaceId: requireWorkspace(workspaceId),
      status: 'bounced',
      ...(listId ? { listId } : {}),
    },
  });
  return { deleted: result.count };
}

export async function deleteRecipient(workspaceId, id) {
  const recipient = await getRecipientById(id, workspaceId);
  await prisma.recipient.delete({ where: { id: recipient.id } });
  return { ok: true };
}

export async function getRecipientById(id, workspaceId) {
  requireWorkspace(workspaceId);
  const recipient = await prisma.recipient.findFirst({ where: { id: String(id), workspaceId } });
  if (!recipient) {
    throw new HttpError(404, 'Recipient not found');
  }
  return recipient;
}

/** Mark one contact bounced or unsubscribed. Only that workspace's contact changes. */
export async function markRecipientInactive(recipientId, status) {
  const recipient = await prisma.recipient.findUnique({ where: { id: recipientId } });

  if (!recipient) {
    return null;
  }

  return prisma.recipient.update({
    where: { id: recipient.id },
    data: { status },
  });
}

export async function unsubscribeByToken(token) {
  const recipient = await prisma.recipient.findUnique({
    where: { unsubscribeToken: token },
  });

  if (!recipient) {
    throw new HttpError(404, 'Unsubscribe link is invalid');
  }

  const updated = await prisma.recipient.update({
    where: { id: recipient.id },
    data: { status: 'unsubscribed' },
  });

  return {
    email: updated.email,
    status: updated.status,
  };
}

export async function getUnsubscribePreview(token) {
  const recipient = await prisma.recipient.findUnique({
    where: { unsubscribeToken: token },
    select: { email: true, name: true, status: true },
  });

  if (!recipient) {
    throw new HttpError(404, 'Unsubscribe link is invalid');
  }

  return recipient;
}

function headerMap(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const key = String(header || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    map[key] = index;
  });
  return map;
}

export async function importRecipientsFromCsv(
  csvText,
  listId,
  { workspaceId, autoSort = true, checkDomain = checkEmailDomain } = {}
) {
  const fallbackList = await getContactListById(listId, workspaceId);
  let records;
  try {
    records = parse(csvText, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    throw new HttpError(400, 'Could not parse CSV file');
  }

  if (!records.length) {
    throw new HttpError(400, 'CSV file is empty');
  }

  const headers = headerMap(records[0]);
  const emailIndex = headers.email ?? headers.emailaddress;
  if (emailIndex == null) {
    throw new HttpError(400, 'CSV must include an email column');
  }

  const nameIndex = headers.name ?? headers.fullname;
  const tzIndex = headers.timezone ?? headers.tz;
  const notesIndex = headers.notes ?? headers.note;

  const summary = {
    created: 0,
    updated: 0,
    skippedInvalid: 0,
    skippedDns: 0,
    skippedDuplicate: 0,
    skippedBounced: 0,
    skippedUnsubscribed: 0,
    skippedOtherList: 0,
    otherListName: '',
    autoSort: Boolean(autoSort),
    byList: {},
  };

  const bumpList = (listName) => {
    summary.byList[listName] = (summary.byList[listName] || 0) + 1;
  };

  const listCache = new Map();
  const resolveList = async (timezone, notes) => {
    if (!autoSort) return fallbackList;
    const target = resolveImportListTarget({ timezone, notes });
    if (!target?.listName) return fallbackList;
    if (listCache.has(target.listName)) return listCache.get(target.listName);
    const list = await ensureListByName(workspaceId, target.listName);
    listCache.set(target.listName, list);
    return list;
  };

  const seenInFile = new Set();

  for (const row of records.slice(1)) {
    const email = normalizeEmail(String(row[emailIndex] || ''));
    if (!isValidEmailSyntax(email)) {
      summary.skippedInvalid += 1;
      continue;
    }

    if (seenInFile.has(email)) {
      summary.skippedDuplicate += 1;
      continue;
    }
    seenInFile.add(email);

    const dnsCheck = await checkDomain(email);
    if (!dnsCheck.valid) {
      summary.skippedDns += 1;
      continue;
    }

    const name = nameIndex != null ? String(row[nameIndex] || '').trim() : '';
    const timezone = tzIndex != null ? String(row[tzIndex] || '').trim() : '';
    const notes = notesIndex != null ? String(row[notesIndex] || '').trim() : '';
    const list = await resolveList(timezone, notes);

    const existing = await prisma.recipient.findUnique({
      where: { workspaceId_email: { workspaceId, email } },
      include: { list: { select: { name: true } } },
    });

    if (!existing) {
      await prisma.recipient.create({
        data: {
          workspaceId,
          email,
          name: name || email.split('@')[0],
          timezone: timezone || 'UTC',
          notes: notes || '',
          listId: list.id,
        },
      });
      summary.created += 1;
      bumpList(list.name);
      continue;
    }

    if (existing.listId !== list.id) {
      summary.skippedOtherList += 1;
      summary.otherListName = existing.list?.name || 'another list';
      continue;
    }

    if (existing.status === 'bounced') {
      summary.skippedBounced += 1;
      continue;
    }

    if (existing.status === 'unsubscribed') {
      summary.skippedUnsubscribed += 1;
      continue;
    }

    await prisma.recipient.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        timezone: timezone || existing.timezone,
        notes: notes || existing.notes,
      },
    });
    summary.updated += 1;
    bumpList(list.name);
  }

  return summary;
}

export const UNASSIGNED_LIST_NAME = 'Unassigned';

/** The list that keeps contacts whose list was deleted. Created when first needed. */
export async function ensureUnassignedList(workspaceId, tx = prisma) {
  requireWorkspace(workspaceId);
  const existing = await tx.contactList.findFirst({
    where: { workspaceId, name: { equals: UNASSIGNED_LIST_NAME, mode: 'insensitive' } },
  });
  if (existing) return existing;
  try {
    return await tx.contactList.create({ data: { name: UNASSIGNED_LIST_NAME, workspaceId } });
  } catch {
    return tx.contactList.findFirst({ where: { workspaceId, name: UNASSIGNED_LIST_NAME } });
  }
}

/** Contacts that must never be deleted: on an unfinished campaign, or suppressed. */
async function protectedContactIds(recipients, workspaceId) {
  const ids = recipients.map((row) => row.id);
  const assignments = await campaignAssignmentsForRecipients(ids, workspaceId);
  const inCampaigns = new Set();
  for (const [id, campaigns] of assignments) {
    if (campaigns.some((campaign) => campaign.status !== 'completed')) inCampaigns.add(id);
  }
  // Paused campaigns are not finished either.
  const pausedRows = await prisma.campaign.findMany({
    where: { workspaceId, pausedAt: { not: null } },
    select: { recipientIds: true },
  });
  for (const campaign of pausedRows) {
    for (const id of campaign.recipientIds) if (ids.includes(id)) inCampaigns.add(id);
  }
  const suppressed = new Set(
    recipients
      .filter((row) => row.status === 'bounced' || row.status === 'unsubscribed' || row.doNotContact)
      .map((row) => row.id)
  );
  return { inCampaigns, suppressed };
}

/** What deleting this list would do. Used by the confirm dialog. */
export async function previewListDeletion(workspaceId, id) {
  const list = await getContactListById(id, workspaceId);
  const recipients = await prisma.recipient.findMany({
    where: { listId: list.id },
    select: { id: true, status: true, doNotContact: true },
  });
  const { inCampaigns, suppressed } = await protectedContactIds(recipients, workspaceId);
  const kept = new Set([...inCampaigns, ...suppressed]);
  return {
    id: list.id,
    name: list.name,
    total: recipients.length,
    inActiveCampaigns: inCampaigns.size,
    suppressed: suppressed.size,
    deletable: recipients.length - kept.size,
    isUnassigned: list.name.toLowerCase() === UNASSIGNED_LIST_NAME.toLowerCase(),
  };
}

/**
 * Delete a list.
 * - empty list: deleted.
 * - mode 'list': contacts move to Unassigned, then the list is deleted.
 * - mode 'contacts': contacts are deleted too, EXCEPT contacts on an unfinished campaign
 *   and suppression records (bounced, unsubscribed, do not contact). Those move to
 *   Unassigned so they are still never emailed.
 */
export async function deleteContactList(workspaceId, id, { mode = 'list' } = {}) {
  const list = await getContactListById(id, workspaceId);
  const recipients = await prisma.recipient.findMany({
    where: { listId: list.id },
    select: { id: true, status: true, doNotContact: true },
  });
  const isUnassigned = list.name.toLowerCase() === UNASSIGNED_LIST_NAME.toLowerCase();

  if (recipients.length === 0) {
    await prisma.contactList.delete({ where: { id: list.id } });
    return { deleted: true, name: list.name, contactsDeleted: 0, contactsMoved: 0, keptInCampaigns: 0, keptSuppressed: 0 };
  }

  if (mode !== 'list' && mode !== 'contacts') {
    throw new HttpError(400, 'Choose whether to keep or delete the contacts');
  }

  const { inCampaigns, suppressed } = await protectedContactIds(recipients, workspaceId);
  const keep = mode === 'list' ? recipients.map((row) => row.id) : recipients.filter((row) => inCampaigns.has(row.id) || suppressed.has(row.id)).map((row) => row.id);
  const remove = mode === 'list' ? [] : recipients.filter((row) => !inCampaigns.has(row.id) && !suppressed.has(row.id)).map((row) => row.id);

  if (isUnassigned && keep.length) {
    throw new HttpError(
      400,
      `${keep.length} contacts in Unassigned are on unfinished campaigns or must stay blocked, so this list cannot be removed. Move them to another list first.`
    );
  }

  return prisma.$transaction(async (tx) => {
    let moved = 0;
    if (keep.length) {
      const target = await ensureUnassignedList(workspaceId, tx);
      moved = (await tx.recipient.updateMany({ where: { id: { in: keep } }, data: { listId: target.id } })).count;
    }
    const deletedCount = remove.length ? (await tx.recipient.deleteMany({ where: { id: { in: remove } } })).count : 0;
    await tx.contactList.delete({ where: { id: list.id } });
    return {
      deleted: true,
      name: list.name,
      contactsDeleted: deletedCount,
      contactsMoved: moved,
      keptInCampaigns: mode === 'contacts' ? inCampaigns.size : 0,
      keptSuppressed: mode === 'contacts' ? [...suppressed].filter((sid) => !inCampaigns.has(sid)).length : 0,
    };
  });
}

/** Delete every list that has no contacts. Keeps at least one list. */
export async function deleteEmptyLists(workspaceId) {
  requireWorkspace(workspaceId);
  const lists = await prisma.contactList.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  const grouped = await prisma.recipient.groupBy({ by: ['listId'], where: { workspaceId }, _count: { _all: true } });
  const counts = new Map(grouped.map((row) => [row.listId, row._count._all]));
  let empty = lists.filter((list) => !counts.get(list.id));
  if (empty.length === lists.length) empty = empty.slice(1); // never remove the last list
  if (!empty.length) return { deleted: 0, names: [] };
  const result = await prisma.contactList.deleteMany({
    where: { workspaceId, id: { in: empty.map((list) => list.id) }, recipients: { none: {} } },
  });
  return { deleted: result.count, names: empty.map((list) => list.name) };
}
