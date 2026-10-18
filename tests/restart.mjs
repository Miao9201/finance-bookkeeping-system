import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = resolve(projectDir, 'server', 'index.js');
const tempRoot = realpathSync(tmpdir());
const dataDir = mkdtempSync(join(tempRoot, 'yundaizhang-restart-'));
const children = new Set();
const attachmentBytes = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255, ...Buffer.from('跨进程附件持久化验证', 'utf8')]);
const preload = 'data:text/javascript,' + encodeURIComponent(`
  process.on('message', message => {
    if (message?.command === 'restart-test-shutdown') {
      if (process.listenerCount('SIGTERM') === 0) throw new Error('服务器关闭处理器尚未注册');
      process.emit('SIGTERM');
    }
  });
`);

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolvePort, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolvePort); });
  const port = socket.address().port;
  await new Promise((resolvePort, reject) => socket.close(error => error ? reject(error) : resolvePort()));
  return port;
}

async function start(port) {
  // IPC invokes the existing shutdown handler because Windows kill(SIGTERM) uses TerminateProcess.
  const child = spawn(process.execPath, ['--import', preload, serverPath], {
    cwd: projectDir,
    env: { ...process.env, YUNDAIZHANG_DATA_DIR: dataDir, PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let output = '', spawnError;
  const capture = chunk => { output = (output + chunk.toString()).slice(-12000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`子进程启动失败：${output}`);
    try {
      const response = await fetch(base + '/api/state', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json();
        if (body.code === 0) { assert.equal(resolve(body.data.system.data_dir), resolve(dataDir)); return { child, exited, base, output: () => output }; }
      }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`子进程未在期限内就绪：${output}`);
}

async function stop(instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) throw new Error(`子进程意外退出：${instance.output()}`);
  await new Promise((resolveSend, reject) => instance.child.send({ command: 'restart-test-shutdown' }, error => error ? reject(error) : resolveSend()));
  const exit = await withTimeout(instance.exited, 8000, '服务器没有正常关闭');
  assert.equal(exit.code, 0, `服务器退出状态异常：${instance.output()}`);
  assert.equal(exit.signal, null);
  children.delete(instance.child);
}

async function api(base, path, body) {
  const response = await fetch(base + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.code, 0, JSON.stringify(result));
  return result.data;
}

function verifyTotals(state) {
  assert.equal(state.dashboard.customer_count, 1);
  assert.equal(state.dashboard.contract_amount_cents, 120045);
  assert.equal(state.dashboard.receivable_cents, 60001);
  assert.equal(state.dashboard.received_cents, 23456);
  assert.equal(state.dashboard.outstanding_cents, 36545);
}

try {
  const port = await unusedPort();
  const first = await start(port);
  const firstPid = first.child.pid;
  assert.equal((await api(first.base, '/state')).customers.length, 0);
  const customer = await api(first.base, '/customers', { name: '跨进程持久化测试企业（虚构）', contact: '测试联系人', status: '服务中', notes: '仅为临时目录中的自动化测试' });
  const contract = await api(first.base, '/contracts', { customer_id: customer.id, title: '重启验证合同', content: '虚构服务内容', start_date: '2026-01-01', end_date: '2026-12-31', amount_cents: 120045, cycle: '按年', status: '执行中' });
  const receivable = await api(first.base, '/receivables', { contract_id: contract.id, amount_cents: 60001, due_date: '2026-10-31', description: '第一期应收' });
  const payment = await api(first.base, '/payments', { receivable_id: receivable.id, date: '2026-10-18', amount_cents: 23456, method: '银行转账', notes: '分金额验证' });
  const bill = await api(first.base, '/bills', { customer_id: customer.id, date: '2026-10-18', type: '其他', amount_cents: 12345, number: 'RESTART-001', notes: '含二进制附件' });
  const attachment = await api(first.base, `/bills/${bill.id}/attachments`, { name: '重启验证附件.bin', mime: 'application/octet-stream', content: attachmentBytes.toString('base64') });
  const before = await api(first.base, '/state'); verifyTotals(before);
  await stop(first);

  const second = await start(port);
  const secondPid = second.child.pid;
  assert.notEqual(secondPid, firstPid);
  const after = await api(second.base, '/state'); verifyTotals(after);
  for (const key of ['customers', 'contracts', 'receivables', 'payments', 'bills', 'attachments', 'logs']) assert.deepEqual(after[key], before[key], `${key} 在进程重启后发生改变`);
  assert.equal(after.customers[0].id, customer.id); assert.equal(after.contracts[0].id, contract.id);
  assert.equal(after.receivables[0].id, receivable.id); assert.equal(after.receivables[0].balance_cents, 36545);
  assert.equal(after.payments[0].id, payment.id); assert.equal(after.bills[0].id, bill.id);
  const downloaded = await fetch(second.base + '/api/attachments/' + attachment.id);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), attachmentBytes);
  await stop(second);
  console.log(JSON.stringify({ result: 'PASS', first_pid: firstPid, second_pid: secondPid, customer_id: customer.id, contract_id: contract.id, receivable_id: receivable.id, payment_id: payment.id, bill_id: bill.id, attachment_id: attachment.id, attachment_bytes: attachmentBytes.length, received_cents: after.dashboard.received_cents, outstanding_cents: after.dashboard.outstanding_cents, shutdown: 'existing SIGTERM handler via IPC; both exit codes 0' }, null, 2));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill(); await withTimeout(exited, 5000, '测试子进程清理超时');
    }
  }
  const actualTarget = realpathSync(dataDir), relativeTarget = relative(tempRoot, actualTarget);
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith('..' + sep) || isAbsolute(relativeTarget) || !basename(actualTarget).startsWith('yundaizhang-restart-')) throw new Error('临时目录边界校验失败，停止清理');
  rmSync(actualTarget, { recursive: true, force: true });
}
