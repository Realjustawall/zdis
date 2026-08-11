import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initDb } from '../db/index.js';
import { initCache } from '../cache/index.js';
import { findUserByIdentifier, setPassword, updateUser } from '../services/users.js';
import { suggestPassword, passwordProblems } from '../lib/password.js';
import { revokeAllSessions } from '../services/sessions.js';
import { audit } from '../services/audit.js';
import { ensureBadgeCatalogue, grantBadge } from '../services/badges.js';

/**
 * Break-glass recovery from the server console:
 *   npm run reset-admin --workspace server -- <email-or-username> [password]
 * Re-promotes the account to admin, re-enables it and sets a new password.
 */
await initDb();
await initCache();
await ensureBadgeCatalogue();

const identifier = process.argv[2];
if (!identifier) {
  console.error('Usage: npm run reset-admin --workspace server -- <email-or-username> [password]');
  process.exit(1);
}

const user = await findUserByIdentifier(identifier);
if (!user) {
  console.error(`No account matches "${identifier}".`);
  process.exit(1);
}

let password = process.argv[3];
if (!password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const suggested = suggestPassword();
  const answer = await rl.question(`New password [${suggested}]: `);
  rl.close();
  password = answer.trim() || suggested;
}

const problems = passwordProblems(password);
if (problems.length) {
  console.error('Password rejected:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

await setPassword(user.id, password, { mustChange: false });
await updateUser(user.id, { role: 'admin', isActive: true });
await grantBadge({ userId: user.id, badgeId: 'admin', grantedBy: null });
await revokeAllSessions(user.id);
await audit({ action: 'system.reset_admin', targetType: 'user', targetId: user.id });

console.log(`\nAccount ${user.email} is now an active administrator.`);
console.log(`Password: ${password}\n`);
process.exit(0);
