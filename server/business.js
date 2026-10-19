import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { transaction, SAFE_MONEY } from './db.js';

const stepKeys = ['collect', 'sort', 'book', 'review', 'tax'];
const stepLabels = ['资料收集', '票据整理', '账务处理', '账目审核', '纳税申报'];
const stepStatuses = ['未开始', '进行中', '已完成'];
const customerStatuses = ['服务中', '暂停服务', '已归档'];
const contractStatuses = ['执行中', '待签约', '已到期', '已终止'];
export const BACKUP_LIMITS = Object.freeze({ archive: 96 * 1024 * 1024, expanded: 128 * 1024 * 1024 });
export function bad(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function str(value, label, max = 2000, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) bad(`${label}格式不正确或过长`);
  return value.trim();
}
function required(value, label, max = 120) { const s = str(value, label, max); if (!s) bad(`请填写${label}`); return s; }
function choice(value, choices, fallback, label) { const s = value === undefined ? fallback : value; if (!choices.includes(s)) bad(`${label}不正确`); return s; }
function id(value, label = '编号') { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) bad(`${label}不正确`); return value; }
function money(value) { if (!Number.isSafeInteger(value) || value <= 0) bad('金额必须为正整数分，且不能超过安全范围'); return value; }
function date(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`${label}格式应为 YYYY-MM-DD`);
  const d = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '2199-12-31') bad(`${label}不是有效日期`);
  return value;
}
function month(value) { if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12') bad('月份格式应为 YYYY-MM'); return value; }
function steps(value) {
  if (value === undefined) return stepKeys.map(key => ({ key, status: '未开始', date: '', notes: '' }));
  if (!Array.isArray(value) || value.length !== 5 || new Set(value.map(s => s?.key)).size !== 5) bad('月度任务必须包含完整的五个步骤');
  return stepKeys.map(key => {
    const s = value.find(x => x?.key === key); if (!s) bad('任务步骤不正确');
    return { key, status: choice(s.status, stepStatuses, '未开始', '步骤状态'), date: s.date ? date(s.date, '步骤日期') : '', notes: str(s.notes, '步骤备注') };
  });
}
const definitions = {
  customers: b => ({ name: required(b.name, '客户名称'), contact: str(b.contact, '联系人', 100), phone: str(b.phone, '电话', 50), tax_no: str(b.tax_no, '税号', 80), status: choice(b.status, customerStatuses, '服务中', '客户状态'), notes: str(b.notes, '备注') }),
  contracts: b => {
    const start_date = date(b.start_date, '合同开始日期'), end_date = date(b.end_date, '合同结束日期');
    if (end_date < start_date) bad('合同结束日期不能早于开始日期');
    return { customer_id: id(b.customer_id, '客户编号'), title: required(b.title, '合同标题'), content: str(b.content, '合同内容', 30000), start_date, end_date, amount_cents: money(b.amount_cents), cycle: str(b.cycle, '收费周期', 50, '月付'), status: choice(b.status, contractStatuses, '执行中', '合同状态'), notes: str(b.notes, '备注') };
  },
  tasks: b => ({ customer_id: id(b.customer_id, '客户编号'), month: month(b.month), due_date: date(b.due_date, '截止日期'), steps: JSON.stringify(steps(b.steps)), notes: str(b.notes, '备注') }),
  bills: b => ({ customer_id: id(b.customer_id, '客户编号'), date: date(b.date), type: required(b.type ?? '发票', '票据类型', 50), amount_cents: money(b.amount_cents), number: str(b.number, '票据号码', 100), notes: str(b.notes, '备注') }),
  receivables: b => ({ contract_id: id(b.contract_id, '合同编号'), amount_cents: money(b.amount_cents), due_date: date(b.due_date, '应收日期'), description: str(b.description, '应收说明') }),
  payments: b => ({ receivable_id: id(b.receivable_id, '应收编号'), date: date(b.date, '收款日期'), amount_cents: money(b.amount_cents), method: str(b.method, '收款方式', 50, '银行转账'), notes: str(b.notes, '备注') }),
};
function sum(rows, key = 'amount_cents') {
  const n = rows.reduce((total, row) => total + BigInt(row[key]), 0n);
  if (n > BigInt(SAFE_MONEY) || n < -BigInt(SAFE_MONEY)) bad('累计金额超出安全范围，请拆分数据');
  return Number(n);
}
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function rawRows(db, table) { return db.prepare(`SELECT * FROM "${table}" ORDER BY id DESC`).all(); }
function entity(db, table, entityId) { const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId); if (!row) bad('记录不存在或已删除', 404); return row; }
function log(db, action, table, entityId = null, detail = '') { db.prepare('INSERT INTO audit_logs(action,entity,entity_id,detail) VALUES(?,?,?,?)').run(action, table, entityId, detail); }
function assertMoneyTotals(db) { for (const table of ['contracts', 'bills', 'receivables', 'payments']) sum(db.prepare(`SELECT amount_cents FROM ${table}`).all()); }
function validateLinks(db, table, row, entityId) {
  if (row.customer_id) entity(db, 'customers', row.customer_id);
  if (row.contract_id) entity(db, 'contracts', row.contract_id);
  if (table === 'payments') {
    const r = entity(db, 'receivables', row.receivable_id);
    const paid = sum(db.prepare('SELECT amount_cents FROM payments WHERE receivable_id=? AND id<>?').all(r.id, entityId ?? -1));
    if (BigInt(paid) + BigInt(row.amount_cents) > BigInt(r.amount_cents)) bad('收款金额超过该笔应收的未收余额');
  }
  if (table === 'receivables' && entityId) {
    if (sum(db.prepare('SELECT amount_cents FROM payments WHERE receivable_id=?').all(entityId)) > row.amount_cents) bad('应收金额不能少于已经登记的收款');
  }
  if (table === 'contracts' && entityId) {
    const original = entity(db, table, entityId);
    if (original.customer_id !== row.customer_id && db.prepare('SELECT id FROM receivables WHERE contract_id=? LIMIT 1').get(entityId)) bad('已有应收的合同不能更换客户');
  }
}
function decorateTask(row) { const parsed = { ...row, steps: JSON.parse(row.steps) }; parsed.progress = parsed.steps.filter(s => s.status === '已完成').length * 20; parsed.status = parsed.progress === 100 ? '已完成' : parsed.steps.some(s => s.status !== '未开始') ? '进行中' : '未开始'; return parsed; }

