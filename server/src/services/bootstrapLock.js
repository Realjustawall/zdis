import { getDb } from '../db/index.js';

// The guarded services open their own transactions. Hold a separate transaction
// only for this cross-process lock so another API node cannot seed the same
// administrator or official bot account while those transactions are running.
export async function withBootstrapLock(operation, db = getDb()) {
  if (db.dialect !== 'postgres') return operation();
  return db.tx(async (tx) => {
    await tx.get('SELECT pg_advisory_xact_lock(?) AS locked', [918_273_646]);
    return operation();
  });
}
