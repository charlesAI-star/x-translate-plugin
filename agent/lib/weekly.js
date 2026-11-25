import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { llmJson } from './llm.js';
import {
  ANALYZE_BATCH_SCHEMA,
  GOVERN_SCHEMA,
  REPORT_SCHEMA,
  SUMMARY_SCHEMA,
  SYSTEM_PROMPT,
  analyzeBatchPrompt,
  governPrompt,
  reportPrompt,
  summarizePrompt
} from './prompts.js';
import * as store from './store.js';
import {
  syncAllActiveEntries,
  syncEntries,
  writeReportMarkdown,
  writeSummaryMarkdown
} from './markdown.js';
import {
  nowIso,
  randomKey,
  scheduledTimeForWeek,
  sleep,
  truncate,
  weekEnd,
  weekKey,
  weekStart
} from './util.js';

const cancelledRuns = new Set();

function runWeekRange(startedAt) {
  const date = new Date(startedAt);
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    start: weekStart(base).toISOString(),
    end: weekEnd(base).toISOString()
  };
}

function saveState(runId, state, extra = {}) {
  store.updateWeeklyRun(runId, {
    state_json: JSON.stringify(state),
    ...extra
  });
}

function setProgress(runId, phase, done, total, label) {
  store.updateWeeklyRun(runId, {
    phase,
    progress_json: JSON.stringify({
      phase,
      done,
      total,
      label,
      updated_at: nowIso()
    })
  });
}

function isCancelled(runId) {
  if (cancelledRuns.has(runId)) return true;
  const run = store.getWeeklyRun(runId);
  return Boolean(run && run.cancel_requested);
}

