import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { initAccounting, registerAccounting, accountingState, validateAccountingBackup } from '../server/accounting.js';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, status TEXT); INSERT INTO customers VALUES (1,'示例甲','服务中'),(2,'示例乙','服务中')");
  initAccounting(db);
  const app = express();
  app.use(express.json());
  registerAccounting(app, db);
  app.use((err,req,res,next)=>res.status(err.status || 500).json({code:1,message:err.message}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve=>server.once('listening', resolve));
  t.after(()=>{server.close();db.close();});
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {method, headers:{'Content-Type':'application/json'}, body:body === undefined?undefined:JSON.stringify(body)});
    return {status:response.status, ...(await response.json())};
  };
  const create = await api('/accounts',{customer_id:1,start_month:'2026-01',name:'测试账套'});
  assert.equal(create.status,200, create.message);
  const id = create.data.id;
  const enable = async()=>{
    assert.equal((await api(`/accounts/${id}/openings`, {rows:[{subject_code:'1002.01',debit_cents:100000,credit_cents:0},{subject_code:'3001',debit_cents:0,credit_cents:100000}]}, 'PUT')).status,200);
    assert.equal((await api(`/accounts/${id}/enable`,{})).status,200);
  };
  const voucher = (entries, extra={})=>api('/vouchers',{account_id:id,date:'2026-01-15',word:'记',status:'草稿',summary:'测试凭证',entries,...extra});
  return {db,api,id,enable,voucher};
}
const entries = (debit=1000,credit=debit)=>[{subject_code:'1002.01',debit_cents:debit,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:credit}];

test('account creates isolated subjects and periods and rejects a second book for a customer', async t=>{
  const {db,api,id}=await fixture(t);
  const state=accountingState(db);
  assert.ok(state.subjects.filter(s=>s.account_id===id).length>=140);
  assert.equal(state.periods.filter(p=>p.account_id===id).length,12);
  assert.equal((await api('/accounts',{customer_id:1,start_month:'2026-01'})).status,400);
  assert.equal((await api('/accounts',{customer_id:2,start_month:'2026-13'})).status,400);
});

test('only balanced openings enable a book and enabled openings are frozen', async t=>{
  const {api,id}=await fixture(t);
  await api(`/accounts/${id}/openings`,{rows:[{subject_code:'1002.01',debit_cents:5,credit_cents:0}]},'PUT');
  assert.equal((await api(`/accounts/${id}/enable`,{})).status,400);
  await api(`/accounts/${id}/openings`,{rows:[]},'PUT');
  assert.equal((await api(`/accounts/${id}/enable`,{})).status,200);
  assert.equal((await api(`/accounts/${id}/openings`,{rows:[]},'PUT')).status,400);
});

test('rejects unbalanced, unsafe, two-sided, disabled and non-leaf voucher entries', async t=>{
  const {api,id,enable,voucher,db}=await fixture(t);
  assert.equal((await voucher(entries())).status,400);
  await enable();
  assert.equal((await voucher(entries(1000,999))).status,400);
  assert.equal((await voucher(entries(Number.MAX_SAFE_INTEGER+1))).status,400);
  assert.equal((await voucher([{subject_code:'1002.01',debit_cents:1,credit_cents:1},...entries()])).status,400);
  assert.equal((await voucher([{subject_code:'1002',debit_cents:1,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:1}])).status,400);
  const subject=db.prepare('SELECT id FROM subjects WHERE account_id=? AND code=?').get(id,'5001');
  assert.equal((await api(`/subjects/${subject.id}`,{name:'主营业务收入',active:0},'PUT')).status,200);
  assert.equal((await voucher(entries())).status,400);
});

test('rejects a subject that belongs only to another account and invalid dates', async t=>{
  const {api,enable,voucher}=await fixture(t);
  await enable();
  const second=await api('/accounts',{customer_id:2,start_month:'2026-01'});
  await api('/subjects',{account_id:second.data.id,code:'1122.99',name:'乙专用往来',parent_code:'1122',type:'资产',direction:'借'});
  assert.equal((await voucher([{subject_code:'1122.99',debit_cents:2,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:2}])).status,400);
  assert.equal((await voucher(entries(),{date:'2026-02-30'})).status,400);
  assert.equal((await voucher(entries(),{date:'2025-12-01'})).status,400);
});

