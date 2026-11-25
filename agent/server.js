import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_DIR,
  isLoopbackHost,
  loadConfig
} from './lib/config.js';
import { getDb } from './lib/db.js';
import { ingestCapture } from './lib/ingest.js';
import * as store from './lib/store.js';
import { checkLlm } from './lib/llm.js';
import {
  renderEntryForApi,
  renderReportForApi,
  renderSummaryForApi,
  syncAllActiveEntries,
  syncEntryMarkdown,
  writeAllSummaries
} from './lib/markdown.js';
import { enqueue, getQueueStats, startWorker } from './lib/worker.js';
import {
  approveProposal,
  cancelWeeklyRun,
  rejectProposal,
  resumeWeeklyRun,
  rollbackWeeklyRun,
  startScheduler,
  startWeeklyRun
} from './lib/weekly.js';

const VERSION = '0.1.0';
const MAX_INGEST_BYTES = 2 * 1024 * 1024;
const MAX_API_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, data) {
  securityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function sendOk(res, data = {}, status = 200) {
  sendJson(res, status, { ok: true, ...data });
}

function authorized(req) {
  const token = String(loadConfig().token || '');
  if (!token) return true;
  return String(req.headers.authorization || '') === `Bearer ${token}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'too_large', '请求体超过大小限制'));
      return;
    }
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        req.pause();
        reject(new HttpError(413, 'too_large', '请求体超过大小限制'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

async function readJson(req, limit = MAX_API_BYTES) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON 格式无效');
  }
}

function entryIdFromPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQuery(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function contentTypeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const map = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css'
  };
  const rel = map[pathname];
  if (!rel) return false;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  securityHeaders(res);
  res.setHeader('Content-Type', contentTypeFor(file));
  res.setHeader('Cache-Control', 'no-cache');
  res.statusCode = 200;
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handleHealth(req, res) {
  const config = loadConfig();
  const llm = checkLlm();
  sendOk(res, {
    service: config.serviceName || 'x-knowledge-agent',
    version: VERSION,
    schema: 'xtr.capture/1',
    authRequired: Boolean(config.token),
    llm: llm.ok ? 'ok' : 'unavailable',
    queue: getQueueStats()
  });
}

async function handleIngest(req, res) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type 必须是 application/json');
  }
  if (!authorized(req)) {
    throw new HttpError(401, 'unauthorized', 'Token 无效');
  }
  const body = await readJson(req, MAX_INGEST_BYTES);
  const result = ingestCapture(body);
  if (!result.ok) {
    const status = result.error.code === 'storage_error' ? 500 : 400;
    throw new HttpError(status, result.error.code, result.error.message);
  }
  const status = result.status === 'duplicate' ? 200 : 202;
  sendOk(res, {
    id: result.id,
    status: result.status,
    processingMode: result.processingMode,
    message: result.message
  }, status);
}

async function handleStatus(req, res) {
  const config = loadConfig();
  const llm = checkLlm();
  sendOk(res, {
    service: config.serviceName || 'x-knowledge-agent',
    version: VERSION,
    stats: store.getStats(),
    queue: getQueueStats(),
    llm: llm.ok ? { status: 'ok', provider: llm.provider, version: llm.version } : { status: 'unavailable', provider: llm.provider },
    weekly: {
      enabled: Boolean(config.weekly.enabled),
      dayOfWeek: config.weekly.dayOfWeek,
      hour: config.weekly.hour,
      minute: config.weekly.minute
    },
    currentWeekly: store.getActiveWeeklyRun()
      ? {
          id: store.getActiveWeeklyRun().id,
          status: store.getActiveWeeklyRun().status,
          phase: store.getActiveWeeklyRun().phase,
          progress: store.getActiveWeeklyRun().progress
        }
      : null
  });
}

async function handleListEntries(req, res, url) {
  const query = parseQuery(url);
  const result = store.listEntries({
    q: query.q,
    category: query.category,
    status: query.status,
    deleted: query.deleted === '1' || query.deleted === 'true',
    sort: query.sort,
    limit: query.limit,
    offset: query.offset
  });
  sendOk(res, result);
}

async function handleGetEntry(req, res, id) {
  const entry = store.getEntry(id);
  if (!entry) throw new HttpError(404, 'not_found', '条目不存在');
  sendOk(res, { entry: renderEntryForApi(entry) });
}

async function handlePatchEntry(req, res, id) {
  const body = await readJson(req);
  const entry = store.getEntry(id);
  if (!entry) throw new HttpError(404, 'not_found', '条目不存在');
  if (body.deleted === true) {
    store.softDeleteEntry(id, 'user');
    syncEntryMarkdown(id);
    sendOk(res, { entry: renderEntryForApi(store.getEntry(id)) });
    return;
  }
  if (body.restore === true) {
    store.restoreEntry(id, 'user');
    syncEntryMarkdown(id);
    sendOk(res, { entry: renderEntryForApi(store.getEntry(id)) });
    return;
  }
  if (body.category_l1 !== undefined || body.category_l2 !== undefined) {
    try {
      store.moveEntry(id, {
        category_l1: body.category_l1,
        category_l2: body.category_l2,
        actor: 'user'
      });
      syncEntryMarkdown(id);
    } catch (err) {
      throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code || 'bad_category', err.message);
    }
    sendOk(res, { entry: renderEntryForApi(store.getEntry(id)) });
    return;
  }
  throw new HttpError(400, 'bad_request', '没有可执行的修改');
}

async function handleEntryAction(req, res, id, action) {
  const entry = store.getEntry(id);
  if (!entry) throw new HttpError(404, 'not_found', '条目不存在');
  if (action === 'retry') {
    if (entry.status === 'processing') throw new HttpError(409, 'busy', '这条内容正在处理');
    store.retryEntry(id);
    enqueue(id);
    sendOk(res, { entry: renderEntryForApi(store.getEntry(id)) });
    return;
  }
  if (action === 'process') {
    const body = await readJson(req);
    const mode = body.mode;
    if (!['classify', 'full'].includes(mode)) {
      throw new HttpError(400, 'bad_mode', 'mode 必须是 classify 或 full');
    }
    if (entry.status === 'processing') throw new HttpError(409, 'busy', '这条内容正在处理');
    store.updateEntryMode(id, mode);
    enqueue(id);
    sendOk(res, { entry: renderEntryForApi(store.getEntry(id)) });
    return;
  }
  if (action === 'notes') {
    const body = await readJson(req);
    try {
      const note = store.addNote(id, body.body, 'user');
      syncEntryMarkdown(id);
      sendOk(res, { note, entry: renderEntryForApi(store.getEntry(id)) }, 201);
    } catch (err) {
      throw new HttpError(400, err.code || 'bad_note', err.message);
    }
    return;
  }
  throw new HttpError(404, 'not_found', '未知操作');
}

async function handleNote(req, res, noteId, method) {
  const note = store.getNote(noteId);
  if (!note) throw new HttpError(404, 'not_found', '想法不存在');
  if (method === 'PATCH') {
    const body = await readJson(req);
    try {
      const updated = store.updateNote(noteId, body.body, 'user');
      syncEntryMarkdown(note.entry_id);
      sendOk(res, { note: updated, entry: renderEntryForApi(store.getEntry(note.entry_id)) });
    } catch (err) {
      throw new HttpError(400, err.code || 'bad_note', err.message);
    }
    return;
  }
  if (method === 'DELETE') {
    store.deleteNote(noteId, 'user');
    syncEntryMarkdown(note.entry_id);
    sendOk(res, { entry: renderEntryForApi(store.getEntry(note.entry_id)) });
    return;
  }
  throw new HttpError(405, 'method_not_allowed', '不支持的方法');
}

async function handleCategories(req, res, method) {
  if (method === 'GET') {
    sendOk(res, {
      tree: store.buildCategoryTree(),
      all: store.listAllCategories(),
      pendingProposals: store.listProposals({ status: 'pending' })
    });
    return;
  }
  if (method === 'POST') {
    const body = await readJson(req);
    try {
      const category = store.createCategory({
        level: body.level,
        parentKey: body.parentKey,
        name: body.name,
        description: body.description || '',
        createdBy: 'user'
      });
      sendOk(res, { category, tree: store.buildCategoryTree() }, 201);
    } catch (err) {
      throw new HttpError(400, err.code || 'bad_category', err.message);
    }
    return;
  }
  throw new HttpError(405, 'method_not_allowed', '不支持的方法');
}

async function handleCategory(req, res, key, method) {
  if (method === 'PATCH') {
    const body = await readJson(req);
    try {
      const category = store.renameCategory(key, body.name, body.description);
      syncAllActiveEntries();
      sendOk(res, { category, tree: store.buildCategoryTree() });
    } catch (err) {
      throw new HttpError(400, err.code || 'bad_category', err.message);
    }
    return;
  }
  if (method === 'DELETE') {
    const body = await readJson(req);
    try {
      const result = store.archiveCategory(key, { targetKey: body.targetKey, actor: 'user' });
      syncAllActiveEntries();
      sendOk(res, { result, tree: store.buildCategoryTree() });
    } catch (err) {
      throw new HttpError(400, err.code || 'bad_category', err.message);
    }
    return;
  }
  throw new HttpError(405, 'method_not_allowed', '不支持的方法');
}

function weeklySummary(run) {
  if (!run) return null;
  return {
    id: run.id,
    week_key: run.week_key,
    trigger: run.trigger,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    changes: run.changes,
    started_at: run.started_at,
    updated_at: run.updated_at,
    finished_at: run.finished_at,
    error: run.error
  };
}

async function handleWeekly(req, res, url, method) {
  if (method === 'GET' && url.pathname === '/api/weekly') {
    const limit = Number(parseQuery(url).limit) || 30;
    sendOk(res, {
      runs: store.listWeeklyRuns(limit).map(weeklySummary),
      current: weeklySummary(store.getActiveWeeklyRun())
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/weekly/current') {
    sendOk(res, { run: weeklySummary(store.getActiveWeeklyRun() || store.getLatestWeeklyRun()) });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/weekly/latest') {
    sendOk(res, { run: weeklySummary(store.getLatestWeeklyRun()) });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/weekly/run') {
    const result = startWeeklyRun({ trigger: 'manual' });
    if (!result.ok) throw new HttpError(409, result.error.code, result.error.message);
    sendOk(res, { run: weeklySummary(result.run) }, 202);
    return;
  }
  throw new HttpError(404, 'not_found', '未知的周报操作');
}

async function handleWeeklyAction(req, res, id, action) {
  if (action === 'cancel') {
    const result = cancelWeeklyRun(id);
    if (!result.ok) throw new HttpError(409, result.error.code, result.error.message);
    sendOk(res, { run: weeklySummary(result.run) });
    return;
  }
  if (action === 'resume') {
    const result = resumeWeeklyRun(id);
    if (!result.ok) throw new HttpError(409, result.error.code, result.error.message);
    sendOk(res, { run: weeklySummary(result.run) });
    return;
  }
  if (action === 'rollback') {
    const result = rollbackWeeklyRun(id);
    if (!result.ok) throw new HttpError(409, result.error.code, result.error.message);
    sendOk(res, result);
    return;
  }
  throw new HttpError(404, 'not_found', '未知的周报操作');
}

async function handleWeeklyDetail(req, res, id) {
  const run = store.getWeeklyRun(id);
  if (!run) throw new HttpError(404, 'not_found', '周报任务不存在');
  const { state, ...rest } = renderReportForApi(run);
  sendOk(res, {
    run: rest,
    proposals: store.listProposals().filter((proposal) => proposal.run_id === run.id)
  });
}

async function handleProposals(req, res, url, method) {
  if (method === 'GET' && url.pathname === '/api/proposals') {
    const status = parseQuery(url).status || null;
    sendOk(res, { proposals: store.listProposals(status ? { status } : {}) });
    return;
  }
  throw new HttpError(404, 'not_found', '未知的提案操作');
}

async function handleProposalAction(req, res, id, action) {
  const result = action === 'approve' ? approveProposal(id) : rejectProposal(id);
  if (!result.ok) throw new HttpError(409, result.error.code, result.error.message);
  sendOk(res, result);
}

async function handleSummaries(req, res) {
  sendOk(res, {
    summaries: store.getCategorySummaries().map(renderSummaryForApi)
  });
}

async function handleExportSummaries(req, res) {
  const files = writeAllSummaries();
  sendOk(res, { files });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/health') return handleHealth(req, res);
  if (method === 'POST' && pathname === '/ingest') return handleIngest(req, res);

  if (pathname.startsWith('/api/') && !authorized(req)) {
    throw new HttpError(401, 'unauthorized', '需要有效的 Token');
  }

  if (method === 'GET' && pathname === '/api/status') return handleStatus(req, res);
  if (method === 'GET' && pathname === '/api/entries') return handleListEntries(req, res, url);
  if (method === 'GET' && pathname === '/api/categories') return handleCategories(req, res, method);
  if (method === 'POST' && pathname === '/api/categories') return handleCategories(req, res, method);
  if (method === 'GET' && pathname === '/api/summaries') return handleSummaries(req, res);
  if (method === 'POST' && pathname === '/api/export/summaries') return handleExportSummaries(req, res);
  if (pathname === '/api/weekly' || pathname === '/api/weekly/current' || pathname === '/api/weekly/latest' || pathname === '/api/weekly/run') {
    return handleWeekly(req, res, url, method);
  }
  if (pathname === '/api/proposals') return handleProposals(req, res, url, method);

  let match = pathname.match(/^\/api\/entries\/([^/]+)\/(notes|retry|process)$/);
  if (match) {
    if (method === 'POST') return handleEntryAction(req, res, entryIdFromPath(match[1]), match[2]);
    throw new HttpError(405, 'method_not_allowed', '不支持的方法');
  }
  match = pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (match) {
    if (method === 'GET') return handleGetEntry(req, res, entryIdFromPath(match[1]));
    if (method === 'PATCH') return handlePatchEntry(req, res, entryIdFromPath(match[1]));
    throw new HttpError(405, 'method_not_allowed', '不支持的方法');
  }
  match = pathname.match(/^\/api\/notes\/(\d+)$/);
  if (match) return handleNote(req, res, Number(match[1]), method);
  match = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (match) return handleCategory(req, res, entryIdFromPath(match[1]), method);
  match = pathname.match(/^\/api\/weekly\/([^/]+)\/(cancel|resume|rollback)$/);
  if (match) {
    if (method === 'POST') return handleWeeklyAction(req, res, entryIdFromPath(match[1]), match[2]);
    throw new HttpError(405, 'method_not_allowed', '不支持的方法');
  }
  match = pathname.match(/^\/api\/weekly\/([^/]+)$/);
  if (match) {
    if (method === 'GET') return handleWeeklyDetail(req, res, entryIdFromPath(match[1]));
    throw new HttpError(405, 'method_not_allowed', '不支持的方法');
  }
  match = pathname.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
  if (match) {
    if (method === 'POST') return handleProposalAction(req, res, match[1], match[2]);
    throw new HttpError(405, 'method_not_allowed', '不支持的方法');
  }

  if (method === 'GET' && serveStatic(req, res, pathname)) return;
  throw new HttpError(404, 'not_found', '未找到');
}

async function handler(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  try {
    await route(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const code = err instanceof HttpError ? err.code : 'internal_error';
    const message = err instanceof HttpError ? err.message : '服务内部错误';
    if (!res.headersSent) sendError(res, status, code, message);
    if (status === 413) {
      try {
        req.resume();
      } catch {}
    }
    if (status >= 500) console.error(`[http] ${req.method} ${url.pathname} ${status}: ${err.message}`);
  } finally {
    console.log(`[http] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

export function startServer() {
  const config = loadConfig();
  if (!isLoopbackHost(config.host) && !config.token) {
    throw new Error('监听非回环地址时必须配置 token');
  }
  getDb();
  const interrupted = store.markInterruptedWeeklyRuns();
  if (interrupted) console.warn(`[agent] 已将 ${interrupted} 个未完成的周任务标记为中断，可手动恢复`);
  const llm = checkLlm({ force: true });
  console.log(`[llm] ${llm.ok ? '可用' : '不可用'}（${llm.provider}）`);
  startWorker();
  startScheduler();
  const server = http.createServer(handler);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    console.log(`[agent] http://${config.host}:${port}`);
    console.log('[agent] 插件接收地址：' + `http://${config.host}:${port}/ingest`);
  });
  return server;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const server = startServer();
  const close = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
