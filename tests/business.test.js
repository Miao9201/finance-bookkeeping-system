import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { get as httpGet } from 'node:http';
import { createApp } from '../server/index.js';
import { BACKUP_LIMITS, backupBuffer } from '../server/business.js';

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'yundaizhang-test-'));
  const instance = createApp({ dataDir });
  const server = await new Promise(resolve => { const s = instance.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, ...data };
  };
  const customer = async (name = '测试客户') => (await request('/api/customers', 'POST', { name, status: '服务中' })).data;
  return { ...instance, dataDir, base, request, customer };
}

test('money is exact integer cents, rejects unsafe/zero amounts and overpayment', async t => {
  const f = await fixture(t); const c = await f.customer();
  const contract = (await f.request('/api/contracts', 'POST', { customer_id: c.id, title: '年度代账', amount_cents: 10001, start_date: '2026-01-01', end_date: '2026-12-31' })).data;
  assert.ok(contract.id);
  for (const amount_cents of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '100']) assert.equal((await f.request('/api/receivables', 'POST', { contract_id: contract.id, amount_cents, due_date: '2026-02-28' })).status, 400);
  const r = (await f.request('/api/receivables', 'POST', { contract_id: contract.id, amount_cents: 10001, due_date: '2026-02-28' })).data;
  assert.equal((await f.request('/api/payments', 'POST', { receivable_id: r.id, date: '2026-02-01', amount_cents: 10000 })).code, 0);
  assert.equal((await f.request('/api/payments', 'POST', { receivable_id: r.id, date: '2026-02-01', amount_cents: 2 })).status, 400);
  assert.equal((await f.request('/api/payments', 'POST', { receivable_id: r.id, date: '2026-02-01', amount_cents: 1 })).code, 0);
  const state = (await f.request('/api/state')).data;
  assert.equal(state.receivables[0].balance_cents, 0); assert.equal(state.dashboard.received_cents, 10001);
  assert.equal((await f.request('/api/receivables/' + r.id, 'PUT', { contract_id: contract.id, amount_cents: 9000, due_date: '2026-02-28' })).status, 400);
});

test('monthly tasks are unique, steps persist, invalid calendar dates fail', async t => {
  const f = await fixture(t); const c = await f.customer();
  const body = { customer_id: c.id, month: '2026-02', due_date: '2026-03-15' };
  const created = await f.request('/api/tasks', 'POST', body); assert.equal(created.code, 0); assert.equal(created.data.steps.length, 5);
  assert.equal((await f.request('/api/tasks', 'POST', body)).status, 400);
  assert.equal((await f.request('/api/bills', 'POST', { customer_id: c.id, date: '2026-02-30', amount_cents: 100, type: '发票' })).status, 400);
  created.data.steps[0].status = '已完成';
  const updated = await f.request('/api/tasks/' + created.data.id, 'PUT', { ...body, steps: created.data.steps });
  assert.equal(updated.data.progress, 20);
});

test('attachments and all data survive restart and transactional backup restore', async t => {
  const f = await fixture(t); const c = await f.customer('备份客户');
  const bill = (await f.request('/api/bills', 'POST', { customer_id: c.id, date: '2026-10-18', type: '发票', amount_cents: 1299, notes: '原件' })).data;
  const bytes = Buffer.from('附件测试\x00\x01');
  const attachment = (await f.request(`/api/bills/${bill.id}/attachments`, 'POST', { name: '原始票据.txt', mime: 'text/plain', content: bytes.toString('base64') })).data;
  assert.deepEqual(Buffer.from(await (await fetch(f.base + '/api/attachments/' + attachment.id)).arrayBuffer()), bytes);
  const backupBytes = Buffer.from(await (await fetch(f.base + '/api/backup')).arrayBuffer());
  const backup = JSON.parse(gunzipSync(backupBytes)); assert.ok(backup.tables.attachments.length);
  await f.customer('恢复后应消失');
  assert.equal((await f.request('/api/restore', 'POST', { content: backupBytes.toString('base64') })).code, 0);
  assert.equal((await f.request('/api/state')).data.customers.length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(f.base + '/api/attachments/' + attachment.id)).arrayBuffer()), bytes);
  assert.ok(readdirSync(join(f.dataDir, 'backups')).some(x => x.endsWith('.json.gz')));
  const reopened = createApp({ dataDir: f.dataDir }); assert.equal(reopened.db.prepare('SELECT count(*) n FROM customers').get().n, 1); reopened.close();
});

test('restore rejects malformed money, missing schema and foreign keys without changing live data', async t => {
  const f = await fixture(t); await f.customer('应保留');
  const raw = Buffer.from(await (await fetch(f.base + '/api/backup')).arrayBuffer()); const original = JSON.parse(gunzipSync(raw));
  const variants = [structuredClone(original), structuredClone(original), structuredClone(original)];
  variants[0].tables.customers[0].status = '任意状态'; delete variants[1].tables.customers;
  variants[2].tables.contracts.push({ id: 999, customer_id: 999, title: '孤儿合同', content: '', start_date: '2026-01-01', end_date: '2026-12-31', amount_cents: 100, cycle: '月付', status: '执行中', notes: '', created_at: '2026-10-18 00:00:00' });
  for (const invalid of variants) {
    assert.equal((await f.request('/api/restore', 'POST', { content: Buffer.from(JSON.stringify(invalid)).toString('base64') })).status, 400);
    assert.equal((await f.request('/api/state')).data.customers[0].name, '应保留');
  }
});

