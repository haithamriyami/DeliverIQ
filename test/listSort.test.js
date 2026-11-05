import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSector,
  sectorFromNotes,
  countryFromTimezone,
  isTimezoneOffset,
  listNameFor,
  resolveImportListTarget,
  formatImportSummary,
} from '../src/utils/listSort.js';

test('mapSector covers agency beauty and other known sectors', () => {
  assert.equal(mapSector('agency'), 'Agencies');
  assert.equal(mapSector('Agencies'), 'Agencies');
  assert.equal(mapSector('beauty'), 'Salons & Barbers');
  assert.equal(mapSector('salon'), 'Salons & Barbers');
  assert.equal(mapSector('barber'), 'Salons & Barbers');
  assert.equal(mapSector('hair'), 'Salons & Barbers');
  assert.equal(mapSector('retail'), 'Retail');
  assert.equal(mapSector('construction'), 'Construction');
  assert.equal(mapSector('electronics'), 'Electronics');
  assert.equal(mapSector('bakery'), 'Bakeries');
  assert.equal(mapSector('restaurant'), 'Restaurants');
  assert.equal(mapSector('freelancer'), 'Freelancers');
  assert.equal(mapSector('co-working'), 'Co-working Spaces');
  assert.equal(mapSector('coworking'), 'Co-working Spaces');
  assert.equal(mapSector('logistics'), 'Logistics');
  assert.equal(mapSector('auto repair'), 'Auto Repair');
  assert.equal(mapSector('hardware'), 'Hardware');
  assert.equal(mapSector('e-commerce'), 'E-commerce');
  assert.equal(mapSector('fashion'), 'Fashion');
  assert.equal(mapSector('real estate'), 'Real Estate');
  assert.equal(mapSector('laundry'), 'Laundry & Cleaning');
  assert.equal(mapSector('hospitality'), 'Hospitality');
  assert.equal(mapSector('unknown-thing'), null);
});

test('sectorFromNotes reads the pipe-separated sector token', () => {
  assert.equal(
    sectorFromNotes('named | agency | South Africa | https://example.com/contact'),
    'Agencies'
  );
  assert.equal(
    sectorFromNotes('named | beauty | Canada | https://example.com'),
    'Salons & Barbers'
  );
  assert.equal(sectorFromNotes('just a note'), null);
  assert.equal(sectorFromNotes(''), null);
});

test('countryFromTimezone prefers country names and ignores UTC offsets', () => {
  assert.equal(countryFromTimezone('South Africa'), 'South Africa');
  assert.equal(countryFromTimezone('canada'), 'Canada');
  assert.equal(countryFromTimezone('United Kingdom'), 'United Kingdom');
  assert.equal(countryFromTimezone('UTC'), null);
  assert.equal(countryFromTimezone('UTC+3'), null);
  assert.equal(countryFromTimezone('GMT-05:00'), null);
  assert.equal(countryFromTimezone('+02:00'), null);
  assert.equal(isTimezoneOffset('UTC+2'), true);
  assert.equal(
    countryFromTimezone('UTC', 'named | agency | Kenya | https://x.test'),
    'Kenya'
  );
});

test('list names use sector (country) with no em or en dashes', () => {
  assert.equal(listNameFor({ sector: 'Agencies', country: 'South Africa' }), 'Agencies (South Africa)');
  assert.equal(listNameFor({ sector: 'Salons & Barbers', country: 'Canada' }), 'Salons & Barbers (Canada)');
  assert.equal(listNameFor({ sector: 'Agencies', country: null }), 'Agencies');
  const name = listNameFor({ sector: 'Agencies', country: 'South Africa' });
  assert.equal(/[—–]/.test(name), false);
});

test('resolveImportListTarget builds the full target', () => {
  assert.deepEqual(
    resolveImportListTarget({
      timezone: 'South Africa',
      notes: 'named | agency | South Africa | https://a.test',
    }),
    { sector: 'Agencies', country: 'South Africa', listName: 'Agencies (South Africa)' }
  );
  assert.deepEqual(
    resolveImportListTarget({
      timezone: 'Canada',
      notes: 'named | beauty | Canada | https://b.test',
    }),
    { sector: 'Salons & Barbers', country: 'Canada', listName: 'Salons & Barbers (Canada)' }
  );
  assert.equal(
    resolveImportListTarget({ timezone: 'South Africa', notes: 'no sector here' }),
    null
  );
  assert.deepEqual(
    resolveImportListTarget({
      timezone: 'UTC+3',
      notes: 'named | agency | | https://c.test',
    }),
    { sector: 'Agencies', country: null, listName: 'Agencies' }
  );
});

test('formatImportSummary matches the toast wording', () => {
  const text = formatImportSummary({
    created: 40,
    byList: {
      'Salons & Barbers (Canada)': 18,
      'Agencies (South Africa)': 22,
    },
    skippedOtherList: 1,
    otherListName: 'Restaurants',
  });
  assert.equal(
    text,
    'Imported 40: 22 into Agencies (South Africa), 18 into Salons & Barbers (Canada). 1 already on Restaurants'
  );
  assert.equal(/[—–]/.test(text), false);
});
