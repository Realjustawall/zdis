import { initDb } from '../db/index.js';
import { restoreBackup } from '../services/backups.js';

const archive = process.argv[2];
const confirmed = process.argv.includes('--confirm-destructive-restore');

if (!archive || !confirmed) {
  console.error(
    'Usage: npm run restore-backup --workspace server -- <archive.tar.gz> --confirm-destructive-restore',
  );
  process.exit(1);
}

await initDb();
const result = await restoreBackup(archive, { confirmed });
console.log(JSON.stringify(result, null, 2));
