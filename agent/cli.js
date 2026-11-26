#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from './lib/config.js';

const USAGE = `X 知识库 agent CLI

用法：
  node agent/cli.js <命令> [参数] [--json]

读取：
  status                         服务、队列与统计
  stats                          只输出统计
  list [--status s] [--category k] [--q 词] [--limit n] [--deleted]
  search <关键词>
  show <id>                      查看条目详情
  notes <id>                     查看条目想法

整理：
  process <id> --mode full|classify
  retry <id>
  move <id> --l1 <key> [--l2 <key>]
  note <id> <想法正文>
  delete <id>
  restore <id>

分类：
  categories
  category-add --level 1|2 --name 名称 [--parent <l1>] [--description 说明]
  category-rename <key> --name 名称 [--description 说明]
  category-archive <key> [--target-key <key>]

周整理：
  weekly run
  weekly list
  weekly current
  weekly show <id>
  weekly cancel <id>
  weekly resume <id>
  weekly rollback <id>
  proposals [--status pending]
  approve <id>
  reject <id>
  summaries

连接参数：
  --endpoint http://127.0.0.1:8787   默认读取 config.json 的 host/port
  --token <token>                    默认读取 KB_TOKEN 或 config.json
  --json                             输出原始 JSON
`;

const BOOLEAN_FLAGS = new Set(['json', 'deleted', 'help']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      let value = eq >= 0 ? arg.slice(eq + 1) : true;
      if (
        eq < 0
        && !BOOLEAN_FLAGS.has(key)
        && argv[i + 1] !== undefined
        && !argv[i + 1].startsWith('--')
      ) {
        value = argv[i + 1];
        i += 1;
      }
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function resolveConnection(flags) {
  const config = loadConfig();
  let host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  if (host === 'localhost') host = '127.0.0.1';
  const endpoint = String(
    flags.endpoint || process.env.KB_ENDPOINT || `http://${host}:${config.port}`
  ).replace(/\/+$/, '');
  const token =
    flags.token !== undefined && flags.token !== true
      ? String(flags.token)
      : process.env.KB_TOKEN !== undefined
        ? String(process.env.KB_TOKEN)
        : config.token || '';
  return { endpoint, token };
}

async function request(path, { method = 'GET', body } = {}) {
  const { endpoint, token } = resolveConnection(flags);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(`无法连接 ${endpoint}：${err.message}`);
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

let flags = {};

function wantJson() {
  return flags.json === true || flags.json === 'true' || flags.json === '1';
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function truncate(text, length = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function statusLabel(status) {
  return (
    {
      pending: '待整理',
      processing: '整理中',
      saved: '仅保存',
      classified: '已分类',
      ready: '已分析',
      failed: '失败'
    }[status] || status
  );
}

function categoryPath(entry) {
  const l1 = entry.category_l1_name || entry.category_l1 || '未分类';
  return entry.category_l2_name ? `${l1} / ${entry.category_l2_name}` : l1;
}

function formatEntryLine(entry) {
  const date = entry.source?.published_at || entry.source?.captured_at || '';
  return [
    `[${statusLabel(entry.status)}]`,
    truncate(entry.title || entry.id, 70),
    `· ${categoryPath(entry)}`,
    `· ${String(date).slice(0, 10)}`,
    `· ${entry.id}`
  ].join(' ');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  flags = parsed.flags;
  const [command, ...rest] = parsed.positional;

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'status') {
    const data = await request('/api/status');
    if (wantJson()) return printJson(data);
    console.log(`服务：${data.service} v${data.version}`);
    console.log(`内容：${data.stats.total} 条（已分析 ${data.stats.byStatus.ready}，待整理 ${data.stats.byStatus.pending}，失败 ${data.stats.byStatus.failed}）`);
    console.log(`分类：${data.stats.categories.l1} 个一级 / ${data.stats.categories.l2} 个二级，待确认提案 ${data.stats.pendingProposals} 个`);
    console.log(`队列：${data.queue.queued} 排队${data.queue.running ? '，正在处理' : ''}`);
    console.log(`Claude CLI：${data.llm.status === 'ok' ? '可用' : '不可用'}`);
    console.log(`每周整理：${data.weekly.enabled ? '已启用' : '已关闭'}（周${data.weekly.dayOfWeek} ${String(data.weekly.hour).padStart(2, '0')}:${String(data.weekly.minute).padStart(2, '0')}）`);
    if (data.currentWeekly) {
      console.log(`当前任务：${data.currentWeekly.id} ${data.currentWeekly.status} ${data.currentWeekly.progress?.label || ''}`);
    }
    return;
  }

  if (command === 'stats') {
    const data = await request('/api/status');
    if (wantJson()) return printJson(data.stats);
    console.log(JSON.stringify(data.stats, null, 2));
    return;
  }

  if (command === 'list' || command === 'search') {
    const params = new URLSearchParams();
    const q = command === 'search' ? rest.join(' ') : flags.q;
    if (q) params.set('q', q);
    if (flags.status) params.set('status', flags.status);
    if (flags.category) params.set('category', flags.category);
    if (flags.deleted) params.set('deleted', '1');
    params.set('limit', String(flags.limit || 20));
    const data = await request(`/api/entries?${params.toString()}`);
    if (wantJson()) return printJson(data);
    if (!data.items.length) {
      console.log('没有内容');
      return;
    }
    for (const entry of data.items) {
      console.log(formatEntryLine(entry));
      if (entry.summary) console.log(`    ${truncate(entry.summary, 110)}`);
    }
    console.log(`\n共 ${data.total} 条，显示 ${data.items.length} 条`);
    return;
  }

  if (command === 'show') {
    const id = rest[0];
    if (!id) throw new Error('缺少条目 id');
    const data = await request(`/api/entries/${encodeURIComponent(id)}`);
    if (wantJson()) return printJson(data);
    const entry = data.entry;
    console.log(`${entry.title || entry.id}`);
    console.log(`${statusLabel(entry.status)} · ${categoryPath(entry)} · ${entry.processing_mode}`);
    if (entry.source?.url) console.log(entry.source.url);
    if (entry.summary) console.log(`\n摘要：\n${entry.summary}`);
    if (entry.analysis?.key_points?.length) {
      console.log('\n要点：');
      for (const point of entry.analysis.key_points) console.log(`- ${point}`);
    }
    if (entry.tags?.length) console.log(`\n标签：${entry.tags.join('、')}`);
    if (entry.notes?.length) {
      console.log('\n想法：');
      for (const note of entry.notes) console.log(`- ${note.body.replace(/\s+/g, ' ')}`);
    }
    if (entry.content?.text) console.log(`\n原文：\n${entry.content.text}`);
    return;
  }

  if (command === 'notes') {
    const id = rest[0];
    if (!id) throw new Error('缺少条目 id');
    const data = await request(`/api/entries/${encodeURIComponent(id)}`);
    if (wantJson()) return printJson(data.entry.notes);
    if (!data.entry.notes.length) {
      console.log('没有想法');
      return;
    }
    for (const note of data.entry.notes) {
      console.log(`#${note.id} ${note.created_at}`);
      console.log(note.body);
      console.log('');
    }
    return;
  }

  if (command === 'process') {
    const id = rest[0];
    const mode = flags.mode || 'full';
    if (!id) throw new Error('缺少条目 id');
    if (!['full', 'classify'].includes(mode)) throw new Error('--mode 必须是 full 或 classify');
    const data = await request(`/api/entries/${encodeURIComponent(id)}/process`, {
      method: 'POST',
      body: { mode }
    });
    if (wantJson()) return printJson(data);
    console.log(`已加入队列：${id}（${mode === 'full' ? '完整分析' : '仅整理分类'}）`);
    return;
  }

  if (command === 'retry') {
    const id = rest[0];
    if (!id) throw new Error('缺少条目 id');
    const data = await request(`/api/entries/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: {}
    });
    if (wantJson()) return printJson(data);
    console.log(`已重试：${id}`);
    return;
  }

  if (command === 'move') {
    const id = rest[0];
    if (!id) throw new Error('缺少条目 id');
    if (!flags.l1) throw new Error('缺少 --l1');
    const body = { category_l1: String(flags.l1) };
    if (flags.l2 !== undefined) body.category_l2 = flags.l2 === true ? null : String(flags.l2);
    const data = await request(`/api/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    if (wantJson()) return printJson(data);
    console.log(`已移动：${id} → ${categoryPath(data.entry)}`);
    return;
  }

  if (command === 'note') {
    const id = rest.shift();
    if (!id) throw new Error('缺少条目 id');
    const body = flags.body && flags.body !== true ? String(flags.body) : rest.join(' ');
    if (!body.trim()) throw new Error('想法不能为空');
    const data = await request(`/api/entries/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      body: { body }
    });
    if (wantJson()) return printJson(data);
    console.log(`已添加想法：${id}`);
    return;
  }

  if (command === 'delete' || command === 'restore') {
    const id = rest[0];
    if (!id) throw new Error('缺少条目 id');
    const body = command === 'delete' ? { deleted: true } : { restore: true };
    const data = await request(`/api/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    if (wantJson()) return printJson(data);
    console.log(command === 'delete' ? `已移入回收站：${id}` : `已恢复：${id}`);
    return;
  }

  if (command === 'categories') {
    const data = await request('/api/categories');
    if (wantJson()) return printJson(data);
    for (const l1 of data.tree) {
      console.log(`${l1.name} (${l1.key}) · ${l1.count} 条`);
      for (const l2 of l1.children || []) {
        console.log(`  └ ${l2.name} (${l2.key}) · ${l2.count} 条`);
      }
    }
    if (data.pendingProposals.length) {
      console.log(`\n待确认提案：${data.pendingProposals.length} 个`);
      for (const proposal of data.pendingProposals) {
        console.log(`- ${proposal.id} ${proposal.type} ${proposal.payload?.name || proposal.payload?.key || ''}`);
      }
    }
    return;
  }

  if (command === 'category-add') {
    const data = await request('/api/categories', {
      method: 'POST',
      body: {
        level: Number(flags.level || (flags.parent ? 2 : 1)),
        parentKey: flags.parent && flags.parent !== true ? String(flags.parent) : null,
        name: flags.name && flags.name !== true ? String(flags.name) : '',
        description: flags.description && flags.description !== true ? String(flags.description) : ''
      }
    });
    if (wantJson()) return printJson(data);
    console.log(`已创建分类：${data.category.name} (${data.category.key})`);
    return;
  }

  if (command === 'category-rename') {
    const key = rest[0];
    if (!key) throw new Error('缺少分类 key');
    if (!flags.name) throw new Error('缺少 --name');
    const data = await request(`/api/categories/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: {
        name: String(flags.name),
        description: flags.description !== undefined && flags.description !== true ? String(flags.description) : undefined
      }
    });
    if (wantJson()) return printJson(data);
    console.log(`已重命名：${key} → ${data.category.name}`);
    return;
  }

  if (command === 'category-archive') {
    const key = rest[0];
    if (!key) throw new Error('缺少分类 key');
    const data = await request(`/api/categories/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      body: { targetKey: flags['target-key'] && flags['target-key'] !== true ? String(flags['target-key']) : null }
    });
    if (wantJson()) return printJson(data);
    console.log(`已归档：${key}，迁移 ${data.result.moved} 条`);
    return;
  }

  if (command === 'weekly') {
    const action = rest[0];
    if (!action || action === 'list') {
      const data = await request('/api/weekly');
      if (wantJson()) return printJson(data);
      if (!data.runs.length) {
        console.log('还没有周报');
        return;
      }
      for (const run of data.runs) {
        console.log(`${run.week_key} · ${run.status} · ${run.phase} · 重新分析 ${run.changes?.counts?.analyzed || 0} 条 · 调整分类 ${run.changes?.counts?.category_changes || 0} 条 · ${run.id}`);
      }
      return;
    }
    if (action === 'run') {
      const data = await request('/api/weekly/run', { method: 'POST', body: {} });
      if (wantJson()) return printJson(data);
      console.log(`已开始：${data.run.id}`);
      return;
    }
    if (action === 'current') {
      const data = await request('/api/weekly/current');
      if (wantJson()) return printJson(data);
      if (!data.run) return console.log('当前没有整理任务');
      console.log(`${data.run.id} · ${data.run.status} · ${data.run.phase} · ${data.run.progress?.label || ''}`);
      return;
    }
    if (action === 'show') {
      const id = rest[1];
      if (!id) throw new Error('缺少任务 id');
      const data = await request(`/api/weekly/${encodeURIComponent(id)}`);
      if (wantJson()) return printJson(data);
      console.log(data.run.report_md || '周报尚未生成');
      if (data.proposals?.length) {
        console.log('\n待确认提案：');
        for (const proposal of data.proposals) {
          console.log(`- ${proposal.id} ${proposal.type} ${proposal.payload?.name || proposal.payload?.key || ''}`);
        }
      }
      return;
    }
    if (['cancel', 'resume', 'rollback'].includes(action)) {
      const id = rest[1];
      if (!id) throw new Error('缺少任务 id');
      const data = await request(`/api/weekly/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        body: {}
      });
      if (wantJson()) return printJson(data);
      console.log(`${action} 完成：${id}`);
      return;
    }
    throw new Error(`未知的 weekly 子命令：${action}`);
  }

  if (command === 'proposals') {
    const params = flags.status ? `?status=${encodeURIComponent(flags.status)}` : '';
    const data = await request(`/api/proposals${params}`);
    if (wantJson()) return printJson(data);
    if (!data.proposals.length) {
      console.log('没有提案');
      return;
    }
    for (const proposal of data.proposals) {
      console.log(`${proposal.id} · ${proposal.type} · ${proposal.status} · ${proposal.payload?.name || proposal.payload?.key || ''}`);
      if (proposal.payload?.reason) console.log(`    ${proposal.payload.reason}`);
    }
    return;
  }

  if (command === 'approve' || command === 'reject') {
    const id = rest[0];
    if (!id) throw new Error('缺少提案 id');
    const data = await request(`/api/proposals/${encodeURIComponent(id)}/${command}`, {
      method: 'POST',
      body: {}
    });
    if (wantJson()) return printJson(data);
    console.log(`${command === 'approve' ? '已批准' : '已拒绝'}：${id}`);
    return;
  }

  if (command === 'summaries') {
    const data = await request('/api/summaries');
    if (wantJson()) return printJson(data);
    if (!data.summaries.length) {
      console.log('还没有分类总结');
      return;
    }
    for (const summary of data.summaries) {
      console.log(`\n## ${summary.category_name || summary.category_key}（${summary.entry_count} 条）`);
      console.log(summary.content_md);
    }
    return;
  }

  throw new Error(`未知命令：${command}\n\n${USAGE}`);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
});
