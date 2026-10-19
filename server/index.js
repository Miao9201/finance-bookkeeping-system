import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { registerBusiness } from './business.js';
import * as accounting from './accounting.js';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createApp({ dataDir = process.env.YUNDAIZHANG_DATA_DIR || join(projectDir, 'data') } = {}) {
  const { db, dbPath, dataDir: actualDataDir } = openDatabase(dataDir);
  try { accounting.initAccounting(db); } catch (error) { db.close(); throw error; }
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    let url;
    try { url = new URL('http://' + req.headers.host); } catch { return res.status(403).json({ code: 403, data: null, message: '仅允许本机访问' }); }
    if (!loopback.has(url.hostname)) return res.status(403).json({ code: 403, data: null, message: '仅允许本机访问' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ code: 403, data: null, message: '已阻止跨站修改请求' });
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({ code: 403, data: null, message: '请求来源不正确' }); }
        if (origin.protocol !== 'http:' || origin.host !== url.host) return res.status(403).json({ code: 403, data: null, message: '已阻止跨站修改请求' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '132mb', strict: true }));
  registerBusiness(app, db, { dataDir: actualDataDir, dbPath, accountingState: accounting.accountingState, seedAccounting: accounting.seedAccounting, validateAccountingBackup: accounting.validateAccountingBackup });
  accounting.registerAccounting(app, db);
  app.use('/api', (req, res) => res.status(404).json({ code: 404, data: null, message: '接口不存在' }));
  const distDir = join(projectDir, 'dist');
  if (existsSync(join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: 'index.html', dotfiles: 'deny' }));
    app.get('/{*path}', (req, res) => res.sendFile(join(distDir, 'index.html')));
  } else app.get('/', (req, res) => res.type('text').send('前端尚未构建，请先运行 npm run build。'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500, message = error.message || '操作失败';
    if (error.type === 'entity.too.large') { status = 413; message = '上传内容过大，附件限 10 MB，备份限 96 MB'; }
    else if (error.type === 'entity.parse.failed') { status = 400; message = '请求不是有效的 JSON'; }
    else if (/UNIQUE constraint failed: tasks/.test(message)) { status = 400; message = '该客户本月任务已存在'; }
    else if (/FOREIGN KEY constraint failed/.test(message)) { status = 400; message = '记录存在关联数据，请先处理关联记录；客户可改为已归档'; }
    else if (/constraint failed/i.test(message)) { status = 400; message = '数据重复、金额或状态不符合要求'; }
    else if (!error.status) { console.error(error); message = '操作失败，请检查数据后重试；原有数据已保留'; }
    res.status(status).json({ code: status, data: null, message });
  });
  return { app, db, dataDir: actualDataDir, dbPath, close: () => db.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const instance = createApp(); const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
  const server = instance.app.listen(port, '127.0.0.1', () => console.log(`财务代账系统已启动：http://127.0.0.1:${port}\n本机数据：${instance.dataDir}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭已启动的财务代账系统或修改 PORT。` : error.message); instance.close(); process.exitCode = 1; });
  const stop = () => server.close(() => { instance.close(); process.exit(0); }); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
