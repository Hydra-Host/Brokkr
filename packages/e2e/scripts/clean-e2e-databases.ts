import { dropE2eDatabase, listE2eDatabases } from './e2e-database.js';

function parseAgeFromName(name: string): number | null {
  const match = name.match(/^brokkr_e2e_([a-z0-9]+)_/);
  const encodedTimestamp = match?.[1];
  if (!encodedTimestamp) return null;
  const timestamp = parseInt(encodedTimestamp, 36);
  if (Number.isNaN(timestamp)) return null;
  return Date.now() - timestamp;
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const olderThanIndex = args.indexOf('--older-than');
  const olderThanValue = olderThanIndex !== -1 ? args[olderThanIndex + 1] : undefined;
  const olderThanHours = olderThanValue ? parseFloat(olderThanValue) : null;
  const olderThanMs = olderThanHours !== null ? olderThanHours * 60 * 60 * 1000 : null;

  const databases = await listE2eDatabases();

  if (databases.length === 0) {
    console.log('No E2E databases found.');
    return;
  }

  const filtered =
    olderThanMs !== null
      ? databases.filter((name) => {
          const age = parseAgeFromName(name);
          return age !== null && age > olderThanMs;
        })
      : databases;

  if (filtered.length === 0) {
    console.log('No E2E databases match the criteria.');
    return;
  }

  if (listOnly) {
    console.log(`Found ${filtered.length} E2E database(s):`);
    for (const name of filtered) {
      const age = parseAgeFromName(name);
      const ageStr = age !== null ? ` (${Math.round(age / 1000 / 60)}m ago)` : '';
      console.log(`  - ${name}${ageStr}`);
    }
    return;
  }

  console.log(`Dropping ${filtered.length} E2E database(s)...`);
  for (const name of filtered) {
    await dropE2eDatabase({ name, databaseUrl: '' });
    console.log(`  Dropped: ${name}`);
  }

  console.log('Done.');
}

main().catch((error) => {
  console.error('Failed to clean E2E databases:', error.message);
  process.exit(1);
});
