/**
 * 服务器本机应急解封工具。
 *
 * 用法：
 *   npm run security:unblock -- --list
 *   npm run security:unblock -- 203.0.113.9
 *
 * 只处理默认 SQLite 数据库；如果使用外部 MySQL/Postgres，请直接在数据库中
 * 删除 ip_blocklist 对应行。
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const dataDir = (process.env.DATA_DIR || './data').trim() || './data';
const dbUrl = (process.env.DB_URL || '').trim();
const dbPath = dbUrl && !dbUrl.startsWith('mysql') && !dbUrl.startsWith('postgres')
  ? resolve(dbUrl.replace(/^sqlite:\/\//, '').replace(/^file:\/\//, ''))
  : resolve(dataDir, 'hub.db');

const db = new Database(dbPath);

try {
  if (args.includes('--list') || args.length === 0) {
    const rows = db.prepare('SELECT id, ip, source, reason, failure_count, blocked_at FROM ip_blocklist ORDER BY id DESC').all();
    if (rows.length === 0) {
      console.log('黑名单为空');
    } else {
      console.table(rows);
    }
  } else {
    const ip = args[0]!.trim();
    const result = db.prepare('DELETE FROM ip_blocklist WHERE ip = ?').run(ip);
    console.log(`已解除 ${ip}，删除 ${result.changes} 条记录`);
  }
} finally {
  db.close();
}
