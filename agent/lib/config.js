import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(AGENT_ROOT, 'public');

const BUILTIN_DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  token: '',
  serviceName: 'x-knowledge-agent',
  llm: {
    provider: 'claude-cli',
    command: 'claude',
    model: 'sonnet',
    timeoutMs: 180000,
    maxTurns: 3,
    maxBudgetUsd: 0.5,
    retries: 2
  },
  categories: [
    { key: 'ai', name: 'AI 与技术', description: 'AI 模型、Agent、开发工具、工程实践、开源项目' },
    { key: 'product', name: '产品与设计', description: '产品思维、用户体验、交互设计、增长、需求判断' },
    { key: 'business', name: '商业与投资', description: '商业模式、创业、投资、市场、经济与行业分析' },
    { key: 'writing', name: '写作与表达', description: '写作方法、内容创作、演讲、沟通与叙事' },
    { key: 'learning', name: '学习与思维', description: '学习方法、认知科学、思维模型、决策与问题解决' },
    { key: 'life', name: '生活与健康', description: '健康、习惯、生活方式、心理与个人成长' },
    { key: 'society', name: '社会与观点', description: '社会议题、文化、历史、政策与公共讨论' },
    { key: 'inbox', name: '待归类', description: '暂时无法确定分类的内容' }
  ],
  weekly: {
    enabled: true,
    dayOfWeek: 1,
    hour: 9,
    minute: 0,
    analyzeBatchSize: 20,
    analyzeTextChars: 3000,
    maxL2Actions: 8,
    maxCategoryChangesRatio: 0.3,
    minCategoryChanges: 15,
    maxSummariesPerRun: 20
  },
  processing: {
    defaultMode: 'full'
  }
};

let cached = null;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function envBool(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function configPath() {
  return process.env.KB_CONFIG ? path.resolve(process.env.KB_CONFIG) : path.join(AGENT_ROOT, 'config.json');
}

export function loadConfig() {
  if (cached) return cached;
  let fileConfig = {};
  const file = configPath();
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`无法解析配置文件 ${file}: ${err.message}`);
    }
  }

  let config = deepMerge(BUILTIN_DEFAULTS, fileConfig);

  const envLlm = {
    provider: process.env.KB_LLM_PROVIDER,
    command: process.env.KB_LLM_COMMAND,
    model: process.env.KB_LLM_MODEL
  };
  const envWeekly = { enabled: envBool('KB_WEEKLY_ENABLED') };

  config = deepMerge(config, {
    port: envNumber('KB_PORT') ?? config.port,
    host: process.env.KB_HOST ?? config.host,
    token: process.env.KB_TOKEN !== undefined ? process.env.KB_TOKEN : config.token,
    dataDir: process.env.KB_DATA_DIR ? path.resolve(process.env.KB_DATA_DIR) : config.dataDir,
    llm: Object.fromEntries(Object.entries(envLlm).filter(([, v]) => v !== undefined)),
    weekly: Object.fromEntries(Object.entries(envWeekly).filter(([, v]) => v !== undefined))
  });

  config.port = Number(config.port);
  config.weekly.dayOfWeek = Math.min(7, Math.max(1, Number(config.weekly.dayOfWeek) || 1));
  config.weekly.hour = Math.min(23, Math.max(0, Number(config.weekly.hour) || 0));
  config.weekly.minute = Math.min(59, Math.max(0, Number(config.weekly.minute) || 0));
  config.weekly.analyzeBatchSize = Math.min(50, Math.max(1, Number(config.weekly.analyzeBatchSize) || 20));
  config.weekly.analyzeTextChars = Math.min(20000, Math.max(500, Number(config.weekly.analyzeTextChars) || 3000));
  config.weekly.maxL2Actions = Math.min(50, Math.max(0, Number(config.weekly.maxL2Actions) || 0));
  config.weekly.maxCategoryChangesRatio = Math.min(1, Math.max(0, Number(config.weekly.maxCategoryChangesRatio) || 0.3));
  config.weekly.minCategoryChanges = Math.min(500, Math.max(0, Number(config.weekly.minCategoryChanges) || 0));
  config.weekly.maxSummariesPerRun = Math.min(100, Math.max(1, Number(config.weekly.maxSummariesPerRun) || 20));
  if (!['save', 'classify', 'full'].includes(config.processing.defaultMode)) {
    config.processing.defaultMode = 'full';
  }

  cached = config;
  ensureDirs(config);
  return config;
}

export function resetConfigCache() {
  cached = null;
}

export function dataDir(config = loadConfig()) {
  return config.dataDir ? path.resolve(config.dataDir) : path.join(AGENT_ROOT, 'data');
}

export function capturesDir(config = loadConfig()) {
  return path.join(dataDir(config), 'captures');
}

export function libraryDir(config = loadConfig()) {
  return path.join(dataDir(config), 'library');
}

export function reportsDir(config = loadConfig()) {
  return path.join(dataDir(config), 'reports');
}

export function ensureDirs(config = loadConfig()) {
  for (const dir of [dataDir(config), capturesDir(config), libraryDir(config), reportsDir(config)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
