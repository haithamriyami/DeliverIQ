import { parse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { isValidEmailSyntax, checkEmailDomain, normalizeEmail } from '../utils/emailValidation.js';

export async function createRecipient({ email, name, timezone, notes, listId }) {
  const normalized = normalizeEmail(email);
  
  if (!isValidEmailSyntax(normalized)) {
    throw new HttpError(400, 'Invalid email address syntax');
  }
  
  const dnsCheck = await checkEmailDomain(normalized);
  if (!dnsCheck.valid) {
    throw new HttpError(400, `Email address is not deliverable: ${dnsCheck.reason}`);
  }
  
  const list = await getContactListById(listId);
  const existing = await prisma.recipient.findUnique({
    where: { email: normalized },
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
      email: normalized,
      name,
      timezone: timezone || 'UTC',
      notes: notes || '',
      listId: list.id,
    },
    include: { list: { select: { id: true, name: true } } },
  });
}

export async function listRecipients(status, q, listId) {
  const where = {};
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
    where: Object.keys(where).length ? where : undefined,
    orderBy: { createdAt: 'desc' },
    include: { list: { select: { id: true, name: true } } },
  }).then(async (recipients) => {
    const assignments = await campaignAssignmentsForRecipients(recipients.map((row) => row.id));
    return recipients.map((row) => ({
      ...row,
      inCampaigns: assignments.get(row.id) || [],
    }));
  });
}

export async function campaignAssignmentsForRecipients(recipientIds) {
  const map = new Map();
  if (!recipientIds.length) {
    return map;
  }

  const idSet = new Set(recipientIds);
  const [campaigns, rows] = await Promise.all([
    prisma.campaign.findMany({
      select: { id: true, name: true, status: true, recipientIds: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.campaignRecipient.findMany({
      where: { recipientId: { in: recipientIds } },
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

export async function getContactListById(id) {
  if (!id) {
    throw new HttpError(400, 'Pick a list first, such as Agencies or Restaurants');
  }
  const list = await prisma.contactList.findUnique({ where: { id } });
  if (!list) {
    throw new HttpError(404, 'List not found');
  }
  return list;
}

export async function ensureDefaultLists() {
  const existing = await prisma.contactList.findMany({ orderBy: { createdAt: 'asc' } });
  if (existing.length) {
    return existing;
  }

  await prisma.contactList.createMany({
    data: [{ name: 'Agencies' }, { name: 'Restaurants' }],
  });
  return prisma.contactList.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function listContactLists() {
  const lists = await ensureDefaultLists();
  const grouped = await prisma.recipient.groupBy({
    by: ['listId'],
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.listId, row._count._all]));
  return lists.map((list) => ({
    ...list,
    recipientCount: counts.get(list.id) || 0,
  }));
}

export async function createContactList(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'List name is required');
  }

  const clash = await prisma.contactList.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (clash) {
    throw new HttpError(409, `A list named ${clash.name} already exists`);
  }

  return prisma.contactList.create({ data: { name: trimmed } });
}

export async function moveRecipient(id, listId) {
  await getRecipientById(id);
  const list = await getContactListById(listId);
  return prisma.recipient.update({
    where: { id },
    data: { listId: list.id },
    include: { list: { select: { id: true, name: true } } },
  });
}

export async function deleteBouncedRecipients(listId) {
  const result = await prisma.recipient.deleteMany({
    where: {
      status: 'bounced',
      ...(listId ? { listId } : {}),
    },
  });
  return { deleted: result.count };
}

export async function deleteRecipient(id) {
  const recipient = await getRecipientById(id);
  await prisma.recipient.delete({ where: { id: recipient.id } });
  return { ok: true };
}

export async function getRecipientById(id) {
  const recipient = await prisma.recipient.findUnique({ where: { id } });
  if (!recipient) {
    throw new HttpError(404, 'Recipient not found');
  }
  return recipient;
}

export async function markRecipientInactive(email, status) {
  const recipient = await prisma.recipient.findUnique({
    where: { email: email.toLowerCase() },
  });

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

export async function importRecipientsFromCsv(csvText, listId) {
  const list = await getContactListById(listId);
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

    const dnsCheck = await checkEmailDomain(email);
    if (!dnsCheck.valid) {
      summary.skippedDns += 1;
      continue;
    }

    const name = nameIndex != null ? String(row[nameIndex] || '').trim() : '';
    const timezone = tzIndex != null ? String(row[tzIndex] || '').trim() : '';
    const notes = notesIndex != null ? String(row[notesIndex] || '').trim() : '';

    const existing = await prisma.recipient.findUnique({
      where: { email },
      include: { list: { select: { name: true } } },
    });

    if (!existing) {
      await prisma.recipient.create({
        data: {
          email,
          name: name || email.split('@')[0],
          timezone: timezone || 'UTC',
          notes: notes || '',
          listId: list.id,
        },
      });
      summary.created += 1;
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
  }

  return summary;
}
