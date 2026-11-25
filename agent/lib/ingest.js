import path from 'node:path';
import { getDb, tx } from './db.js';
import { capturesDir, loadConfig } from './config.js';
import { validateCapture } from './capture-schema.js';
import {
  createEntryFromCapture,
  prepareEntryForRetry,
  upgradeEntryMode
} from './store.js';
import { enqueue } from './worker.js';
import { atomicWrite, formatDateLocal, nowIso, safeFileId } from './util.js';
import { syncEntryMarkdown } from './markdown.js';

export function captureFilePath(capture) {
  const date = formatDateLocal(capture.capturedAt) || formatDateLocal(nowIso());
  return path.join(capturesDir(), date, `${safeFileId(capture.id)}.json`);
}

function modeMessage(mode) {
  if (mode === 'save') return '已保存，稍后整理';
  if (mode === 'classify') return '已加入知识库，正在整理分类';
  return '已加入知识库，正在整理分析';
}

function duplicateResult(id, mode, upgraded) {
  return {
    ok: true,
    id,
    status: upgraded ? 'queued' : 'duplicate',
    processingMode: mode,
    message: upgraded ? `已升级为${mode === 'full' ? '完整分析' : '整理分类'}` : '这条内容已经在知识库中'
  };
}

function syncSavedEntry(id) {
  try {
    syncEntryMarkdown(id);
  } catch (err) {
    console.error(`[ingest] Markdown 导出失败 ${id}: ${err.message}`);
  }
}

export function ingestCapture(raw) {
  const checked = validateCapture(raw);
  if (!checked.ok) return checked;
  const capture = checked.capture;
  const config = loadConfig();
  const mode = capture.processingMode || config.processing.defaultMode || 'full';
  const db = getDb();

  const existing = db.prepare('SELECT id FROM captures WHERE id = ?').get(capture.id);
  if (existing) {
    const entry = db.prepare('SELECT id, status FROM entries WHERE id = ?').get(capture.id);
    if (!entry) {
      createEntryFromCapture(capture, mode);
      if (mode === 'save') syncSavedEntry(capture.id);
      else enqueue(capture.id);
      return duplicateResult(capture.id, mode, true);
    }
    if (entry.status === 'pending') {
      enqueue(capture.id);
      return duplicateResult(capture.id, mode, false);
    }
    if (entry.status === 'failed' && mode !== 'save') {
      if (prepareEntryForRetry(capture.id, mode)) {
        enqueue(capture.id);
        return duplicateResult(capture.id, mode, true);
      }
    }
    if (upgradeEntryMode(capture.id, mode)) {
      enqueue(capture.id);
      return duplicateResult(capture.id, mode, true);
    }
    return duplicateResult(capture.id, mode, false);
  }

  try {
    atomicWrite(captureFilePath(capture), JSON.stringify(raw, null, 2));
  } catch {
    return { ok: false, error: { code: 'storage_error', message: '无法持久化原始内容' } };
  }

  let inserted = false;
  tx(() => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO captures
        (id, schema, captured_at, source_type, source_url, author_name, author_handle,
         published_at, language, title, text, truncated, links_json, quoted_json,
         media_json, raw_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capture.id,
      capture.schema,
      capture.capturedAt,
      capture.source.type,
      capture.source.url,
      capture.source.author?.name || null,
      capture.source.author?.handle || null,
      capture.source.publishedAt,
      capture.source.language,
      capture.content.title,
      capture.content.text,
      capture.content.truncated ? 1 : 0,
      JSON.stringify(capture.links),
      capture.quoted ? JSON.stringify(capture.quoted) : null,
      JSON.stringify(capture.media),
      JSON.stringify(raw),
      nowIso()
    );
    if (Number(result.changes) > 0) {
      inserted = true;
      createEntryFromCapture(capture, mode);
    }
  });

  if (!inserted) return duplicateResult(capture.id, mode, false);
  if (mode === 'save') syncSavedEntry(capture.id);
  else enqueue(capture.id);
  return {
    ok: true,
    id: capture.id,
    status: mode === 'save' ? 'saved' : 'queued',
    processingMode: mode,
    message: modeMessage(mode)
  };
}