export function businessState(db) {
  const customers = rawRows(db, 'customers'), contracts = rawRows(db, 'contracts'), tasks = rawRows(db, 'tasks').map(decorateTask);
  const attachments = db.prepare('SELECT id,bill_id,name,mime,size,created_at FROM attachments ORDER BY id').all();
  const bills = rawRows(db, 'bills').map(b => ({ ...b, attachments: attachments.filter(a => a.bill_id === b.id) }));
  const payments = rawRows(db, 'payments');
  const receivables = rawRows(db, 'receivables').map(r => {
    const received_cents = sum(payments.filter(p => p.receivable_id === r.id));
    return { ...r, customer_id: contracts.find(c => c.id === r.contract_id)?.customer_id, received_cents, balance_cents: r.amount_cents - received_cents, status: received_cents === 0 ? '未收款' : received_cents === r.amount_cents ? '已收清' : '部分收款' };
  });
  const day = today(), monthly = [];
  const current = new Date(day + 'T00:00:00Z');
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1)), m = d.toISOString().slice(0, 7);
    monthly.push({ month: m, receivable_cents: sum(receivables.filter(r => r.due_date.startsWith(m))), received_cents: sum(payments.filter(p => p.date.startsWith(m))) });
  }
  const dashboard = {
    customer_count: customers.length, active_customer_count: customers.filter(c => c.status === '服务中').length,
    contract_count: contracts.length, contract_amount_cents: sum(contracts), receivable_cents: sum(receivables), received_cents: sum(payments),
    outstanding_cents: sum(receivables, 'balance_cents'), overdue_cents: sum(receivables.filter(r => r.due_date < day), 'balance_cents'),
    task_count: tasks.length, completed_task_count: tasks.filter(t => t.progress === 100).length, overdue_task_count: tasks.filter(t => t.due_date < day && t.progress < 100).length,
    task_steps: stepKeys.map((key, i) => ({ key, label: stepLabels[i], total: tasks.length, completed: tasks.filter(t => t.steps.find(s => s.key === key)?.status === '已完成').length })),
    monthly, recent_tasks: [...tasks].filter(t => t.progress < 100).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 8),
  };
  return { customers, contracts, tasks, bills, receivables, payments, attachments, dashboard, logs: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all() };
}

