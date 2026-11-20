/*
 * X 翻译 — translation provider clients.
 *
 * Runs in the MV3 service worker. All network access happens here so the
 * content script never needs cross-origin permissions and API keys never
 * enter the page's world.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'), require('./core.js'));
  } else {
    root.XTRProviders = factory(root.XTR, root.XTRCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, core) {
  'use strict';

  class ProviderError extends Error {
    constructor(message, code = 'error', retryable = false, retryAfterMs = 0) {
      super(message);
      this.name = 'ProviderError';
      this.code = code;
      this.retryable = !!retryable;
      this.retryAfterMs = Number(retryAfterMs) || 0;
    }
  }

  function serializeError(err) {
    if (!err) return { code: 'error', message: '未知错误' };
    return {
      code: err.code || 'error',
      message: err.message || String(err)
    };
  }

  function parseRetryAfter(res) {
    const raw = res.headers.get('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  async function httpError(res, providerName) {
    let detail = '';
    try {
      const body = await res.text();
      if (body) {
        try {
          const json = JSON.parse(body);
          detail = json.error?.message || json.message || json.error_description || '';
        } catch (_) {
          detail = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (_) {
      // Ignore body read errors.
    }
    detail = core.truncate(detail, 240);
    if (res.status === 401 || res.status === 403) {
      return new ProviderError(`${providerName} 鉴权失败${detail ? '：' + detail : '，请检查 API Key'}`, 'auth', false);
    }
    if (res.status === 429) {
      return new ProviderError(`${providerName} 请求过于频繁，请稍后重试`, 'rate_limit', true, parseRetryAfter(res));
    }
    if (res.status >= 500) {
      return new ProviderError(`${providerName} 服务暂时不可用（HTTP ${res.status}）`, 'server', true, parseRetryAfter(res));
    }
    if (res.status === 400 || res.status === 404) {
      return new ProviderError(`${providerName} 请求被拒绝${detail ? '：' + detail : `（HTTP ${res.status}）`}`, 'bad_request', false);
    }
    return new ProviderError(`${providerName} 请求失败${detail ? '：' + detail : `（HTTP ${res.status}）`}`, 'http', res.status >= 500);
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderError('翻译请求超时，请检查网络或代理', 'timeout', true);
      }
      throw new ProviderError('网络请求失败：' + (err && err.message ? err.message : String(err)), 'network', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function retry(fn, { attempts = 3, baseDelay = 600, maxDelay = 8000 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ProviderError ? err.retryable : true;
        if (!retryable || attempt >= attempts) break;
        const backoff = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1)) + Math.random() * 250;
        const wait = Math.max(backoff, err.retryAfterMs || 0);
        if (wait > 0) await core.sleep(wait);
      }
    }
    throw lastError;
  }

  /**
   * Limits concurrent requests and spaces them out. Free endpoints dislike
   * bursts, so every provider gets its own limiter.
   */
  class Limiter {
    constructor(concurrency, minGapMs = 0) {
      this.concurrency = Math.max(1, concurrency);
      this.minGapMs = Math.max(0, minGapMs);
      this.active = 0;
      this.queue = [];
      this.nextAt = 0;
    }

    run(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.drain();
      });
    }

    drain() {
      while (this.active < this.concurrency && this.queue.length) {
        const item = this.queue.shift();
        this.active++;
        const now = Date.now();
        const wait = Math.max(0, this.nextAt - now);
        this.nextAt = Math.max(now, this.nextAt) + this.minGapMs;
        (async () => {
          if (wait) await core.sleep(wait);
          try {
            item.resolve(await item.fn());
          } catch (err) {
            item.reject(err);
          } finally {
            this.active--;
            this.drain();
          }
        })();
      }
    }
  }

  const limiters = {
    google: new Limiter(2, 120),
    mymemory: new Limiter(1, 300),
    azure: new Limiter(2, 40),
    // A profile page can produce two LLM groups at once. Running them
    // concurrently cuts the tail latency roughly in half; the retry/limiter
    // still protects providers from a large burst.
    llm: new Limiter(2, 0)
  };

  function utf8Length(text) {
    try {
      return new TextEncoder().encode(text).length;
    } catch (_) {
      return text.length * 3;
    }
  }

  function splitByBytes(text, maxBytes) {
    if (utf8Length(text) <= maxBytes) return [text];
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of text) {
      const n = utf8Length(ch);
      if (current && bytes + n > maxBytes) {
        out.push(current);
        current = '';
        bytes = 0;
      }
      current += ch;
      bytes += n;
    }
    if (current) out.push(current);
    return out;
  }

  /** Split a long text into provider-safe chunks. */
  function textChunks(text, maxChars, maxBytes = 0) {
    const chunks = core.chunkText(text, maxChars);
    if (!maxBytes) return chunks;
    const out = [];
    for (const chunk of chunks) out.push(...splitByBytes(chunk, maxBytes));
    return out;
  }

  async function translateGoogleText(text, targetCode) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex'
      + '&sl=auto&tl=' + encodeURIComponent(targetCode) + '&dt=t&dj=1';
    const chunks = textChunks(text, 4000);
    const parts = [];
    let sourceLang = '';
    for (const chunk of chunks) {
      const parsed = await limiters.google.run(() => retry(async () => {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ q: chunk })
        }, 25000);
        if (!res.ok) throw await httpError(res, 'Google 翻译');
        const ct = res.headers.get('content-type') || '';
        if (!/json/i.test(ct)) {
          throw new ProviderError('Google 返回了非 JSON 内容，可能被限流', 'rate_limit', true);
        }
        let json;
        try {
          json = await res.json();
        } catch (_) {
          throw new ProviderError('Google 返回内容无法解析，可能被限流', 'rate_limit', true);
        }
        return core.parseGoogleResponse(json);
      }, { attempts: 3, baseDelay: 800 }));
      parts.push(parsed.text);
      if (!sourceLang) sourceLang = parsed.sourceLang;
    }
    return { text: parts.join(chunks.length > 1 ? '\n' : ''), sourceLang };
  }

  async function translateMyMemoryText(text, targetCode, email) {
    const chunks = textChunks(text, 400, 480);
    const parts = [];
    let sourceLang = '';
    for (const chunk of chunks) {
      const u = new URL('https://api.mymemory.translated.net/get');
      u.searchParams.set('q', chunk);
      u.searchParams.set('langpair', 'autodetect|' + targetCode);
      if (email) u.searchParams.set('de', email);
      const parsed = await limiters.mymemory.run(() => retry(async () => {
        const res = await fetchWithTimeout(u.toString(), { method: 'GET' }, 20000);
        if (!res.ok) throw await httpError(res, 'MyMemory');
        let json;
        try {
          json = await res.json();
        } catch (_) {
          throw new ProviderError('MyMemory 返回内容无法解析', 'bad_response', true);
        }
        return core.parseMyMemoryResponse(json);
      }, { attempts: 2, baseDelay: 900 }));
      parts.push(parsed.text);
      if (!sourceLang) sourceLang = parsed.sourceLang;
    }
    return { text: parts.join(chunks.length > 1 ? '\n' : ''), sourceLang };
  }

  function groupByBudget(items, maxItems, maxChars) {
    const groups = [];
    let current = [];
    let chars = 0;
    for (const item of items) {
      const len = item.text.length;
      if (current.length && (current.length >= maxItems || chars + len > maxChars)) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += len;
    }
    if (current.length) groups.push(current);
    return groups;
  }

  // Keep groups small enough that the model reliably returns a complete JSON
  // array (very large batches tend to get truncated), but large enough to
  // amortize the per-request latency.
  const LLM_GROUP_MAX = 8;
  const LLM_GROUP_CHARS = 6000;
  const LLM_GROUP_CONCURRENCY = 2;

  async function translateLLM(texts, targetLang, settings) {
    const llm = settings.llm || {};
    const baseUrl = core.normalizeBaseUrl(llm.baseUrl);
    const endpoint = baseUrl + '/chat/completions';
    const apiKey = (llm.apiKey || '').trim();
    const model = (llm.model || '').trim();
    if (!model) throw new ProviderError('请先在设置中填写模型名称', 'auth', false);
    if (!apiKey && !core.isLocalhostUrl(baseUrl)) {
      throw new ProviderError('请先在设置中填写大模型 API Key', 'auth', false);
    }

    // Split oversized texts so the response fits comfortably in output limits.
    const subItems = [];
    const chunkCounts = new Map();
    texts.forEach((text, originalIndex) => {
      const chunks = textChunks(text, 2500);
      chunkCounts.set(originalIndex, chunks.length);
      chunks.forEach((chunk, chunkIndex) => subItems.push({ originalIndex, chunkIndex, text: chunk, count: chunks.length }));
    });

    const groups = groupByBudget(subItems, LLM_GROUP_MAX, LLM_GROUP_CHARS);
    // A long tweet can be split across two groups. Store each chunk by its
    // original position instead of completion order so concurrent requests
    // cannot scramble the joined translation.
    const translatedByOriginal = new Map();

    await core.mapLimit(groups, LLM_GROUP_CONCURRENCY, async (group) => {
      const groupTexts = group.map((item) => item.text);
      const messages = core.buildLLMMessages(groupTexts, targetLang);
      const body = {
        model,
        messages,
        temperature: typeof llm.temperature === 'number' ? llm.temperature : 0.2,
        stream: false
      };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

      const translated = await limiters.llm.run(() => retry(async () => {
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        }, 90000);
        if (!res.ok) throw await httpError(res, '大模型');
        let json;
        try {
          json = await res.json();
        } catch (_) {
          throw new ProviderError('大模型返回内容不是 JSON', 'bad_response', true);
        }
        const content = json && json.choices && json.choices[0] && json.choices[0].message
          ? json.choices[0].message.content
          : '';
        if (typeof content !== 'string' || !content.trim()) {
          throw new ProviderError('大模型返回了空内容', 'bad_response', true);
        }
        return core.parseLLMResponse(content, group.length);
      }, { attempts: 2, baseDelay: 1200 }));

      translated.forEach((text, i) => {
        const item = group[i];
        let parts = translatedByOriginal.get(item.originalIndex);
        if (!parts) {
          parts = new Array(chunkCounts.get(item.originalIndex) || item.count);
          translatedByOriginal.set(item.originalIndex, parts);
        }
        parts[item.chunkIndex] = text;
      });
    });

    return texts.map((_, i) => {
      const parts = translatedByOriginal.get(i) || [];
      const expected = chunkCounts.get(i) || 1;
      const complete = parts.length >= expected
        && Array.from({ length: expected }, (_, idx) => parts[idx])
          .every((part) => typeof part === 'string' && part);
      if (!complete) {
        throw new ProviderError('大模型没有返回这条推文的完整译文', 'bad_response', false);
      }
      return { text: parts.slice(0, expected).join('\n'), sourceLang: '' };
    });
  }

  function azureGroupByBudget(texts, maxItems, maxChars) {
    return groupByBudget(texts.map((text) => ({ text })), maxItems, maxChars).map((group) => group.map((x) => x.text));
  }

  async function translateAzure(texts, targetLang, settings) {
    const azure = settings.azure || {};
    const key = (azure.key || '').trim();
    if (!key) throw new ProviderError('请先在设置中填写 Microsoft Translator 的 Key', 'auth', false);
    const region = (azure.region || '').trim();
    const target = shared.targetCodeFor('azure', targetLang);
    const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + encodeURIComponent(target);

    const groups = azureGroupByBudget(texts, 25, 30000);
    const results = [];
    for (const group of groups) {
      const headers = {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': key
      };
      if (region) headers['Ocp-Apim-Subscription-Region'] = region;
      const parsed = await limiters.azure.run(() => retry(async () => {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(group.map((text) => ({ Text: text })))
        }, 40000);
        if (!res.ok) throw await httpError(res, 'Microsoft Translator');
        let json;
        try {
          json = await res.json();
        } catch (_) {
          throw new ProviderError('Microsoft Translator 返回内容不是 JSON', 'bad_response', true);
        }
        return core.parseAzureResponse(json, group.length);
      }, { attempts: 3, baseDelay: 700 }));
      results.push(...parsed);
    }
    return results;
  }

  /**
   * Parse the model lists returned by OpenAI-compatible services and Ollama.
   * OpenAI: { data: [{ id }] }, Ollama: { models: [{ name }] }, or a bare array.
   */
  function parseModelsResponse(json) {
    const out = [];
    const seen = new Set();
    const add = (item) => {
      let id = '';
      if (typeof item === 'string') id = item;
      else if (item && typeof item === 'object') id = item.id || item.name || item.model || '';
      id = String(id || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    if (Array.isArray(json)) {
      json.forEach(add);
    } else if (json && typeof json === 'object') {
      if (Array.isArray(json.data)) json.data.forEach(add);
      if (Array.isArray(json.models)) json.models.forEach(add);
      if (json.data && Array.isArray(json.data.models)) json.data.models.forEach(add);
      if (Array.isArray(json.result)) json.result.forEach(add);
    }
    return out;
  }

  async function fetchModelList(url, apiKey, timeoutMs, providerName) {
    const headers = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs);
    if (!res.ok) throw await httpError(res, providerName);
    let json;
    try {
      json = await res.json();
    } catch (_) {
      throw new ProviderError(providerName + ' 返回的模型列表不是 JSON', 'bad_response', false);
    }
    return parseModelsResponse(json);
  }

  /** List model IDs exposed by an OpenAI-compatible /v1/models endpoint. */
  async function listModels(baseUrl, apiKey = '', timeoutMs = 12000) {
    const base = core.normalizeBaseUrl(baseUrl);
    const models = await fetchModelList(base + '/models', apiKey, timeoutMs, '大模型服务');
    if (!models.length) throw new ProviderError('服务已连接，但没有返回模型列表', 'bad_response', false);
    return models;
  }

  async function listOllamaModels(host, timeoutMs = 12000) {
    const base = String(host || '').replace(/\/+$/, '');
    const models = await fetchModelList(base + '/api/tags', '', timeoutMs, 'Ollama');
    if (!models.length) throw new ProviderError('Ollama 已连接，但没有已下载的模型', 'bad_response', false);
    return models;
  }

  /**
   * Common local OpenAI-compatible services. Magpie's default gateway is
   * 127.0.0.1:3425 and accepts the public "magpie" key.
   */
  const LOCAL_CANDIDATES = [
    { port: 3425, name: 'Magpie', preset: 'magpie', apiKey: 'magpie' },
    { port: 11434, name: 'Ollama', preset: 'ollama' },
    { port: 1234, name: 'LM Studio', preset: 'lmstudio' },
    { port: 4000, name: 'LiteLLM（可能）', preset: 'localrouter' },
    { port: 3000, name: 'One API / New API（可能）', preset: 'localrouter' },
    { port: 8080, name: '本地 OpenAI 兼容服务', preset: 'localrouter' },
    { port: 8000, name: 'vLLM（可能）', preset: 'localrouter' },
    { port: 5000, name: 'text-generation-webui（可能）', preset: 'localrouter' },
    { port: 5001, name: 'KoboldCpp（可能）', preset: 'localrouter' }
  ];

  /**
   * Probe localhost ports in parallel. Only local services are contacted.
   * A 401/403 still counts as "found" so the user can enter a key.
   */
  async function probeLocalServices(candidates = LOCAL_CANDIDATES, timeoutMs = 1600, host = '127.0.0.1') {
    const list = Array.isArray(candidates) && candidates.length ? candidates : LOCAL_CANDIDATES;
    const results = await core.mapLimit(list, 4, async (candidate) => {
      const baseUrl = 'http://' + host + ':' + candidate.port + '/v1';
      try {
        const models = await listModels(baseUrl, candidate.apiKey || '', timeoutMs);
        return Object.assign({}, candidate, { baseUrl, models, authRequired: false });
      } catch (err) {
        if (err && err.code === 'auth') {
          return Object.assign({}, candidate, { baseUrl, models: [], authRequired: true });
        }
        // Older Ollama versions only expose the native /api/tags endpoint.
        if (candidate.port === 11434) {
          try {
            const models = await listOllamaModels('http://' + host + ':11434', timeoutMs);
            return Object.assign({}, candidate, { baseUrl, models, authRequired: false });
          } catch (_) {
            // Ignore and report nothing for this port.
          }
        }
        return null;
      }
    });
    return results.filter(Boolean);
  }

  /**
   * Translate a batch, preserving order. Supported providers: google,
   * mymemory, llm, azure.
   *
   * Individual failures on per-text providers are returned as `{error}` so a
   * single rate-limited tweet does not discard the rest of the batch.
   */
  async function translateBatch({ provider, texts, targetLang, settings }) {
    if (!Array.isArray(texts) || !texts.length) return [];
    if (provider === 'google') {
      const target = shared.targetCodeFor('google', targetLang);
      return core.mapLimit(texts, 3, async (text) => {
        try {
          return await translateGoogleText(text, target);
        } catch (err) {
          return { error: serializeError(err) };
        }
      });
    }
    if (provider === 'mymemory') {
      const target = shared.targetCodeFor('mymemory', targetLang);
      const email = (settings.mymemory && settings.mymemory.email) || '';
      return core.mapLimit(texts, 1, async (text) => {
        try {
          return await translateMyMemoryText(text, target, email);
        } catch (err) {
          return { error: serializeError(err) };
        }
      });
    }
    if (provider === 'llm') {
      try {
        return await translateLLM(texts, targetLang, settings);
      } catch (err) {
        const error = serializeError(err);
        return texts.map(() => ({ error }));
      }
    }
    if (provider === 'azure') {
      try {
        return await translateAzure(texts, targetLang, settings);
      } catch (err) {
        const error = serializeError(err);
        return texts.map(() => ({ error }));
      }
    }
    throw new ProviderError('未知的翻译服务：' + provider, 'bad_request', false);
  }

  return {
    ProviderError,
    serializeError,
    fetchWithTimeout,
    retry,
    Limiter,
    translateBatch,
    translateGoogleText,
    translateMyMemoryText,
    translateLLM,
    translateAzure,
    listModels,
    parseModelsResponse,
    probeLocalServices,
    LOCAL_CANDIDATES
  };
});
