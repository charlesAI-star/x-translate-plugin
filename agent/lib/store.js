import { getDb, tx } from './db.js';
import { nowIso, parseJson, randomKey, truncate } from './util.js';

const ENTRY_FROM = `
  FROM entries e
  JOIN captures c ON c.id = e.id
  LEFT JOIN categories c1 ON c1.key = e.category_l1
  LEFT JOIN categories c2 ON c2.key = e.category_l2
`;

function entrySelect(includeText) {
  return `
    SELECT
      e.id, e.title, e.summary, e.category_l1, e.category_l2,
      e.tags_json, e.analysis_json, e.status, e.processing_mode, e.error,
      e.category_source, e.category_updated_at, e.markdown_path,
      e.deleted_at, e.created_at, e.updated_at,
      c.source_type, c.source_url, c.author_name, c.author_handle,
      c.published_at, c.language, c.captured_at, c.title AS capture_title,
      c.truncated, c.links_json, c.quoted_json, c.media_json,
      ${includeText ? 'c.text,' : ''}
      c1.name AS l1_name, c2.name AS l2_name,
      (SELECT COUNT(*) FROM notes n WHERE n.entry_id = e.id) AS note_count
  `;
}

function rowToEntry(row, { full = false } = {}) {
  if (!row) return null;
  const entry = {
    id: row.id,
    title: row.title || row.capture_title || '',
    summary: row.summary || '',
    category_l1: row.category_l1,
    category_l2: row.category_l2,
    category_l1_name: row.l1_name || row.category_l1,
    category_l2_name: row.l2_name || row.category_l2,
    tags: parseJson(row.tags_json, []),
    analysis: parseJson(row.analysis_json, {}),
    status: row.status,
    processing_mode: row.processing_mode || 'full',
    error: row.error || null,
    category_source: row.category_source,
    category_updated_at: row.category_updated_at,
    deleted_at: row.deleted_at,
    note_count: Number(row.note_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: {
      type: row.source_type,
      url: row.source_url,
      author_name: row.author_name || '',
      author_handle: row.author_handle || '',
      published_at: row.published_at,
      language: row.language,
      captured_at: row.captured_at
    }
  };
  if (full) {
    entry.content = {
      title: row.capture_title || null,
      text: row.text || '',
      truncated: Boolean(row.truncated)
    };
    entry.links = parseJson(row.links_json, []);
    entry.quoted = parseJson(row.quoted_json, null);
    entry.media = parseJson(row.media_json, []);
    entry.markdown_path = row.markdown_path || null;
  }
  return entry;
}

function toId(value) {
  return String(value ?? '').trim();
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

export function getCategory(key) {
  if (!key) return null;
  return getDb().prepare('SELECT * FROM categories WHERE key = ?').get(String(key)) || null;
}

function activeL1(key) {
  const row = getDb().prepare("SELECT * FROM categories WHERE key = ? AND level = 1 AND status = 'active'").get(String(key));
  return row || null;
}

function resolveL1(key) {
  return activeL1(key) ? String(key) : 'inbox';
}

function resolveL2(l1Key, nameOrKey) {
  const value = toId(nameOrKey);
  if (!value) return null;
  const db = getDb();
  const byKey = db
    .prepare("SELECT * FROM categories WHERE key = ? AND level = 2 AND status = 'active' AND parent_key = ?")
    .get(value, l1Key);
  if (byKey) return byKey.key;
  const byName = db
    .prepare("SELECT * FROM categories WHERE level = 2 AND status = 'active' AND parent_key = ? AND lower(name) = lower(?)")
    .get(l1Key, value);
  return byName ? byName.key : null;
}

export function getEntry(id) {
  const row = getDb().prepare(`${entrySelect(true)} ${ENTRY_FROM} WHERE e.id = ?`).get(String(id));
  if (!row) return null;
  const entry = rowToEntry(row, { full: true });
  entry.notes = listNotes(entry.id);
  entry.l1_summary = getCategorySummary(entry.category_l1);
  return entry;
}

export function listEntries(options = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  const includeDeleted = Boolean(options.deleted);
  where.push(includeDeleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL');

  const category = toId(options.category);
  if (category && category !== 'all') {
    const cat = getCategory(category);
    if (cat && cat.level === 2) {
      where.push('e.category_l2 = ?');
      params.push(category);
    } else {
      where.push('e.category_l1 = ?');
      params.push(category);
    }
  }

  const statuses = toId(options.status)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => ['pending', 'processing', 'saved', 'classified', 'ready', 'failed'].includes(value));
  if (statuses.length === 1) {
    where.push('e.status = ?');
    params.push(statuses[0]);
  } else if (statuses.length > 1) {
    where.push(`e.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  const q = toId(options.q);
  if (q) {
    const pattern = likePattern(q);
    where.push(`(
      lower(COALESCE(e.title, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(e.summary, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(c.text, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(e.tags_json, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(c.author_name, '')) LIKE lower(?) ESCAPE '\\'
      OR lower(COALESCE(c.author_handle, '')) LIKE lower(?) ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS c ${ENTRY_FROM} ${whereSql}`)
    .get(...params).c;

  const sortMap = {
    oldest: 'COALESCE(c.published_at, c.captured_at) ASC',
    updated: 'e.updated_at DESC',
    newest: 'COALESCE(c.published_at, c.captured_at) DESC'
  };
  const order = sortMap[toId(options.sort)] || sortMap.newest;
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
  const offset = Math.max(0, Number(options.offset) || 0);

  const rows = db
    .prepare(`${entrySelect(false)} ${ENTRY_FROM} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return {
    items: rows.map((row) => rowToEntry(row)),
    total: Number(total || 0),
    limit,
    offset
  };
}

export function getStats() {
  const db = getDb();
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS c FROM entries WHERE deleted_at IS NULL GROUP BY status')
    .all();
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.c)]));
  const total = statusRows.reduce((sum, r) => sum + Number(r.c), 0);
  const deleted = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NOT NULL').get().c;
  const notes = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const categories = db
    .prepare("SELECT level, COUNT(*) AS c FROM categories WHERE status = 'active' GROUP BY level")
    .all();
  const categoryCounts = Object.fromEntries(categories.map((r) => [String(r.level), Number(r.c)]));
  const pendingProposals = db.prepare("SELECT COUNT(*) AS c FROM proposals WHERE status = 'pending'").get().c;
  return {
    total: Number(total),
    deleted: Number(deleted),
    notes: Number(notes),
    byStatus: {
      pending: byStatus.pending || 0,
      processing: byStatus.processing || 0,
      saved: byStatus.saved || 0,
      classified: byStatus.classified || 0,
      ready: byStatus.ready || 0,
      failed: byStatus.failed || 0
    },
    inbox: db
      .prepare("SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NULL AND category_l1 = 'inbox'")
      .get().c,
    categories: { l1: categoryCounts['1'] || 0, l2: categoryCounts['2'] || 0 },
    pendingProposals: Number(pendingProposals)
  };
}

export function createEntryFromCapture(capture, mode = 'full') {
  const db = getDb();
  const now = nowIso();
  const title = capture.content.title || firstLine(capture.content.text);
  const processingMode = ['save', 'classify', 'full'].includes(mode) ? mode : 'full';
  const status = processingMode === 'save' ? 'saved' : 'pending';
  db.prepare(`
    INSERT OR IGNORE INTO entries
      (id, title, summary, category_l1, category_l2, tags_json, analysis_json,
       status, processing_mode, error, category_source, category_updated_at,
       deleted_at, created_at, updated_at)
    VALUES (?, ?, '', 'inbox', NULL, '[]', NULL, ?, ?, NULL, 'auto', NULL, NULL, ?, ?)
  `).run(capture.id, title, status, processingMode, now, now);
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return truncate(line, 120);
}

export function setEntryProcessing(id) {
  getDb()
    .prepare("UPDATE entries SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), String(id));
}

export function applyEntryAnalysis(id, analysis, options = {}) {
  const db = getDb();
  const current = db
    .prepare('SELECT e.*, c.title AS capture_title, c.text AS capture_text FROM entries e JOIN captures c ON c.id = e.id WHERE e.id = ?')
    .get(String(id));
  if (!current) throw new Error('条目不存在');
  if (current.deleted_at) return null;

  const l1 = resolveL1(analysis.category_l1);
  const l2 = resolveL2(l1, analysis.category_l2);
  const categoryMode = options.categoryMode || (current.category_source === 'manual' ? 'respect' : 'force');
  let nextL1 = l1;
  let nextL2 = l2;
  if (categoryMode === 'keep') {
    nextL1 = current.category_l1;
    nextL2 = current.category_l2;
  } else if (categoryMode === 'respect' && current.category_source === 'manual') {
    nextL1 = current.category_l1;
    nextL2 = current.category_l2;
  }

  const changed = nextL1 !== current.category_l1 || (nextL2 || null) !== (current.category_l2 || null);
  const manualOverride = changed && current.category_source === 'manual';
  const now = nowIso();
  const title = truncate(analysis.title || current.title || current.capture_title || firstLine(current.capture_text), 160);
  const analysisJson = JSON.stringify({
    key_points: Array.isArray(analysis.key_points) ? analysis.key_points : [],
    content_type: analysis.content_type || 'other',
    language: analysis.language || ''
  });
  const actor = options.actor === 'user' ? 'user' : 'agent';

  tx(() => {
    db.prepare(`
      UPDATE entries SET
        title = ?, summary = ?,
        category_l1 = ?, category_l2 = ?,
        category_source = ?, category_updated_at = ?,
        tags_json = ?, analysis_json = ?,
        status = 'ready', processing_mode = 'full', error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      title,
      truncate(analysis.summary || '', 800),
      nextL1,
      nextL2,
      changed ? 'auto' : current.category_source,
      changed ? now : current.category_updated_at,
      JSON.stringify(Array.isArray(analysis.tags) ? analysis.tags.slice(0, 8) : []),
      analysisJson,
      now,
      String(id)
    );
    recordEvent({
      entryId: String(id),
      type: 'analyze',
      actor,
      payload: {
        category: { l1: nextL1, l2: nextL2 },
        confidence: options.confidence ?? null,
        reason: options.reason || ''
      },
      batchId: options.batchId || null
    });
    if (changed) {
      recordEvent({
        entryId: String(id),
        type: 'move',
        actor,
        payload: {
          from: { l1: current.category_l1, l2: current.category_l2 },
          to: { l1: nextL1, l2: nextL2 },
          reason: options.reason || '重新分析',
          confidence: options.confidence ?? null,
          manual_override: manualOverride
        },
        batchId: options.batchId || null
      });
    }
  });
  return getEntry(id);
}

export function applyEntryClassification(id, result) {
  const db = getDb();
  const current = db
    .prepare('SELECT e.*, c.title AS capture_title, c.text AS capture_text FROM entries e JOIN captures c ON c.id = e.id WHERE e.id = ?')
    .get(String(id));
  if (!current) throw new Error('条目不存在');
  if (current.deleted_at) return null;

  const l1 = resolveL1(result.category_l1);
  const l2 = resolveL2(l1, result.category_l2);
  const keepManual = current.category_source === 'manual';
  const nextL1 = keepManual ? current.category_l1 : l1;
  const nextL2 = keepManual ? current.category_l2 : l2;
  const changed = nextL1 !== current.category_l1 || (nextL2 || null) !== (current.category_l2 || null);
  const now = nowIso();
  const title = truncate(result.title || current.title || current.capture_title || firstLine(current.capture_text), 160);
  // Re-running the lightweight mode on an already analyzed entry must not
  // throw away its summary and key points.
  const keepAnalysis = current.status === 'ready' || Boolean(current.summary);
  const existingAnalysis = parseJson(current.analysis_json, {});
  const analysisJson = keepAnalysis
    ? JSON.stringify({
        ...existingAnalysis,
        content_type: result.content_type || existingAnalysis.content_type || '',
        language: result.language || existingAnalysis.language || ''
      })
    : JSON.stringify({
        key_points: [],
        content_type: result.content_type || '',
        language: result.language || ''
      });

  tx(() => {
    db.prepare(`
      UPDATE entries SET
        title = ?, category_l1 = ?, category_l2 = ?, tags_json = ?,
        analysis_json = ?, status = ?, processing_mode = ?,
        category_source = ?, category_updated_at = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      title,
      nextL1,
      nextL2,
      JSON.stringify(Array.isArray(result.tags) ? result.tags.slice(0, 8) : []),
      analysisJson,
      keepAnalysis ? 'ready' : 'classified',
      keepAnalysis ? 'full' : 'classify',
      keepManual ? 'manual' : 'auto',
      changed ? now : current.category_updated_at,
      now,
      String(id)
    );
    recordEvent({
      entryId: String(id),
      type: 'classify',
      actor: 'agent',
      payload: { from: { l1: current.category_l1, l2: current.category_l2 }, to: { l1: nextL1, l2: nextL2 } }
    });
  });
  return getEntry(id);
}

export function setEntrySaved(id) {
  getDb()
    .prepare("UPDATE entries SET status = 'saved', processing_mode = 'save', error = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), String(id));
}

export function updateEntryMode(id, mode) {
  if (!['save', 'classify', 'full'].includes(mode)) {
    const err = new Error('处理方式必须是 save、classify 或 full');
    err.code = 'bad_mode';
    throw err;
  }
  const entry = getEntry(id);
  if (!entry || entry.deleted_at) {
    const err = new Error('条目不存在或在回收站');
    err.code = 'not_found';
    throw err;
  }
  const status = mode === 'save' ? 'saved' : 'pending';
  getDb()
    .prepare('UPDATE entries SET processing_mode = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run(mode, status, nowIso(), String(id));
  return getEntry(id);
}

export function upgradeEntryMode(id, mode) {
  const rank = { save: 0, classify: 1, full: 2 };
  if (!(mode in rank)) return false;
  const entry = getEntry(id);
  if (!entry || entry.deleted_at) return false;
  if (rank[mode] <= rank[entry.processing_mode || 'full']) return false;
  if (!['saved', 'classified', 'failed', 'pending'].includes(entry.status)) return false;
  updateEntryMode(id, mode);
  return true;
}

export function prepareEntryForRetry(id, mode) {
  const entry = getEntry(id);
  if (!entry || entry.deleted_at || entry.status === 'processing') return false;
  if (mode === 'save') return false;
  updateEntryMode(id, mode);
  return true;
}

export function setEntryFailed(id, message) {
  getDb()
    .prepare("UPDATE entries SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(truncate(message || '分析失败', 500), nowIso(), String(id));
}

export function retryEntry(id) {
  const result = getDb()
    .prepare("UPDATE entries SET status = 'pending', error = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(nowIso(), String(id));
  return Number(result.changes) > 0;
}

export function moveEntry(id, options = {}) {
  const db = getDb();
  const current = db
    .prepare(`${entrySelect(false)} ${ENTRY_FROM} WHERE e.id = ?`)
    .get(String(id));
  if (!current) {
    const err = new Error('条目不存在');
    err.code = 'not_found';
    throw err;
  }
  if (current.deleted_at) {
    const err = new Error('条目已在回收站');
    err.code = 'deleted';
    throw err;
  }

  let l1 = toId(options.category_l1) || current.category_l1;
  let l2 = null;
  if (options.category_l2 !== undefined && options.category_l2 !== null && toId(options.category_l2)) {
    const input = toId(options.category_l2);
    const cat = getCategory(input);
    if (cat && cat.level === 2 && cat.status === 'active') {
      l1 = cat.parent_key;
      l2 = cat.key;
    } else {
      l2 = resolveL2(l1, input);
      if (!l2) {
        const err = new Error('二级分类不存在或不属于该一级分类');
        err.code = 'bad_category';
        throw err;
      }
    }
  } else if (!activeL1(l1)) {
    const err = new Error('一级分类不存在');
    err.code = 'bad_category';
    throw err;
  }

  if (!activeL1(l1)) {
    const err = new Error('一级分类不存在');
    err.code = 'bad_category';
    throw err;
  }

  const actor = options.actor === 'agent' ? 'agent' : 'user';
  const now = nowIso();
  const source = actor === 'user' ? 'manual' : 'auto';
  const from = { l1: current.category_l1, l2: current.category_l2, l1_name: current.l1_name, l2_name: current.l2_name };
  const toCat = getCategory(l1);
  const toL2Cat = l2 ? getCategory(l2) : null;
  const to = { l1, l2, l1_name: toCat ? toCat.name : l1, l2_name: toL2Cat ? toL2Cat.name : null };

  tx(() => {
    db.prepare(`
      UPDATE entries SET category_l1 = ?, category_l2 = ?, category_source = ?,
        category_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(l1, l2, source, now, now, String(id));
    recordEvent({
      entryId: String(id),
      type: 'move',
      actor,
      payload: {
        from,
        to,
        reason: options.reason || '',
        confidence: options.confidence ?? null,
        manual_override: current.category_source === 'manual' && actor === 'agent'
      },
      batchId: options.batchId || null
    });
  });
  return getEntry(id);
}

export function softDeleteEntry(id, actor = 'user') {
  const now = nowIso();
  const result = getDb()
    .prepare(`
      UPDATE entries
      SET deleted_at = ?,
        status = CASE WHEN status = 'processing' THEN 'pending' ELSE status END,
        error = CASE WHEN status = 'processing' THEN NULL ELSE error END,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `)
    .run(now, now, String(id));
  if (Number(result.changes) > 0) {
    recordEvent({ entryId: String(id), type: 'delete', actor, payload: {} });
  }
  return Number(result.changes) > 0;
}

export function restoreEntry(id, actor = 'user') {
  const now = nowIso();
  const result = getDb()
    .prepare(`
      UPDATE entries
      SET deleted_at = NULL,
        status = CASE WHEN status = 'processing' THEN 'pending' ELSE status END,
        error = CASE WHEN status = 'processing' THEN NULL ELSE error END,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NOT NULL
    `)
    .run(now, String(id));
  if (Number(result.changes) > 0) {
    recordEvent({ entryId: String(id), type: 'restore', actor, payload: {} });
  }
  return Number(result.changes) > 0;
}

export function listNotes(entryId) {
  return getDb()
    .prepare('SELECT * FROM notes WHERE entry_id = ? ORDER BY created_at ASC, id ASC')
    .all(String(entryId));
}

export function addNote(entryId, body, actor = 'user') {
  const text = String(body || '').trim();
  if (!text) {
    const err = new Error('想法内容不能为空');
    err.code = 'empty_note';
    throw err;
  }
  const now = nowIso();
  const result = getDb()
    .prepare('INSERT INTO notes (entry_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(String(entryId), truncate(text, 20000), now, now);
  recordEvent({ entryId: String(entryId), type: 'note', actor, payload: { note_id: Number(result.lastInsertRowid) } });
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
}

export function updateNote(noteId, body, actor = 'user') {
  const text = String(body || '').trim();
  if (!text) {
    const err = new Error('想法内容不能为空');
    err.code = 'empty_note';
    throw err;
  }
  const note = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(Number(noteId));
  if (!note) return null;
  getDb()
    .prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?')
    .run(truncate(text, 20000), nowIso(), Number(noteId));
  recordEvent({ entryId: note.entry_id, type: 'note_edit', actor, payload: { note_id: Number(noteId) } });
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(Number(noteId));
}

export function deleteNote(noteId, actor = 'user') {
  const note = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(Number(noteId));
  if (!note) return false;
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(Number(noteId));
  recordEvent({ entryId: note.entry_id, type: 'note_delete', actor, payload: { note_id: Number(noteId) } });
  return true;
}

export function getNote(noteId) {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(Number(noteId)) || null;
}

export function buildCategoryTree(options = {}) {
  const db = getDb();
  const includeArchived = Boolean(options.includeArchived);
  const includeProposed = Boolean(options.includeProposed);
  const statuses = ["'active'"];
  if (includeArchived) statuses.push("'archived'");
  if (includeProposed) statuses.push("'proposed'");
  const rows = db
    .prepare(`SELECT * FROM categories WHERE status IN (${statuses.join(',')}) ORDER BY level ASC, sort_order ASC, name ASC`)
    .all();
  const countRows = db
    .prepare('SELECT category_l1, category_l2, COUNT(*) AS c FROM entries WHERE deleted_at IS NULL GROUP BY category_l1, category_l2')
    .all();
  const l1Total = new Map();
  const l2Count = new Map();
  for (const row of countRows) {
    l1Total.set(row.category_l1, (l1Total.get(row.category_l1) || 0) + Number(row.c));
    if (row.category_l2) l2Count.set(row.category_l2, (l2Count.get(row.category_l2) || 0) + Number(row.c));
  }

  const l1Rows = rows.filter((r) => r.level === 1);
  const l2Rows = rows.filter((r) => r.level === 2);
  const children = new Map();
  for (const row of l2Rows) {
    if (!children.has(row.parent_key)) children.set(row.parent_key, []);
    children.get(row.parent_key).push({
      ...row,
      count: l2Count.get(row.key) || 0
    });
  }
  return l1Rows.map((row) => ({
    ...row,
    count: l1Total.get(row.key) || 0,
    children: children.get(row.key) || []
  }));
}

export function listAllCategories(options = {}) {
  const statuses = options.statuses || ['active', 'archived', 'proposed'];
  const placeholders = statuses.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM categories WHERE status IN (${placeholders}) ORDER BY level, sort_order, name`)
    .all(...statuses);
}

function duplicateCategoryName(level, parentKey, name, excludeKey = null) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT key FROM categories
      WHERE level = ? AND IFNULL(parent_key, '') = IFNULL(?, '')
        AND lower(name) = lower(?) AND status != 'archived' AND key != ?
    `)
    .get(Number(level), parentKey || null, String(name).trim(), excludeKey || '');
  return Boolean(row);
}

export function createCategory({ level, parentKey = null, name, description = '', createdBy = 'user', status = 'active', key = null }) {
  const db = getDb();
  const lvl = Number(level);
  const cleanName = String(name || '').trim();
  if (lvl !== 1 && lvl !== 2) {
    const err = new Error('分类层级必须是 1 或 2');
    err.code = 'bad_category';
    throw err;
  }
  if (!cleanName || cleanName.length > 40) {
    const err = new Error('分类名称应为 1-40 个字符');
    err.code = 'bad_category';
    throw err;
  }
  if (lvl === 2) {
    if (!parentKey || !activeL1(parentKey)) {
      const err = new Error('二级分类必须挂在一个启用的一级分类下');
      err.code = 'bad_category';
      throw err;
    }
  } else if (parentKey) {
    const err = new Error('一级分类不能有父分类');
    err.code = 'bad_category';
    throw err;
  }
  if (duplicateCategoryName(lvl, parentKey, cleanName)) {
    const err = new Error('同级下已有同名分类');
    err.code = 'duplicate_category';
    throw err;
  }
  const categoryKey = key || randomKey(lvl === 1 ? 'l1' : 'l2');
  const now = nowIso();
  const sortRow = db
    .prepare('SELECT MAX(sort_order) AS m FROM categories WHERE level = ? AND IFNULL(parent_key, \'\') = IFNULL(?, \'\')')
    .get(lvl, parentKey || null);
  db.prepare(`
    INSERT INTO categories
      (key, level, parent_key, name, description, status, created_by, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    categoryKey,
    lvl,
    lvl === 2 ? parentKey : null,
    cleanName,
    String(description || ''),
    status,
    createdBy,
    Number(sortRow.m || 0) + 1,
    now,
    now
  );
  recordEvent({ categoryKey, type: 'category_create', actor: createdBy, payload: { name: cleanName, level: lvl } });
  return getCategory(categoryKey);
}

export function renameCategory(key, name, description) {
  const db = getDb();
  const category = getCategory(key);
  if (!category || category.status === 'archived') {
    const err = new Error('分类不存在');
    err.code = 'bad_category';
    throw err;
  }
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 40) {
    const err = new Error('分类名称应为 1-40 个字符');
    err.code = 'bad_category';
    throw err;
  }
  if (duplicateCategoryName(category.level, category.parent_key, cleanName, key)) {
    const err = new Error('同级下已有同名分类');
    err.code = 'duplicate_category';
    throw err;
  }
  db.prepare('UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE key = ?')
    .run(cleanName, description !== undefined ? String(description) : category.description, nowIso(), String(key));
  recordEvent({ categoryKey: key, type: 'category_rename', actor: 'user', payload: { from: category.name, to: cleanName } });
  return getCategory(key);
}

export function moveEntryToCategory(entryId, options) {
  return moveEntry(entryId, options);
}

export function archiveCategory(key, { targetKey = null, actor = 'agent', batchId = null } = {}) {
  const db = getDb();
  const category = getCategory(key);
  if (!category || category.status === 'archived') {
    const err = new Error('分类不存在或已归档');
    err.code = 'bad_category';
    throw err;
  }
  const now = nowIso();
  let target = null;
  if (category.level === 2) {
    if (targetKey) {
      const targetCat = getCategory(targetKey);
      if (!targetCat || targetCat.level !== 2 || targetCat.status !== 'active' || targetCat.parent_key !== category.parent_key) {
        const err = new Error('目标二级分类必须与当前分类同级且启用');
        err.code = 'bad_category';
        throw err;
      }
      if (targetCat.key === category.key) {
        const err = new Error('不能把二级分类归档到自身');
        err.code = 'bad_category';
        throw err;
      }
      target = { l1: targetCat.parent_key, l2: targetCat.key };
    } else {
      target = { l1: category.parent_key, l2: null };
    }
  } else {
    const targetCat = targetKey ? activeL1(targetKey) : null;
    if (!targetCat || targetCat.key === key) {
      const err = new Error('归档一级分类需要指定另一个启用的一级分类作为迁移目标');
      err.code = 'bad_category';
      throw err;
    }
    target = { l1: targetCat.key, l2: null };
  }

  const moves = category.level === 2
    ? db.prepare('SELECT id FROM entries WHERE category_l2 = ? AND deleted_at IS NULL').all(String(key))
    : db.prepare('SELECT id FROM entries WHERE category_l1 = ? AND deleted_at IS NULL').all(String(key));
  const manualOverrides = [];

  tx(() => {
    for (const row of moves) {
      const before = db.prepare('SELECT * FROM entries WHERE id = ?').get(row.id);
      const manualOverride = actor === 'agent' && before.category_source === 'manual';
      const beforeL1 = getCategory(before.category_l1);
      const beforeL2 = before.category_l2 ? getCategory(before.category_l2) : null;
      db.prepare(`
        UPDATE entries SET category_l1 = ?, category_l2 = ?, category_source = 'auto',
          category_updated_at = ?, updated_at = ? WHERE id = ?
      `).run(target.l1, target.l2, now, now, row.id);
      recordEvent({
        entryId: row.id,
        type: 'move',
        actor,
        payload: {
          from: { l1: before.category_l1, l2: before.category_l2 },
          to: target,
          reason: '分类归档迁移',
          manual_override: manualOverride
        },
        batchId
      });
      if (manualOverride) {
        manualOverrides.push({
          entry_id: row.id,
          title: before.title || row.id,
          from: {
            l1: before.category_l1,
            l2: before.category_l2,
            l1_name: beforeL1?.name || before.category_l1,
            l2_name: beforeL2?.name || before.category_l2
          },
          to: {
            l1: target.l1,
            l2: target.l2,
            l1_name: getCategory(target.l1)?.name || target.l1,
            l2_name: target.l2 ? getCategory(target.l2)?.name || target.l2 : null
          },
          reason: '分类归档迁移',
          manual_override: true
        });
      }
    }
    if (category.level === 1) {
      db.prepare("UPDATE categories SET status = 'archived', updated_at = ? WHERE parent_key = ? AND status = 'active'")
        .run(now, String(key));
    }
    db.prepare("UPDATE categories SET status = 'archived', updated_at = ? WHERE key = ?").run(now, String(key));
    recordEvent({
      categoryKey: key,
      type: 'category_archive',
      actor,
      payload: { name: category.name, target, moved: moves.length },
      batchId
    });
  });
  return { moved: moves.length, target, manual_overrides: manualOverrides };
}

export function mergeCategories(fromKey, intoKey, { actor = 'agent', batchId = null } = {}) {
  const db = getDb();
  const from = getCategory(fromKey);
  const into = getCategory(intoKey);
  if (!from || !into || from.status === 'archived' || into.status === 'archived') {
    const err = new Error('要合并的分类不存在或已归档');
    err.code = 'bad_category';
    throw err;
  }
  if (from.level !== into.level) {
    const err = new Error('只能合并同一层级的分类');
    err.code = 'bad_category';
    throw err;
  }
  if (String(from.key) === String(into.key)) {
    const err = new Error('不能把分类合并到自身');
    err.code = 'bad_category';
    throw err;
  }
  if (from.level === 2 && from.parent_key !== into.parent_key) {
    const err = new Error('只能合并同一一级分类下的二级分类');
    err.code = 'bad_category';
    throw err;
  }
  return archiveCategory(fromKey, {
    targetKey: intoKey,
    actor,
    batchId
  });
}

export function recordEvent({ entryId = null, categoryKey = null, type, actor = 'system', payload = null, batchId = null }) {
  getDb().prepare(`
    INSERT INTO events (entry_id, category_key, type, actor, payload_json, batch_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId ? String(entryId) : null,
    categoryKey ? String(categoryKey) : null,
    String(type),
    String(actor),
    payload === null ? null : JSON.stringify(payload),
    batchId ? String(batchId) : null,
    nowIso()
  );
}

export function listEventsByBatch(batchId) {
  return getDb()
    .prepare('SELECT * FROM events WHERE batch_id = ? ORDER BY id ASC')
    .all(String(batchId))
    .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function listRecentEvents(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, Number(limit) || 50)))
    .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function upsertCategorySummary({ categoryKey, contentMd, entryCount, runId = null }) {
  getDb().prepare(`
    INSERT INTO category_summaries (category_key, content_md, entry_count, generated_at, run_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(category_key) DO UPDATE SET
      content_md = excluded.content_md,
      entry_count = excluded.entry_count,
      generated_at = excluded.generated_at,
      run_id = excluded.run_id
  `).run(String(categoryKey), String(contentMd), Number(entryCount), nowIso(), runId);
}

export function getCategorySummary(categoryKey) {
  if (!categoryKey) return null;
  const row = getDb().prepare('SELECT * FROM category_summaries WHERE category_key = ?').get(String(categoryKey));
  return row ? { ...row, content_md: row.content_md } : null;
}

export function getCategorySummaries() {
  return getDb().prepare(`
    SELECT s.*, c.name AS category_name
    FROM category_summaries s
    LEFT JOIN categories c ON c.key = s.category_key
    ORDER BY s.generated_at DESC
  `).all();
}

export function getAllEntriesForWeekly() {
  return getDb().prepare(`
    SELECT e.id, e.title, e.summary, e.category_l1, e.category_l2,
      e.tags_json, e.analysis_json, e.category_source, e.status, e.processing_mode,
      c.source_type, c.source_url, c.author_name, c.author_handle,
      c.published_at, c.captured_at, c.language, c.title AS capture_title,
      c.text, c.truncated, c.links_json, c.quoted_json, c.media_json
    FROM entries e JOIN captures c ON c.id = e.id
    WHERE e.deleted_at IS NULL
    ORDER BY COALESCE(c.published_at, c.captured_at) DESC
  `).all().map((row) => ({
    ...row,
    tags: parseJson(row.tags_json, []),
    analysis: parseJson(row.analysis_json, {}),
    links: parseJson(row.links_json, []),
    quoted: parseJson(row.quoted_json, null),
    media: parseJson(row.media_json, [])
  }));
}

export function getEntriesForCategory(l1Key, limit = 80) {
  return getDb().prepare(`
    SELECT e.id, e.title, e.summary, e.category_l1, e.category_l2,
      e.tags_json, e.analysis_json, e.category_source, e.status,
      c.source_type, c.source_url, c.author_name, c.author_handle,
      c.published_at, c.captured_at
    FROM entries e JOIN captures c ON c.id = e.id
    WHERE e.deleted_at IS NULL AND e.category_l1 = ?
    ORDER BY COALESCE(c.published_at, c.captured_at) DESC
    LIMIT ?
  `).all(String(l1Key), Math.min(500, Math.max(1, Number(limit) || 80))).map((row) => ({
    ...row,
    tags: parseJson(row.tags_json, []),
    analysis: parseJson(row.analysis_json, {})
  }));
}

export function getNotesForEntries(entryIds) {
  if (!entryIds.length) return new Map();
  const db = getDb();
  const map = new Map();
  for (let i = 0; i < entryIds.length; i += 400) {
    const chunk = entryIds.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM notes WHERE entry_id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...chunk);
    for (const row of rows) {
      if (!map.has(row.entry_id)) map.set(row.entry_id, []);
      map.get(row.entry_id).push(row);
    }
  }
  return map;
}

export function createWeeklyRun({ id, weekKey, trigger, phase = 'scan', status = 'running' }) {
  const now = nowIso();
  getDb().prepare(`
    INSERT INTO weekly_runs
      (id, week_key, trigger, status, phase, progress_json, state_json,
       changes_json, proposals_json, report_md, error, cancel_requested,
       started_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, NULL)
  `).run(String(id), String(weekKey), String(trigger), String(status), String(phase), now, now);
  return getWeeklyRun(id);
}

const RUN_FIELDS = new Set([
  'status', 'phase', 'progress_json', 'state_json', 'changes_json',
  'proposals_json', 'report_md', 'error', 'cancel_requested', 'finished_at'
]);

export function updateWeeklyRun(id, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!RUN_FIELDS.has(key)) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(nowIso(), String(id));
  getDb().prepare(`UPDATE weekly_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function parseRun(row) {
  if (!row) return null;
  return {
    ...row,
    progress: parseJson(row.progress_json, {}),
    state: parseJson(row.state_json, {}),
    changes: parseJson(row.changes_json, {}),
    proposals: parseJson(row.proposals_json, []),
    cancel_requested: Boolean(row.cancel_requested)
  };
}

export function getWeeklyRun(id) {
  return parseRun(getDb().prepare('SELECT * FROM weekly_runs WHERE id = ?').get(String(id)));
}

export function listWeeklyRuns(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM weekly_runs ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(100, Math.max(1, Number(limit) || 20)))
    .map(parseRun);
}

export function getLatestWeeklyRun() {
  return parseRun(getDb().prepare('SELECT * FROM weekly_runs ORDER BY started_at DESC LIMIT 1').get());
}

export function markInterruptedWeeklyRuns() {
  const result = getDb().prepare(`
    UPDATE weekly_runs
    SET status = 'interrupted', error = ?, updated_at = ?
    WHERE status = 'running'
  `).run('服务重启，任务已中断；可在周报中恢复', nowIso());
  return Number(result.changes || 0);
}

export function getActiveWeeklyRun() {
  return parseRun(
    getDb().prepare("SELECT * FROM weekly_runs WHERE status IN ('running', 'interrupted') ORDER BY started_at DESC LIMIT 1").get()
  );
}

export function hasWeeklyAutoRun(weekKey) {
  return Boolean(
    getDb().prepare("SELECT id FROM weekly_runs WHERE week_key = ? AND trigger = 'auto' LIMIT 1").get(String(weekKey))
  );
}

export function hasWeeklyRun(weekKey) {
  return Boolean(
    getDb().prepare('SELECT id FROM weekly_runs WHERE week_key = ? LIMIT 1').get(String(weekKey))
  );
}

export function requestWeeklyCancel(id) {
  getDb().prepare('UPDATE weekly_runs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(nowIso(), String(id));
  return getWeeklyRun(id);
}

export function createProposal({ id, runId = null, type, payload, status = 'pending' }) {
  getDb().prepare(`
    INSERT INTO proposals (id, run_id, type, payload_json, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(String(id), runId ? String(runId) : null, String(type), JSON.stringify(payload), String(status), nowIso());
  return getProposal(id);
}

export function getProposal(id) {
  const row = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(String(id));
  return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
}

export function listProposals({ status = null } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all(String(status))
    : db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200').all();
  return rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

export function resolveProposal(id, status) {
  getDb().prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?').run(String(status), nowIso(), String(id));
  return getProposal(id);
}

export function resetStaleProcessing() {
  getDb()
    .prepare("UPDATE entries SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'processing'")
    .run(nowIso());
}

export function getWeeklyStats(startIso, endIso) {
  const db = getDb();
  const newCount = db
    .prepare('SELECT COUNT(*) AS c FROM captures WHERE captured_at >= ? AND captured_at < ?')
    .get(startIso, endIso).c;
  const newByType = db
    .prepare('SELECT source_type, COUNT(*) AS c FROM captures WHERE captured_at >= ? AND captured_at < ? GROUP BY source_type')
    .all(startIso, endIso);
  return {
    newCount: Number(newCount),
    newByType: Object.fromEntries(newByType.map((r) => [r.source_type, Number(r.c)]))
  };
}
