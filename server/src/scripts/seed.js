import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { initDb } from '../db/index.js';
import { initCache } from '../cache/index.js';
import { createUser, findUserByEmail, countUsers, updateUser } from '../services/users.js';
import { suggestPassword } from '../lib/password.js';
import { audit } from '../services/audit.js';
import { ensureBadgeCatalogue, grantBadge } from '../services/badges.js';

/**
 * First-run bootstrap. Creates the administrator account named in the brief so
 * there is a way in — there is no public signup, and every other account is
 * created from the admin panel.
 *
 * The password comes from SEED_ADMIN_PASSWORD. If it is not set we generate a
 * random one and print it once; it is never written to disk in plaintext.
 */
export async function ensureSeedAdmin() {
  const email = config.seedAdminEmail;
  const existing = await findUserByEmail(email);

  if (existing) {
    if (existing.role !== 'admin' || !existing.is_active) {
      await updateUser(existing.id, { role: 'admin', isActive: true });
      await grantBadge({ userId: existing.id, badgeId: 'admin', grantedBy: null });
      logger.warn('seed admin re-promoted', { email });
    }
    return existing;
  }

  const total = await countUsers();
  const password = config.seedAdminPassword || suggestPassword();

  const user = await createUser({
    email,
    username: config.seedAdminUsername,
    displayName: 'Administrator',
    password,
    role: 'admin',
    mustChangePassword: !config.seedAdminPassword,
    // The operator chose this password out-of-band; the policy check would
    // only lock them out of their own first login.
    skipPasswordPolicy: true,
  });

  await audit({
    action: 'system.seed_admin',
    targetType: 'user',
    targetId: user.id,
    meta: { email, firstRun: total === 0 },
  });

  logger.warn('----------------------------------------------------------');
  logger.warn(`Administrator account created for ${email}`);
  if (!config.seedAdminPassword) {
    logger.warn(`Temporary password: ${password}`);
    logger.warn('You will be asked to change it on first login.');
  } else {
    logger.warn('Password taken from SEED_ADMIN_PASSWORD.');
  }
  logger.warn('----------------------------------------------------------');

  return user;
}

// Allow `npm run seed` to run this standalone.
const isDirectRun = process.argv[1] && process.argv[1].endsWith('seed.js');
if (isDirectRun) {
  await initDb();
  await initCache();
  await ensureBadgeCatalogue();
  await ensureSeedAdmin();
  process.exit(0);
}
