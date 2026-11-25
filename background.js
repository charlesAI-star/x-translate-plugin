/*
 * X 翻译 — MV3 service worker.
 *
 * Owns all network requests, caching and provider configuration. The content
 * script only sends tweet text and receives translations; API keys never leave
 * this context.
 */
importScripts('lib/shared.js', 'lib/core.js', 'lib/providers.js');

const { shared, core, providers } = {
  shared: self.XTR,
  core: self.XTRCore,
  providers: self.XTRProviders
};

const CACHE_KEY = 'xtrTranslationCache';
const CACHE_VERSION = 2;
const CACHE_LIMIT = 3000;
const SUPER_COPY_TIMEOUT_MS = 15000;
const SUPER_COPY_TEST_TIMEOUT_MS = 8000;
const MAX_CAPTURE_TEXT = 200000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_LINKS = 100;
const MAX_CAPTURE_MEDIA = 50;

let settingsCache = null;
let cache = new Map();
let cacheLoaded = false;
let persistTimer = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  let stored = null;
  try {
    stored = await chrome.storage.local.get('settings');
  } catch (_) {
    // Ignore; use defaults.
  }
  settingsCache = shared.mergeSettings(stored && stored.settings);
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'settings')) {
    settingsCache = null;
  }
});

function applyOverrides(base, overrides) {
  const raw = JSON.parse(JSON.stringify(base));
  if (overrides && typeof overrides === 'object') {
    for (const key of ['provider', 'targetLang', 'skipTargetLang', 'minChars']) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) raw[key] = overrides[key];
    }
    for (const key of ['llm', 'azure', 'mymemory']) {
      if (overrides[key] && typeof overrides[key] === 'object') {
        raw[key] = Object.assign({}, raw[key], overrides[key]);
      }
    }
  }
  return shared.mergeSettings(raw);
}

/* ------------------------------------------------------------------ cache */

function cacheKey(provider, targetLang, settings, text) {
  const extra = provider === 'llm'
    ? `${settings.llm.baseUrl}|${settings.llm.model}`
    : (provider === 'azure' ? 'azure' : '');
  return `${CACHE_VERSION}|${provider}|${targetLang}|${extra}|${core.hashText(text)}`;
}

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (chrome.storage.session) {
      const stored = await chrome.storage.session.get(CACHE_KEY);
      const obj = stored && stored[CACHE_KEY];
      if (obj && typeof obj === 'object') {
        cache = new Map(Object.entries(obj));
      }
    }
  } catch (_) {
    // Session storage is optional; keep the in-memory cache.
  }
}

function persistCacheSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!chrome.storage.session) return;
    const obj = Object.fromEntries(cache);
    chrome.storage.session.set({ [CACHE_KEY]: obj }).catch(() => {});
  }, 800);
}

function cacheGet(key) {
  const value = cache.get(key);
  if (!value) return null;
  // Refresh insertion order for a simple LRU.
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next();
    if (first.done) break;
    cache.delete(first.value);
  }
  persistCacheSoon();
}

async function clearCache() {
  cache.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    if (chrome.storage.session) await chrome.storage.session.remove(CACHE_KEY);
  } catch (_) {
    // Ignore.
  }
}

/* -------------------------------------------------------------- translation */

