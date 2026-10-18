import { SME_SUBJECTS, SUBJECT_SOURCE } from './subjects.js';

const MAX = Number.MAX_SAFE_INTEGER;
const statuses = ['草稿','待复核','已完成'];
const types = ['资产','负债','权益','成本','损益'];
const fail = (message,status=400)=>{throw Object.assign(new Error(message),{status});};
const all = (db,sql,...args)=>db.prepare(sql).all(...args);
const get = (db,sql,...args)=>db.prepare(sql).get(...args);
const run = (db,sql,...args)=>db.prepare(sql).run(...args);
const sum = values=>values.reduce((total,value)=>{const next=total+value; if(!Number.isSafeInteger(next)) fail('汇总金额超出安全整数范围');return next;},0);
const cents = (value,label='金额')=>{if(!Number.isSafeInteger(value)||value<0) fail(`${label}须为非负整数分`);return value;};
const idValue = value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)fail('ID无效');return n;};
const textValue = (value,label,max=200)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(`${label}不能为空且长度不能超过${max}字`);return value.trim();};
function monthValue(value) {
  if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)||value<'1900-01'||value>'2199-12')fail('会计期间须为有效的YYYY-MM');
  return value;
}
function dateValue(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('凭证日期无效');
  const parsed=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)fail('凭证日期无效');
  monthValue(value.slice(0,7));return value;
}
const addMonth = (month,offset)=>{
  const [year,m]=month.split('-').map(Number), date=new Date(Date.UTC(year,m-1+offset,1));
  return date.toISOString().slice(0,7);
};
function transaction(db,fn) {
  db.exec('SAVEPOINT accounting_write');
  try {const result=fn();db.exec('RELEASE accounting_write');return result;}
  catch(error){db.exec('ROLLBACK TO accounting_write; RELEASE accounting_write');throw error;}
}
function account(db,value,enabled=false) {
  const row=get(db,'SELECT * FROM accounts WHERE id=?',idValue(value));
  if(!row)fail('账套不存在',404);
  if(enabled&&!row.enabled)fail('请先录入期初并启用账套');
  return row;
}
function period(db,accountId,month,open=false) {
  monthValue(month);
  const row=get(db,'SELECT * FROM periods WHERE account_id=? AND month=?',accountId,month);
  if(!row)fail('此期间不在账套已建立的期间内');
  if(open&&row.closed)fail('此期间已结账，请先按顺序反结账');
  return row;
}
function earliestOpen(db,accountId,month) {
  const first=get(db,'SELECT month FROM periods WHERE account_id=? AND closed=0 ORDER BY month LIMIT 1',accountId);
  if(!first||first.month!==month)fail('须先完成最早未结账期间，不可跳期');
}
function leaf(db,accountId,code,active=true) {
  const subject=get(db,'SELECT * FROM subjects WHERE account_id=? AND code=?',accountId,String(code??''));
  if(!subject)fail(`科目${code??''}不属于此账套`);
  if(active&&!subject.active)fail(`科目${code}已停用`);
  if(active){
    let parentCode=subject.parent_code;
    while(parentCode){const parent=get(db,'SELECT active,parent_code FROM subjects WHERE account_id=? AND code=?',accountId,parentCode);if(!parent||!parent.active)fail(`科目${code}的上级科目已停用`);parentCode=parent.parent_code;}
  }
  if(get(db,'SELECT id FROM subjects WHERE account_id=? AND parent_code=? LIMIT 1',accountId,subject.code))fail(`科目${code}有明细科目，请选择末级科目`);
  return subject;
}
function subjectUsed(db,accountId,code) {
  return !!(get(db,'SELECT id FROM openings WHERE account_id=? AND subject_code=? LIMIT 1',accountId,code)||get(db,'SELECT e.id FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.account_id=? AND e.subject_code=? LIMIT 1',accountId,code));
}
function normalizeEntries(db,accountId,entries,opening=false,active=true) {
  if(!Array.isArray(entries)||entries.length>(opening?1000:500)||(!opening&&entries.length<2))fail(opening?'期初数据格式无效':'凭证至少需要两条分录，最多500条');
  const seen=new Set();
  const rows=entries.map(entry=>{
    if(!entry||typeof entry!=='object')fail('分录格式无效');
    const subject=leaf(db,accountId,entry.subject_code,active);
    const debit=cents(entry.debit_cents??0), credit=cents(entry.credit_cents??0);
    if(debit&&credit)fail('一条分录只能有借方或贷方金额');
    if(!opening&&!debit&&!credit)fail('分录金额必须大于零');
    if(opening&&seen.has(subject.code))fail('期初科目不可重复');
    seen.add(subject.code);
    if(entry.summary!==undefined&&(typeof entry.summary!=='string'||entry.summary.length>500))fail('分录摘要最多500字');
    return {subject_code:subject.code,summary:entry.summary?.trim()??'',debit_cents:debit,credit_cents:credit};
  });
  const debit=sum(rows.map(x=>x.debit_cents)),credit=sum(rows.map(x=>x.credit_cents));
  if(!opening&&(debit!==credit||debit<=0))fail('凭证借贷不平衡或金额为零');
  return {rows,debit,credit};
}