async function callWithRetry(args, label) {
  const config = loadConfig();
  const attempts = Math.max(1, Number(config.llm.retries || 0) + 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await llmJson(args);
    } catch (err) {
      lastError = err;
      console.error(`[weekly] ${label} 失败（${attempt + 1}/${attempts}）：${err.message}`);
      if (attempt < attempts - 1) {
        await sleep(Math.min(10000, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

function buildMaps(tree) {
  const l1ByKey = new Map();
  const l2ByKey = new Map();
  for (const l1 of tree) {
    l1ByKey.set(l1.key, l1);
    for (const l2 of l1.children || []) {
      l2ByKey.set(l2.key, l2);
    }
  }
  return { l1ByKey, l2ByKey };
}

function l1Name(maps, key) {
  return maps.l1ByKey.get(key)?.name || key;
}

function l2Name(maps, key) {
  if (!key) return '';
  return maps.l2ByKey.get(key)?.name || key;
}

function resolveL2ForChange(maps, l1Key, nameOrKey) {
  const value = String(nameOrKey || '').trim();
  if (!value) return { key: null, name: null, invalid: false };
  const l1 = maps.l1ByKey.get(l1Key);
  if (!l1) return { key: null, name: null, invalid: true };
  const child = (l1.children || []).find(
    (item) => item.key === value || item.name.toLowerCase() === value.toLowerCase()
  );
  if (!child) return { key: null, name: null, invalid: true };
  return { key: child.key, name: child.name, invalid: false };
}

function promptEntry(entry, maps, notesMap) {
  const notes = notesMap.get(entry.id) || [];
  return {
    id: entry.id,
    title: entry.title,
    summary: truncate(entry.summary || '', 500),
    tags: entry.tags || [],
    content_type: entry.analysis?.content_type || '',
    key_points: entry.analysis?.key_points || [],
    author: [entry.author_name, entry.author_handle ? `@${entry.author_handle}` : ''].filter(Boolean).join(' '),
    captured_at: entry.captured_at,
    current_l1: l1Name(maps, entry.category_l1),
    current_l2: l2Name(maps, entry.category_l2),
    notes: notes.slice(0, 3).map((note) => ({
      created_at: note.created_at,
      body: truncate(note.body, 800)
    }))
  };
}

function analyzePromptEntry(entry, maps, notesMap, textChars) {
  const notes = notesMap.get(entry.id) || [];
  return {
    id: entry.id,
    title: entry.title,
    summary: truncate(entry.summary || '', 600),
    tags: entry.tags || [],
    current_l1: l1Name(maps, entry.category_l1),
    current_l2: l2Name(maps, entry.category_l2),
    source_type: entry.source_type,
    author: [entry.author_name, entry.author_handle ? `@${entry.author_handle}` : ''].filter(Boolean).join(' '),
    captured_at: entry.captured_at,
    text: truncate(entry.text || '', textChars),
    quoted: entry.quoted?.content?.text ? truncate(entry.quoted.content.text, 1000) : null,
    links: (entry.links || []).slice(0, 10).map((link) => link.url),
    media: (entry.media || []).slice(0, 5).map((media) => ({
      type: media.type,
      alt: media.alt,
      caption: media.caption
    })),
    notes: notes.slice(0, 3).map((note) => ({
      created_at: note.created_at,
      body: truncate(note.body, 500)
    }))
  };
}

function scanPhase(run) {
  const range = runWeekRange(run.started_at);
  const entries = store.getAllEntriesForWeekly();
  const stats = store.getStats();
  const byL1 = {};
  const byL2 = {};
  const newEntries = [];
  let newCount = 0;
  for (const entry of entries) {
    byL1[entry.category_l1] = (byL1[entry.category_l1] || 0) + 1;
    if (entry.category_l2) {
      byL2[entry.category_l2] = (byL2[entry.category_l2] || 0) + 1;
    }
    if (entry.captured_at >= range.start && entry.captured_at < range.end) {
      newCount += 1;
      if (newEntries.length < 40) {
        newEntries.push({
          id: entry.id,
          title: entry.title,
          summary: truncate(entry.summary || '', 300),
          category_l1: entry.category_l1,
          category_l2: entry.category_l2,
          captured_at: entry.captured_at
        });
      }
    }
  }
  return {
    range,
    total: entries.length,
    byL1,
    byL2,
    newCount,
    newEntries,
    status: stats.byStatus,
    inbox: stats.inbox,
    failed: stats.byStatus.failed,
    pending: stats.byStatus.pending,
    saved: stats.byStatus.saved,
    classified: stats.byStatus.classified
  };
}

function buildSamples(entries, maps) {
  const byL1 = {};
  const byL2 = {};
  for (const entry of entries) {
    if (!byL1[entry.category_l1]) byL1[entry.category_l1] = [];
    if (byL1[entry.category_l1].length < 8) {
      byL1[entry.category_l1].push({
        id: entry.id,
        title: entry.title,
        summary: truncate(entry.summary || '', 160)
      });
    }
    if (entry.category_l2) {
      if (!byL2[entry.category_l2]) byL2[entry.category_l2] = [];
      if (byL2[entry.category_l2].length < 5) {
        byL2[entry.category_l2].push({
          id: entry.id,
          title: entry.title,
          summary: truncate(entry.summary || '', 140)
        });
      }
    }
  }
  return {
    by_l1: byL1,
    by_l2: byL2,
    l1_names: Object.fromEntries([...maps.l1ByKey].map(([key, value]) => [key, value.name])),
    l2_names: Object.fromEntries([...maps.l2ByKey].map(([key, value]) => [key, value.name]))
  };
}

function pendingProposalExists(pending, type, payload) {
  return pending.some((proposal) => {
    if (proposal.type !== type) return false;
    if (type === 'l1_create') return proposal.payload?.name === payload.name;
    if (type === 'l1_archive') return proposal.payload?.key === payload.key;
    return false;
  });
}

async function governPhase(state, run) {
  const config = loadConfig();
  const tree = store.buildCategoryTree();
  const maps = buildMaps(tree);
  const entries = store.getAllEntriesForWeekly();
  const samples = buildSamples(entries, maps);
  const stats = {
    total: state.scan.total,
    newCount: state.scan.newCount,
    by_l1: state.scan.byL1,
    by_l2: state.scan.byL2,
    inbox: state.scan.inbox,
    saved: state.scan.saved,
    classified: state.scan.classified,
    failed: state.scan.failed,
    pending: state.scan.pending
  };
  const result = await callWithRetry(
    {
      task: 'govern',
      prompt: governPrompt({
        tree,
        stats,
        samples,
        maxL2Actions: config.weekly.maxL2Actions
      }),
      schema: GOVERN_SCHEMA,
      system: SYSTEM_PROMPT
    },
    '分类治理'
  );

  const applied = [];
  const errors = [];
  const order = { create: 0, rename: 1, merge: 2, archive: 3 };
  const actions = [...(result.l2_actions || [])].sort(
    (a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9)
  );
  let appliedCount = 0;
  for (const action of actions) {
    if (appliedCount >= config.weekly.maxL2Actions) break;
    try {
      if (action.action === 'create') {
        const parent = store.getCategory(action.parent_key);
        if (!parent || parent.level !== 1 || parent.status !== 'active') {
          throw new Error('父级一级分类不存在');
        }
        const category = store.createCategory({
          level: 2,
          parentKey: action.parent_key,
          name: action.name,
          description: action.description || '',
          createdBy: 'agent'
        });
        applied.push({
          action: 'create',
          key: category.key,
          name: category.name,
          parent_key: action.parent_key,
          parent_name: parent.name,
          reason: action.reason
        });
        appliedCount += 1;
      } else if (action.action === 'rename') {
        const category = store.getCategory(action.key);
        if (!category || category.level !== 2 || category.status !== 'active') {
          throw new Error('二级分类不存在');
        }
        const updated = store.renameCategory(action.key, action.name, action.description);
        applied.push({
          action: 'rename',
          key: action.key,
          from: category.name,
          to: updated.name,
          reason: action.reason
        });
        appliedCount += 1;
      } else if (action.action === 'merge') {
        const from = store.getCategory(action.key);
        const into = store.getCategory(action.merge_into_key);
        if (!from || from.level !== 2 || !into || into.level !== 2) {
          throw new Error('合并目标必须是二级分类');
        }
        if (action.key === action.merge_into_key) {
          throw new Error('不能合并到自身');
        }
        const moved = store.mergeCategories(action.key, action.merge_into_key, {
          actor: 'agent',
          batchId: run.id
        });
        applied.push({
          action: 'merge',
          key: action.key,
          from: from.name,
          into: into.name,
          moved: moved.moved,
          manual_overrides: moved.manual_overrides || [],
          reason: action.reason
        });
        appliedCount += 1;
      } else if (action.action === 'archive') {
        const category = store.getCategory(action.key);
        if (!category || category.level !== 2 || category.status !== 'active') {
          throw new Error('二级分类不存在');
        }
        const resultArchive = store.archiveCategory(action.key, {
          actor: 'agent',
          batchId: run.id
        });
        applied.push({
          action: 'archive',
          key: action.key,
          name: category.name,
          moved: resultArchive.moved,
          manual_overrides: resultArchive.manual_overrides || [],
          reason: action.reason
        });
        appliedCount += 1;
      }
    } catch (err) {
      errors.push({ action: action.action, key: action.key || null, message: err.message });
    }
  }
  if (applied.length) {
    try {
      syncAllActiveEntries();
    } catch (err) {
      errors.push({ action: 'markdown_sync', message: err.message });
    }
  }

  const proposals = [];
  const pending = store.listProposals({ status: 'pending' });
  const activeL1s = tree;
  for (const proposal of result.l1_proposals || []) {
    try {
      if (proposal.action === 'create') {
        const name = String(proposal.name || '').trim();
        if (!name) throw new Error('一级分类名称不能为空');
        if (activeL1s.some((l1) => l1.name.toLowerCase() === name.toLowerCase())) {
          throw new Error('一级分类已存在');
        }
        const payload = {
          action: 'create',
          name,
          description: proposal.description || '',
          reason: proposal.reason
        };
        if (pendingProposalExists(pending, 'l1_create', payload)) continue;
        proposals.push(
          store.createProposal({
            id: randomKey('prop'),
            runId: run.id,
            type: 'l1_create',
            payload
          })
        );
      } else if (proposal.action === 'archive') {
        const key = String(proposal.key || '').trim();
        const target = String(proposal.target_key || '').trim();
        const category = store.getCategory(key);
        const targetCategory = store.getCategory(target);
        if (!category || category.level !== 1 || category.status !== 'active') {
          throw new Error('要归档的一级分类不存在');
        }
        if (!targetCategory || targetCategory.level !== 1 || targetCategory.status !== 'active' || target === key) {
          throw new Error('归档目标必须是另一个启用的一级分类');
        }
        const payload = {
          action: 'archive',
          key,
          name: category.name,
          target_key: target,
          target_name: targetCategory.name,
          reason: proposal.reason
        };
        if (pendingProposalExists(pending, 'l1_archive', payload)) continue;
        proposals.push(
          store.createProposal({
            id: randomKey('prop'),
            runId: run.id,
            type: 'l1_archive',
            payload
          })
        );
      }
    } catch (err) {
      errors.push({ action: 'l1_proposal', message: err.message });
    }
  }

  return {
    actions: applied,
    proposals,
    errors,
    raw: {
      l2_actions: result.l2_actions || [],
      l1_proposals: result.l1_proposals || []
    }
  };
}

async function analyzePhase(state, run) {
  const config = loadConfig();
  const tree = store.buildCategoryTree();
  const maps = buildMaps(tree);
  const all = store.getAllEntriesForWeekly();
  const entryMap = new Map(all.map((entry) => [entry.id, entry]));

  if (!state.analyze) {
    const ids = all.map((entry) => entry.id);
    const batchSize = config.weekly.analyzeBatchSize;
    const batches = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      batches.push(ids.slice(i, i + batchSize));
    }
    const ratioValue = Number(config.weekly.maxCategoryChangesRatio);
    const ratio = Number.isFinite(ratioValue) ? ratioValue : 0.3;
    const maxCategoryChanges = Math.min(
      500,
      Math.max(
        Number(config.weekly.minCategoryChanges) || 0,
        Math.ceil(all.length * ratio)
      )
    );
    state.analyze = {
      batches,
      cursor: 0,
      analyzed: 0,
      category_changes: [],
      skipped_category_changes: 0,
      max_category_changes: maxCategoryChanges,
      warnings: [],
      errors: []
    };
  }

  const progress = state.analyze;
  for (let index = progress.cursor; index < progress.batches.length; index += 1) {
    if (isCancelled(run.id)) break;
    const batchIds = progress.batches[index];
    const batchEntries = batchIds.map((id) => entryMap.get(id)).filter(Boolean);
    if (!batchEntries.length) {
      progress.cursor = index + 1;
      saveState(run.id, state);
      continue;
    }
    setProgress(
      run.id,
      'analyze',
      index,
      progress.batches.length,
      `全量重新分析 ${index + 1}/${progress.batches.length}`
    );

    const notesMap = store.getNotesForEntries(batchIds);
    const prepared = batchEntries.map((entry) =>
      analyzePromptEntry(entry, maps, notesMap, config.weekly.analyzeTextChars)
    );
    let result;
    try {
      result = await callWithRetry(
        {
          task: 'analyze_batch',
          prompt: analyzeBatchPrompt({
            tree,
            entries: prepared,
            batchIndex: index,
            batchTotal: progress.batches.length,
            textChars: config.weekly.analyzeTextChars
          }),
          schema: ANALYZE_BATCH_SCHEMA,
          system: SYSTEM_PROMPT
        },
        `全量重新分析 ${index + 1}/${progress.batches.length}`
      );
    } catch (err) {
      progress.errors.push({ batch: index, message: err.message });
      progress.cursor = index + 1;
      saveState(run.id, state);
      continue;
    }

    const batchSet = new Set(batchIds);
    const returned = new Set();
    const synced = [];
    for (const item of result.items || []) {
      if (!batchSet.has(item.entry_id)) {
        progress.warnings.push({ entry_id: item.entry_id, message: '模型返回了批次外的条目' });
        continue;
      }
      if (returned.has(item.entry_id)) continue;
      returned.add(item.entry_id);
      const entry = entryMap.get(item.entry_id);
      if (!entry) continue;

      const l1 = maps.l1ByKey.get(item.category_l1);
      let categoryMode = 'keep';
      let targetL1 = entry.category_l1;
      let targetL2 = entry.category_l2;
      if (!l1) {
        progress.warnings.push({ entry_id: entry.id, message: '一级分类不存在，保留原分类' });
      } else {
        const l2 = resolveL2ForChange(maps, l1.key, item.category_l2);
        if (l2.invalid) {
          progress.warnings.push({ entry_id: entry.id, message: '二级分类不存在，忽略该建议' });
        } else {
          const confidence = Number(item.confidence) || 0;
          const different =
            entry.category_l1 !== l1.key || (entry.category_l2 || null) !== (l2.key || null);
          if (different && confidence >= 0.7 && progress.category_changes.length < progress.max_category_changes) {
            categoryMode = 'force';
            targetL1 = l1.key;
            targetL2 = l2.key;
          } else {
            if (different && confidence >= 0.7) progress.skipped_category_changes += 1;
            categoryMode = 'keep';
          }
        }
      }

      try {
        // The batch prompt can take a while; re-read before applying so a user
        // move during the model call is not overwritten by a stale snapshot.
        const before = store.getEntry(entry.id);
        if (!before || before.deleted_at) {
          progress.warnings.push({ entry_id: entry.id, message: '条目已删除，跳过本次分析结果' });
          continue;
        }
        let applyMode = categoryMode;
        let applyL1 = targetL1;
        let applyL2 = targetL2;
        if (applyMode === 'force' &&
            before.category_l1 === targetL1 &&
            (before.category_l2 || null) === (targetL2 || null)) {
          applyMode = 'keep';
        }
        if (applyMode === 'keep') {
          applyL1 = before.category_l1;
          applyL2 = before.category_l2;
        }
        const updated = store.applyEntryAnalysis(
          entry.id,
          {
            title: item.title,
            summary: item.summary,
            tags: item.tags,
            key_points: item.key_points,
            content_type: item.content_type,
            language: item.language,
            category_l1: applyL1,
            category_l2: applyL2
          },
          {
            categoryMode: applyMode,
            actor: 'agent',
            batchId: run.id,
            confidence: item.confidence,
            reason: item.reason || '每周重新分析'
          }
        );
        if (!updated) {
          progress.warnings.push({ entry_id: entry.id, message: '条目已删除，跳过本次分析结果' });
          continue;
        }
        progress.analyzed += 1;
        synced.push(updated.id);
        if (applyMode === 'force') {
          progress.category_changes.push({
            entry_id: updated.id,
            title: updated.title,
            from: {
              l1: before.category_l1,
              l2: before.category_l2,
              l1_name: l1Name(maps, before.category_l1),
              l2_name: l2Name(maps, before.category_l2)
            },
            to: {
              l1: updated.category_l1,
              l2: updated.category_l2,
              l1_name: updated.category_l1_name || l1Name(maps, updated.category_l1),
              l2_name: updated.category_l2_name || l2Name(maps, updated.category_l2)
            },
            confidence: item.confidence,
            reason: item.reason,
            manual_override: before.category_source === 'manual'
          });
        }
      } catch (err) {
        progress.warnings.push({ entry_id: entry.id, message: err.message });
      }
    }

    for (const entry of batchEntries) {
      if (!returned.has(entry.id)) {
        progress.warnings.push({ entry_id: entry.id, message: '模型未返回该条结果' });
      }
    }

    progress.cursor = index + 1;
    saveState(run.id, state);
    if (synced.length) {
      try {
        syncEntries(synced);
      } catch (err) {
        progress.warnings.push({ entry_id: null, message: `Markdown 同步失败：${err.message}` });
      }
    }
  }
  return progress;
}

async function summarizePhase(state, run) {
  const config = loadConfig();
  const tree = store.buildCategoryTree();
  const maps = buildMaps(tree);
  const selected = tree
    .filter((l1) => l1.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.weekly.maxSummariesPerRun);
  if (!state.summaries) state.summaries = [];
  const done = new Set(state.summaries.filter((item) => !item.error).map((item) => item.key));

  for (const category of selected) {
    if (done.has(category.key)) continue;
    if (isCancelled(run.id)) break;
    setProgress(
      run.id,
      'summarize',
      state.summaries.length,
      selected.length,
      `生成分类总结：${category.name}`
    );
    const entries = store.getEntriesForCategory(category.key, 80).filter((entry) => entry.status === 'ready');
    if (!entries.length) {
      state.summaries.push({
        key: category.key,
        name: category.name,
        entry_count: 0,
        skipped: true
      });
      saveState(run.id, state);
      continue;
    }
    const notesMap = store.getNotesForEntries(entries.map((entry) => entry.id));
    const byL2 = {};
    for (const child of category.children || []) {
      byL2[child.name] = child.count;
    }
    try {
      const result = await callWithRetry(
        {
          task: 'summarize',
          prompt: summarizePrompt({
            category: { name: category.name, description: category.description },
            entries: entries.map((entry) => promptEntry(entry, maps, notesMap)),
            counts: {
              total: category.count,
              sampled: entries.length,
              byL2
            }
          }),
          schema: SUMMARY_SCHEMA,
          system: SYSTEM_PROMPT
        },
        `分类总结 ${category.name}`
      );
      store.upsertCategorySummary({
        categoryKey: category.key,
        contentMd: result.summary_md,
        entryCount: entries.length,
        runId: run.id
      });
      writeSummaryMarkdown(category.key, category.name, result.summary_md);
      state.summaries.push({
        key: category.key,
        name: category.name,
        entry_count: entries.length,
        themes: result.themes,
        learning_order: result.learning_order,
        generated_at: nowIso()
      });
    } catch (err) {
      state.summaries.push({
        key: category.key,
        name: category.name,
        entry_count: entries.length,
        error: err.message
      });
    }
    saveState(run.id, state);
  }
  return state.summaries;
}

function fallbackReport(state, run, proposals, summaries) {
  const scan = state.scan || {};
  const analyze = state.analyze || {};
  const changes = analyze.category_changes || [];
  const governManual = (state.govern?.actions || []).flatMap(
    (action) => action.manual_overrides || []
  );
  const manualChanges = [
    ...changes.filter((change) => change.manual_override),
    ...governManual
  ];
  const lines = [
    `# ${run.week_key} 知识周报`,
    '',
    '## 本周概览',
    '',
    `- 知识库共 ${scan.total || 0} 条，本周新增 ${scan.newCount || 0} 条。`,
    `- 本周全量重新分析 ${analyze.analyzed || 0} 条，调整分类 ${changes.length} 条。`,
    `- 二级分类调整 ${state.govern?.actions?.length || 0} 项，待确认一级分类调整 ${proposals.length} 项。`,
    ''
  ];
  lines.push('## 分类分析', '');
  if (summaries.length) {
    for (const summary of summaries) {
      lines.push(`### ${summary.category || summary.category_key}`, '');
      lines.push(truncate(summary.content_md || '', 900), '');
    }
  } else {
    lines.push('本周没有可用的分类总结。', '');
  }
  lines.push('## 本周优先学习', '');
  const manual = manualChanges.slice(0, 5);
  if (manual.length) {
    lines.push('以下条目你手动设置过分类，本周被重新分类，建议优先复核：', '');
    for (const change of manual) {
      lines.push(`- ${change.title || change.entry_id}：${change.from?.l1_name || ''} → ${change.to?.l1_name || ''}`);
    }
    lines.push('');
  } else {
    lines.push('本周没有手动分类被覆盖的条目。', '');
  }
  lines.push('## 需要你决策', '');
  if (proposals.length) {
    for (const proposal of proposals) {
      lines.push(`- ${proposal.payload?.reason || proposal.type}（${proposal.payload?.name || proposal.payload?.key || ''}）`);
    }
  } else {
    lines.push('无。');
  }
  lines.push('', '## 数据质量', '');
  lines.push(
    `- 待归类 ${scan.inbox || 0} 条，仅保存 ${scan.saved || 0} 条，待分析 ${scan.classified || 0} 条，分析失败 ${scan.failed || 0} 条。`
  );
  if (analyze.errors?.length) {
    lines.push(`- 有 ${analyze.errors.length} 个分析批次失败，建议稍后恢复任务。`);
  }
  if (analyze.skipped_category_changes) {
    lines.push(`- 有 ${analyze.skipped_category_changes} 条分类建议因稳定性上限未自动应用。`);
  }
  lines.push('');
  return lines.join('\n');
}

async function reportPhase(state, run) {
  const proposals = (state.govern?.proposals || []).map((proposal) => ({
    id: proposal.id,
    type: proposal.type,
    payload: proposal.payload
  }));
  // Only include summaries generated by this run. A failed or skipped
  // category must not resurface last week's text in this week's report.
  const summaries = (state.summaries || [])
    .filter((item) => !item.error && !item.skipped && item.key)
    .map((item) => {
      const stored = store.getCategorySummary(item.key);
      return {
        category: item.name || stored?.category_name || item.key,
        generated_at: item.generated_at || stored?.generated_at || '',
        content_md: truncate(stored?.content_md || '', 2000)
      };
    })
    .filter((summary) => summary.content_md);
  const allEntries = store.getAllEntriesForWeekly();
  const range = state.scan.range;
  const maps = buildMaps(store.buildCategoryTree());
  const newEntries = allEntries
    .filter((entry) => entry.captured_at >= range.start && entry.captured_at < range.end)
    .slice(0, 40)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      summary: truncate(entry.summary || '', 200),
      category: l1Name(maps, entry.category_l1)
    }));
  const analyze = state.analyze || {};
  const governManualOverrides = (state.govern?.actions || []).flatMap(
    (action) => action.manual_overrides || []
  );
  const manualOverrides = [
    ...(analyze.category_changes || []).filter((change) => change.manual_override),
    ...governManualOverrides
  ];
  const changes = {
    l2_actions: state.govern?.actions || [],
    analyzed: analyze.analyzed || 0,
    category_changes: analyze.category_changes || [],
    manual_overrides: manualOverrides,
    counts: {
      analyzed: analyze.analyzed || 0,
      category_changes: (analyze.category_changes || []).length,
      skipped_category_changes: analyze.skipped_category_changes || 0
    },
    errors: [
      ...(state.govern?.errors || []),
      ...(analyze.errors || [])
    ]
  };
  const freshStats = store.getStats();
  const quality = {
    inbox: freshStats.inbox,
    saved: freshStats.byStatus.saved,
    classified: freshStats.byStatus.classified,
    failed: freshStats.byStatus.failed,
    pending: freshStats.byStatus.pending + freshStats.byStatus.processing,
    govern_warnings: state.govern?.errors || [],
    analyze_warnings: (analyze.warnings || []).slice(0, 30),
    summarize_errors: (state.summaries || []).filter((item) => item.error)
  };
  const stats = {
    total: state.scan.total,
    newCount: state.scan.newCount,
    byL1: Object.entries(state.scan.byL1).map(([key, count]) => ({
      key,
      name: l1Name(maps, key),
      count
    })),
    status: freshStats.byStatus
  };

  let reportMd;
  try {
    const result = await callWithRetry(
      {
        task: 'report',
        prompt: reportPrompt({
          weekKey: run.week_key,
          stats,
          changes,
          proposals,
          summaries,
          newEntries,
          quality
        }),
        schema: REPORT_SCHEMA,
        system: SYSTEM_PROMPT
      },
      '生成周报'
    );
    reportMd = result.report_md;
  } catch (err) {
    reportMd = fallbackReport(state, run, proposals, summaries);
  }

  store.updateWeeklyRun(run.id, {
    report_md: reportMd,
    changes_json: JSON.stringify(changes),
    proposals_json: JSON.stringify(proposals),
    progress_json: JSON.stringify({
      phase: 'report',
      done: 1,
      total: 1,
      label: '周报已生成',
      updated_at: nowIso()
    })
  });
  try {
    writeReportMarkdown(run.week_key, reportMd);
  } catch (err) {
    console.error(`[weekly] 周报 Markdown 写入失败：${err.message}`);
  }
  return { generated_at: nowIso() };
}

function finishCancelled(runId) {
  store.updateWeeklyRun(runId, {
    status: 'cancelled',
    phase: 'cancelled',
    finished_at: nowIso(),
    progress_json: JSON.stringify({
      phase: 'cancelled',
      done: 0,
      total: 0,
      label: '已取消',
      updated_at: nowIso()
    })
  });
}

async function runWeekly(runId) {
  let run = store.getWeeklyRun(runId);
  if (!run) return;
  const state = run.state || {};
  try {
    if (isCancelled(runId)) {
      finishCancelled(runId);
      return;
    }
    if (!state.scan) {
      setProgress(runId, 'scan', 0, 1, '扫描全部内容');
      state.scan = scanPhase(run);
      saveState(runId, state);
    }
    if (isCancelled(runId)) {
      finishCancelled(runId);
      return;
    }
    if (!state.govern) {
      setProgress(runId, 'govern', 0, 1, '治理二级分类');
      state.govern = await governPhase(state, run);
      saveState(runId, state, {
        proposals_json: JSON.stringify(state.govern.proposals || [])
      });
    }
    if (isCancelled(runId)) {
      finishCancelled(runId);
      return;
    }
    if (!state.analyze) {
      setProgress(runId, 'analyze', 0, 1, '准备全量重新分析');
      state.analyze = await analyzePhase(state, run);
      saveState(runId, state);
    } else if (state.analyze.cursor < state.analyze.batches.length) {
      state.analyze = await analyzePhase(state, run);
      saveState(runId, state);
    }
    if (isCancelled(runId)) {
      finishCancelled(runId);
      return;
    }
    setProgress(runId, 'summarize', 0, 1, '生成分类总结');
    state.summaries = await summarizePhase(state, run);
    saveState(runId, state);
    if (isCancelled(runId)) {
      finishCancelled(runId);
      return;
    }
    run = store.getWeeklyRun(runId);
    if (!state.report || !run.report_md) {
      delete state.report;
      setProgress(runId, 'report', 0, 1, '生成周报');
      state.report = await reportPhase(state, run);
      saveState(runId, state);
    }
    store.updateWeeklyRun(runId, {
      status: 'completed',
      phase: 'done',
      error: null,
      finished_at: nowIso(),
      progress_json: JSON.stringify({
        phase: 'done',
        done: 1,
        total: 1,
        label: '整理完成',
        updated_at: nowIso()
      })
    });
    cancelledRuns.delete(runId);
    console.log(`[weekly] ${runId} 完成`);
  } catch (err) {
    store.updateWeeklyRun(runId, {
      status: 'failed',
      error: truncate(err.message || '整理失败', 500),
      finished_at: nowIso()
    });
    console.error(`[weekly] ${runId} 失败：${err.message}`);
  }
}

export function startWeeklyRun({ trigger = 'manual' } = {}) {
  const active = store.getActiveWeeklyRun();
  if (active) {
    return {
      ok: false,
      error: { code: 'busy', message: `已有整理任务 ${active.id} 在运行` }
    };
  }
  const now = new Date();
  const id = `${weekKey(now)}-${Date.now().toString(36)}`;
  const run = store.createWeeklyRun({
    id,
    weekKey: weekKey(now),
    trigger
  });
  runWeekly(id).catch((err) => {
    console.error(`[weekly] 启动失败：${err.message}`);
  });
  return { ok: true, run: store.getWeeklyRun(id) };
}

export function resumeWeeklyRun(id) {
  const run = store.getWeeklyRun(id);
  if (!run) return { ok: false, error: { code: 'not_found', message: '任务不存在' } };
  if (run.status === 'running') {
    return { ok: false, error: { code: 'busy', message: '任务仍在运行' } };
  }
  if (['completed', 'cancelled'].includes(run.status)) {
    return { ok: false, error: { code: 'done', message: '任务已结束' } };
  }
  const active = store.getActiveWeeklyRun();
  if (active && active.id !== run.id) {
    return { ok: false, error: { code: 'busy', message: `已有整理任务 ${active.id} 在运行` } };
  }
  cancelledRuns.delete(run.id);
  store.updateWeeklyRun(run.id, {
    status: 'running',
    error: null,
    cancel_requested: 0,
    finished_at: null
  });
  runWeekly(run.id).catch((err) => {
    console.error(`[weekly] 恢复失败：${err.message}`);
  });
  return { ok: true, run: store.getWeeklyRun(run.id) };
}

export function cancelWeeklyRun(id) {
  const run = store.getWeeklyRun(id);
  if (!run) return { ok: false, error: { code: 'not_found', message: '任务不存在' } };
  if (!['running', 'interrupted'].includes(run.status)) {
    return { ok: false, error: { code: 'not_running', message: '任务不在运行中' } };
  }
  cancelledRuns.add(run.id);
  if (run.status === 'interrupted') {
    // 没有 runner 会再消费 cancel_requested；直接落成终态，避免永久阻塞后续周任务。
    store.updateWeeklyRun(run.id, {
      status: 'cancelled',
      cancel_requested: 1,
      error: '任务已取消',
      finished_at: nowIso()
    });
  } else {
    store.requestWeeklyCancel(run.id);
  }
  return { ok: true, run: store.getWeeklyRun(run.id) };
}

export function approveProposal(id) {
  const proposal = store.getProposal(id);
  if (!proposal) return { ok: false, error: { code: 'not_found', message: '提案不存在' } };
  if (proposal.status !== 'pending') {
    return { ok: false, error: { code: 'resolved', message: '提案已处理' } };
  }
  try {
    if (proposal.type === 'l1_create') {
      const category = store.createCategory({
        level: 1,
        name: proposal.payload.name,
        description: proposal.payload.description || '',
        createdBy: 'agent'
      });
      store.resolveProposal(proposal.id, 'approved');
      return { ok: true, proposal: store.getProposal(proposal.id), category };
    }
    if (proposal.type === 'l1_archive') {
      store.archiveCategory(proposal.payload.key, {
        targetKey: proposal.payload.target_key,
        actor: 'user'
      });
      syncAllActiveEntries();
      store.resolveProposal(proposal.id, 'approved');
      return { ok: true, proposal: store.getProposal(proposal.id) };
    }
    throw new Error('未知的提案类型');
  } catch (err) {
    return { ok: false, error: { code: 'apply_failed', message: err.message } };
  }
}

export function rejectProposal(id) {
  const proposal = store.getProposal(id);
  if (!proposal) return { ok: false, error: { code: 'not_found', message: '提案不存在' } };
  if (proposal.status !== 'pending') {
    return { ok: false, error: { code: 'resolved', message: '提案已处理' } };
  }
  store.resolveProposal(proposal.id, 'rejected');
  return { ok: true, proposal: store.getProposal(proposal.id) };
}

export function rollbackWeeklyRun(id) {
  const run = store.getWeeklyRun(id);
  if (!run) return { ok: false, error: { code: 'not_found', message: '任务不存在' } };
  if (run.status === 'running') {
    return { ok: false, error: { code: 'running', message: '任务仍在运行，不能回滚' } };
  }
  const events = store
    .listEventsByBatch(run.id)
    .filter((event) => event.type === 'move' && event.actor === 'agent' && event.payload?.from && event.payload?.to);
  const db = getDb();
  let restored = 0;
  let skipped = 0;
  for (const event of [...events].reverse()) {
    const entry = store.getEntry(event.entry_id);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const to = event.payload.to;
    if (entry.category_l1 !== to.l1 || (entry.category_l2 || null) !== (to.l2 || null)) {
      skipped += 1;
      continue;
    }
    const from = event.payload.from;
    const fromCategory = store.getCategory(from.l1);
    const targetL1 = fromCategory && fromCategory.status === 'active' ? from.l1 : 'inbox';
    const targetL2Category = from.l2 ? store.getCategory(from.l2) : null;
    const targetL2 =
      targetL2Category && targetL2Category.status === 'active' && targetL2Category.parent_key === targetL1
        ? from.l2
        : null;
    const now = nowIso();
    db.prepare(`
      UPDATE entries SET category_l1 = ?, category_l2 = ?, category_source = ?,
        category_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      targetL1,
      targetL2,
      event.payload.manual_override ? 'manual' : 'auto',
      now,
      now,
      entry.id
    );
    store.recordEvent({
      entryId: entry.id,
      type: 'rollback',
      actor: 'user',
      payload: { from: to, to: { l1: targetL1, l2: targetL2 } },
      batchId: run.id
    });
    restored += 1;
  }
  if (restored) syncAllActiveEntries();
  return { ok: true, restored, skipped };
}

export function checkSchedule() {
  const config = loadConfig();
  if (!config.weekly.enabled) return;
  if (store.getActiveWeeklyRun()) return;
  const now = new Date();
  const scheduled = scheduledTimeForWeek(
    now,
    config.weekly.dayOfWeek,
    config.weekly.hour,
    config.weekly.minute
  );
  if (now < scheduled) return;
  const key = weekKey(now);
  if (store.hasWeeklyRun(key)) return;
  if (store.getStats().total === 0) return;
  console.log(`[weekly] 本周自动整理开始（${key}）`);
  const result = startWeeklyRun({ trigger: 'auto' });
  if (!result.ok) console.error(`[weekly] 自动整理未启动：${result.error.message}`);
}

export function startScheduler() {
  const timer = setInterval(() => {
    try {
      checkSchedule();
    } catch (err) {
      console.error(`[weekly] 调度检查失败：${err.message}`);
    }
  }, 60_000);
  timer.unref();
  const warmup = setTimeout(() => {
    try {
      checkSchedule();
    } catch (err) {
      console.error(`[weekly] 调度检查失败：${err.message}`);
    }
  }, 5000);
  warmup.unref();
  return timer;
}

export function formatWeeklyProgress(run) {
  if (!run) return '';
  const progress = run.progress || {};
  return `${progress.label || run.phase} ${progress.done || 0}/${progress.total || 0}`;
}
