import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// Docker-free local PostgreSQL for development. Boots an embedded cluster on a
// fixed port with a persistent data directory (./.pgdata by default) so your
// repositories and analyses survive restarts. Ctrl+C stops it cleanly.

const port = Number(process.env.RAT_DEV_PG_PORT ?? 55432);
const database = process.env.RAT_DEV_PG_DB ?? 'rat';
const password = process.env.RAT_DEV_PG_PASSWORD ?? 'postgres';
const databaseDir = resolve(process.env.RAT_DEV_PG_DATA ?? './.pgdata');

await mkdir(databaseDir, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user: 'postgres',
  password,
  persistent: true,
  onLog: (message) => process.stdout.write(message.endsWith('\n') ? message : `${message}\n`),
  onError: (message) => console.error(typeof message === 'string' ? message : String(message)),
});

let initialized = true;
try {
  await access(resolve(databaseDir, 'PG_VERSION'));
} catch {
  initialized = false;
}
if (!initialized) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(database);
} catch {
  // Database already exists from a previous run.
}

const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
console.log('\n========================================================');
console.log('  Embedded PostgreSQL is ready (Docker-free).');
console.log(`  In your app terminal run:\n`);
console.log(`    export DATABASE_URL=${url}`);
console.log(`    npx pnpm dev`);
console.log('\n  Leave this terminal running. Press Ctrl+C to stop.');
console.log('========================================================\n');

// Keep the process alive until interrupted; embedded-postgres stops the cluster on exit.
setInterval(() => {}, 1 << 30);
