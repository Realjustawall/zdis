import { verifyBackup } from '../services/backups.js';

const archive = process.argv[2];
if (!archive) {
  console.error('Usage: npm run verify-backup --workspace server -- <archive.tar.gz>');
  process.exit(1);
}
const result = await verifyBackup(archive);
console.log(JSON.stringify(result, null, 2));