function normalizeForCompare(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cacheValueToResult(value) {
  if (!value) return null;
  if (value.skip) {
    return { ok: true, skip: true, reason: value.reason || 'skipped', sourceLang: value.sourceLang || '', cached: true };
  }
  if (typeof value.text === 'string') {
    return { ok: true, text: value.text, sourceLang: value.sourceLang || '', provider: value.provider || '', cached: true };
  }
  return null;
}

async function handleTranslate(msg) {
  const settings = await getSettings();
  const targetLang = shared.getLanguage(msg.targetLang) ? msg.targetLang : settings.targetLang;
  const provider = msg.provider;
  const allowed = new Set(['google', 'mymemory', 'llm', 'azure']);
  if (!allowed.has(provider)) {
    return { error: { code: 'bad_request', message: '不支持的后台翻译服务：' + provider } };
  }

  const rawTexts = Array.isArray(msg.texts) ? msg.texts.slice(0, 20) : [];
  const rawSourceLangs = Array.isArray(msg.sourceLangs) ? msg.sourceLangs : [];
  const rawIds = Array.isArray(msg.ids) ? msg.ids : [];
  if (!rawTexts.length) return { results: [] };

  const skipTargetLang = typeof msg.skipTargetLang === 'boolean' ? msg.skipTargetLang : settings.skipTargetLang;
  const minChars = Number.isFinite(msg.minChars) ? msg.minChars : settings.minChars;

  await loadCache();

  const items = rawTexts.map((raw, i) => {
    const text = core.cleanText(raw).slice(0, 30000);
    return {
      id: Object.prototype.hasOwnProperty.call(rawIds, i) ? rawIds[i] : i,
      text,
      sourceLang: shared.normalizeLangTag(rawSourceLangs[i]),
      key: cacheKey(provider, targetLang, settings, text)
    };
  });

  const results = new Array(items.length);
  const missing = new Map();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.text) {
      results[i] = { id: item.id, ok: true, skip: true, reason: 'empty' };
      continue;
    }
    const pre = core.shouldSkipTranslation({
      text: item.text,
      sourceLang: item.sourceLang,
      targetLang,
      skipTargetLang,
      minChars
    });
    if (pre.skip) {
      results[i] = { id: item.id, ok: true, skip: true, reason: pre.reason };
      continue;
    }
    const cached = cacheGet(item.key);
    if (cached) {
      const cachedResult = cacheValueToResult(cached);
      if (cachedResult) {
        results[i] = Object.assign({ id: item.id }, cachedResult);
        continue;
      }
    }
    const existing = missing.get(item.key);
    if (existing) {
      existing.indices.push(i);
    } else {
      missing.set(item.key, { text: item.text, indices: [i] });
    }
  }

  const unique = Array.from(missing.entries());
  if (unique.length) {
    let translated;
    try {
      translated = await providers.translateBatch({
        provider,
        texts: unique.map(([, entry]) => entry.text),
        targetLang,
        settings
      });
    } catch (err) {
      const error = providers.serializeError(err);
      for (const [, entry] of unique) {
        for (const i of entry.indices) {
          results[i] = { id: items[i].id, ok: false, error };
        }
      }
      translated = [];
    }

    for (let u = 0; u < unique.length; u++) {
      const [key, entry] = unique[u];
      const res = translated[u];
      if (!res || res.error) {
        const error = (res && res.error) || { code: 'error', message: '翻译服务没有返回结果' };
        for (const i of entry.indices) {
          results[i] = { id: items[i].id, ok: false, error };
        }
        continue;
      }

      const sourceLang = shared.normalizeLangTag(res.sourceLang);
      let finalResult;
      if (skipTargetLang && sourceLang && shared.sameLanguage(sourceLang, targetLang)) {
        finalResult = { ok: true, skip: true, reason: 'same-language', sourceLang };
        cacheSet(key, { skip: true, reason: 'same-language', sourceLang });
      } else if (normalizeForCompare(res.text) === normalizeForCompare(entry.text)) {
        finalResult = { ok: true, skip: true, reason: 'identical', sourceLang };
        cacheSet(key, { skip: true, reason: 'identical', sourceLang });
      } else {
        finalResult = { ok: true, text: res.text, sourceLang };
        cacheSet(key, { text: res.text, sourceLang });
      }

      for (const i of entry.indices) {
        results[i] = Object.assign({ id: items[i].id }, finalResult);
      }
    }
  }

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = { id: items[i].id, ok: false, error: { code: 'error', message: '内部错误：没有生成结果' } };
    }
  }

  return { results };
}

