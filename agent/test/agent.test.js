import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xtr-agent-test-'));
process.env.KB_PORT = '0';
process.env.KB_HOST = '127.0.0.1';
process.env.KB_TOKEN = 'test-token';
process.env.KB_DATA_DIR = path.join(TMP, 'data');
process.env.KB_LLM_PROVIDER = 'mock';
process.env.KB_WEEKLY_ENABLED = '0';

const { startServer } = await import('../server.js');
const { setMockHandler } = await import('../lib/llm.js');
const store = await import('../lib/store.js');
const { closeDb } = await import('../lib/db.js');

let server;
let base = '';
const llmCalls = [];
let categoryChangeTarget = 'product';
let invalidL2Entry = null;
let delayedEntry = null;
let releaseDelayed = null;

function singleResult() {
  return {
    title: '完整分析标题',
    summary: '这是一条完整分析摘要。',
    category_l1: 'ai',
    category_l2: '',
    tags: ['AI', '知识库'],
    key_points: ['要点一', '要点二'],
    content_type: 'insight',
    language: 'zh'
  };
}

function extractEntries(prompt) {
  const match = String(prompt).match(/<entries>\n([\s\S]*?)\n<\/entries>/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

setMockHandler(({ task, prompt }) => {
  llmCalls.push(task);
  if (task === 'single') {
    if (delayedEntry && String(prompt).includes(delayedEntry)) {
      return new Promise((resolve) => {
        releaseDelayed = () => resolve(singleResult());
      });
    }
    return singleResult();
  }
  if (task === 'classify') {
    return {
      title: '分类标题',
      category_l1: 'ai',
      category_l2: '',
      tags: ['分类'],
      content_type: 'insight',
      language: 'zh'
    };
  }
  if (task === 'analyze_batch') {
    const entries = extractEntries(prompt);
    return {
      items: entries.map((entry, index) => ({
        entry_id: entry.entry_id,
        title: `周分析标题 ${index + 1}`,
        summary: `周分析摘要 ${index + 1}`,
        category_l1: categoryChangeTarget,
        category_l2: entry.entry_id === invalidL2Entry ? '完全不存在的二级' : '',
        tags: ['周分析'],
        key_points: [`周分析要点 ${index + 1}`],
        content_type: 'insight',
        language: 'zh',
        confidence: 0.95,
        reason: '每周重新分析'
      }))
    };
  }
  if (task === 'govern') {
    return {
      l2_actions: [
        {
          action: 'create',
          parent_key: 'ai',
          name: '测试二级',
          description: '测试创建的二级分类',
          reason: '用于测试分类治理'
        }
      ],
      l1_proposals: [
        {
          action: 'create',
          name: '测试一级',
          description: '测试创建的一级分类',
          reason: '用于测试提案审批'
        }
      ]
    };
  }
  if (task === 'summarize') {
    return {
      summary_md: '## 本周主题\n\n这是测试分类总结。',
      themes: ['主题一', '主题二'],
      learning_order: ['先看第一篇']
    };
  }
  if (task === 'report') {
    return { report_md: '# 测试周报\n\n本周一切正常。' };
  }
  throw new Error(`unexpected task ${task}`);
});

function capture(id, text, processingMode) {
  return {
    schema: 'xtr.capture/1',
    id,
    capturedAt: new Date().toISOString(),
    source: {
      platform: 'x',
      type: 'tweet',
      url: `https://x.com/tester/status/${id.replace(/\D/g, '') || '1'}`,
      author: { name: 'Tester', handle: 'tester' },
      publishedAt: '2026-11-25T09:00:00.000Z',
      language: 'zh'
    },
    content: { title: null, text, truncated: false },
    links: [],
    quoted: null,
    media: [],
    thread: null,
    ...(processingMode ? { processingMode } : {}),
    client: { name: 'agent-test', version: '1' }
  };
}

async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = 'Bearer test-token';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { status: response.status, data };
}

async function waitFor(fn, timeout = 10000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function entry(id) {
  const result = await api(`/api/entries/${encodeURIComponent(id)}`);
  return result.data.entry;
}

async function waitStatus(id, statuses) {
  return waitFor(async () => {
    const value = await entry(id);
    return statuses.includes(value.status) ? value : null;
  });
}

async function runWeeklyToCompletion() {
  const start = await api('/api/weekly/run', { method: 'POST', body: {} });
  assert.equal(start.status, 202);
  return waitFor(async () => {
    const result = await api(`/api/weekly/${encodeURIComponent(start.data.run.id)}`);
    return result.data.run.status === 'completed' ? result.data : null;
  }, 15000);
}

test.before(async () => {
  server = startServer();
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('health is public and reports schema', async () => {
  const result = await api('/health', { auth: false });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.schema, 'xtr.capture/1');
  assert.equal(result.data.authRequired, true);
  assert.equal(result.data.queue.currentId, undefined);
  assert.equal(typeof result.data.queue.queued, 'number');
});

test('serves the web UI', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /X 知识库/);
  assert.match(html, /app\.js/);
});

test('rejects unauthorized, wrong content type and oversized bodies', async () => {
  const unauthorized = await api('/ingest', {
    method: 'POST',
    auth: false,
    body: capture('x:tweet:auth', 'auth test', 'save')
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.data.error.code, 'unauthorized');

  const wrongType = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'text/plain' },
    body: 'hello'
  });
  assert.equal(wrongType.status, 415);

  const large = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'xtr.capture/1', text: 'x'.repeat(2 * 1024 * 1024 + 100) })
  });
  assert.equal(large.status, 413);

  const badSchema = await api('/ingest', {
    method: 'POST',
    body: { schema: 'other' }
  });
  assert.equal(badSchema.status, 400);
});

