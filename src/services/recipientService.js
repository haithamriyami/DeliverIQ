import { parse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

export async function createRecipient({ email, name, timezone, notes }) {
  const existing = await prisma.recipient.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existing) {
    throw new HttpError(409, 'Recipient already exists', { email: existing.email });
  }

  return prisma.recipient.create({
    data: {
      email: email.toLowerCase(),
      name,
      timezone: timezone || 'UTC',
      notes: notes || '',
    },
  });
}

export async function listRecipients(status, q) {
  const where = {};
  if (status) {
    where.status = status;
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
  });
}

export async function deleteBouncedRecipients() {
  const result = await prisma.recipient.deleteMany({
    where: { status: 'bounced' },
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

export async function importRecipientsFromCsv(csvText) {
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
    skippedBounced: 0,
    skippedUnsubscribed: 0,
  };

  for (const row of records.slice(1)) {
    const email = String(row[emailIndex] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      summary.skippedInvalid += 1;
      continue;
    }

    const name = nameIndex != null ? String(row[nameIndex] || '').trim() : '';
    const timezone = tzIndex != null ? String(row[tzIndex] || '').trim() : '';
    const notes = notesIndex != null ? String(row[notesIndex] || '').trim() : '';

    const existing = await prisma.recipient.findUnique({ where: { email } });

    if (!existing) {
      await prisma.recipient.create({
        data: {
          email,
          name: name || email.split('@')[0],
          timezone: timezone || 'UTC',
          notes: notes || '',
        },
      });
      summary.created += 1;
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
