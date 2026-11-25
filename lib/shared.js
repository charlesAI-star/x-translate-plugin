/*
 * X 翻译 — shared constants and settings helpers.
 *
 * This file is loaded as a classic script in the service worker, content
 * scripts, popup and options page, and is also require()-able from Node for
 * tests. Keep it dependency-free.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XTR = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Languages offered in the UI. `code` is our stable app-level code. */
  const LANGUAGES = [
    { code: 'zh-CN', label: '简体中文', prompt: '简体中文', google: 'zh-CN', mymemory: 'zh-CN', azure: 'zh-Hans', chrome: 'zh' },
    { code: 'zh-TW', label: '繁體中文', prompt: '繁體中文', google: 'zh-TW', mymemory: 'zh-TW', azure: 'zh-Hant', chrome: 'zh-Hant' },
    { code: 'en', label: 'English', prompt: 'English', google: 'en', mymemory: 'en', azure: 'en', chrome: 'en' },
    { code: 'ja', label: '日本語', prompt: '日本語', google: 'ja', mymemory: 'ja', azure: 'ja', chrome: 'ja' },
    { code: 'ko', label: '한국어', prompt: '한국어', google: 'ko', mymemory: 'ko', azure: 'ko', chrome: 'ko' },
    { code: 'fr', label: 'Français', prompt: 'français', google: 'fr', mymemory: 'fr', azure: 'fr', chrome: 'fr' },
    { code: 'de', label: 'Deutsch', prompt: 'Deutsch', google: 'de', mymemory: 'de', azure: 'de', chrome: 'de' },
    { code: 'es', label: 'Español', prompt: 'español', google: 'es', mymemory: 'es', azure: 'es', chrome: 'es' },
    { code: 'ru', label: 'Русский', prompt: 'русский', google: 'ru', mymemory: 'ru', azure: 'ru', chrome: 'ru' },
    { code: 'pt', label: 'Português', prompt: 'português', google: 'pt', mymemory: 'pt', azure: 'pt', chrome: 'pt' },
    { code: 'it', label: 'Italiano', prompt: 'italiano', google: 'it', mymemory: 'it', azure: 'it', chrome: 'it' },
    { code: 'ar', label: 'العربية', prompt: 'العربية', google: 'ar', mymemory: 'ar', azure: 'ar', chrome: 'ar' },
    { code: 'hi', label: 'हिन्दी', prompt: 'हिन्दी', google: 'hi', mymemory: 'hi', azure: 'hi', chrome: 'hi' },
    { code: 'th', label: 'ไทย', prompt: 'ภาษาไทย', google: 'th', mymemory: 'th', azure: 'th', chrome: 'th' },
    { code: 'vi', label: 'Tiếng Việt', prompt: 'tiếng Việt', google: 'vi', mymemory: 'vi', azure: 'vi', chrome: 'vi' },
    { code: 'id', label: 'Bahasa Indonesia', prompt: 'Bahasa Indonesia', google: 'id', mymemory: 'id', azure: 'id', chrome: 'id' },
    { code: 'tr', label: 'Türkçe', prompt: 'Türkçe', google: 'tr', mymemory: 'tr', azure: 'tr', chrome: 'tr' },
    { code: 'nl', label: 'Nederlands', prompt: 'Nederlands', google: 'nl', mymemory: 'nl', azure: 'nl', chrome: 'nl' },
    { code: 'pl', label: 'Polski', prompt: 'polski', google: 'pl', mymemory: 'pl', azure: 'pl', chrome: 'pl' },
    { code: 'uk', label: 'Українська', prompt: 'українська', google: 'uk', mymemory: 'uk', azure: 'uk', chrome: 'uk' },
    { code: 'fa', label: 'فارسی', prompt: 'فارسی', google: 'fa', mymemory: 'fa', azure: 'fa', chrome: 'fa' },
    { code: 'he', label: 'עברית', prompt: 'עברית', google: 'iw', mymemory: 'he', azure: 'he', chrome: 'he' }
  ];

  const LANGUAGE_MAP = Object.create(null);
  for (const lang of LANGUAGES) LANGUAGE_MAP[lang.code] = lang;

  /** Provider ids, labels and short labels used in the per-tweet caption. */
  const PROVIDERS = [
    { id: 'auto', label: '自动（本地优先）', short: '自动', desc: '优先使用 Chrome 内置翻译；不支持的语言对自动改用 Google。' },
    { id: 'chrome', label: 'Chrome 内置翻译', short: '本地', desc: '免费、在本机运行，首次使用某个语言对时会下载模型。' },
    { id: 'google', label: 'Google 翻译（免费接口）', short: 'Google', desc: '无需 API Key，速度和质量取决于网络；可能被限流。' },
    { id: 'llm', label: '大模型（OpenAI 兼容）', short: 'AI', desc: '质量最好，支持云端 API 和本地路由（Magpie / Ollama / LM Studio 等）。' },
    { id: 'azure', label: 'Microsoft Translator', short: 'Microsoft', desc: 'Azure 翻译服务，每月有免费额度；需要 Key 和区域。' },
    { id: 'mymemory', label: 'MyMemory（免费）', short: 'MyMemory', desc: '无需 Key 的备用接口，每天额度较小，质量一般。' }
  ];
  const PROVIDER_MAP = Object.create(null);
  for (const p of PROVIDERS) PROVIDER_MAP[p.id] = p;

  /** Presets for OpenAI-compatible chat completion APIs. */
  const LLM_PRESETS = {
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
    siliconflow: { label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', needsKey: true },
    moonshot: { label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needsKey: true },
    zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needsKey: true },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', needsKey: true },
    ollama: { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', needsKey: false },
    lmstudio: { label: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', model: 'local-model', needsKey: false },
    magpie: { label: 'Magpie（本地路由）', baseUrl: 'http://127.0.0.1:3425/v1', model: '', apiKey: 'magpie', needsKey: false },
    localrouter: { label: '本地路由（自动检测）', baseUrl: '', model: '', needsKey: false },
    custom: { label: '自定义 / 其他兼容接口', baseUrl: '', model: '', needsKey: false }
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoTranslate: true,
    targetLang: 'zh-CN',
    provider: 'auto',
    skipTargetLang: true,
    translateQuotes: true,
    translateBios: false,
    prefetchProfile: true,
    showProviderLabel: true,
    minChars: 2,
    debug: false,
    llm: {
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.2
    },
    azure: {
      key: '',
      region: 'eastasia'
    },
    mymemory: {
      email: ''
    },
    superCopy: {
      enabled: false,
      endpoint: '',
      token: '',
      includeQuoted: true,
      includeMedia: true
    }
  };

  const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
  const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

  function getLanguage(code) {
    return LANGUAGE_MAP[code] || null;
  }

  function languageLabel(code) {
    const lang = getLanguage(code);
    return lang ? lang.label : code;
  }

  function providerInfo(id) {
    return PROVIDER_MAP[id] || PROVIDER_MAP.auto;
  }

  function providerLabel(id) {
    return providerInfo(id).short;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeString(value, fallback) {
    return typeof value === 'string' ? value.trim() : fallback;
  }

  /**
   * Merge persisted settings over defaults, while tolerating values written
   * by older versions or edited by hand in chrome.storage.
   */
  function mergeSettings(raw) {
    const out = clone(DEFAULT_SETTINGS);
    if (!isPlainObject(raw)) return out;

    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.autoTranslate === 'boolean') out.autoTranslate = raw.autoTranslate;
    if (typeof raw.skipTargetLang === 'boolean') out.skipTargetLang = raw.skipTargetLang;
    if (typeof raw.translateQuotes === 'boolean') out.translateQuotes = raw.translateQuotes;
    if (typeof raw.translateBios === 'boolean') out.translateBios = raw.translateBios;
    if (typeof raw.prefetchProfile === 'boolean') out.prefetchProfile = raw.prefetchProfile;
    if (typeof raw.showProviderLabel === 'boolean') out.showProviderLabel = raw.showProviderLabel;
    if (typeof raw.debug === 'boolean') out.debug = raw.debug;
    if (LANGUAGE_CODES.has(raw.targetLang)) out.targetLang = raw.targetLang;
    if (PROVIDER_IDS.has(raw.provider)) out.provider = raw.provider;
    if (typeof raw.minChars === 'number' && Number.isFinite(raw.minChars)) out.minChars = Math.round(clamp(raw.minChars, 1, 50));

    if (isPlainObject(raw.llm)) {
      const p = raw.llm.preset;
      if (typeof p === 'string' && LLM_PRESETS[p]) out.llm.preset = p;
      out.llm.baseUrl = normalizeString(raw.llm.baseUrl, out.llm.baseUrl);
      out.llm.apiKey = normalizeString(raw.llm.apiKey, '');
      out.llm.model = normalizeString(raw.llm.model, out.llm.model);
      if (typeof raw.llm.temperature === 'number' && Number.isFinite(raw.llm.temperature)) {
        out.llm.temperature = clamp(raw.llm.temperature, 0, 1);
      }
    }
    if (isPlainObject(raw.azure)) {
      out.azure.key = normalizeString(raw.azure.key, '');
      out.azure.region = normalizeString(raw.azure.region, out.azure.region) || 'eastasia';
    }
    if (isPlainObject(raw.mymemory)) {
      out.mymemory.email = normalizeString(raw.mymemory.email, '');
    }
    if (isPlainObject(raw.superCopy)) {
      if (typeof raw.superCopy.enabled === 'boolean') out.superCopy.enabled = raw.superCopy.enabled;
      out.superCopy.endpoint = normalizeString(raw.superCopy.endpoint, '');
      out.superCopy.token = normalizeString(raw.superCopy.token, '');
      if (typeof raw.superCopy.includeQuoted === 'boolean') out.superCopy.includeQuoted = raw.superCopy.includeQuoted;
      if (typeof raw.superCopy.includeMedia === 'boolean') out.superCopy.includeMedia = raw.superCopy.includeMedia;
    }
    return out;
  }

  /**
   * Normalize a BCP-47-ish language tag to a small, stable code.
   * Chinese is collapsed to `zh` / `zh-Hant`; everything else to its base.
   */
  function normalizeLangTag(tag) {
    if (!tag) return '';
    let t = String(tag).trim().toLowerCase().replace(/_/g, '-');
    if (!t) return '';
    if (t === 'und' || t === 'zxx' || t === 'mul' || t === 'qme' || t === 'art') return '';
    if (t === 'zh' || t.startsWith('zh-')) {
      return /(hant|tw|hk|mo)/.test(t) ? 'zh-Hant' : 'zh';
    }
    // Legacy ISO 639-1 aliases still found in older pages.
    if (t === 'iw') return 'he';
    if (t === 'in') return 'id';
    if (t === 'ji') return 'yi';
    return t.split('-')[0];
  }

  function baseLang(tag) {
    const n = normalizeLangTag(tag);
    if (!n) return '';
    return n.startsWith('zh') ? 'zh' : n.split('-')[0];
  }

  function sameLanguage(a, b) {
    const ba = baseLang(a);
    const bb = baseLang(b);
    return !!ba && ba === bb;
  }

  function isChinese(tag) {
    return baseLang(tag) === 'zh';
  }

  function targetCodeFor(provider, appCode) {
    const lang = getLanguage(appCode);
    if (!lang) return appCode;
    switch (provider) {
      case 'google':
        return lang.google;
      case 'mymemory':
        return lang.mymemory;
      case 'azure':
        return lang.azure;
      case 'chrome':
        return lang.chrome;
      case 'llm':
        return lang.prompt;
      default:
        return lang.google;
    }
  }

  /** LanguageDetector / Translator source codes used by Chrome's built-in API. */
  function chromeLangCode(tag) {
    const n = normalizeLangTag(tag);
    if (!n) return '';
    if (n === 'zh') return 'zh';
    if (n === 'zh-Hant') return 'zh-Hant';
    return n;
  }

  return {
    LANGUAGES,
    LANGUAGE_MAP,
    PROVIDERS,
    PROVIDER_MAP,
    LLM_PRESETS,
    DEFAULT_SETTINGS,
    getLanguage,
    languageLabel,
    providerInfo,
    providerLabel,
    mergeSettings,
    normalizeLangTag,
    baseLang,
    sameLanguage,
    isChinese,
    targetCodeFor,
    chromeLangCode,
    clone,
    clamp
  };
});
