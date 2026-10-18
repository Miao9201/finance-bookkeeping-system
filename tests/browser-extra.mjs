import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'yundaizhang-extra-'));
const instance = createApp({ dataDir });
const server = instance.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const pageErrors = [], failures = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const nav = async name => page.getByRole('navigation').getByRole('button', { name: new RegExp('^' + name + '(?:\\s*\\d+)?$') }).click();
const state = async () => (await (await fetch(base + '/api/state')).json()).data;
const yuan = cents => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dateOffset = days => { const date = new Date(); date.setDate(date.getDate() + days); return localDate(date); };
const today = dateOffset(0), month = today.slice(0, 7);
async function api(path, data, method = 'POST') {
  const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  assert.equal(result.code, 0, `${method} ${path}: ${result.message || ''}`);
  return result.data;
}
async function check(name, run) {
  try { await run(); console.log('PASS extra browser: ' + name); }
  catch (error) { failures.push({ name, error }); console.error('FAIL extra browser: ' + name + '\n' + error.stack); }
}
async function contractRows() {
  return page.locator('.business-view .data-table tbody tr td:first-child button').allTextContents();
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: '体验虚构示例' }).click();
  await page.getByRole('button', { name: '载入示例', exact: true }).click();
  await page.getByText('虚构示例已载入，可以开始体验。', { exact: true }).waitFor();
  if (process.env.YUNDAIZHANG_PREVIEW_PATH) {
    await page.locator('.toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: resolve(process.env.YUNDAIZHANG_PREVIEW_PATH), fullPage: true, animations: 'disabled' });
  }
  const demo = await state();
  assert.ok(demo.accounting.accounts.length >= 2, 'demo needs two independent accounts');
  const second = demo.accounting.accounts[1];
  const withoutAccount = demo.customers.find(customer => !demo.accounting.accounts.some(account => account.customer_id === customer.id));
  assert.ok(withoutAccount, 'demo needs customer without account');

  await check('second account survives vouchers → financial and shows its own totals', async () => {
    await nav('账套设置');
    await page.getByLabel('客户账套', { exact: true }).selectOption(String(second.id));
    await nav('凭证管理');
    assert.equal(await page.getByLabel('客户账套', { exact: true }).inputValue(), String(second.id));
    const expectedVouchers = demo.accounting.vouchers.filter(voucher => voucher.account_id === second.id && voucher.date.startsWith(month));
    assert.equal(await page.locator('.accounting-view .data-table tbody tr').count(), expectedVouchers.length);
    const receipt = expectedVouchers.find(voucher => voucher.summary === '虚构示例：收到服务款');
    const expectedDebit = receipt.entries.reduce((sum, row) => sum + row.debit_cents, 0);
    assert.equal(await page.getByRole('row').filter({ hasText: receipt.summary }).locator('.money').first().innerText(), '¥' + yuan(expectedDebit));
    await nav('财务报表');
    await page.getByRole('heading', { name: '资产负债基础表' }).waitFor();
    assert.equal(await page.getByLabel('客户账套', { exact: true }).inputValue(), String(second.id));
    const financial = (await (await fetch(base + `/api/financial?account_id=${second.id}&month=${month}`)).json()).data;
    await page.locator('.report-stats .card').filter({ hasText: '资产合计' }).getByText('¥' + yuan(financial.balance_sheet.assets_cents), { exact: true }).waitFor();
    await page.locator('.report-stats .card').filter({ hasText: '本期净利润' }).getByText('¥' + yuan(financial.income_statement.net_profit_cents), { exact: true }).waitFor();
  });

  await check('dashboard quick 录入凭证 opens an enabled account voucher form', async () => {
    await nav('工作台');
    await page.locator('.quick-grid').getByRole('button', { name: '录入凭证' }).click();
    const dialog = page.getByRole('dialog', { name: '记账凭证', exact: true });
    await dialog.waitFor();
    assert.ok(await dialog.getByLabel('摘要', { exact: false }).first().isVisible());
    const selectedAccount = Number(await page.getByLabel('客户账套', { exact: true }).inputValue());
    assert.ok(demo.accounting.accounts.find(account => account.id === selectedAccount)?.enabled);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });

  await check('customer without an account shows empty account and no other customer voucher data', async () => {
    await nav('客户管理');
    await page.getByRole('button', { name: withoutAccount.name, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '查看凭证', exact: true }).click();
    await page.getByRole('heading', { name: '该客户尚未建立账套' }).waitFor();
    assert.equal(await page.getByLabel('客户账套', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('.accounting-view .data-table').count(), 0);
    assert.equal(await page.getByRole('button', { name: '＋ 新增凭证', exact: true }).isDisabled(), true);
  });

  const contractFixtures = [
    { title: '额外回归：十日内续签', end_date: dateOffset(10), status: '执行中' },
    { title: '额外回归：过期仍执行', end_date: dateOffset(-1), status: '执行中' },
    { title: '额外回归：已到期待续签', end_date: dateOffset(-2), status: '已到期' },
    { title: '额外回归：已终止排除', end_date: dateOffset(-3), status: '已终止' },
    { title: '额外回归：长期合同排除', end_date: dateOffset(90), status: '执行中' },
  ];
  for (const fixture of contractFixtures) await api('/contracts', { ...fixture, customer_id: demo.customers[0].id, content: '隔离临时数据库中的虚构回归记录', start_date: dateOffset(-100), amount_cents: 10000, cycle: '一次性', notes: '自动浏览器回归' });
  await page.reload();
  await check('contract strip 30-day and expired filters match actual contracts', async () => {
    const fixtureState = await state();
    const expectedSoon = fixtureState.contracts.filter(contract => contract.status === '执行中' && contract.end_date >= today && contract.end_date <= dateOffset(30)).map(contract => contract.title).sort();
    const expectedExpired = fixtureState.contracts.filter(contract => contract.status === '已到期' || (contract.status === '执行中' && contract.end_date < today)).map(contract => contract.title).sort();
    await nav('工作台');
    const soon = page.locator('.contract-metric').filter({ hasText: '30 天内到期' });
    assert.match(await soon.innerText(), new RegExp(`\\n${expectedSoon.length}份$`));
    await soon.click();
    await page.getByRole('heading', { name: '代账合同', exact: true }).waitFor();
    assert.deepEqual((await contractRows()).sort(), expectedSoon);
    await nav('工作台');
    await page.locator('.contract-metric').filter({ hasText: '已到期待续签' }).click();
    await page.getByRole('heading', { name: '代账合同', exact: true }).waitFor();
    assert.deepEqual((await contractRows()).sort(), expectedExpired);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    assert.equal((await contractRows()).length, fixtureState.contracts.length);
  });

  await check('archiving a service customer reduces live dashboard service count', async () => {
    const before = await state();
    const serviceCustomer = before.customers.find(customer => customer.status === '服务中');
    const expected = before.customers.filter(customer => customer.status === '服务中').length - 1;
    await nav('客户管理');
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: serviceCustomer.name, exact: true }) });
    await row.getByRole('button', { name: '归档', exact: true }).click();
    await row.getByText('已归档', { exact: true }).waitFor();
    await nav('工作台');
    assert.equal(await page.locator('.stat-value').first().innerText(), expected + '家');
    assert.equal((await state()).dashboard.active_customer_count, expected);
  });

  await check('completed and incomplete past-due tasks produce correct current-month status and overdue count', async () => {
    const current = await state();
    assert.ok(current.tasks.length >= 3);
    const completed = current.tasks[0], incomplete = current.tasks[1];
    await api('/tasks/' + completed.id, { ...completed, month, due_date: dateOffset(-1), steps: completed.steps.map(step => ({ ...step, status: '已完成', date: today })) }, 'PUT');
    await api('/tasks/' + incomplete.id, { ...incomplete, month, due_date: dateOffset(-1), steps: incomplete.steps.map((step, index) => ({ ...step, status: index ? '未开始' : '已完成', date: index ? '' : today })) }, 'PUT');
    await page.reload();
    await page.getByRole('heading', { name: '工作台.' }).waitFor();
    const updated = await state(), tasks = updated.tasks.filter(task => task.month === month);
    const pending = tasks.filter(task => task.steps.some(step => step.status !== '已完成'));
    const late = pending.filter(task => task.due_date < today);
    assert.equal(await page.locator('.stat-value').nth(3).innerText(), `${pending.length}项${late.length ? late.length + ' 项逾期' : ''}`);
    assert.equal(await page.locator('.ring-content strong').innerText(), Math.round((tasks.length - pending.length) / tasks.length * 100) + '%');
    const updatedTask = updated.tasks.find(task => task.id === completed.id);
    assert.equal(updatedTask.status, '已完成');
    assert.equal(updatedTask.progress, 100);
    await nav('月度任务');
    const completedCustomer = updated.customers.find(customer => customer.id === updatedTask.customer_id);
    const taskRow = page.getByRole('row').filter({ hasText: completedCustomer.name });
    assert.equal(await taskRow.getByText('已逾期', { exact: true }).count(), 0);
    assert.equal(await taskRow.locator('.badge.success').count(), 5);
  });

  assert.deepEqual(pageErrors, [], 'no browser runtime errors');
  if (failures.length) throw new AggregateError(failures.map(failure => failure.error), failures.map(failure => failure.name).join('; '));
  console.log('PASS extra browser regression: account isolation/preservation, quick entry, missing account isolation, real expiry filters, archive count, task completion/overdue state. Temporary database only.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  instance.close();
  const resolvedData = resolve(dataDir), resolvedTemp = resolve(tmpdir()) + sep;
  assert.ok(resolvedData.startsWith(resolvedTemp) && basename(resolvedData).startsWith('yundaizhang-extra-'), 'temporary cleanup path must remain in the generated temp directory');
  await rm(resolvedData, { recursive: true, force: true });
}
