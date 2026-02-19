/**
 * In-process mutex for IMAP connections.
 * Prevents concurrent IMAP connections to the same mailbox,
 * which Exchange Online rejects with "Command Error. 12".
 *
 * Lock key format: imap:<tenantCode>:<mailbox>
 */

const locks = new Map();

/**
 * Try to acquire a lock for the given key.
 * @param {string} key - Lock key (e.g. "imap:apoyar:user@example.com")
 * @param {number} ttlMs - Lock TTL in milliseconds (default 120s)
 * @returns {boolean} true if lock acquired, false if already held
 */
function tryLock(key, ttlMs = 120000) {
  const now = Date.now();
  const cur = locks.get(key);
  if (cur && cur > now) return false;
  locks.set(key, now + ttlMs);
  return true;
}

/**
 * Release the lock for the given key.
 * @param {string} key - Lock key
 */
function unlock(key) {
  locks.delete(key);
}

module.exports = { tryLock, unlock };