test('same-origin guard, CSV injection escaping, and history preservation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/customers', 'POST', { name: '跨站' }, { Origin: 'https://evil.example' })).status, 403);
  const c = await f.customer('=HYPERLINK("evil")');
  const csv = await (await fetch(f.base + '/api/export/customers')).text(); assert.ok(csv.includes("'=HYPERLINK"));
  await f.request('/api/bills', 'POST', { customer_id: c.id, date: '2026-10-18', type: '发票', amount_cents: 1 });
  assert.equal((await f.request('/api/customers/' + c.id, 'DELETE')).status, 400);
  assert.equal((await f.request('/api/customers/' + c.id, 'PUT', { name: c.name, status: '已归档' })).code, 0);
  assert.equal((await f.request('/api/demo', 'POST', {})).status, 400);
  const reboundStatus = await new Promise((resolve, reject) => httpGet(f.base + '/api/state', { headers: { Host: 'rebinding.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(reboundStatus, 403);
});

test('complete demo backup preserves accounting and rejects unbalanced tampering', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/demo', 'POST', {})).code, 0);
  const initial = (await f.request('/api/state')).data;
  assert.equal(initial.customers.length, 3); assert.ok(initial.accounting.accounts.length); assert.ok(initial.accounting.vouchers.length);
  const bytes = Buffer.from(await (await fetch(f.base + '/api/backup')).arrayBuffer());
  const invalid = JSON.parse(gunzipSync(bytes)); invalid.tables.voucher_entries[0].debit_cents += 1;
  assert.equal((await f.request('/api/restore', 'POST', { content: Buffer.from(JSON.stringify(invalid)).toString('base64') })).status, 400);
  assert.deepEqual((await f.request('/api/state')).data.accounting, initial.accounting);
  assert.equal((await f.request('/api/restore', 'POST', { content: bytes.toString('base64') })).code, 0);
  assert.deepEqual((await f.request('/api/state')).data.accounting, initial.accounting);
});

test('aggregate money overflow rolls back the attempted write', async t => {
  const f = await fixture(t); const c = await f.customer();
  const body = { customer_id: c.id, title: '安全上限', amount_cents: Number.MAX_SAFE_INTEGER, start_date: '2026-01-01', end_date: '2026-12-31' };
  assert.equal((await f.request('/api/contracts', 'POST', body)).code, 0);
  assert.equal((await f.request('/api/contracts', 'POST', { ...body, amount_cents: 1 })).status, 400);
  const state = (await f.request('/api/state')).data;
  assert.equal(state.contracts.length, 1); assert.equal(state.dashboard.contract_amount_cents, Number.MAX_SAFE_INTEGER);
});

test('oversize backups cannot be downloaded or replace current data without a recoverable snapshot', async t => {
  const f = await fixture(t); const c = await f.customer('保留大附件');
  const bill = (await f.request('/api/bills', 'POST', { customer_id: c.id, date: '2026-10-18', amount_cents: 1, type: '其他' })).data;
  const smallBackup = Buffer.from(await (await fetch(f.base + '/api/backup')).arrayBuffer());
  const attachment = Buffer.alloc(10 * 1024 * 1024);
  const insert = f.db.prepare('INSERT INTO attachments(bill_id,name,mime,size,content) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 10; i++) insert.run(bill.id, `大附件-${i}.bin`, 'application/octet-stream', attachment.length, attachment);
  const response = await fetch(f.base + '/api/backup');
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const error = await response.json();
  assert.match(error.message, /128/); assert.match(error.message, /停止服务后复制整个 data 文件夹/);
  const restored = await f.request('/api/restore', 'POST', { content: smallBackup.toString('base64') });
  assert.equal(restored.status, 413); assert.match(restored.message, /停止服务后复制整个 data 文件夹/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM attachments').get().n, 10);
  assert.equal(f.db.prepare('SELECT name FROM customers WHERE id=?').get(c.id).name, '保留大附件');
  assert.equal(readdirSync(join(f.dataDir, 'backups')).length, 0);
});

test('backup encoder checks compressed capacity as well as expanded capacity', async t => {
  const f = await fixture(t); await f.customer('压缩容量校验');
  const normal = backupBuffer(f.db);
  assert.equal(JSON.parse(gunzipSync(normal)).tables.customers[0].name, '压缩容量校验');
  assert.throws(() => backupBuffer(f.db, { ...BACKUP_LIMITS, archive: normal.length - 20 }), error => error.status === 413 && /停止服务后复制整个 data 文件夹/.test(error.message));
  assert.throws(() => backupBuffer(f.db, { ...BACKUP_LIMITS, expanded: 100 }), error => error.status === 413);
});