function decodeBase64(value, maxBytes = 10485760) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) bad('附件或备份内容不是有效的 Base64 数据');
  const bytes = Buffer.from(value, 'base64'); if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) bad('附件或备份大小不正确'); return bytes;
}
function attachmentInput(body) {
  const name = required(body.name, '附件名称', 180); if (/[\\/\x00-\x1f\x7f]/.test(name)) bad('附件名称不能包含路径或控制字符');
  const mime = str(body.mime, '附件类型', 120, 'application/octet-stream');
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)) bad('附件类型不正确');
  const content = decodeBase64(body.content); return { name, mime, content, size: content.length };
}
function schemaTables(db) { return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); }
function backupCapacityError() { bad('备份超过容量限制（压缩文件最大 96 MiB，展开数据最大 128 MiB），已停止操作，当前数据未被替换。请停止服务后复制整个 data 文件夹（使用自定义数据目录时复制该目录）进行完整备份或迁移。', 413); }
export function backupBuffer(db, limits = BACKUP_LIMITS) {
  const parts = []; let byteLength = 0;
  const append = value => { byteLength += Buffer.byteLength(value, 'utf8'); if (byteLength > limits.expanded) backupCapacityError(); parts.push(value); };
  const header = JSON.stringify({ format: 'yundaizhang-local-backup', version: 1, created_at: new Date().toISOString() });
  append(header.slice(0, -1) + ',"tables":{');
  let firstTable = true;
  for (const { name } of schemaTables(db)) {
    append((firstTable ? '' : ',') + JSON.stringify(name) + ':['); firstTable = false;
    let firstRow = true;
    for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate()) {
      const encoded = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { __blob: Buffer.from(value).toString('base64') } : value]));
      append((firstRow ? '' : ',') + JSON.stringify(encoded)); firstRow = false;
    }
    append(']');
  }
  append('}}');
  const archive = gzipSync(Buffer.from(parts.join(''), 'utf8'));
  if (archive.length > limits.archive) backupCapacityError();
  return archive;
}
function validateBusinessBackup(db) {
  for (const table of Object.keys(definitions)) for (const row of rawRows(db, table)) {
    const b = { ...row }; if (table === 'tasks') { try { b.steps = JSON.parse(row.steps); } catch { bad('备份任务步骤损坏'); } }
    const validated = definitions[table](b);
    for (const [key, value] of Object.entries(validated)) if (key !== 'steps' && row[key] !== value) bad(`备份中的 ${table} 数据格式不正确`);
    validateLinks(db, table, validated, row.id);
  }
  for (const row of rawRows(db, 'attachments')) {
    if (!(row.content instanceof Uint8Array)) bad('备份中的附件格式不正确');
    const validated = attachmentInput({ name: row.name, mime: row.mime, content: Buffer.from(row.content).toString('base64') });
    if (validated.size !== row.size) bad('备份中的附件长度不正确');
  }
  assertMoneyTotals(db);
}
function stageBackup(db, bytes, validateAccountingBackup) {
  let backup;
  try { const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: BACKUP_LIMITS.expanded }) : bytes; backup = JSON.parse(raw.toString('utf8')); }
  catch { bad('备份文件损坏或超过 128 MB'); }
  if (backup?.format !== 'yundaizhang-local-backup' || backup.version !== 1 || !backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) bad('不支持的备份格式或版本');
  const schemas = schemaTables(db), names = schemas.map(t => t.name);
  if (Object.keys(backup.tables).length !== names.length || names.some(n => !Object.hasOwn(backup.tables, n))) bad('备份数据表不完整或版本不兼容');
  const staging = new DatabaseSync(':memory:');
  try {
    staging.exec('PRAGMA foreign_keys=OFF');
    for (const table of schemas) staging.exec(table.sql);
    for (const index of db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) staging.exec(index.sql);
    let rowCount = 0;
    const decoded = {};
    for (const name of names) {
      const rows = backup.tables[name], columns = staging.prepare(`PRAGMA table_info("${name}")`).all();
      if (!Array.isArray(rows) || (rowCount += rows.length) > 250000) bad('备份记录数量过多或格式错误');
      const statement = staging.prepare(`INSERT INTO "${name}" (${columns.map(c => `"${c.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      decoded[name] = rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length || columns.some(c => !Object.hasOwn(row, c.name))) bad(`备份表 ${name} 的字段不完整`);
        const values = columns.map(c => {
          const value = row[c.name];
          if (value === null && !c.notnull && !c.pk) return null;
          if (c.type.toUpperCase() === 'BLOB') { if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) bad('备份附件格式不正确'); return decodeBase64(value.__blob); }
          if (c.type.toUpperCase().includes('INT')) { if (!Number.isSafeInteger(value)) bad('备份整数超出安全范围'); if (c.name === 'id' || c.name.endsWith('_id')) id(value, '备份记录编号'); return value; }
          if (typeof value !== 'string' || value.length > 100000) bad('备份文本格式不正确'); return value;
        });
        statement.run(...values); return values;
      });
    }
    if (staging.prepare('PRAGMA foreign_key_check').all().length) bad('备份包含无效关联记录');
    validateBusinessBackup(staging); if (validateAccountingBackup) validateAccountingBackup(staging);
    return { decoded, schemas };
  } catch (error) { if (error.status) throw error; bad(`备份校验失败：${error.message.includes('constraint') ? '数据约束不满足' : '数据不完整或不平衡'}`); }
  finally { staging.close(); }
}

