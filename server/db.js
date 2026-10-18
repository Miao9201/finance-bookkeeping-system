import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SAFE_MONEY = Number.MAX_SAFE_INTEGER;
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openDatabase(dataDir) {
  dataDir = resolve(dataDir); mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'yundaizhang.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  initBusiness(db);
  return { db, dataDir, dbPath };
}

export function initBusiness(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', tax_no TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '服务中' CHECK(status IN ('服务中','暂停服务','已归档')),
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), title TEXT NOT NULL CHECK(length(trim(title))>0),
      content TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND ${SAFE_MONEY}),
      cycle TEXT NOT NULL DEFAULT '月付', status TEXT NOT NULL DEFAULT '执行中' CHECK(status IN ('执行中','待签约','已到期','已终止')),
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), month TEXT NOT NULL,
      due_date TEXT NOT NULL, steps TEXT NOT NULL CHECK(json_valid(steps)), notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(customer_id,month)
    );
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '发票', amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND ${SAFE_MONEY}),
      number TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 10485760), content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(length(content)=size)
    );
    CREATE TABLE IF NOT EXISTS receivables (
      id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id),
      amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND ${SAFE_MONEY}),
      due_date TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, receivable_id INTEGER NOT NULL REFERENCES receivables(id), date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND ${SAFE_MONEY}),
      method TEXT NOT NULL DEFAULT '银行转账', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
      detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_contract_customer ON contracts(customer_id);
    CREATE INDEX IF NOT EXISTS idx_task_month ON tasks(month);
    CREATE INDEX IF NOT EXISTS idx_bill_customer ON bills(customer_id);
    CREATE INDEX IF NOT EXISTS idx_receivable_contract ON receivables(contract_id);
    CREATE INDEX IF NOT EXISTS idx_payment_receivable ON payments(receivable_id);
  `);
}
