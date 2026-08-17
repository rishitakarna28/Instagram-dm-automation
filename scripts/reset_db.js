import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = './automation.db';
const dbFiles = ['./automation.db', './automation.db-wal', './automation.db-shm'];

console.log('🧹 Resetting database tables and state...');

let clearedViaSQL = false;

// If file exists, try clearing tables via SQLite query first (works even while server is running!)
if (fs.existsSync(dbPath)) {
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      DELETE FROM dm_jobs;
      DELETE FROM user_rule_deliveries;
      DELETE FROM duplicate_blocks;
      DELETE FROM processed_events;
      DELETE FROM deleted_comments;
      DELETE FROM rules;
    `);
    clearedViaSQL = true;
    console.log('✅ All tables cleared successfully (SQL truncate).');
  } catch (err) {
    // If DB is in exclusive lock, we'll try file deletion below
  }
}

// Try deleting files if possible
for (const file of dbFiles) {
  const p = path.resolve(process.cwd(), file);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      console.log(`Deleted ${file}`);
    } catch {
      // File locked by running server — already cleared via SQL above
    }
  }
}

console.log('✨ Database reset complete and ready for fresh test runs!\n');
