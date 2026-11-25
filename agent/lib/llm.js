import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { AGENT_ROOT, loadConfig } from './config.js';
import { truncate } from './util.js';
import { validateJsonSchema } from './json-schema.js';

const TOOL_NAMES = [
  'Bash',
  'BashOutput',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
  'TodoWrite',
  'KillShell',
  'SlashCommand',
  'Skill'
];

export class LlmError extends Error {
  constructor(message, code = 'llm_error') {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

let mockHandler = null;
const mockCursors = new Map();
let cachedMock = null;
let llmStatusCache = null;

export function setMockHandler(fn) {
  mockHandler = fn;
}

function loadMockFixture() {
  if (cachedMock) return cachedMock;
  const file = process.env.KB_LLM_MOCK_FILE;
  if (!file) return null;
  cachedMock = JSON.parse(fs.readFileSync(file, 'utf8'));
  return cachedMock;
}

function mockResponse({ task, prompt, schema }) {
  if (mockHandler) return mockHandler({ task, prompt, schema });
  const fixture = loadMockFixture();
  if (!fixture) throw new LlmError('mock provider 未配置 KB_LLM_MOCK_FILE', 'mock_missing');
  const value = fixture[task];
  if (value === undefined) throw new LlmError(`mock 缺少任务 ${task}`, 'mock_missing');
  if (Array.isArray(value)) {
    const cursor = mockCursors.get(task) || 0;
    const item = value[Math.min(cursor, value.length - 1)];
    mockCursors.set(task, cursor + 1);
    return structuredClone(item);
  }
  return structuredClone(value);
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function killChild(child) {
  try {
    child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 5000).unref();
}

function runClaude({ prompt, schema, system, timeoutMs, maxTurns, signal }) {
  const config = loadConfig();
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--model',
    config.llm.model,
    '--max-turns',
    String(maxTurns || config.llm.maxTurns || 3),
    '--max-budget-usd',
    String(config.llm.maxBudgetUsd || 0.5),
    '--no-session-persistence',
    // 不依赖黑名单：显式清空工具集，并忽略本机 MCP 配置。
    '--tools',
    '',
    '--strict-mcp-config'
  ];
  if (config.llm.safeMode !== false) args.push('--safe-mode');
  if (system) args.push('--append-system-prompt', system);
  args.push('--disallowedTools', ...TOOL_NAMES);

  const childEnv = { ...process.env };
  delete childEnv.KB_TOKEN;

  if (signal?.aborted) {
    return Promise.reject(new LlmError('模型调用已取消', 'cancelled'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.llm.command || 'claude', args, {
      cwd: AGENT_ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    let onAbort = null;
    const limit = 20 * 1024 * 1024;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const cancel = () => {
      killChild(child);
      settle(reject, new LlmError('模型调用已取消', 'cancelled'));
    };

    if (signal) {
      onAbort = cancel;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      killChild(child);
      settle(reject, new LlmError('模型调用超时', 'timeout'));
    }, timeoutMs || config.llm.timeoutMs || 180000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > limit) {
        stdout = stdout.slice(0, limit);
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      settle(reject, new LlmError(`无法启动 Claude CLI：${err.message}`, 'cli_unavailable'));
    });
    child.on('close', (code) => {
      if (settled) return;
      const parsed = extractJson(stdout);
      if (!parsed) {
        const hint = truncate(stderr.replace(/\s+/g, ' ').trim(), 300);
        settle(reject, new LlmError(`Claude CLI 未返回 JSON（退出码 ${code}）${hint ? '：' + hint : ''}`, 'bad_output'));
        return;
      }
      if (parsed.is_error) {
        settle(reject, new LlmError(truncate(parsed.result || parsed.subtype || '模型返回错误', 300), 'api_error'));
        return;
      }
      let output = parsed.structured_output;
      if (output === undefined && typeof parsed.result === 'string') {
        output = extractJson(parsed.result);
      }
      if (output === undefined) {
        settle(reject, new LlmError('模型没有返回结构化结果', 'no_structured_output'));
        return;
      }
      settle(resolve, output);
    });
    child.stdin.end(prompt);
  });
}

export async function llmJson({ task, prompt, schema, system, timeoutMs, maxTurns, signal }) {
  if (signal?.aborted) throw new LlmError('模型调用已取消', 'cancelled');
  const config = loadConfig();
  let output;
  if (config.llm.provider === 'mock') {
    output = await mockResponse({ task, prompt, schema });
    if (signal?.aborted) throw new LlmError('模型调用已取消', 'cancelled');
  } else if (config.llm.provider === 'claude-cli') {
    output = await runClaude({ prompt, schema, system, timeoutMs, maxTurns, signal });
  } else {
    throw new LlmError(`不支持的 LLM provider：${config.llm.provider}`, 'bad_provider');
  }
  if (signal?.aborted) throw new LlmError('模型调用已取消', 'cancelled');
  const errors = validateJsonSchema(output, schema);
  if (errors.length) {
    throw new LlmError(`模型输出不符合结构：${errors.slice(0, 3).join('；')}`, 'invalid_output');
  }
  return output;
}

export function checkLlm({ force = false } = {}) {
  if (!force && llmStatusCache && Date.now() - llmStatusCache.at < 10000) {
    return llmStatusCache.value;
  }
  const config = loadConfig();
  let value;
  if (config.llm.provider === 'mock') {
    value = { ok: true, provider: 'mock', version: 'mock' };
  } else {
    const result = spawnSync(config.llm.command || 'claude', ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      env: process.env
    });
    if (result.error || result.status !== 0) {
      value = {
        ok: false,
        provider: config.llm.provider,
        message: result.error ? result.error.message : 'Claude CLI 不可用'
      };
    } else {
      value = { ok: true, provider: config.llm.provider, version: String(result.stdout || '').trim() };
    }
  }
  llmStatusCache = { at: Date.now(), value };
  return value;
}
