/**
 * Turn a CSV notes field and timezone/country column into a contact list name
 * like "Agencies (South Africa)" or "Salons & Barbers".
 */

/** Ordered so longer/more specific keys win when matching. */
const SECTOR_RULES = [
  { keys: ['auto repair', 'autorepair', 'garage', 'garages'], name: 'Auto Repair' },
  { keys: ['co-working', 'coworking', 'co working', 'hub-cowork', 'hub cowork'], name: 'Co-working Spaces' },
  { keys: ['hardware', 'building materials', 'building material'], name: 'Hardware' },
  { keys: ['laundry', 'cleaning'], name: 'Laundry & Cleaning' },
  { keys: ['real estate', 'realestate', 'realtor'], name: 'Real Estate' },
  { keys: ['e-commerce', 'ecommerce', 'e commerce'], name: 'E-commerce' },
  { keys: ['electronics', 'phone shop', 'phone shops'], name: 'Electronics' },
  { keys: ['beauty', 'salon', 'salons', 'barber', 'barbers', 'hair'], name: 'Salons & Barbers' },
  { keys: ['agency', 'agencies'], name: 'Agencies' },
  { keys: ['restaurant', 'restaurants'], name: 'Restaurants' },
  { keys: ['retail', 'retails'], name: 'Retail' },
  { keys: ['construction'], name: 'Construction' },
  { keys: ['bakery', 'bakeries', 'baker', 'bakers'], name: 'Bakeries' },
  { keys: ['freelancer', 'freelancers', 'freelance'], name: 'Freelancers' },
  { keys: ['logistics'], name: 'Logistics' },
  { keys: ['fashion'], name: 'Fashion' },
  { keys: ['hospitality', 'hotel', 'hotels'], name: 'Hospitality' },
];

/** UTC / GMT style values that are not a country. */
const OFFSET_RE = /^(utc|gmt|zulu)?\s*[+-]?\d{1,2}(:\d{2})?$/i;
const PURE_OFFSET_RE = /^[+-]\d{1,2}(:\d{2})?$/;
const UTC_ONLY_RE = /^(utc|gmt|zulu)$/i;

export function normalizeSectorKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function mapSector(raw) {
  const key = normalizeSectorKey(raw);
  if (!key) return null;
  for (const rule of SECTOR_RULES) {
    if (rule.keys.some((k) => key === k || key.includes(k))) return rule.name;
  }
  return null;
}

/**
 * Pull the sector token out of a pipe-separated notes string.
 * Typical shape: "named | agency | South Africa | https://..."
 */
export function sectorFromNotes(notes) {
  const parts = String(notes || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  // Prefer the second segment when it looks like a sector.
  if (parts.length >= 2) {
    const second = mapSector(parts[1]);
    if (second) return second;
  }
  for (const part of parts) {
    const mapped = mapSector(part);
    if (mapped) return mapped;
  }
  return null;
}

export function isTimezoneOffset(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (UTC_ONLY_RE.test(raw)) return true;
  if (PURE_OFFSET_RE.test(raw)) return true;
  if (/^(utc|gmt)/i.test(raw) && OFFSET_RE.test(raw.replace(/\s+/g, ''))) return true;
  // "UTC+3", "GMT-05:00", "UTC +3"
  if (/^(utc|gmt)\s*[+-]\d/i.test(raw)) return true;
  return false;
}

/**
 * Country from the timezone column. Empty or a UTC offset means unknown.
 * Also accepts a country found in the notes third segment as a fallback.
 */
export function countryFromTimezone(timezone, notes = '') {
  const tz = String(timezone || '').trim();
  if (tz && !isTimezoneOffset(tz)) {
    return titleCaseCountry(tz);
  }
  const parts = String(notes || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    const candidate = parts[2];
    if (candidate && !isTimezoneOffset(candidate) && !/^https?:\/\//i.test(candidate)) {
      return titleCaseCountry(candidate);
    }
  }
  return null;
}

function titleCaseCountry(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      if (/^[A-Z]{2,3}$/.test(word)) return word; // UK, USA, UAE
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Build the list name. Sector only when country is unknown. */
export function listNameFor({ sector, country }) {
  if (!sector) return null;
  if (!country) return sector;
  return `${sector} (${country})`;
}

/**
 * Resolve where a CSV row should land.
 * Returns null when there is no recognizable sector (caller keeps the selected list).
 */
export function resolveImportListTarget({ timezone, notes }) {
  const sector = sectorFromNotes(notes);
  if (!sector) return null;
  const country = countryFromTimezone(timezone, notes);
  return {
    sector,
    country,
    listName: listNameFor({ sector, country }),
  };
}

export function formatImportSummary(summary) {
  const byList = summary.byList || {};
  const listParts = Object.entries(byList)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} into ${name}`);
  const imported = summary.created || 0;
  let head =
    imported === 0
      ? 'Imported 0'
      : listParts.length
        ? `Imported ${imported}: ${listParts.join(', ')}`
        : `Imported ${imported}`;
  const extras = [];
  if (summary.updated) extras.push(`${summary.updated} updated`);
  if (summary.skippedInvalid) extras.push(`${summary.skippedInvalid} bad address`);
  if (summary.skippedDns) extras.push(`${summary.skippedDns} bad domain`);
  if (summary.skippedDuplicate) extras.push(`${summary.skippedDuplicate} duplicate in file`);
  if (summary.skippedBounced) extras.push(`${summary.skippedBounced} bounced`);
  if (summary.skippedUnsubscribed) extras.push(`${summary.skippedUnsubscribed} unsubscribed`);
  if (summary.skippedOtherList) {
    extras.push(
      `${summary.skippedOtherList} already on ${summary.otherListName || 'another list'}`
    );
  }
  if (extras.length) head = `${head}. ${extras.join(', ')}`;
  return head;
}
