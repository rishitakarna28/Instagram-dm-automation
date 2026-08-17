import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const db = new DatabaseSync(config.dbPath);

// Enable WAL mode for high concurrency between webhooks and background worker
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Helper for atomic transactions
db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

// Initialize database schema
export function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      dm_message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deleted_comments (
      comment_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_rule_deliveries (
      user_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      comment_id TEXT,
      dm_job_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS dm_jobs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      message TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL, -- 'queued', 'in_flight', 'accepted', 'delivered', 'failed', 'cancelled'
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      next_run_at INTEGER DEFAULT 0,
      dm_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS duplicate_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT,
      user_id TEXT,
      rule_id TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dm_jobs_status_next ON dm_jobs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_dm_jobs_dm_id ON dm_jobs(dm_id);
    CREATE INDEX IF NOT EXISTS idx_rules_keyword ON rules(keyword);
  `);
}

// Ensure schema is created before preparing statements
initDB();

// Prepare statements for high performance
export const queries = {
  // Rules
  createRule: db.prepare(`
    INSERT INTO rules (id, keyword, dm_message, created_at)
    VALUES (?, ?, ?, ?)
  `),

  getAllRules: db.prepare(`
    SELECT id, keyword, dm_message FROM rules
  `),

  // Events
  isEventProcessed: db.prepare(`
    SELECT 1 FROM processed_events WHERE event_id = ?
  `),

  markEventProcessed: db.prepare(`
    INSERT OR IGNORE INTO processed_events (event_id, event_type, created_at)
    VALUES (?, ?, ?)
  `),

  // Deleted comments
  markCommentDeleted: db.prepare(`
    INSERT OR IGNORE INTO deleted_comments (comment_id, deleted_at)
    VALUES (?, ?)
  `),

  isCommentDeleted: db.prepare(`
    SELECT 1 FROM deleted_comments WHERE comment_id = ?
  `),

  cancelJobByCommentId: db.prepare(`
    UPDATE dm_jobs 
    SET status = 'cancelled', updated_at = ?
    WHERE comment_id = ? AND status IN ('queued', 'in_flight')
  `),

  // User-Rule delivery (Atomic deduplication)
  hasUserReceivedRule: db.prepare(`
    SELECT 1 FROM user_rule_deliveries WHERE user_id = ? AND rule_id = ?
  `),

  recordUserRuleDelivery: db.prepare(`
    INSERT INTO user_rule_deliveries (user_id, rule_id, comment_id, dm_job_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  recordDuplicateBlock: db.prepare(`
    INSERT INTO duplicate_blocks (event_id, user_id, rule_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  // DM Jobs Queue
  createDMJob: db.prepare(`
    INSERT INTO dm_jobs (
      id, rule_id, recipient_user_id, comment_id, message, idempotency_key, 
      status, attempts, max_attempts, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `),

  getNextQueuedJob: db.prepare(`
    SELECT * FROM dm_jobs 
    WHERE status = 'queued' AND next_run_at <= ?
    ORDER BY created_at ASC
    LIMIT 1
  `),

  updateJobStatus: db.prepare(`
    UPDATE dm_jobs
    SET status = ?, dm_id = ?, last_error = ?, next_run_at = ?, attempts = ?, updated_at = ?
    WHERE id = ?
  `),

  getJobsAwaitingReconciliation: db.prepare(`
    SELECT * FROM dm_jobs
    WHERE status = 'accepted' AND dm_id IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT 20
  `),

  // Stats Counters
  getStats: db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM dm_jobs WHERE status = 'delivered') AS sent,
      (SELECT COUNT(*) FROM dm_jobs WHERE status = 'failed') AS failed,
      (SELECT COUNT(*) FROM dm_jobs WHERE status IN ('queued', 'in_flight', 'accepted')) AS queued,
      (SELECT COUNT(*) FROM duplicate_blocks) AS duplicates_blocked
  `),

  getRecentJobs: db.prepare(`
    SELECT id, rule_id, recipient_user_id, comment_id, message, status, attempts, dm_id, updated_at
    FROM dm_jobs
    ORDER BY updated_at DESC
    LIMIT 20
  `),

  getRecentBlocks: db.prepare(`
    SELECT id, event_id, user_id, rule_id, reason, created_at
    FROM duplicate_blocks
    ORDER BY created_at DESC
    LIMIT 20
  `),
};

export { db };