export function initAccounting(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),start_month TEXT NOT NULL CHECK(length(start_month)=7),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),code TEXT NOT NULL CHECK(length(code) BETWEEN 4 AND 13),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),parent_code TEXT,
      type TEXT NOT NULL CHECK(type IN('资产','负债','权益','成本','损益')),direction TEXT NOT NULL CHECK(direction IN('借','贷')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),preset INTEGER NOT NULL DEFAULT 0 CHECK(preset IN(0,1,2)),
      UNIQUE(account_id,code),FOREIGN KEY(account_id,parent_code) REFERENCES subjects(account_id,code) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS periods (
      account_id INTEGER NOT NULL REFERENCES accounts(id),month TEXT NOT NULL CHECK(length(month)=7),
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN(0,1)),carryforward_done INTEGER NOT NULL DEFAULT 0 CHECK(carryforward_done IN(0,1)),closed_at TEXT,
      PRIMARY KEY(account_id,month),CHECK(closed=0 OR carryforward_done=1)
    );
    CREATE TABLE IF NOT EXISTS openings (
      id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),subject_code TEXT NOT NULL,
      debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(debit_cents)='integer' AND debit_cents BETWEEN 0 AND ${MAX}),
      credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(credit_cents)='integer' AND credit_cents BETWEEN 0 AND ${MAX}),
      UNIQUE(account_id,subject_code),CHECK(debit_cents=0 OR credit_cents=0),FOREIGN KEY(account_id,subject_code) REFERENCES subjects(account_id,code)
    );
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),date TEXT NOT NULL CHECK(length(date)=10),
      month TEXT NOT NULL CHECK(month=substr(date,1,7)),word TEXT NOT NULL CHECK(length(word) BETWEEN 1 AND 10),
      number INTEGER NOT NULL CHECK(typeof(number)='integer' AND number BETWEEN 1 AND ${MAX}),
      status TEXT NOT NULL DEFAULT '草稿' CHECK(status IN('草稿','待复核','已完成')),summary TEXT NOT NULL DEFAULT '' CHECK(length(summary)<=500),
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN('manual','carryforward')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id,month,word,number),FOREIGN KEY(account_id,month) REFERENCES periods(account_id,month)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_carryforward_per_period ON vouchers(account_id,month) WHERE source='carryforward';
    CREATE TABLE IF NOT EXISTS voucher_entries (
      id INTEGER PRIMARY KEY,voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,subject_code TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '' CHECK(length(summary)<=500),
      debit_cents INTEGER NOT NULL CHECK(typeof(debit_cents)='integer' AND debit_cents BETWEEN 0 AND ${MAX}),
      credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents BETWEEN 0 AND ${MAX}),
      line_no INTEGER NOT NULL CHECK(line_no>=1),UNIQUE(voucher_id,line_no),
      CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0))
    );
    CREATE INDEX IF NOT EXISTS voucher_account_period ON vouchers(account_id,month,status);
    CREATE TABLE IF NOT EXISTS period_balances (
      account_id INTEGER NOT NULL,month TEXT NOT NULL,subject_code TEXT NOT NULL,
      opening_net_cents INTEGER NOT NULL CHECK(typeof(opening_net_cents)='integer' AND abs(opening_net_cents)<=${MAX}),
      debit_cents INTEGER NOT NULL CHECK(typeof(debit_cents)='integer' AND debit_cents BETWEEN 0 AND ${MAX}),
      credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents BETWEEN 0 AND ${MAX}),
      closing_net_cents INTEGER NOT NULL CHECK(typeof(closing_net_cents)='integer' AND abs(closing_net_cents)<=${MAX}),
      PRIMARY KEY(account_id,month,subject_code),FOREIGN KEY(account_id,month) REFERENCES periods(account_id,month),
      FOREIGN KEY(account_id,subject_code) REFERENCES subjects(account_id,code)
    );
  `);
}

function createAccount(db,body) {
  const customerId=idValue(body.customer_id), start=monthValue(body.start_month);
  const customer=get(db,'SELECT * FROM customers WHERE id=?',customerId);
  if(!customer)fail('客户不存在');
  if(customer.status==='已归档'||customer.archived===1)fail('归档客户不可新增账套');
  if(get(db,'SELECT id FROM accounts WHERE customer_id=?',customerId))fail('一个客户只能建立一个独立账套');
  const name=textValue(body.name||`${customer.name}账套`,'账套名称');
  return transaction(db,()=>{
    const id=Number(run(db,'INSERT INTO accounts(customer_id,name,start_month) VALUES(?,?,?)',customerId,name,start).lastInsertRowid);
    const insert=db.prepare('INSERT INTO subjects(account_id,code,name,parent_code,type,direction,preset) VALUES(?,?,?,?,?,?,?)');
    for(const s of SME_SUBJECTS)insert.run(id,s.code,s.name,s.parent_code,s.type,s.direction,s.preset);
    for(let offset=0;offset<12;offset++){
      const month=addMonth(start,offset);
      if(month<='2199-12')run(db,'INSERT INTO periods(account_id,month) VALUES(?,?)',id,month);
    }
    return account(db,id);
  });
}
function setOpenings(db,accountId,rows) {
  const book=account(db,accountId);
  if(book.enabled)fail('启用后期初余额已冻结');
  const normalized=normalizeEntries(db,book.id,rows,true);
  return transaction(db,()=>{
    run(db,'DELETE FROM openings WHERE account_id=?',book.id);
    for(const row of normalized.rows)run(db,'INSERT INTO openings(account_id,subject_code,debit_cents,credit_cents) VALUES(?,?,?,?)',book.id,row.subject_code,row.debit_cents,row.credit_cents);
    return {...normalized,balanced:normalized.debit===normalized.credit};
  });
}
function enableAccount(db,accountId) {
  const book=account(db,accountId);
  const openings=all(db,'SELECT * FROM openings WHERE account_id=?',book.id);
  const result=normalizeEntries(db,book.id,openings,true);
  if(result.debit!==result.credit)fail('期初借贷不平衡，不能启用账套');
  run(db,'UPDATE accounts SET enabled=1 WHERE id=?',book.id);
  return account(db,book.id);
}
function voucherById(db,value) {
  const row=get(db,'SELECT * FROM vouchers WHERE id=?',idValue(value));
  if(!row)fail('凭证不存在',404);
  return {...row,entries:all(db,'SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY line_no',row.id)};
}
function invalidateCarryforward(db,accountId,month) {
  const cf=get(db,"SELECT * FROM vouchers WHERE account_id=? AND month=? AND source='carryforward'",accountId,month);
  if(cf?.status==='已完成')fail('损益结转凭证已审核，请先反审核结转凭证再改动业务凭证');
  if(cf)run(db,'DELETE FROM vouchers WHERE id=?',cf.id);
  run(db,'UPDATE periods SET carryforward_done=0 WHERE account_id=? AND month=?',accountId,month);
}
function saveVoucher(db,body,existingId=null,source='manual') {
  const old=existingId?voucherById(db,existingId):null;
  if(old?.status==='已完成')fail('已审核凭证已锁定，请先反审核');
  if(old?.source==='carryforward')fail('自动结转凭证请删除后重新生成');
  const merged={...old,...body};
  const book=account(db,merged.account_id,true);
  if(old&&old.account_id!==book.id)fail('凭证不可转移到账套');
  const date=dateValue(merged.date),month=date.slice(0,7);
  period(db,book.id,month,true);
  if(old)period(db,book.id,old.month,true);
  const word=textValue(merged.word||'记','凭证字',10);
  const status=merged.status||'草稿';
  if(!statuses.includes(status))fail('凭证状态无效');
  const summary=merged.summary??'';
  if(typeof summary!=='string'||summary.length>500)fail('凭证摘要最多500字');
  const normalized=normalizeEntries(db,book.id,merged.entries);
  let number=merged.number;
  if(number===undefined||number===null||number==='')number=Number(get(db,'SELECT COALESCE(MAX(number),0)+1 AS next FROM vouchers WHERE account_id=? AND month=? AND word=?',book.id,month,word).next);
  if(!Number.isSafeInteger(number)||number<1)fail('凭证号须为正整数');
  if(get(db,'SELECT id FROM vouchers WHERE account_id=? AND month=? AND word=? AND number=? AND id<>?',book.id,month,word,number,old?.id??0))fail('此期间的凭证字号已存在');
  return transaction(db,()=>{
    if(source==='manual'){
      invalidateCarryforward(db,book.id,month);
      if(old&&old.month!==month)invalidateCarryforward(db,book.id,old.month);
    }
    let id=old?.id;
    if(id){
      run(db,'UPDATE vouchers SET date=?,month=?,word=?,number=?,status=?,summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',date,month,word,number,status,summary,id);
      run(db,'DELETE FROM voucher_entries WHERE voucher_id=?',id);
    }else id=Number(run(db,'INSERT INTO vouchers(account_id,date,month,word,number,status,summary,source) VALUES(?,?,?,?,?,?,?,?)',book.id,date,month,word,number,status,summary,source).lastInsertRowid);
    normalized.rows.forEach((row,index)=>run(db,'INSERT INTO voucher_entries(voucher_id,subject_code,summary,debit_cents,credit_cents,line_no) VALUES(?,?,?,?,?,?)',id,row.subject_code,row.summary,row.debit_cents,row.credit_cents,index+1));
    if(status==='已完成')assertBookPrecision(db,book.id,month);
    return voucherById(db,id);
  });
}
function setAudit(db,value,audit) {
  const voucher=voucherById(db,value);
  account(db,voucher.account_id,true);
  period(db,voucher.account_id,voucher.month,true);
  if(audit)normalizeEntries(db,voucher.account_id,voucher.entries);
  return transaction(db,()=>{
    if(voucher.source==='manual'&&((audit&&voucher.status!=='已完成')||(!audit&&voucher.status==='已完成')))invalidateCarryforward(db,voucher.account_id,voucher.month);
    run(db,'UPDATE vouchers SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',audit?'已完成':'待复核',voucher.id);
    assertBookPrecision(db,voucher.account_id,voucher.month);
    return voucherById(db,voucher.id);
  });
}

function balanceRows(db,accountId,month) {
  const subjects=all(db,'SELECT * FROM subjects WHERE account_id=? ORDER BY code',accountId);
  const parentCodes=new Set(subjects.map(x=>x.parent_code).filter(Boolean));
  const map=new Map(subjects.filter(x=>!parentCodes.has(x.code)).map(s=>[s.code,{...s,opening_net_cents:0,debit_cents:0,credit_cents:0,closing_net_cents:0}]));
  for(const opening of all(db,'SELECT * FROM openings WHERE account_id=?',accountId)) {
    const row=map.get(opening.subject_code);
    if(!row)fail('期初引用了非末级或缺失科目');
    row.opening_net_cents=sum([row.opening_net_cents,opening.debit_cents,-opening.credit_cents]);
  }
  const entries=all(db,"SELECT e.*,v.month FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id WHERE v.account_id=? AND v.status='已完成' AND v.month<=? ORDER BY v.date,v.number,e.line_no",accountId,month);
  for(const entry of entries){
    const row=map.get(entry.subject_code);
    if(!row)fail('凭证引用了非末级或缺失科目');
    if(entry.month<month)row.opening_net_cents=sum([row.opening_net_cents,entry.debit_cents,-entry.credit_cents]);
    else {row.debit_cents=sum([row.debit_cents,entry.debit_cents]);row.credit_cents=sum([row.credit_cents,entry.credit_cents]);}
  }
  for(const row of map.values()) {
    row.closing_net_cents=sum([row.opening_net_cents,row.debit_cents,-row.credit_cents]);
    row.opening_debit_cents=Math.max(row.opening_net_cents,0);row.opening_credit_cents=Math.max(-row.opening_net_cents,0);
    row.closing_debit_cents=Math.max(row.closing_net_cents,0);row.closing_credit_cents=Math.max(-row.closing_net_cents,0);
    row.subject_code=row.code;row.subject_name=row.name;
  }
  return [...map.values()];
}
function ledger(db,accountId,month,kind,subjectCode) {
  const book=account(db,accountId,true);period(db,book.id,month);
  if(!['general','detail','journal','trial','summary'].includes(kind))fail('账簿类型无效');
  const balances=balanceRows(db,book.id,month);
  let rows;
  if(kind==='detail'||kind==='journal') {
    if(subjectCode&&!get(db,'SELECT id FROM subjects WHERE account_id=? AND code=?',book.id,subjectCode))fail('科目不属于当前账套');
    rows=all(db,"SELECT e.*,s.name AS subject_name,v.date,v.month,v.word,v.number,v.summary AS voucher_summary,v.account_id FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id JOIN subjects s ON s.account_id=v.account_id AND s.code=e.subject_code WHERE v.account_id=? AND v.status='已完成' AND v.month=? ORDER BY v.date,v.word,v.number,e.line_no",book.id,month)
      .filter(row=>(!subjectCode||row.subject_code.startsWith(subjectCode))&&(kind!=='journal'||['1001','1002'].some(code=>row.subject_code.startsWith(code))));
    const running=new Map(balances.map(row=>[row.code,row.opening_net_cents]));
    for(const row of rows){row.balance_cents=sum([running.get(row.subject_code)??0,row.debit_cents,-row.credit_cents]);running.set(row.subject_code,row.balance_cents);row.summary=row.summary||row.voucher_summary;}
  } else if(kind==='trial') rows=balances;
  else {
    const roots=new Map(all(db,'SELECT * FROM subjects WHERE account_id=? AND parent_code IS NULL ORDER BY code',book.id).map(s=>[s.code,{subject_code:s.code,subject_name:s.name,type:s.type,direction:s.direction,opening_net_cents:0,debit_cents:0,credit_cents:0,closing_net_cents:0}]));
    for(const balance of balances){
      const root=roots.get(balance.code.slice(0,4));
      if(!root)fail('科目缺少一级科目');
      for(const field of ['opening_net_cents','debit_cents','credit_cents','closing_net_cents'])root[field]=sum([root[field],balance[field]]);
    }
    rows=[...roots.values()].map(row=>({...row,opening_debit_cents:Math.max(row.opening_net_cents,0),opening_credit_cents:Math.max(-row.opening_net_cents,0),closing_debit_cents:Math.max(row.closing_net_cents,0),closing_credit_cents:Math.max(-row.closing_net_cents,0)}));
    if(kind==='summary')rows=rows.filter(row=>row.debit_cents||row.credit_cents);
  }
  const totals={debit_cents:sum(rows.map(x=>x.debit_cents)),credit_cents:sum(rows.map(x=>x.credit_cents)),opening_debit_cents:sum(balances.map(x=>x.opening_debit_cents)),opening_credit_cents:sum(balances.map(x=>x.opening_credit_cents)),closing_debit_cents:sum(balances.map(x=>x.closing_debit_cents)),closing_credit_cents:sum(balances.map(x=>x.closing_credit_cents))};
  totals.balanced=totals.closing_debit_cents===totals.closing_credit_cents;
  return {account_id:book.id,month,kind,rows,totals,note:'仅已审核凭证进入账簿；金额单位为分。'};
}
function financial(db,accountId,month) {
  const book=account(db,accountId,true);period(db,book.id,month);
  const balances=balanceRows(db,book.id,month), roots=new Map();
  for(const row of balances){
    const code=row.code.slice(0,4), existing=roots.get(code)??{subject_code:code,subject_name:get(db,'SELECT name FROM subjects WHERE account_id=? AND code=?',book.id,code).name,type:row.type,amount_cents:0};
    existing.amount_cents=sum([existing.amount_cents,(row.type==='负债'||row.type==='权益')?-row.closing_net_cents:row.closing_net_cents]);roots.set(code,existing);
  }
  const assets=sum(balances.filter(x=>['资产','成本'].includes(x.type)).map(x=>x.closing_net_cents));
  const liabilities=-sum(balances.filter(x=>x.type==='负债').map(x=>x.closing_net_cents));
  const untransferred=-sum(balances.filter(x=>x.type==='损益').map(x=>x.closing_net_cents));
  const equity=sum([-sum(balances.filter(x=>x.type==='权益').map(x=>x.closing_net_cents)),untransferred]);
  const entries=all(db,"SELECT e.*,s.code,s.name,s.direction,v.month FROM voucher_entries e JOIN vouchers v ON e.voucher_id=v.id JOIN subjects s ON s.account_id=v.account_id AND s.code=e.subject_code WHERE v.account_id=? AND v.status='已完成' AND v.source<>'carryforward' AND s.type='损益' AND v.month>=? AND v.month<=?",book.id,month.slice(0,4)+'-01',month);
  const lossRoots=all(db,"SELECT * FROM subjects WHERE account_id=? AND type='损益' AND parent_code IS NULL ORDER BY code",book.id);
  const incomeRows=lossRoots.map(root=>{
    const relevant=entries.filter(x=>x.code.startsWith(root.code)), sign=root.direction==='贷'?1:-1;
    return {subject_code:root.code,subject_name:root.name,direction:root.direction,amount_cents:sign*sum(relevant.filter(x=>x.month===month).map(x=>x.credit_cents-x.debit_cents)),ytd_cents:sign*sum(relevant.map(x=>x.credit_cents-x.debit_cents))};
  });
  const incomeValue=code=>incomeRows.find(x=>x.subject_code===code)?.amount_cents??0;
  const revenue=sum(['5001','5051'].map(incomeValue)), cost=sum(['5401','5402'].map(incomeValue));
  const expenses=sum(['5403','5601','5602','5603','5711','5801'].map(incomeValue));
  const net=sum(entries.filter(x=>x.month===month).map(x=>x.credit_cents-x.debit_cents));
  return {account_id:book.id,month,
    balance_sheet:{rows:[...roots.values()].filter(x=>x.type!=='损益'),assets_cents:assets,liabilities_cents:liabilities,equity_cents:equity,untransferred_profit_cents:untransferred,difference_cents:sum([assets,-liabilities,-equity])},
    income_statement:{rows:incomeRows,revenue_cents:revenue,cost_cents:cost,expenses_cents:expenses,net_profit_cents:net,ytd_net_profit_cents:sum(entries.map(x=>x.credit_cents-x.debit_cents))},
    note:`基础财务汇总，仅包含已审核凭证；成本类余额计入资产，损益未结转余额计入权益。利润表排除自动结转，年累计自${book.start_month.slice(0,4)===month.slice(0,4)?book.start_month:month.slice(0,4)+'-01'}起的系统凭证；不含建账前损益发生额。报表不替代正式财务报告或税务申报。`};
}
function assertBookPrecision(db,accountId,fromMonth='1900-01') {
  for(const p of all(db,'SELECT month FROM periods WHERE account_id=? AND month>=? ORDER BY month',accountId,fromMonth)) {
    const rows=balanceRows(db,accountId,p.month);
    for(const field of ['opening_debit_cents','opening_credit_cents','debit_cents','credit_cents','closing_debit_cents','closing_credit_cents'])sum(rows.map(row=>row[field]));
    financial(db,accountId,p.month);
  }
}
function carryforward(db,accountId,month) {
  const book=account(db,accountId,true);period(db,book.id,month,true);earliestOpen(db,book.id,month);
  if(get(db,"SELECT id FROM vouchers WHERE account_id=? AND month=? AND source<>'carryforward' AND status<>'已完成' LIMIT 1",book.id,month))fail('请先审核本期全部业务凭证');
  const existing=get(db,"SELECT id FROM vouchers WHERE account_id=? AND month=? AND source='carryforward'",book.id,month);
  if(existing)return {voucher:voucherById(db,existing.id),no_activity:false};
  const loss=balanceRows(db,book.id,month).filter(x=>x.type==='损益'&&x.closing_net_cents!==0);
  return transaction(db,()=>{
    if(!loss.length){run(db,'UPDATE periods SET carryforward_done=1 WHERE account_id=? AND month=?',book.id,month);return {voucher:null,no_activity:true};}
    const profit=leaf(db,book.id,'3103');
    const lines=loss.map(row=>({subject_code:row.code,summary:'结转本期损益',debit_cents:Math.max(-row.closing_net_cents,0),credit_cents:Math.max(row.closing_net_cents,0)}));
    const diff=sum(lines.map(x=>x.credit_cents-x.debit_cents));
    if(diff!==0)lines.push({subject_code:profit.code,summary:'结转本期损益',debit_cents:Math.max(diff,0),credit_cents:Math.max(-diff,0)});
    const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
    const voucher=saveVoucher(db,{account_id:book.id,date:end,word:'转',status:'待复核',summary:`${month}损益结转`,entries:lines},null,'carryforward');
    run(db,'UPDATE periods SET carryforward_done=1 WHERE account_id=? AND month=?',book.id,month);
    return {voucher,no_activity:false};
  });
}
function closePeriod(db,accountId,month) {
  const book=account(db,accountId,true),p=period(db,book.id,month,true);earliestOpen(db,book.id,month);
  if(!p.carryforward_done)fail('请先执行本期损益结转');
  if(get(db,"SELECT id FROM vouchers WHERE account_id=? AND month=? AND status<>'已完成' LIMIT 1",book.id,month))fail('包括结转凭证在内的全部凭证须审核后才能结账');
  const balances=balanceRows(db,book.id,month);
  if(sum(balances.map(x=>x.closing_net_cents))!==0)fail('试算不平衡，不能结账');
  if(balances.some(x=>x.type==='损益'&&x.closing_net_cents!==0))fail('损益结转未结平，请重做结转');
  return transaction(db,()=>{
    run(db,'DELETE FROM period_balances WHERE account_id=? AND month=?',book.id,month);
    for(const row of balances)run(db,'INSERT INTO period_balances(account_id,month,subject_code,opening_net_cents,debit_cents,credit_cents,closing_net_cents) VALUES(?,?,?,?,?,?,?)',book.id,month,row.code,row.opening_net_cents,row.debit_cents,row.credit_cents,row.closing_net_cents);
    run(db,'UPDATE periods SET closed=1,closed_at=CURRENT_TIMESTAMP WHERE account_id=? AND month=?',book.id,month);
    if(!get(db,'SELECT month FROM periods WHERE account_id=? AND month>? LIMIT 1',book.id,month)){
      for(let offset=1;offset<=12;offset++){
        const next=addMonth(month,offset);
        if(next<='2199-12')run(db,'INSERT INTO periods(account_id,month) VALUES(?,?)',book.id,next);
      }
    }
    return period(db,book.id,month);
  });
}
function unclosePeriod(db,accountId,month) {
  const book=account(db,accountId,true),p=period(db,book.id,month);
  if(!p.closed)fail('此期间尚未结账');
  const latest=get(db,'SELECT month FROM periods WHERE account_id=? AND closed=1 ORDER BY month DESC LIMIT 1',book.id);
  if(latest?.month!==month)fail('只能从最近已结账期间开始反结账');
  return transaction(db,()=>{
    run(db,'UPDATE periods SET closed=0,closed_at=NULL WHERE account_id=? AND month=?',book.id,month);
    run(db,'DELETE FROM period_balances WHERE account_id=? AND month=?',book.id,month);
    return period(db,book.id,month);
  });
}

export function accountingState(db) {
  const entries=all(db,'SELECT * FROM voucher_entries ORDER BY voucher_id,line_no');
  return {accounts:all(db,'SELECT * FROM accounts ORDER BY id'),subjects:all(db,'SELECT * FROM subjects ORDER BY account_id,code'),periods:all(db,'SELECT * FROM periods ORDER BY account_id,month'),openings:all(db,'SELECT * FROM openings ORDER BY account_id,subject_code'),vouchers:all(db,'SELECT * FROM vouchers ORDER BY date DESC,number DESC,id DESC').map(v=>({...v,entries:entries.filter(e=>e.voucher_id===v.id),debit_cents:sum(entries.filter(e=>e.voucher_id===v.id).map(e=>e.debit_cents)),credit_cents:sum(entries.filter(e=>e.voucher_id===v.id).map(e=>e.credit_cents))})),subject_source:SUBJECT_SOURCE};
}

export function registerAccounting(app,db) {
  const route=(method,path,fn)=>app[method]('/api'+path,(req,res,next)=>{
    try {
      if(['post','put'].includes(method)&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)))fail('请求体须为JSON对象');
      const data=method==='get'?fn(req):transaction(db,()=>{
        const result=fn(req);
        if(get(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'")) {
          const labels={'/accounts':'新增账套','/accounts/:id/openings':'录入期初','/accounts/:id/enable':'启用账套','/subjects':'新增科目','/subjects/:id':'修改科目','/vouchers':'新增凭证','/vouchers/:id':method==='delete'?'删除凭证':'修改凭证','/vouchers/:id/audit':'审核凭证','/vouchers/:id/unaudit':'反审核凭证','/accounts/:id/periods':'添加期间','/accounts/:id/periods/:month/carryforward':'损益结转','/accounts/:id/periods/:month/close':'期间结账','/accounts/:id/periods/:month/unclose':'期间反结账'};
          run(db,'INSERT INTO audit_logs(action,entity,entity_id,detail) VALUES(?,?,?,?)',labels[path]||'会计操作','accounting',result?.id??(Number(req.params.id)||null),req.params.month??result?.summary??result?.name??'');
        }
        return result;
      });
      res.json({code:0,data,message:'操作成功'});
    }
    catch(error){if(String(error.message).includes('UNIQUE constraint'))error=Object.assign(new Error('记录已存在，请检查重复科目或凭证字号'),{status:400});next(error);}
  });
  route('post','/accounts',req=>createAccount(db,req.body));
  route('post','/accounts/:id/periods',req=>{
    const book=account(db,req.params.id),year=req.body.year;
    const latest=get(db,'SELECT month FROM periods WHERE account_id=? ORDER BY month DESC LIMIT 1',book.id).month;
    if(!Number.isInteger(year)||year!==Number(latest.slice(0,4))+1||year>2199)fail('仅可添加现有最后期间的下一年度，不能重复或跳年');
    const months=[];
    for(let next=addMonth(latest,1);next<=`${year}-12`;next=addMonth(next,1))months.push(next);
    for(const month of months)run(db,'INSERT INTO periods(account_id,month) VALUES(?,?)',book.id,month);
    return {year,added:months.length,periods:all(db,'SELECT * FROM periods WHERE account_id=? ORDER BY month',book.id)};
  });
  route('put','/accounts/:id/openings',req=>setOpenings(db,req.params.id,req.body.rows));
  route('post','/accounts/:id/enable',req=>enableAccount(db,req.params.id));
  route('get','/subjects',req=>{const book=account(db,req.query.account_id);return all(db,'SELECT * FROM subjects WHERE account_id=? ORDER BY code',book.id);});
  route('post','/subjects',req=>{
    const body=req.body,book=account(db,body.account_id),code=String(body.code??'');
    if(!/^\d{4}(\.\d{2}){0,3}$/.test(code))fail('科目编码须为4位一级，后续以点连接2位明细，最多4级');
    if(code.startsWith('3103.'))fail('3103本年利润为系统损益结转保留科目，不可增设明细');
    const parentCode=body.parent_code||null;
    let type=body.type,direction=body.direction;
    if(parentCode){
      const parent=get(db,'SELECT * FROM subjects WHERE account_id=? AND code=?',book.id,parentCode);
      if(!parent||code.length!==parentCode.length+3||!code.startsWith(parentCode))fail('上级科目与编码层级不匹配');
      if(subjectUsed(db,book.id,parentCode))fail('已发生业务或期初的末级科目不可直接增加明细');
      type=parent.type;direction=direction||parent.direction;
    }else if(code.length!==4)fail('非一级科目必须指定上级科目');
    if(!types.includes(type)||!['借','贷'].includes(direction))fail('科目类别或余额方向无效');
    const name=textValue(body.name,'科目名称');
    const id=Number(run(db,'INSERT INTO subjects(account_id,code,name,parent_code,type,direction) VALUES(?,?,?,?,?,?)',book.id,code,name,parentCode,type,direction).lastInsertRowid);
    return get(db,'SELECT * FROM subjects WHERE id=?',id);
  });
  route('put','/subjects/:id',req=>{
    const old=get(db,'SELECT * FROM subjects WHERE id=?',idValue(req.params.id));if(!old)fail('科目不存在',404);
    const body=req.body,name=body.name===undefined?old.name:textValue(body.name,'科目名称');
    if(body.account_id!==undefined&&idValue(body.account_id)!==old.account_id)fail('科目不可转移到账套');
    if(body.code!==undefined&&body.code!==old.code)fail('科目编码建立后不可修改');
    const active=body.active===undefined?old.active:Number(body.active);
    if(![0,1].includes(active))fail('科目启用状态无效');
    const type=body.type??old.type,direction=body.direction??old.direction;
    if(!types.includes(type)||!['借','贷'].includes(direction))fail('科目类别或余额方向无效');
    if((!active||type!==old.type||direction!==old.direction)&&subjectUsed(db,old.account_id,old.code))fail('已有业务或期初的科目不能停用或修改类别方向');
    if((type!==old.type||direction!==old.direction)&&(old.preset||get(db,'SELECT id FROM subjects WHERE account_id=? AND parent_code=?',old.account_id,old.code)))fail('预设科目或有下级的科目不能修改类别方向');
    if(old.parent_code){const parent=get(db,'SELECT type FROM subjects WHERE account_id=? AND code=?',old.account_id,old.parent_code);if(type!==parent.type)fail('明细科目类别须与上级一致');}
    run(db,'UPDATE subjects SET name=?,active=?,type=?,direction=? WHERE id=?',name,active,type,direction,old.id);
    return get(db,'SELECT * FROM subjects WHERE id=?',old.id);
  });
  route('post','/vouchers',req=>saveVoucher(db,req.body));
  route('put','/vouchers/:id',req=>saveVoucher(db,req.body,req.params.id));
  route('post','/vouchers/:id/audit',req=>setAudit(db,req.params.id,true));
  route('post','/vouchers/:id/unaudit',req=>setAudit(db,req.params.id,false));
  route('delete','/vouchers/:id',req=>{
    const v=voucherById(db,req.params.id);period(db,v.account_id,v.month,true);
    if(v.status==='已完成')fail('已审核凭证已锁定，请先反审核');
    return transaction(db,()=>{
      if(v.source==='manual')invalidateCarryforward(db,v.account_id,v.month);
      run(db,'DELETE FROM vouchers WHERE id=?',v.id);
      if(v.source==='carryforward')run(db,'UPDATE periods SET carryforward_done=0 WHERE account_id=? AND month=?',v.account_id,v.month);
      return {id:v.id};
    });
  });
  route('get','/ledger',req=>ledger(db,req.query.account_id,req.query.month,req.query.kind||'trial',req.query.subject_code));
  route('get','/financial',req=>financial(db,req.query.account_id,req.query.month));
  route('post','/accounts/:id/periods/:month/carryforward',req=>carryforward(db,req.params.id,req.params.month));
  route('post','/accounts/:id/periods/:month/close',req=>closePeriod(db,req.params.id,req.params.month));
  route('post','/accounts/:id/periods/:month/unclose',req=>unclosePeriod(db,req.params.id,req.params.month));
}

export function validateAccountingBackup(db) {
  for(const book of all(db,'SELECT * FROM accounts')) {
    monthValue(book.start_month);
    const periods=all(db,'SELECT * FROM periods WHERE account_id=? ORDER BY month',book.id);
    if(!periods.length||periods[0].month!==book.start_month)fail('备份账套期间不完整');
    let sawOpen=false;
    periods.forEach((p,index)=>{
      monthValue(p.month);if(p.month!==addMonth(book.start_month,index))fail('备份期间不连续');
      if(sawOpen&&p.closed)fail('备份存在跳期结账');if(!p.closed)sawOpen=true;
    });
    for(const s of all(db,'SELECT * FROM subjects WHERE account_id=?',book.id)) {
      if(!/^\d{4}(\.\d{2}){0,3}$/.test(s.code))fail('备份科目编码无效');
      if(s.code.startsWith('3103.'))fail('备份包含3103本年利润的明细科目，会阻止系统损益结转，不能恢复');
      if(s.parent_code){const parent=get(db,'SELECT * FROM subjects WHERE account_id=? AND code=?',book.id,s.parent_code);if(!parent||parent.type!==s.type||s.code.length!==parent.code.length+3||!s.code.startsWith(parent.code))fail('备份科目层级无效');}
      else if(s.code.length!==4)fail('备份缺少科目上级');
    }
    const opening=normalizeEntries(db,book.id,all(db,'SELECT * FROM openings WHERE account_id=?',book.id),true,false);
    if(book.enabled&&opening.debit!==opening.credit)fail('备份期初借贷不平衡');
    for(const v of all(db,'SELECT * FROM vouchers WHERE account_id=?',book.id)) {
      if(!book.enabled)fail('未启用账套不应含有凭证');
      dateValue(v.date);if(v.date.slice(0,7)!==v.month)fail('备份凭证日期与期间不一致');
      const p=period(db,book.id,v.month);
      if(p.closed&&v.status!=='已完成')fail('已结账期间存在未审核凭证');
      const entries=all(db,'SELECT * FROM voucher_entries WHERE voucher_id=?',v.id);
      normalizeEntries(db,book.id,entries,false,false);
      if(v.source==='carryforward'&&!p.carryforward_done)fail('备份结转标记不一致');
      if(v.source==='carryforward') {
        const end=new Date(Date.UTC(Number(v.month.slice(0,4)),Number(v.month.slice(5)),0)).toISOString().slice(0,10);
        if(v.date!==end||v.word!=='转'||entries.some(e=>{const s=get(db,'SELECT type FROM subjects WHERE account_id=? AND code=?',book.id,e.subject_code);return s.type!=='损益'&&e.subject_code!=='3103';}))fail('备份自动结转凭证包含不适用的科目或日期');
        if(get(db,"SELECT id FROM vouchers WHERE account_id=? AND month=? AND source='manual' AND status<>'已完成' LIMIT 1",book.id,v.month))fail('备份结转前的业务凭证未全部审核');
        for(const row of balanceRows(db,book.id,v.month).filter(row=>row.type==='损益')) {
          const adjustment=v.status==='已完成'?0:sum(entries.filter(e=>e.subject_code===row.code).map(e=>e.debit_cents-e.credit_cents));
          if(sum([row.closing_net_cents,adjustment])!==0)fail('备份损益结转凭证未结平损益科目');
        }
      }
    }
    if(get(db,'SELECT subject_code FROM period_balances b JOIN periods p ON b.account_id=p.account_id AND b.month=p.month WHERE b.account_id=? AND p.closed=0 LIMIT 1',book.id))fail('备份未结账期间不应有结账快照');
    for(const p of periods.filter(x=>x.carryforward_done))if(!get(db,"SELECT id FROM vouchers WHERE account_id=? AND month=? AND source='carryforward'",book.id,p.month)&&balanceRows(db,book.id,p.month).some(row=>row.type==='损益'&&row.closing_net_cents!==0))fail('备份结转标记与损益余额不一致');
    for(const p of periods.filter(x=>x.closed)) {
      const calculated=balanceRows(db,book.id,p.month),snapshots=all(db,'SELECT * FROM period_balances WHERE account_id=? AND month=?',book.id,p.month);
      if(!book.enabled||!snapshots.length)fail('备份结账余额快照不完整');
      const fields=['opening_net_cents','debit_cents','credit_cents','closing_net_cents'];
      for(const snapshot of snapshots)if(!calculated.some(row=>row.code===snapshot.subject_code)&&fields.some(field=>snapshot[field]!==0))fail('备份结账快照引用的科目已发生变动');
      for(const row of calculated){
        const snapshot=snapshots.find(x=>x.subject_code===row.code);
        if(snapshot?fields.some(field=>snapshot[field]!==row[field]):fields.some(field=>row[field]!==0))fail('备份结账快照与凭证不一致');
        if(row.type==='损益'&&row.closing_net_cents!==0)fail('备份已结账期间损益未结平');
      }
    }
    if(book.enabled)assertBookPrecision(db,book.id);
  }
  if(get(db,'SELECT e.id FROM voucher_entries e LEFT JOIN vouchers v ON v.id=e.voucher_id LEFT JOIN subjects s ON s.account_id=v.account_id AND s.code=e.subject_code WHERE v.id IS NULL OR s.id IS NULL LIMIT 1'))fail('备份分录引用了其他账套或缺失科目');
  return true;
}

export function seedAccounting(db) {
  if(get(db,'SELECT id FROM accounts LIMIT 1'))return;
  const customers=all(db,'SELECT id,name FROM customers ORDER BY id LIMIT 2');
  const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  for(const [index,customer] of customers.entries()){
    const book=createAccount(db,{customer_id:customer.id,start_month:month,name:`${customer.name}示例账套`});
    setOpenings(db,book.id,[{subject_code:'1002.01',debit_cents:5000000+index*2000000,credit_cents:0},{subject_code:'3001',debit_cents:0,credit_cents:5000000+index*2000000}]);
    enableAccount(db,book.id);
    saveVoucher(db,{account_id:book.id,date:month+'-05',summary:'虚构示例：收到服务款',status:'已完成',entries:[{subject_code:'1002.01',debit_cents:300000+index*100000,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:300000+index*100000}]});
    saveVoucher(db,{account_id:book.id,date:month+'-08',summary:'虚构示例：支付办公费用',status:'已完成',entries:[{subject_code:'5602.01',debit_cents:56000,credit_cents:0},{subject_code:'1002.01',debit_cents:0,credit_cents:56000}]});
    saveVoucher(db,{account_id:book.id,date:month+'-12',summary:'虚构示例：应收服务款（待复核）',status:'待复核',entries:[{subject_code:'1122',debit_cents:120000,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:120000}]});
  }
}

