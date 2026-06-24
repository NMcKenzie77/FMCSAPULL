import { config, type ImportSource } from './config.js';
import { closePool, initSchema } from './db.js';
import { exportToArkon, exportToSheets } from './export/webhooks.js';
import { importFmcsa, refreshScores } from './importer.js';

async function main() {
  const command = process.argv[2];

  if (command === 'db:init') {
    await initSchema();
    console.log('Database schema initialized.');
    return;
  }

  if (command === 'import') {
    await initSchema();
    const source = (process.argv[3] as ImportSource | undefined) ?? config.defaultImportSource;
    const limitArg = process.argv[4] ? Number.parseInt(process.argv[4], 10) : config.importLimit;
    const result = await importFmcsa(source, Number.isFinite(limitArg) ? limitArg : config.importLimit);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'score:refresh') {
    await initSchema();
    const result = await refreshScores();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'export:arkon') {
    const result = await exportToArkon();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'export:sheets') {
    const result = await exportToSheets();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Usage:
  npm run db:init
  npm run import -- [carrier-daily|carrier-all-history|company-census] [limit]
  npm run score:refresh
  npm run start

Railway Cron command:
  npm run import -- carrier-daily 5000`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