function csvCell(value) { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s; return `"${s.replaceAll('"', '""')}"`; }
const exportFields = {
  customers: [['id', '编号'], ['name', '客户名称'], ['tax_no', '税号'], ['contact', '联系人'], ['phone', '电话'], ['status', '服务状态'], ['notes', '备注']],
  contracts: [['id', '编号'], ['customer_id', '客户编号'], ['title', '合同标题'], ['start_date', '开始日期'], ['end_date', '结束日期'], ['amount_cents', '合同金额（元）'], ['cycle', '收费周期'], ['status', '状态'], ['content', '合同内容'], ['notes', '备注']],
  tasks: [['id', '编号'], ['customer_id', '客户编号'], ['month', '所属月份'], ['due_date', '截止日期'], ['status', '任务状态'], ['progress', '完成百分比'], ['steps', '五步记录'], ['notes', '备注']],
  bills: [['id', '编号'], ['customer_id', '客户编号'], ['date', '日期'], ['type', '票据类型'], ['amount_cents', '金额（元）'], ['number', '票据号码'], ['notes', '备注']],
  receivables: [['id', '编号'], ['contract_id', '合同编号'], ['customer_id', '客户编号'], ['due_date', '应收日期'], ['amount_cents', '应收金额（元）'], ['received_cents', '已收金额（元）'], ['balance_cents', '未收金额（元）'], ['status', '状态'], ['description', '说明']],
  payments: [['id', '编号'], ['receivable_id', '应收编号'], ['date', '收款日期'], ['amount_cents', '收款金额（元）'], ['method', '收款方式'], ['notes', '备注']],
};
function yuan(cents) { const n = BigInt(cents); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`; }

export function registerBusiness(app, db, { dataDir, dbPath, accountingState, seedAccounting, validateAccountingBackup }) {
  const success = (res, data, message = '操作成功') => res.json({ code: 0, data, message });
  app.get('/api/state', (req, res) => {
    let backupCount = 0; try { backupCount = readdirSync(join(dataDir, 'backups')).filter(x => x.endsWith('.json.gz')).length; } catch { /* First run has no backups. */ }
    success(res, { ...businessState(db), accounting: accountingState(db), system: { data_dir: dataDir, db_path: dbPath, mode: '本机单人模式', backup_count: backupCount } });
  });
  for (const [table, validate] of Object.entries(definitions)) {
    const save = (req, res) => {
      const entityId = req.params.id ? id(Number(req.params.id)) : null;
      const row = validate(req.body ?? {});
      const savedId = transaction(db, () => {
        if (entityId) entity(db, table, entityId); validateLinks(db, table, row, entityId);
        const fields = Object.keys(row);
        const result = entityId
          ? db.prepare(`UPDATE ${table} SET ${fields.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(row), entityId)
          : db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
        const savedId = entityId ?? Number(result.lastInsertRowid); assertMoneyTotals(db); log(db, entityId ? '修改' : '新增', table, savedId); return savedId;
      });
      const saved = businessState(db)[table].find(r => r.id === savedId); success(res, saved);
    };
    app.post(`/api/${table}`, save); app.put(`/api/${table}/:id`, save);
    app.delete(`/api/${table}/:id`, (req, res) => {
      const entityId = id(Number(req.params.id));
      transaction(db, () => { entity(db, table, entityId); db.prepare(`DELETE FROM ${table} WHERE id=?`).run(entityId); log(db, '删除', table, entityId); });
      success(res, null);
    });
  }
  app.post('/api/bills/:id/attachments', (req, res) => {
    const billId = id(Number(req.params.id)); entity(db, 'bills', billId); const attachment = attachmentInput(req.body ?? {});
    const attachmentId = transaction(db, () => {
      const result = db.prepare('INSERT INTO attachments(bill_id,name,mime,size,content) VALUES(?,?,?,?,?)').run(billId, attachment.name, attachment.mime, attachment.size, attachment.content);
      log(db, '上传附件', 'bills', billId, attachment.name); return Number(result.lastInsertRowid);
    });
    success(res, db.prepare('SELECT id,bill_id,name,mime,size,created_at FROM attachments WHERE id=?').get(attachmentId));
  });
  app.get('/api/attachments/:id', (req, res) => {
    const attachment = entity(db, 'attachments', id(Number(req.params.id)));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment-${attachment.id}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'Content-Length': String(attachment.size) }); res.send(Buffer.from(attachment.content));
  });
  app.delete('/api/attachments/:id', (req, res) => { const attachmentId = id(Number(req.params.id)); transaction(db, () => { entity(db, 'attachments', attachmentId); db.prepare('DELETE FROM attachments WHERE id=?').run(attachmentId); log(db, '删除附件', 'attachments', attachmentId); }); success(res, null); });
  app.get('/api/backup', (req, res) => { const archive = backupBuffer(db); res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="finance-bookkeeping-system-${today()}.json.gz"` }); res.send(archive); });
  app.post('/api/restore', (req, res) => {
    const bytes = decodeBase64(req.body?.content, BACKUP_LIMITS.archive);
    const validated = stageBackup(db, bytes, validateAccountingBackup);
    const backupDir = join(dataDir, 'backups'); mkdirSync(backupDir, { recursive: true });
    const backupName = `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.json.gz`;
    writeFileSync(join(backupDir, backupName), backupBuffer(db), { flag: 'wx' });
    transaction(db, () => {
      db.exec('PRAGMA defer_foreign_keys=ON');
      for (const table of validated.schemas) db.exec(`DELETE FROM "${table.name}"`);
      for (const { name } of validated.schemas) {
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
        const stmt = db.prepare(`INSERT INTO "${name}" (${columns.map(c => `"${c.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of validated.decoded[name]) stmt.run(...row);
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) bad('恢复后的关联校验失败');
      log(db, '恢复备份', 'system', null, `恢复前副本：${backupName}`);
    });
    success(res, { backup_name: backupName }, '恢复成功，已保留恢复前副本');
  });
  app.get('/api/export/:kind', (req, res) => {
    const fields = exportFields[req.params.kind]; if (!fields) bad('不支持的导出类型', 404);
    const rows = businessState(db)[req.params.kind];
    const csv = '\ufeff' + [fields.map(([, label]) => csvCell(label)).join(','), ...rows.map(row => fields.map(([key]) => csvCell(key.endsWith('_cents') ? yuan(row[key]) : key === 'steps' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\r\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.params.kind}-${today()}.csv"` }); res.send(csv);
  });
  app.post('/api/demo', (req, res) => {
    const dataTables = schemaTables(db).filter(t => t.name !== 'audit_logs');
    if (dataTables.some(t => db.prepare(`SELECT 1 FROM "${t.name}" LIMIT 1`).get())) bad('仅空数据库可添加示例，现有数据不会被覆盖');
    transaction(db, () => { seedBusiness(db); seedAccounting(db); log(db, '添加虚构示例', 'system'); }); success(res, null, '已添加虚构示例数据');
  });
}

