import { initDb } from '../db/index.js';
import { initCache } from '../cache/index.js';
import { runBackup } from '../services/backups.js';

await initDb();
await initCache();
const result = await runBackup();
console.log(JSON.stringify(result, null, 2));
process.exit(0);
