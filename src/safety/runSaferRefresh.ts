import { closePool, initSchema } from '../db.js';
import { enrichSaferCarrierSafety } from './safer.js';

async function main() {
  await initSchema();
  const limitArg = process.argv[2] ? Number.parseInt(process.argv[2], 10) : 25;
  const usdotNumbers = process.argv.slice(3).map((item) => item.trim()).filter(Boolean);
  const result = await enrichSaferCarrierSafety({
    limit: Number.isFinite(limitArg) ? limitArg : 25,
    usdotNumbers,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
