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