test('save mode persists raw data and does not call the model', async () => {
  const before = llmCalls.length;
  const result = await api('/ingest', {
    method: 'POST',
    body: capture('x:tweet:save-1', '这是一条只保存的内容。', 'save')
  });
  assert.equal(result.status, 202);
  assert.equal(result.data.status, 'saved');
  assert.equal(result.data.processingMode, 'save');
  await waitStatus('x:tweet:save-1', ['saved']);
  assert.equal(llmCalls.length, before);

  const saved = await entry('x:tweet:save-1');
  assert.equal(saved.status, 'saved');
  assert.equal(saved.processing_mode, 'save');
  assert.equal(saved.category_l1, 'inbox');
  assert.ok(saved.markdown_path);
  assert.ok(fs.existsSync(saved.markdown_path));

  const rawDir = path.join(TMP, 'data', 'captures');
  const rawFiles = fs.readdirSync(rawDir, { recursive: true });
  assert.ok(rawFiles.some((file) => String(file).endsWith('.json')));

  const duplicate = await api('/ingest', {
    method: 'POST',
    body: capture('x:tweet:save-1', '这是一条只保存的内容。', 'save')
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.status, 'duplicate');
});

test('classify mode creates title, category and tags without a summary', async () => {
  const result = await api('/ingest', {
    method: 'POST',
    body: capture('x:tweet:classify-1', '这是一条只做分类的内容。', 'classify')
  });
  assert.equal(result.status, 202);
  assert.equal(result.data.status, 'queued');
  const classified = await waitStatus('x:tweet:classify-1', ['classified']);
  assert.equal(classified.processing_mode, 'classify');
  assert.equal(classified.title, '分类标题');
  assert.equal(classified.category_l1, 'ai');
  assert.equal(classified.summary, '');
  assert.deepEqual(classified.tags, ['分类']);
});

test('full mode creates a summary and key points', async () => {
  const result = await api('/ingest', {
    method: 'POST',
    body: capture('x:tweet:full-1', '这是一条完整分析的内容。', 'full')
  });
  assert.equal(result.status, 202);
  const analyzed = await waitStatus('x:tweet:full-1', ['ready']);
  assert.equal(analyzed.processing_mode, 'full');
  assert.equal(analyzed.summary, '这是一条完整分析摘要。');
  assert.deepEqual(analyzed.analysis.key_points, ['要点一', '要点二']);
});

test('re-sending the same id upgrades a saved entry', async () => {
  const result = await api('/ingest', {
    method: 'POST',
    body: capture('x:tweet:save-1', '这是一条只保存的内容。', 'full')
  });
  assert.equal(result.status, 202);
  assert.equal(result.data.status, 'queued');
  const analyzed = await waitStatus('x:tweet:save-1', ['ready']);
  assert.equal(analyzed.processing_mode, 'full');
  assert.equal(analyzed.summary, '这是一条完整分析摘要。');
});

test('move, notes, delete and restore are user actions', async () => {
  const moved = await api('/api/entries/x:tweet:save-1', {
    method: 'PATCH',
    body: { category_l1: 'writing', category_l2: null }
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.entry.category_l1, 'writing');
  assert.equal(moved.data.entry.category_source, 'manual');

  const note = await api('/api/entries/x:tweet:save-1/notes', {
    method: 'POST',
    body: { body: '我的**想法**' }
  });
  assert.equal(note.status, 201);
  assert.match(note.data.entry.notes[0].body_html, /<strong>想法<\/strong>/);

  const deleted = await api('/api/entries/x:tweet:save-1', {
    method: 'PATCH',
    body: { deleted: true }
  });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.data.entry.deleted_at);
  const trash = await api('/api/entries?deleted=1');
  assert.ok(trash.data.items.some((item) => item.id === 'x:tweet:save-1'));

  const restored = await api('/api/entries/x:tweet:save-1', {
    method: 'PATCH',
    body: { restore: true }
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.entry.deleted_at, null);
});

test('weekly run re-analyzes everything, creates summaries and proposals, and can roll back', async () => {
  const weekly = await runWeeklyToCompletion();
  const run = weekly.run;
  assert.equal(run.status, 'completed');
  assert.equal(run.changes.counts.analyzed, 3);
  assert.ok(run.changes.counts.category_changes >= 1);
  assert.ok(run.changes.manual_overrides.some((item) => item.entry_id === 'x:tweet:save-1'));
  assert.match(run.report_md, /测试周报/);
  assert.match(run.report_html, /测试周报/);
  assert.ok(fs.existsSync(path.join(TMP, 'data', 'reports', `${run.week_key}.md`)));

  const categories = await api('/api/categories');
  assert.ok(categories.data.tree.some((l1) => l1.key === 'ai' && l1.children.some((l2) => l2.name === '测试二级')));
  assert.equal(categories.data.pendingProposals.length, 1);

  const summaries = await api('/api/summaries');
  assert.ok(summaries.data.summaries.length >= 1);
  assert.match(summaries.data.summaries[0].content_html, /测试分类总结/);

  const proposalId = categories.data.pendingProposals[0].id;
  const approved = await api(`/api/proposals/${proposalId}/approve`, { method: 'POST', body: {} });
  assert.equal(approved.status, 200);
  const afterApprove = await api('/api/categories');
  assert.ok(afterApprove.data.tree.some((l1) => l1.name === '测试一级'));

  const rolled = await api(`/api/weekly/${run.id}/rollback`, { method: 'POST', body: {} });
  assert.equal(rolled.status, 200);
  assert.ok(rolled.data.restored >= 1);
  const restoredEntry = await entry('x:tweet:save-1');
  assert.equal(restoredEntry.category_l1, 'writing');
  assert.equal(restoredEntry.category_source, 'manual');
});

test('process endpoint can re-run classification for one entry', async () => {
  const before = await entry('x:tweet:full-1');
  assert.ok(before.summary);
  const result = await api('/api/entries/x:tweet:full-1/process', {
    method: 'POST',
    body: { mode: 'classify' }
  });
  assert.equal(result.status, 200);
  assert.ok(['pending', 'processing', 'ready'].includes(result.data.entry.status));
  const classified = await waitStatus('x:tweet:full-1', ['ready']);
  assert.equal(classified.processing_mode, 'full');
  assert.equal(classified.title, '分类标题');
  assert.equal(classified.summary, before.summary);
});

test('CLI reads status through the HTTP API', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(AGENT_ROOT, 'cli.js'), 'status'],
    {
      cwd: AGENT_ROOT,
      env: { ...process.env, KB_ENDPOINT: base, KB_TOKEN: 'test-token' }
    }
  );
  assert.match(stdout, /x-knowledge-agent/);
  assert.match(stdout, /内容：3 条/);
});

