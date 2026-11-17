/**
 * After the organization migration is applied in production, backfill organization
 * for contacts in the ReportCopilot workspace owned by haithamsoud822
 * (b24d2b81-eae4-4188-852d-fd90df1cbe31) from the batch2 and batch3 CSV files.
 *
 * Default is a dry run (SELECT and report only). Pass "go" to write.
 * Never point this at a workspace other than the one hard-coded below.
 */
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const WS = 'b24d2b81-eae4-4188-852d-fd90df1cbe31';
const FILES = [
  '/workspace/outreach/batch2_deliveriq.csv',
  '/workspace/outreach/batch3_deliveriq.csv',
];
const DRY = process.argv[2] !== 'go';

function rowsFrom(file) {
  const records = parse(fs.readFileSync(file, 'utf8'), {
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    columns: true,
  });
  return records.map((row) => ({
    email: String(row.email || '').trim().toLowerCase(),
    organization: String(row.organization || row.organisation || row.company || '').trim(),
  })).filter((row) => row.email);
}

const fromFiles = new Map();
for (const file of FILES) {
  for (const row of rowsFrom(file)) {
    if (!fromFiles.has(row.email) || row.organization) fromFiles.set(row.email, row);
  }
}

const prisma = new PrismaClient();
try {
  const hasColumn = await prisma.$queryRawUnsafe(
    "select 1 from information_schema.columns where table_name = 'recipients' and column_name = 'organization' limit 1"
  );
  if (!hasColumn.length) {
    console.error('The organization column is not on recipients yet. Apply the migration first, after this pull request is merged to production.');
    process.exit(1);
  }
  const contacts = await prisma.recipient.findMany({
    where: { workspaceId: WS },
    select: { id: true, email: true, name: true, organization: true },
  });
  const matches = [];
  const missingInCsv = [];
  const missingOrg = [];
  for (const contact of contacts) {
    const row = fromFiles.get(String(contact.email).toLowerCase());
    if (!row) {
      missingInCsv.push(contact.email);
      continue;
    }
    if (!row.organization) {
      missingOrg.push(contact.email);
      continue;
    }
    matches.push({ id: contact.id, email: contact.email, organization: row.organization, current: contact.organization });
  }
  const unmatchedCsv = [...fromFiles.keys()].filter(
    (email) => !contacts.some((c) => String(c.email).toLowerCase() === email)
  );
  console.log(JSON.stringify({
    dry: DRY,
    workspace: WS,
    contactsInWorkspace: contacts.length,
    csvRows: fromFiles.size,
    matches: matches.length,
    alreadySet: matches.filter((m) => m.current === m.organization).length,
    wouldUpdate: matches.filter((m) => m.current !== m.organization).length,
    missingInCsv: missingInCsv.length,
    missingOrgInCsv: missingOrg.length,
    unmatchedCsvEmails: unmatchedCsv.length,
    missingInCsvSample: missingInCsv.slice(0, 10),
    unmatchedCsvSample: unmatchedCsv.slice(0, 10),
  }, null, 2));

  if (DRY) process.exit(0);

  let updated = 0;
  for (const row of matches) {
    if (row.current === row.organization) continue;
    await prisma.recipient.update({
      where: { id: row.id },
      data: { organization: row.organization },
    });
    updated += 1;
  }
  console.log(JSON.stringify({ updated }, null, 2));
} finally {
  await prisma.$disconnect();
}