async function handleTest(msg) {
  const provider = msg.provider;
  const allowed = new Set(['google', 'mymemory', 'llm', 'azure']);
  if (!allowed.has(provider)) {
    return { ok: false, error: { code: 'bad_request', message: '请选择具体的翻译服务（Chrome 内置翻译由设置页直接测试）' } };
  }
  const base = await getSettings();
  const settings = applyOverrides(base, msg.overrides);
  const targetLang = shared.getLanguage(msg.targetLang) ? msg.targetLang : settings.targetLang;
  const text = String(msg.text || 'Hello world! This is a test.').slice(0, 2000);
  const started = Date.now();
  try {
    const translated = await providers.translateBatch({ provider, texts: [text], targetLang, settings });
    const res = translated[0];
    if (!res || res.error) {
      return { ok: false, error: (res && res.error) || { code: 'error', message: '没有返回结果' } };
    }
    return { ok: true, text: res.text, sourceLang: res.sourceLang || '', ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: providers.serializeError(err), ms: Date.now() - started };
  }
}

function detectLanguage(text) {
  return new Promise((resolve) => {
    try {
      if (!chrome.i18n || !chrome.i18n.detectLanguage) return resolve({ lang: '', percentage: 0 });
      chrome.i18n.detectLanguage(String(text || '').slice(0, 2000), (result) => {
        const langs = result && Array.isArray(result.languages) ? result.languages : [];
        if (!langs.length) return resolve({ lang: '', percentage: 0 });
        const top = langs[0];
        resolve({
          lang: shared.normalizeLangTag(top.language),
          percentage: Number(top.percentage) || 0
        });
      });
    } catch (_) {
      resolve({ lang: '', percentage: 0 });
    }
  });
}

async function hasOriginPermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

async function handleListModels(msg) {
  let baseUrl;
  try {
    baseUrl = core.normalizeBaseUrl(msg.baseUrl);
  } catch (err) {
    return { ok: false, error: { code: 'bad_request', message: err.message || 'API 地址无效' } };
  }
  const origin = core.originPattern(baseUrl);
  if (!origin || !(await hasOriginPermission(origin))) {
    return {
      ok: false,
      error: { code: 'permission', message: '需要先授权访问 ' + (origin || '这个地址') + '，请重新点「获取模型」并允许权限。' }
    };
  }
  try {
    const models = await providers.listModels(baseUrl, String(msg.apiKey || '').trim(), 15000);
    return { ok: true, baseUrl, models };
  } catch (err) {
    return { ok: false, error: providers.serializeError(err) };
  }
}

async function handleScanLocal() {
  const localhostGranted = await hasOriginPermission('http://localhost/*');
  const loopbackGranted = await hasOriginPermission('http://127.0.0.1/*');
  if (!localhostGranted && !loopbackGranted) {
    return {
      ok: false,
      error: { code: 'permission', message: '需要授权访问本机服务（127.0.0.1），请重新点「自动检测」并允许权限。' }
    };
  }
  const host = loopbackGranted ? '127.0.0.1' : 'localhost';
  try {
    const results = await providers.probeLocalServices(providers.LOCAL_CANDIDATES, 1600, host);
    return { ok: true, host, results };
  } catch (err) {
    return { ok: false, error: providers.serializeError(err) };
  }
}

/* ------------------------------------------------------------- super copy */

function superCopyError(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message }, extra || {}) };
}

function superCopyHttpCode(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_response';
}

function superCopyMessage(data, fallback) {
  if (data && data.error && typeof data.error.message === 'string') return data.error.message;
  if (data && typeof data.message === 'string') return data.message;
  return fallback;
}

function parseJsonBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * The content script builds the capture. The service worker only validates
 * its shape and size so a page bug cannot send an unbounded payload.
 */