test('CLI accepts boolean flags before the command', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(AGENT_ROOT, 'cli.js'), '--json', 'show', 'x:tweet:save-1'],
    {
      cwd: AGENT_ROOT,
      env: { ...process.env, KB_ENDPOINT: base, KB_TOKEN: 'test-token' }
    }
  );
  const data = JSON.parse(stdout);
  assert.equal(data.entry.id, 'x:tweet:save-1');
});

test('status reports saved, classified and ready counts', async () => {
  const result = await api('/api/status');
  assert.equal(result.status, 200);
  assert.equal(result.data.stats.total, 3);
  assert.equal(result.data.stats.byStatus.ready, 3);
  assert.equal(result.data.stats.byStatus.classified, 0);
  assert.equal(result.data.queue.running, false);
});

test('unknown API routes return JSON 404', async () => {
  const result = await api('/api/no-such-route');
  assert.equal(result.status, 404);
  assert.equal(result.data.ok, false);
});

test('stored categories include the seeded first level', () => {
  const categories = store.listAllCategories({ statuses: ['active'] });
  assert.ok(categories.some((category) => category.key === 'ai'));
  assert.ok(categories.some((category) => category.key === 'inbox'));
});

test('startup recovery marks stale running weekly runs interrupted', () => {
  store.createWeeklyRun({ id: 'stale-run', weekKey: '2099-W01', trigger: 'auto' });
  assert.equal(store.markInterruptedWeeklyRuns(), 1);
  const run = store.getWeeklyRun('stale-run');
  assert.equal(run.status, 'interrupted');
  assert.match(run.error, /中断/);
});

