import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApp} from '../server/index.js';

export async function verifyLayout(page) {
  const nav=name=>page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
  await nav('账套设置');
  await page.locator('.subject-scroll tbody tr').first().waitFor();
  const edges=await page.locator('.subject-scroll').evaluate(wrap=>{
    const edge=cell=>{const range=document.createRange();range.selectNodeContents(cell);return range.getBoundingClientRect().left;};
    return [edge(wrap.querySelector('th:nth-child(2)')),...[...wrap.querySelectorAll('tbody tr')].slice(0,14).map(r=>edge(r.cells[1]))];
  });
  assert.ok(Math.max(...edges)-Math.min(...edges)<1,`Subject header and names must share a left edge: ${edges}`);
  const header=await page.locator('.topbar').boundingBox(),sidebar=await page.locator('.sidebar').boundingBox();
  const main=await page.locator('.main-content').boundingBox();
  await page.mouse.move(main.x+main.width-30,main.y+40);await page.mouse.wheel(0,650);
  await page.waitForFunction(()=>document.querySelector('.main-content').scrollTop>0);
  assert.equal(await page.evaluate(()=>window.scrollY),0,'The document must not scroll');
  const scrolledHeader=await page.locator('.topbar').boundingBox(),scrolledSidebar=await page.locator('.sidebar').boundingBox();
  assert.equal(scrolledHeader.y,header.y,'Header remains fixed');
  assert.equal(scrolledSidebar.y,sidebar.y,'Navigation remains fixed');
  if(process.env.LAYOUT_SCREENSHOT_PATH)await page.screenshot({path:process.env.LAYOUT_SCREENSHOT_PATH});
  await nav('客户管理');
  assert.equal(await page.locator('.main-content').evaluate(e=>e.scrollTop),0,'New menu opens at the top');
  await page.setViewportSize({width:1024,height:600});
  await nav('数据维护');
  assert.equal((await page.locator('.topbar').boundingBox()).y,0,'Short-window navigation stays usable');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'展开导航'}).click();await nav('账套设置');
  await page.locator('.subject-scroll tbody tr').first().waitFor();
  await page.mouse.move(370,120);await page.mouse.wheel(0,500);
  await page.waitForFunction(()=>document.querySelector('.main-content').scrollTop>0);
  assert.equal((await page.locator('.topbar').boundingBox()).y,0,'Mobile header remains fixed');
  assert.equal(await page.evaluate(()=>window.scrollY),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});await nav('账套设置');
  await page.getByRole('button',{name:'＋ 新增科目',exact:true}).click();
  await page.getByRole('dialog',{name:'会计科目',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  console.log('PASS layout: aligned subject names/header, independent content scrolling, fixed header/navigation, menu scroll reset, short window, mobile menu and modal.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const data=await mkdtemp(join(tmpdir(),'finance-layout-'));
  const instance=createApp({dataDir:data}),server=instance.app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    assert.equal((await fetch(base+'/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
    const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(base);await page.getByRole('heading',{name:'工作台.'}).waitFor();
    await verifyLayout(page);
  }finally{
    await browser.close();await new Promise(r=>server.close(r));instance.close();
    assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep)&&basename(data).startsWith('finance-layout-'));await rm(data,{recursive:true,force:true});
  }
}
