import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,basename,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {createApp} from '../../server/index.js';import {migrateData,fingerprint} from '../migrate-data.mjs';
test('native migration preserves every table and attachment and refuses overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yundaizhang-migration-'));const source=join(dir,'原数据'),target=join(dir,'桌面数据');
 try{
  const app=createApp({dataDir:source});app.db.prepare('INSERT INTO customers(name) VALUES(?)').run('迁移虚构企业');app.db.prepare('INSERT INTO bills(customer_id,date,type,amount_cents) VALUES(1,?,?,29)').run('2026-10-18','收据');const bytes=Buffer.from([0,1,2,255,254,65,66]);app.db.prepare('INSERT INTO attachments(bill_id,name,mime,size,content) VALUES(1,?,?,?,?)').run('完整附件.bin','application/octet-stream',bytes.length,bytes);const expected=fingerprint(app.db);app.close();
  const record=await migrateData(source,target);assert.equal(record.sha256,expected.sha256);const moved=new DatabaseSync(join(target,'yundaizhang.sqlite'));assert.equal(fingerprint(moved).sha256,expected.sha256);assert.deepEqual(Buffer.from(moved.prepare('SELECT content FROM attachments').get().content),bytes);moved.close();
  await assert.rejects(migrateData(source,target),/拒绝覆盖/);const original=new DatabaseSync(join(source,'yundaizhang.sqlite'));assert.equal(fingerprint(original).sha256,expected.sha256);original.close();
 }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&basename(dir).startsWith('yundaizhang-migration-'));await rm(dir,{recursive:true,force:true});}
});