export function seedBusiness(db) {
  const monthValue = today().slice(0, 7), year = monthValue.slice(0, 4);
  const customerInsert = db.prepare('INSERT INTO customers(name,contact,status,notes,tax_no) VALUES(?,?,?,?,?)');
  for (const [name, contact] of [['青禾设计工作室（示例）', '示例联系人甲'], ['星野商贸有限公司（示例）', '示例联系人乙'], ['云帆咨询中心（示例）', '示例联系人丙']]) customerInsert.run(name, contact, '服务中', '虚构演示数据，请勿用于真实申报', '');
  const customers = db.prepare('SELECT id FROM customers ORDER BY id').all();
  for (const [index, c] of customers.entries()) {
    const contract = db.prepare('INSERT INTO contracts(customer_id,title,content,start_date,end_date,amount_cents,cycle,status) VALUES(?,?,?,?,?,?,?,?)').run(c.id, '年度代理记账服务（示例）', '资料整理、账务处理与申报进度记录；所有内容为虚构示例。', year + '-01-01', year + '-12-31', (index + 1) * 360000, '年付', '执行中');
    const taskSteps = steps(); taskSteps.forEach((s, i) => { if (i < 4 - index) { s.status = '已完成'; s.date = today(); } else if (i === 4 - index) s.status = '进行中'; });
    db.prepare('INSERT INTO tasks(customer_id,month,due_date,steps,notes) VALUES(?,?,?,?,?)').run(c.id, monthValue, monthValue + '-25', JSON.stringify(taskSteps), '虚构示例任务');
    db.prepare('INSERT INTO bills(customer_id,date,type,amount_cents,number,notes) VALUES(?,?,?,?,?,?)').run(c.id, today(), '增值税普通发票', 128000 + index * 23000, 'DEMO-' + (index + 1), '虚构示例票据');
    const r = db.prepare('INSERT INTO receivables(contract_id,amount_cents,due_date,description) VALUES(?,?,?,?)').run(Number(contract.lastInsertRowid), (index + 1) * 360000, monthValue + '-25', '年度服务费（示例）');
    if (index < 2) db.prepare('INSERT INTO payments(receivable_id,date,amount_cents,method,notes) VALUES(?,?,?,?,?)').run(Number(r.lastInsertRowid), today(), index === 0 ? 360000 : 300000, '银行转账', '虚构示例收款');
  }
}