test('audited vouchers cannot edit or delete until unaudit and draft does not affect reports', async t=>{
  const {api,id,enable,voucher}=await fixture(t);
  await enable();
  const saved=await voucher(entries());
  assert.equal(saved.status,200,saved.message);
  assert.equal((await api(`/financial?account_id=${id}&month=2026-01`)).data.balance_sheet.assets_cents,100000);
  assert.equal((await api(`/vouchers/${saved.data.id}/audit`,{})).status,200);
  assert.equal((await api(`/vouchers/${saved.data.id}`,{entries:entries()},'PUT')).status,400);
  assert.equal((await api(`/vouchers/${saved.data.id}`,undefined,'DELETE')).status,400);
  assert.equal((await api(`/vouchers/${saved.data.id}/unaudit`,{})).status,200);
  assert.equal((await api(`/vouchers/${saved.data.id}`,undefined,'DELETE')).status,200);
});

test('voucher sequence is scoped by month and word and collisions are rejected', async t=>{
  const {enable,voucher}=await fixture(t);
  await enable();
  const first=await voucher(entries());
  const second=await voucher(entries());
  assert.equal(first.data.number,1);
  assert.equal(second.data.number,2);
  assert.equal((await voucher(entries(),{number:1})).status,400);
  assert.equal((await voucher(entries(),{date:'2026-02-01',number:1})).status,200);
});

test('financial statements and five ledgers reconcile before and after profit carryforward', async t=>{
  const {api,id,enable,voucher}=await fixture(t);
  await enable();
  const income=await voucher(entries(30000));
  await api(`/vouchers/${income.data.id}/audit`,{});
  const expense=await voucher([{subject_code:'5602.01',debit_cents:12000,credit_cents:0},{subject_code:'1002.01',debit_cents:0,credit_cents:12000}]);
  await api(`/vouchers/${expense.data.id}/audit`,{});
  const financial=(await api(`/financial?account_id=${id}&month=2026-01`)).data;
  assert.equal(financial.balance_sheet.assets_cents,118000);
  assert.equal(financial.balance_sheet.equity_cents,118000);
  assert.equal(financial.balance_sheet.difference_cents,0);
  assert.equal(financial.income_statement.net_profit_cents,18000);
  for (const kind of ['general','detail','journal','trial','summary']) {
    const ledger=await api(`/ledger?account_id=${id}&month=2026-01&kind=${kind}`);
    assert.equal(ledger.status,200,ledger.message);
    assert.ok(ledger.data.rows.length>0);
  }
  const closing=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  assert.equal(closing.status,200,closing.message);
  const again=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  assert.equal(again.data.voucher.id,closing.data.voucher.id);
  await api(`/vouchers/${closing.data.voucher.id}/audit`,{});
  const after=(await api(`/financial?account_id=${id}&month=2026-01`)).data;
  assert.equal(after.balance_sheet.difference_cents,0);
  assert.equal(after.balance_sheet.equity_cents,118000);
  assert.equal(after.income_statement.net_profit_cents,18000);
});

test('close follows sequence and requires audit and carryforward, unclose latest only', async t=>{
  const {api,id,enable,voucher,db}=await fixture(t);
  await enable();
  assert.equal((await api(`/accounts/${id}/periods/2026-02/close`,{})).status,400);
  assert.equal((await api(`/accounts/${id}/periods/2026-01/close`,{})).status,400);
  const v=await voucher(entries());
  assert.equal((await api(`/accounts/${id}/periods/2026-01/carryforward`,{})).status,400);
  await api(`/vouchers/${v.data.id}/audit`,{});
  const cf=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  assert.equal((await api(`/accounts/${id}/periods/2026-01/close`,{})).status,400);
  await api(`/vouchers/${cf.data.voucher.id}/audit`,{});
  assert.equal((await api(`/accounts/${id}/periods/2026-01/close`,{})).status,200);
  assert.ok(db.prepare('SELECT * FROM period_balances WHERE account_id=? AND month=?').all(id,'2026-01').length>0);
  assert.equal((await voucher(entries())).status,400);
  assert.equal((await api(`/vouchers/${v.data.id}/unaudit`,{})).status,400);
  const empty=await api(`/accounts/${id}/periods/2026-02/carryforward`,{});
  assert.equal(empty.data.no_activity,true);
  assert.equal((await api(`/accounts/${id}/periods/2026-02/close`,{})).status,200);
  assert.equal((await api(`/accounts/${id}/periods/2026-01/unclose`,{})).status,400);
  assert.equal((await api(`/accounts/${id}/periods/2026-02/unclose`,{})).status,200);
  assert.equal((await api(`/accounts/${id}/periods/2026-01/unclose`,{})).status,200);
});