function normalizeCapture(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'capture 必须是对象' };
  let capture;
  try {
    capture = JSON.parse(JSON.stringify(raw));
  } catch (_) {
    return { error: 'capture 不是可序列化的 JSON' };
  }
  if (capture.schema !== 'xtr.capture/1') return { error: '不支持的 capture.schema' };
  if (typeof capture.id !== 'string' || !capture.id.trim()) return { error: '缺少 capture.id' };
  if (!capture.source || typeof capture.source !== 'object') return { error: '缺少 capture.source' };
  if (capture.source.platform !== 'x') return { error: 'capture.source.platform 必须是 x' };
  if (capture.source.type !== 'tweet' && capture.source.type !== 'article') {
    return { error: 'capture.source.type 必须是 tweet 或 article' };
  }
  if (typeof capture.source.url !== 'string' || !/^https?:\/\//i.test(capture.source.url)) {
    return { error: '缺少有效的 capture.source.url' };
  }
  if (!capture.content || typeof capture.content !== 'object') return { error: '缺少 capture.content' };
  if (typeof capture.content.text !== 'string' || !capture.content.text.trim()) {
    return { error: 'capture.content.text 不能为空' };
  }
  if (!capture.capturedAt) capture.capturedAt = new Date().toISOString();
  if (!capture.client || typeof capture.client !== 'object') {
    capture.client = { name: 'x-translate-plugin', version: chrome.runtime.getManifest().version };
  }
  if (capture.content.text.length > MAX_CAPTURE_TEXT) {
    capture.content.text = capture.content.text.slice(0, MAX_CAPTURE_TEXT);
    capture.content.truncated = true;
  }
  if (capture.processingMode !== undefined
    && capture.processingMode !== null
    && capture.processingMode !== 'save'
    && capture.processingMode !== 'classify'
    && capture.processingMode !== 'full') {
    return { error: 'capture.processingMode 必须是 save、classify 或 full' };
  }
  if (Array.isArray(capture.links)) capture.links = capture.links.slice(0, MAX_CAPTURE_LINKS);
  if (Array.isArray(capture.media)) capture.media = capture.media.slice(0, MAX_CAPTURE_MEDIA);
  if (capture.quoted && capture.quoted.content && typeof capture.quoted.content.text === 'string'
    && capture.quoted.content.text.length > MAX_CAPTURE_TEXT) {
    capture.quoted.content.text = capture.quoted.content.text.slice(0, MAX_CAPTURE_TEXT);
    capture.quoted.content.truncated = true;
  }
  return { capture };
}

async function superCopyEndpointFromSettings() {
  const settings = await getSettings();
  const sc = settings.superCopy || {};
  if (!sc.enabled) return { error: superCopyError('disabled', '超级复制未启用') };
  let endpoint;
  try {
    endpoint = core.normalizeEndpoint(sc.endpoint);
  } catch (err) {
    return { error: superCopyError('bad_request', err.message || '接收地址无效') };
  }
  const origin = core.originPattern(endpoint);
  if (!origin || !(await hasOriginPermission(origin))) {
    return {
      error: superCopyError(
        'permission',
        '需要授权访问 ' + (origin || endpoint) + '，请在设置页保存并允许权限。'
      )
    };
  }
  return { endpoint, token: String(sc.token || '').trim() };
}

