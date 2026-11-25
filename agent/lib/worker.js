import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { llmJson } from './llm.js';
import {
  CLASSIFY_SCHEMA,
  SINGLE_SCHEMA,
  SYSTEM_PROMPT,
  classifyPrompt,
  singlePrompt
} from './prompts.js';
import {
  applyEntryAnalysis,
  applyEntryClassification,
  buildCategoryTree,
  getEntry,
  resetStaleProcessing,
  setEntryFailed,
  setEntryProcessing,
  setEntrySaved
} from './store.js';
import { syncEntryMarkdown } from './markdown.js';
import { sleep } from './util.js';

const queue = [];
const queued = new Set();
let running = false;
let currentId = null;
let currentController = null;

export function enqueue(id) {
  const value = String(id);
  if (queued.has(value)) return;
  queued.add(value);
  queue.push(value);
  pump();
}

export function cancelEntry(id) {
  if (currentId !== String(id) || !currentController) return false;
  currentController.abort();
  return true;
}

function captureFromEntry(entry) {
  return {
    id: entry.id,
    source: {
      platform: 'x',
      type: entry.source.type,
      url: entry.source.url,
      author: entry.source.author_name || entry.source.author_handle
        ? { name: entry.source.author_name, handle: entry.source.author_handle }
        : null,
      publishedAt: entry.source.published_at,
      language: entry.source.language
    },
    content: {
      title: entry.content.title,
      text: entry.content.text,
      truncated: entry.content.truncated
    },
    links: entry.links || [],
    quoted: entry.quoted || null,
    media: entry.media || []
  };
}

function failIfStillProcessing(id, message) {
  const fresh = getEntry(id);
  if (!fresh || fresh.deleted_at || fresh.status !== 'processing') return;
  setEntryFailed(id, message);
}

async function analyzeEntry(id) {
  const entry = getEntry(id);
  if (!entry || entry.deleted_at || entry.status !== 'pending') return;

  const mode = entry.processing_mode || 'full';
  if (mode === 'save') {
    setEntrySaved(id);
    try {
      syncEntryMarkdown(id);
    } catch (err) {
      console.error(`[worker] Markdown 导出失败 ${id}: ${err.message}`);
    }
    return;
  }

  if (!setEntryProcessing(id)) return;
  const config = loadConfig();
  const controller = new AbortController();
  currentController = controller;
  const attempts = Math.max(1, Number(config.llm.retries || 0) + 1);
  let lastError = null;

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const tree = buildCategoryTree();
        const capture = captureFromEntry(entry);
        const prompt = mode === 'classify'
          ? classifyPrompt({ capture, tree })
          : singlePrompt({ capture, tree });
        const result = await llmJson({
          task: mode === 'classify' ? 'classify' : 'single',
          prompt,
          schema: mode === 'classify' ? CLASSIFY_SCHEMA : SINGLE_SCHEMA,
          system: SYSTEM_PROMPT,
          timeoutMs: config.llm.timeoutMs,
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        const fresh = getEntry(id);
        if (!fresh || fresh.deleted_at) return;
        if (fresh.status !== 'processing') return;
        if (mode === 'classify') {
          applyEntryClassification(id, result);
        } else {
          applyEntryAnalysis(id, result);
        }
        try {
          syncEntryMarkdown(id);
        } catch (err) {
          console.error(`[worker] Markdown 导出失败 ${id}: ${err.message}`);
        }
        return;
      } catch (err) {
        if (controller.signal.aborted || err.code === 'cancelled') {
          console.log(`[worker] ${id} 已取消`);
          return;
        }
        lastError = err;
        if (attempt < attempts - 1) {
          await sleep(Math.min(10000, 1000 * 2 ** attempt));
        }
      }
    }
    failIfStillProcessing(id, lastError?.message || '分析失败');
    console.error(`[worker] ${mode} 失败 ${id}: ${lastError?.message || 'unknown'}`);
  } finally {
    if (currentController === controller) currentController = null;
  }
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    queued.delete(id);
    currentId = id;
    const started = Date.now();
    try {
      await analyzeEntry(id);
      console.log(`[worker] ${id} 处理完成 ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[worker] ${id} 异常: ${err.message}`);
      failIfStillProcessing(id, err.message || '分析异常');
    } finally {
      currentId = null;
    }
  }
  running = false;
}

export function startWorker() {
  resetStaleProcessing();
  const rows = getDb().prepare("SELECT id FROM entries WHERE status = 'pending' AND deleted_at IS NULL").all();
  for (const row of rows) enqueue(row.id);
  if (rows.length) console.log(`[worker] 恢复 ${rows.length} 条待处理内容`);
  pump();
}

export function getQueueStats() {
  return {
    queued: queue.length,
    running: Boolean(running),
    currentId
  };
}