test('backup validation rejects altered accounting amounts and state survives database reconstruction', async t=>{
  const {api,id,db,enable,voucher}=await fixture(t);
  await enable();
  const v=await voucher(entries(2400));
  await api(`/vouchers/${v.data.id}/audit`,{});
  assert.doesNotThrow(()=>validateAccountingBackup(db));
  const recovered=new DatabaseSync(':memory:');
  t.after(()=>recovered.close());
  for (const schema of db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all()) recovered.exec(schema.sql);
  for (const table of ['customers','accounts','subjects','periods','openings','vouchers','voucher_entries','period_balances']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const columns=Object.keys(row);
      recovered.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
    }
  }
  assert.deepEqual(accountingState(recovered),accountingState(db));
  recovered.prepare('UPDATE voucher_entries SET credit_cents=2399 WHERE voucher_id=? AND credit_cents>0').run(v.data.id);
  assert.throws(()=>validateAccountingBackup(recovered),/平衡/);
});

test('extends only the next contiguous calendar year and rejects duplicate or skipped years', async t=>{
  const {api,id,db}=await fixture(t);
  assert.equal((await api(`/accounts/${id}/periods`,{year:2028})).status,400);
  const next=await api(`/accounts/${id}/periods`,{year:2027});
  assert.equal(next.status,200,next.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM periods WHERE account_id=?').get(id).n,24);
  assert.equal((await api(`/accounts/${id}/periods`,{year:2027})).status,400);
});

test('inactive parent blocks posting and used subjects cannot gain children', async t=>{
  const {api,id,enable,voucher,db}=await fixture(t);
  await enable();
  assert.equal((await api('/subjects',{account_id:id,code:'1002.01.01',name:'分户',parent_code:'1002.01'})).status,400);
  const parent=db.prepare('SELECT id FROM subjects WHERE account_id=? AND code=?').get(id,'1002');
  assert.equal((await api(`/subjects/${parent.id}`,{active:0},'PUT')).status,200);
  assert.equal((await voucher(entries())).status,400);
});

test('subject added after a closed period does not invalidate an unchanged historical snapshot', async t=>{
  const {api,id,enable,db}=await fixture(t);
  await enable();
  await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  await api(`/accounts/${id}/periods/2026-01/close`,{});
  const added=await api('/subjects',{account_id:id,code:'1122.01',name:'客户甲',parent_code:'1122'});
  assert.equal(added.status,200,added.message);
  assert.doesNotThrow(()=>validateAccountingBackup(db));
});

test('manual changes invalidate an unreviewed carryforward and reviewed closing requires unaudit first', async t=>{
  const {api,id,enable,voucher,db}=await fixture(t);
  await enable();
  const original=await voucher(entries());
  await api(`/vouchers/${original.data.id}/audit`,{});
  const closing=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  const pending=await voucher(entries());
  assert.equal(pending.status,200,pending.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE source='carryforward'").get().n,0);
  assert.equal((await api(`/accounts/${id}/periods/2026-01/close`,{})).status,400);
  await api(`/vouchers/${pending.data.id}/audit`,{});
  const regenerated=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  await api(`/vouchers/${regenerated.data.voucher.id}/audit`,{});
  assert.equal((await voucher(entries())).status,400);
  assert.equal((await api(`/vouchers/${original.data.id}/unaudit`,{})).status,400);
  await api(`/vouchers/${regenerated.data.voucher.id}/unaudit`,{});
  assert.equal((await api(`/vouchers/${original.data.id}/unaudit`,{})).status,200);
});

test('audit that would overflow account balances is rolled back and preserves the draft', async t=>{
  const {api,id,voucher,db}=await fixture(t);
  await api(`/accounts/${id}/openings`,{rows:[{subject_code:'1002.01',debit_cents:Number.MAX_SAFE_INTEGER,credit_cents:0},{subject_code:'3001',debit_cents:0,credit_cents:Number.MAX_SAFE_INTEGER}]},'PUT');
  await api(`/accounts/${id}/enable`,{});
  const direct=await voucher(entries(1),{status:'已完成'});
  assert.equal(direct.status,400,direct.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get().n,0);
  const draft=await voucher(entries(1));
  assert.equal(draft.status,200,draft.message);
  assert.equal((await api(`/vouchers/${draft.data.id}/audit`,{})).status,400);
  assert.equal(db.prepare('SELECT status FROM vouchers WHERE id=?').get(draft.data.id).status,'草稿');
});

test('backup validation rejects a carryforward disguised as a manual cash movement', async t=>{
  const {api,id,voucher,db,enable}=await fixture(t);
  await enable();
  const v=await voucher(entries(2000));
  await api(`/vouchers/${v.data.id}/audit`,{});
  await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  const cf=db.prepare("SELECT id FROM vouchers WHERE source='carryforward'").get();
  db.prepare("UPDATE voucher_entries SET subject_code='1002.01' WHERE voucher_id=? AND subject_code='5001'").run(cf.id);
  assert.throws(()=>validateAccountingBackup(db),/结转/);
});

test('missing or array JSON payloads are validation errors without changing accounting data', async t=>{
  const {api,db}=await fixture(t);
  assert.equal((await api('/accounts',undefined,'POST')).status,400);
  assert.equal((await api('/vouchers',[])).status,400);
  const subject=db.prepare("SELECT id FROM subjects WHERE code='1001'").get();
  assert.equal((await api(`/subjects/${subject.id}`,[],'PUT')).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get().n,0);
});

test('reserves 3103 as the profit carryforward leaf and keeps carryforward usable', async t=>{
  const {api,id,enable,voucher,db}=await fixture(t);
  const added=await api('/subjects',{account_id:id,code:'3103.01',name:'本年利润明细',parent_code:'3103'});
  assert.equal(added.status,400,added.message);
  assert.match(added.message,/3103.*结转/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM subjects WHERE account_id=? AND parent_code='3103'").get(id).n,0);
  await enable();
  const income=await voucher(entries(3000));
  await api(`/vouchers/${income.data.id}/audit`,{});
  const closing=await api(`/accounts/${id}/periods/2026-01/carryforward`,{});
  assert.equal(closing.status,200,closing.message);
  assert.ok(closing.data.voucher.entries.some(row=>row.subject_code==='3103'&&row.credit_cents===3000));
  await api(`/vouchers/${closing.data.voucher.id}/audit`,{});
  assert.equal((await api(`/accounts/${id}/periods/2026-01/close`,{})).status,200);
});

test('backup rejects even an inactive child of the reserved 3103 carryforward subject', async t=>{
  const {id,db}=await fixture(t);
  db.prepare("INSERT INTO subjects(account_id,code,name,parent_code,type,direction,active) VALUES(?, '3103.01', '停用利润明细', '3103', '权益', '贷', 0)").run(id);
  assert.throws(()=>validateAccountingBackup(db),/3103.*结转/);
});

test('final supported month can be enabled and closed without generating unrestorable future periods', async t=>{
  const {api,db}=await fixture(t);
  const created=await api('/accounts',{customer_id:2,start_month:'2199-12',name:'日期上限账套'});
  assert.equal(created.status,200,created.message);
  const id=created.data.id;
  assert.equal((await api(`/accounts/${id}/enable`,{})).status,200);
  assert.equal((await api(`/accounts/${id}/periods/2199-12/carryforward`,{})).status,200);
  assert.equal((await api(`/accounts/${id}/periods/2199-12/close`,{})).status,200);
  const periods=db.prepare('SELECT month FROM periods WHERE account_id=? ORDER BY month').all(id);
  assert.deepEqual(periods.map(row=>row.month),['2199-12']);
  assert.doesNotThrow(()=>validateAccountingBackup(db));
});

