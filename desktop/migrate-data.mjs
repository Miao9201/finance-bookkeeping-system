import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,renameSync,copyFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateAccountingBackup} from '../server/accounting.js';
export function fingerprint(db){
  const hash=createHash('sha256'),tables={};
  for(const {name,sql} of db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
    hash.update(name+'\0'+sql+'\0');let count=0;
    for(const row of db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').iterate()){
      for(const [key,value] of Object.entries(row)){hash.update(key+'\0');if(value instanceof Uint8Array){hash.update('blob:'+value.length+':');hash.update(value);}else hash.update(JSON.stringify(value));hash.update('\0');}count++;
    }
    tables[name]=count;
  }
  return {sha256:hash.digest('hex'),tables};
}
export async function migrateData(sourceDir,targetDir){
  sourceDir=resolve(sourceDir);targetDir=resolve(targetDir);
  const sourceFile=join(sourceDir,'yundaizhang.sqlite'),targetFile=join(targetDir,'yundaizhang.sqlite');
  if(!existsSync(sourceFile))throw new Error('原数据库不存在，停止迁移');
  if(existsSync(targetFile))throw new Error('目标数据库已存在，拒绝覆盖');
  if(sourceDir===targetDir)throw new Error('源目录与目标目录相同');
  mkdirSync(targetDir,{recursive:true});
  const staging=join(targetDir,'migration-'+randomUUID()+'.sqlite');
  const source=new DatabaseSync(sourceFile,{readOnly:true});let snapshot;
  try{
    source.exec('BEGIN');
    if(source.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('原数据库完整性检查失败');
    const original=fingerprint(source);
    await backup(source,staging);
    snapshot=new DatabaseSync(staging,{readOnly:true});
    if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||snapshot.prepare('PRAGMA foreign_key_check').all().length)throw new Error('迁移副本校验失败');
    validateAccountingBackup(snapshot);
    const copied=fingerprint(snapshot);
    if(copied.sha256!==original.sha256)throw new Error('迁移前后内容不一致，停止迁移');
    snapshot.close();snapshot=null;
    if(existsSync(targetFile))throw new Error('迁移期间目标数据库已生成，拒绝覆盖');
    renameSync(staging,targetFile);
    const backups=join(targetDir,'backups');mkdirSync(backups,{recursive:true});
    const backupName='before-desktop-migration-'+new Date().toISOString().replaceAll(':','-')+'.sqlite';
    copyFileSync(targetFile,join(backups,backupName));
    const record={created_at:new Date().toISOString(),source:sourceFile,target:targetFile,...original,backup_name:backupName};
    writeFileSync(join(targetDir,'desktop-migration.json'),JSON.stringify(record,null,2));
    return record;
  }finally{if(snapshot)snapshot.close();source.exec('ROLLBACK');source.close();if(existsSync(staging))unlinkSync(staging);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);const source=args[args.indexOf('--source')+1],target=args[args.indexOf('--target')+1];
 if(!args.includes('--source')||!args.includes('--target')||!source||!target)throw new Error('需要 --source 和 --target 数据目录');
 console.log(JSON.stringify(await migrateData(source,target),null,2));
}