test('mutating API actions require a JSON content type', async () => {
  const noType = await fetch(`${base}/api/entries/x:tweet:full-1/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' }
  });
  assert.equal(noType.status, 415);

  const formType = await fetch(`${base}/api/entries/x:tweet:full-1/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'text/plain' },
    body: '{}'
  });
  assert.equal(formType.status, 415);
});

test('category names cannot escape the markdown library path', async () => {
  const { safePathPart } = await import('../lib/util.js');
  assert.equal(safePathPart('..'), '未分类');
  assert.equal(safePathPart('.'), '未分类');
  assert.equal(safePathPart('foo/../../bar'), 'foo_.._.._bar');
});

test('canceling an interrupted weekly run clears the active run', async () => {
  const { cancelWeeklyRun } = await import('../lib/weekly.js');
  const result = cancelWeeklyRun('stale-run');
  assert.equal(result.ok, true);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(store.getActiveWeeklyRun(), null);
});

test('resume refuses to start a second weekly run', async () => {
  const { resumeWeeklyRun } = await import('../lib/weekly.js');
  store.createWeeklyRun({ id: 'resume-a', weekKey: '2099-W02', trigger: 'manual', status: 'failed' });
  store.createWeeklyRun({ id: 'resume-b', weekKey: '2099-W03', trigger: 'manual', status: 'running' });
  const result = resumeWeeklyRun('resume-a');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'busy');
  store.updateWeeklyRun('resume-b', {
    status: 'cancelled',
    finished_at: new Date().toISOString()
  });
});

