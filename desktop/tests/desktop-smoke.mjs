import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {spawn,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,join,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const source=dirname(dirname(fileURLToPath(import.meta.url)));
const exe=resolve(process.env.YUNDAIZHANG_EXE_PATH || resolve(source,'../release/云代账.exe'));
assert.ok(existsSync(exe),'Built desktop EXE must exist');
const data=await mkdtemp(join(tmpdir(),'yundaizhang-desktop-'));
const port=32991;let child,browser,page,base;
async function downloaded(extension,check){const end=Date.now()+15000;let last;while(Date.now()<end){try{const name=(await readdir(join(data,'test-downloads'))).find(n=>n.endsWith(extension));if(name){const bytes=await readFile(join(data,'test-downloads',name));check(bytes);return bytes;}}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw last||new Error('Download not completed: '+extension);}
async function launch(){
 child=spawn(exe,['--data-dir',data,'--debug-port',String(port),'--test-mode'],{windowsHide:false,stdio:'ignore'});
 const end=Date.now()+60000;while(Date.now()<end){if(child.exitCode!==null)throw new Error('Desktop exited: '+await readFile(join(data,'desktop.log'),'utf8').catch(()=>''));try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});let tries=100;while(tries--){page=browser.contexts().flatMap(c=>c.pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,200));}
 assert.ok(page,'Actual WebView2 business page available');base=new URL(page.url()).origin;await page.getByRole('heading',{name:'工作台.'}).waitFor();
}
async function stop(){
 await browser.close();browser=null;
 execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${child.pid}; if(!$p.CloseMainWindow()){throw 'No desktop window'}`],{windowsHide:true});
 await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const t=setTimeout(()=>reject(new Error('Desktop did not close')),15000);child.once('exit',code=>{clearTimeout(t);code===0?resolve():reject(new Error('Desktop exit '+code));});});
 await assert.rejects(fetch(base+'/api/state'));
}
try{
 await launch();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const second=spawn(exe,['--data-dir',data],{windowsHide:false,stdio:'ignore'});assert.equal(await new Promise((r,j)=>{const timer=setTimeout(()=>j(new Error('Duplicate instance did not exit')),10000);second.once('exit',code=>{clearTimeout(timer);r(code);});}),0);assert.equal(Number(await readFile(join(data,'desktop.pid'),'utf8')),child.pid);
 const nav=async name=>page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
 await nav('客户管理');await page.getByRole('button',{name:'＋ 新增客户',exact:true}).click();await page.getByRole('dialog').getByLabel('企业名称').fill('EXE虚构验证客户');await page.getByRole('dialog').getByRole('button',{name:'保存记录'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 let state=(await(await fetch(base+'/api/state')).json()).data;assert.equal(state.customers[0].name,'EXE虚构验证客户');
 await nav('票据管理');await page.getByRole('button',{name:'＋ 登记票据'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('金额（元）').fill('128.29');await dialog.locator('input[type=file]').setInputFiles({name:'EXE附件.txt',mimeType:'text/plain',buffer:Buffer.from('EXE KEEP ATTACHMENT')});await dialog.getByRole('button',{name:'保存记录'}).click();await dialog.waitFor({state:'hidden'});
 state=(await(await fetch(base+'/api/state')).json()).data;const attachment=state.bills[0].attachments[0];assert.equal(await(await fetch(base+'/api/attachments/'+attachment.id)).text(),'EXE KEEP ATTACHMENT');
 await page.locator('.attachment-link').first().click();await downloaded('.txt',bytes=>assert.equal(bytes.toString(),'EXE KEEP ATTACHMENT'));
 await nav('客户管理');await page.getByRole('link',{name:'导出 CSV',exact:true}).click();await downloaded('.csv',bytes=>assert.match(bytes.toString('utf8'),/EXE虚构验证客户/));
 await nav('数据维护');await page.getByRole('button',{name:'↧ 下载完整备份'}).click();await page.getByText('完整备份已生成，请妥善保存下载文件',{exact:true}).first().waitFor();
 await downloaded('.json.gz',bytes=>{const backup=JSON.parse(gunzipSync(bytes));assert.equal(backup.format,'yundaizhang-local-backup');assert.equal(backup.tables.customers[0].name,'EXE虚构验证客户');assert.equal(backup.tables.attachments.length,1);});
 const request=async(path,data,method='POST')=>{const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();assert.equal(result.code,0,result.message);return result.data;};
 const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 const account=await request('/accounts',{customer_id:1,name:'EXE打印验证账套',start_month:date.slice(0,7)});await request(`/accounts/${account.id}/openings`,{rows:[]},'PUT');await request(`/accounts/${account.id}/enable`,{});await request('/vouchers',{account_id:account.id,date,word:'记',status:'草稿',summary:'原生凭证打印验证',entries:[{subject_code:'1002.01',debit_cents:12829,credit_cents:0},{subject_code:'5001',debit_cents:0,credit_cents:12829}]});
 await page.reload();await nav('凭证管理');await page.getByRole('button',{name:'打印',exact:true}).click();let printPage;for(let i=0;i<100;i++){for(const candidate of browser.contexts().flatMap(c=>c.pages())){if(candidate===page||candidate.isClosed())continue;try{if((await candidate.locator('body').innerText({timeout:200})).includes('原生凭证打印验证')){printPage=candidate;break;}}catch{}}if(printPage)break;await new Promise(r=>setTimeout(r,100));}assert.ok(printPage,'Actual voucher print preview opens');assert.match(await printPage.locator('body').innerText(),/128\.29/);await printPage.close();
 await nav('工作台');assert.deepEqual(errors,[]);await stop();
 await launch();state=(await(await fetch(base+'/api/state')).json()).data;assert.equal(state.customers[0].name,'EXE虚构验证客户');assert.equal(state.bills[0].amount_cents,12829);assert.equal(await(await fetch(base+'/api/attachments/'+attachment.id)).text(),'EXE KEEP ATTACHMENT');await stop();
 await launch();await browser.close();browser=null;child.kill();await new Promise(r=>child.once('exit',r));let released=false;for(let i=0;i<100;i++){try{await fetch(base+'/api/state');}catch{released=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(released,'Owned backend exits when desktop host is force-closed');
 console.log('PASS native EXE: actual window, single instance, customer/bill/upload, byte-exact attachment and CSV downloads, valid full backup, actual voucher print preview, graceful close, restart persistence, parent-crash backend cleanup.');
}catch(error){console.log('NATIVE LOG',await readFile(join(data,'desktop.log'),'utf8').catch(()=>''));throw error;}finally{if(browser)await browser.close();if(child&&child.exitCode===null)child.kill();assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep)&&basename(data).startsWith('yundaizhang-desktop-'));await rm(data,{recursive:true,force:true,maxRetries:40,retryDelay:250});}