async function handleSuperCopy(msg) {
  const target = await superCopyEndpointFromSettings();
  if (target.error) return target.error;
  const checked = normalizeCapture(msg.capture);
  if (checked.error) return superCopyError('bad_request', checked.error);
  const capture = checked.capture;
  const body = JSON.stringify(capture);
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_CAPTURE_BYTES) {
    return superCopyError('too_large', '内容太大（' + Math.round(bytes / 1024) + ' KB），已超过 2 MB 限制。');
  }

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-XTR-Client': 'x-translate-plugin/' + chrome.runtime.getManifest().version,
    'Idempotency-Key': capture.id
  };
  if (target.token) headers.Authorization = 'Bearer ' + target.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPER_COPY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers,
      body,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await res.text();
    const data = parseJsonBody(text);
    if (!res.ok) {
      return superCopyError(
        superCopyHttpCode(res.status),
        superCopyMessage(data, 'Agent 返回 HTTP ' + res.status),
        { status: res.status }
      );
    }
    if (data && data.ok === false) {
      return superCopyError('bad_response', superCopyMessage(data, 'Agent 拒绝了这条内容'), { status: res.status });
    }
    return { ok: true, status: res.status, response: data, ms: Date.now() - started };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return superCopyError('timeout', 'Agent 响应超时，请检查服务是否正在处理但未及时返回。');
    }
    return superCopyError('network', '无法连接 Agent：' + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

async function handleTestSuperCopy(msg) {
  let endpoint;
  try {
    endpoint = core.normalizeEndpoint(msg.endpoint);
  } catch (err) {
    return superCopyError('bad_request', err.message || '接收地址无效');
  }
  const origin = core.originPattern(endpoint);
  if (!origin || !(await hasOriginPermission(origin))) {
    return superCopyError(
      'permission',
      '需要授权访问 ' + (origin || endpoint) + '，请重新点「测试连接」并允许权限。'
    );
  }
  const token = String(msg.token || '').trim();
  const headers = { 'X-XTR-Client': 'x-translate-plugin/' + chrome.runtime.getManifest().version };
  if (token) headers.Authorization = 'Bearer ' + token;

  const healthUrl = new URL('/health', endpoint).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPER_COPY_TEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await res.text();
    const data = parseJsonBody(text);
    if (!res.ok) {
      const suffix = res.status === 404 ? '（接收端没有 /health 接口）' : '';
      return superCopyError(
        superCopyHttpCode(res.status),
        superCopyMessage(data, '健康检查返回 HTTP ' + res.status + suffix),
        { status: res.status }
      );
    }
    if (data && data.ok === false) {
      return superCopyError('bad_response', superCopyMessage(data, '接收端报告未就绪'), { status: res.status });
    }
    return { ok: true, status: res.status, response: data, ms: Date.now() - started };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return superCopyError('timeout', '健康检查超时。');
    }
    return superCopyError('network', '无法连接接收端：' + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'xtr:translate') {
    handleTranslate(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: providers.serializeError(err) }));
    return true;
  }

  if (msg.type === 'xtr:test') {
    handleTest(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: providers.serializeError(err) }));
    return true;
  }

  if (msg.type === 'xtr:listModels') {
    handleListModels(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: providers.serializeError(err) }));
    return true;
  }

  if (msg.type === 'xtr:scanLocal') {
    handleScanLocal()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: providers.serializeError(err) }));
    return true;
  }

  if (msg.type === 'xtr:superCopy') {
    handleSuperCopy(msg)
      .then(sendResponse)
      .catch((err) => sendResponse(superCopyError('error', err && err.message ? err.message : String(err))));
    return true;
  }

  if (msg.type === 'xtr:testSuperCopy') {
    handleTestSuperCopy(msg)
      .then(sendResponse)
      .catch((err) => sendResponse(superCopyError('error', err && err.message ? err.message : String(err))));
    return true;
  }

  if (msg.type === 'xtr:clearCache') {
    clearCache()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'xtr:detect') {
    detectLanguage(msg.text).then(sendResponse);
    return true;
  }

  if (msg.type === 'xtr:openOptions') {
    try {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
    } catch (_) {
      sendResponse({ ok: false });
    }
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const stored = await chrome.storage.local.get('settings');
    if (!stored || !stored.settings) {
      await chrome.storage.local.set({ settings: shared.DEFAULT_SETTINGS });
    }
  } catch (_) {
    // Ignore storage errors.
  }
  if (details && details.reason === 'install') {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      // Ignore.
    }
  }
});