test('an invalid L2 suggestion does not wipe an existing L2', async () => {
  const category = await api('/api/categories', {
    method: 'POST',
    body: { level: 2, parentKey: 'ai', name: 'L2 保留测试' }
  });
  assert.equal(category.status, 201);
  const l2Key = category.data.category.key;
  const moved = await api('/api/entries/x:tweet:classify-1', {
    method: 'PATCH',
    body: { category_l1: 'ai', category_l2: l2Key }
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.entry.category_l2, l2Key);

  invalidL2Entry = 'x:tweet:classify-1';
  const weekly = await runWeeklyToCompletion();
  assert.equal(weekly.run.status, 'completed');
  const after = await entry('x:tweet:classify-1');
  assert.equal(after.category_l1, 'ai');
  assert.equal(after.category_l2, l2Key);
  invalidL2Entry = null;
});

test('re-sending a pending entry upgrades its mode before the worker starts', async () => {
  const id = 'x:tweet:pending-upgrade-1';
  const saved = await api('/ingest', {
    method: 'POST',
    body: capture(id, '这是一条排队中的内容。', 'save')
  });
  assert.equal(saved.status, 202);
  store.updateEntryMode(id, 'classify');
  assert.equal(store.getEntry(id).status, 'pending');

  const upgraded = await api('/ingest', {
    method: 'POST',
    body: capture(id, '这是一条排队中的内容。', 'full')
  });
  assert.equal(upgraded.status, 202);
  assert.equal(upgraded.data.status, 'queued');
  assert.equal(upgraded.data.processingMode, 'full');
  const ready = await waitStatus(id, ['ready']);
  assert.equal(ready.processing_mode, 'full');
  assert.equal(ready.summary, '这是一条完整分析摘要。');
});

test('deleting and restoring a processing entry resets it to pending', () => {
  const id = 'x:tweet:full-1';
  store.retryEntry(id);
  assert.equal(store.setEntryProcessing(id), true);
  assert.equal(store.getEntry(id).status, 'processing');
  store.softDeleteEntry(id);
  let current = store.getEntry(id);
  assert.ok(current.deleted_at);
  assert.equal(current.status, 'pending');
  store.restoreEntry(id);
  current = store.getEntry(id);
  assert.equal(current.deleted_at, null);
  assert.equal(current.status, 'pending');
});

test('pending entries can be upgraded to a more complete mode', () => {
  const id = 'x:tweet:full-1';
  store.updateEntryMode(id, 'classify');
  assert.equal(store.getEntry(id).status, 'pending');
  assert.equal(store.upgradeEntryMode(id, 'full'), true);
  const current = store.getEntry(id);
  assert.equal(current.processing_mode, 'full');
  assert.equal(current.status, 'pending');
});

test('a category cannot be archived or merged into itself', () => {
  const category = store.createCategory({
    level: 2,
    parentKey: 'ai',
    name: '自归档测试',
    createdBy: 'user'
  });
  assert.throws(() => store.archiveCategory(category.key, { targetKey: category.key }), /自身/);
  assert.throws(() => store.mergeCategories(category.key, category.key), /自身/);
});

test('governance moves report manual overrides', () => {
  const category = store.createCategory({
    level: 2,
    parentKey: 'ai',
    name: '治理覆盖测试',
    createdBy: 'user'
  });
  store.moveEntry('x:tweet:pending-upgrade-1', {
    category_l1: 'ai',
    category_l2: category.key,
    actor: 'user'
  });
  assert.equal(store.getEntry('x:tweet:pending-upgrade-1').category_source, 'manual');
  const result = store.archiveCategory(category.key, { actor: 'agent', batchId: 'test-govern' });
  assert.equal(result.moved, 1);
  assert.ok(result.manual_overrides.some((item) => item.entry_id === 'x:tweet:pending-upgrade-1'));
});

test('deleting a running entry aborts its analysis and restore re-enqueues it', async () => {
  const { getQueueStats } = await import('../lib/worker.js');
  const id = 'x:tweet:cancel-1';
  delayedEntry = id;
  releaseDelayed = null;
  try {
    const ingested = await api('/ingest', {
      method: 'POST',
      body: capture(id, '这条内容会在分析中被删除。', 'full')
    });
    assert.equal(ingested.status, 202);
    await waitStatus(id, ['processing']);
    await waitFor(() => (releaseDelayed ? true : null));

    const deleted = await api(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { deleted: true }
    });
    assert.equal(deleted.status, 200);
    assert.ok(deleted.data.entry.deleted_at);
    assert.equal(deleted.data.entry.status, 'pending');

    releaseDelayed();
    releaseDelayed = null;
    delayedEntry = null;
    await waitFor(() => (getQueueStats().running ? null : true));

    const after = await entry(id);
    assert.equal(after.status, 'pending');
    assert.equal(after.summary || '', '');

    const restored = await api(`/api/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { restore: true }
    });
    assert.equal(restored.status, 200);
    const ready = await waitStatus(id, ['ready']);
    assert.equal(ready.summary, '这是一条完整分析摘要。');
  } finally {
    delayedEntry = null;
    releaseDelayed = null;
  }
});

test('aborting llmJson terminates a running Claude CLI child', async () => {
  const { loadConfig } = await import('../lib/config.js');
  const { llmJson } = await import('../lib/llm.js');
  const fake = path.join(TMP, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });

  const config = loadConfig();
  const original = {
    provider: config.llm.provider,
    command: config.llm.command,
    timeoutMs: config.llm.timeoutMs
  };
  config.llm.provider = 'claude-cli';
  config.llm.command = fake;
  config.llm.timeoutMs = 5000;
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = llmJson({
      task: 'single',
      prompt: 'test',
      schema: { type: 'object' },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (err) => err.code === 'cancelled');
    assert.ok(Date.now() - started < 3000);
  } finally {
    Object.assign(config.llm, original);
    fs.rmSync(fake, { force: true });
  }
});

test('weekly catch-up stays in the scheduled or night window', async () => {
  const { isWithinWeeklyRunWindow } = await import('../lib/weekly.js');
  const scheduled = new Date(2026, 10, 23, 2, 0, 0);
  assert.equal(isWithinWeeklyRunWindow(new Date(2026, 10, 23, 2, 0, 20), scheduled, 2, 4), true);
  assert.equal(isWithinWeeklyRunWindow(new Date(2026, 10, 23, 9, 0, 0), scheduled, 2, 4), false);
  assert.equal(isWithinWeeklyRunWindow(new Date(2026, 10, 24, 1, 0, 0), scheduled, 2, 4), true);
  assert.equal(isWithinWeeklyRunWindow(new Date(2026, 10, 24, 9, 0, 0), scheduled, 2, 4), false);
  assert.equal(isWithinWeeklyRunWindow(new Date(2026, 10, 24, 1, 0, 0), scheduled, 2, 0), false);
});
