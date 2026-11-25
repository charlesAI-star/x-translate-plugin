/*
 * X 翻译 — pure helpers shared by the content script, service worker and
 * tests: language heuristics, chunking and provider response parsing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
  } else {
    root.XTRCore = factory(root.XTR);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  'use strict';

  const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
  const MENTION_RE = /(^|\s)@[a-z0-9_]{1,30}\b/giu;
  const CASHTAG_RE = /(^|\s)\$[a-z0-9.]{1,20}\b/giu;
  const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
  const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

  function cleanText(text) {
    return String(text == null ? '' : text).replace(ZERO_WIDTH_RE, '').trim();
  }

  /** Remove links, handles, cashtags and hashtags before script detection. */
  function stripForDetection(text) {
    return cleanText(text)
      .replace(URL_RE, ' ')
      .replace(MENTION_RE, ' ')
      .replace(CASHTAG_RE, ' ')
      .replace(HASHTAG_RE, ' ');
  }

  function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  function scriptStats(text) {
    const s = stripForDetection(text);
    return {
      han: countMatches(s, /\p{Script=Han}/gu),
      kana: countMatches(s, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
      hangul: countMatches(s, /\p{Script=Hangul}/gu),
      latin: countMatches(s, /\p{Script=Latin}/gu),
      cyrillic: countMatches(s, /\p{Script=Cyrillic}/gu),
      arabic: countMatches(s, /\p{Script=Arabic}/gu),
      thai: countMatches(s, /\p{Script=Thai}/gu),
      devanagari: countMatches(s, /\p{Script=Devanagari}/gu),
      hebrew: countMatches(s, /\p{Script=Hebrew}/gu),
      greek: countMatches(s, /\p{Script=Greek}/gu),
      letters: countMatches(s, /\p{L}/gu)
    };
  }

  /**
   * Best-effort script-based language guess when X does not provide a `lang`
   * attribute. Latin text intentionally returns '' because English, French,
   * Spanish, etc. cannot be separated reliably from script alone.
   */
  function detectScript(text) {
    const s = scriptStats(text);
    if (s.kana > 0) return 'ja';
    if (s.hangul > 0) return 'ko';
    if (s.han > 0) {
      if (s.han >= 3 && s.han >= s.latin * 0.6) return 'zh';
      if (s.han > s.latin && s.han >= 3) return 'zh';
    }
    if (s.cyrillic > 0 && s.cyrillic >= s.latin) return 'ru';
    if (s.arabic > 0 && s.arabic >= s.latin) return 'ar';
    if (s.thai > 0 && s.thai >= s.latin) return 'th';
    if (s.devanagari > 0 && s.devanagari >= s.latin) return 'hi';
    if (s.hebrew > 0 && s.hebrew >= s.latin) return 'he';
    if (s.greek > 0 && s.greek >= s.latin) return 'el';
    return '';
  }

  function hasTranslatableText(text) {
    const stripped = stripForDetection(text);
    const letters = countMatches(stripped, /\p{L}/gu);
    return letters >= 2;
  }

  /** FNV-1a twice with different offset bases + length, as a compact key. */
  function hashText(text) {
    const s = String(text == null ? '' : text);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + 0x9e3779b9;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '-' + s.length.toString(36);
  }

  /**
   * Decide whether a tweet should be sent to a translator.
   * Returns {skip: boolean, reason?: string}.
   */
  function shouldSkipTranslation({ text, sourceLang, targetLang, skipTargetLang = true, minChars = 2 }) {
    const t = cleanText(text);
    if (!t || t.length < Math.max(1, minChars)) return { skip: true, reason: 'too-short' };
    if (!hasTranslatableText(t)) return { skip: true, reason: 'no-letters' };

    const src = shared.normalizeLangTag(sourceLang);
    const tgt = shared.normalizeLangTag(targetLang);
    if (skipTargetLang && src && shared.sameLanguage(src, tgt)) {
      return { skip: true, reason: 'same-language' };
    }

    // When X gives no lang attribute, at least avoid translating obvious
    // Chinese/Japanese/Korean tweets into the same language.
    if (skipTargetLang && !src) {
      const guessed = detectScript(t);
      if (guessed && shared.sameLanguage(guessed, tgt)) {
        return { skip: true, reason: 'same-language' };
      }
    }
    return { skip: false };
  }

  function splitLongPiece(piece, maxLen) {
    if (piece.length <= maxLen) return [piece];
    const out = [];
    let rest = piece;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(' ', maxLen);
      if (cut < maxLen * 0.5) cut = maxLen;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) out.push(rest);
    return out;
  }

  /**
   * Split oversized text at paragraph/sentence/word boundaries. Tweets are
   * short; this mainly protects the free endpoints on long-form posts.
   */
  function chunkText(text, maxLen = 4000) {
    const s = cleanText(text);
    if (!s) return [];
    if (s.length <= maxLen) return [s];

    const chunks = [];
    let current = '';
    const push = () => {
      if (current.trim()) chunks.push(current.trim());
      current = '';
    };

    const paragraphs = s.split(/\n{2,}/);
    for (const para of paragraphs) {
      const sentences = para.match(/[^。！？.!?\n]+[。！？.!?]*|\n/g) || [para];
      for (const rawSentence of sentences) {
        const sentence = rawSentence.trim();
        if (!sentence) continue;
        const pieces = splitLongPiece(sentence, Math.max(500, maxLen - 1));
        for (const piece of pieces) {
          const joiner = current ? (current.endsWith('\n') ? '' : ' ') : '';
          if (current && current.length + joiner.length + piece.length > maxLen) push();
          current += (current ? (current.endsWith('\n') ? '' : ' ') : '') + piece;
        }
      }
      if (current) current += '\n';
    }
    push();
    return chunks.length ? chunks : [s];
  }

  function stripCodeFence(text) {
    let s = cleanText(text);
    if (s.startsWith('```')) {
      s = s.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/```\s*$/, '').trim();
    }
    return s;
  }

  function parseGoogleResponse(data) {
    if (!data || typeof data !== 'object') throw new Error('Google 返回了非 JSON 内容');
    const sentences = Array.isArray(data.sentences) ? data.sentences : [];
    const text = sentences
      .map((s) => (s && typeof s.trans === 'string' ? s.trans : ''))
      .join('')
      .trim();
    if (!text) throw new Error('Google 没有返回译文');
    return { text, sourceLang: shared.normalizeLangTag(data.src) };
  }

  function parseMyMemoryResponse(data) {
    if (!data || typeof data !== 'object') throw new Error('MyMemory 返回了非 JSON 内容');
    const status = Number(data.responseStatus);
    if (status !== 200) throw new Error(data.responseDetails || `MyMemory 错误 ${status || '未知'}`);
    const rd = data.responseData || {};
    let text = typeof rd.translatedText === 'string' ? rd.translatedText : '';
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|ALL AVAILABLE FREE TRANSLATIONS/i.test(text)) {
      throw new Error('MyMemory 今日免费额度可能已用完');
    }
    text = text.trim();
    if (!text) throw new Error('MyMemory 没有返回译文');
    const detected = rd.detectedLanguage || (Array.isArray(data.matches) && data.matches[0] && data.matches[0].source) || '';
    return { text, sourceLang: shared.normalizeLangTag(detected) };
  }

  function parseAzureResponse(data, count) {
    if (!Array.isArray(data)) throw new Error('Microsoft Translator 返回格式异常');
    if (data.length !== count) throw new Error('Microsoft Translator 返回条数不匹配');
    return data.map((item) => {
      const tr = item && Array.isArray(item.translations) && item.translations[0];
      const text = tr && typeof tr.text === 'string' ? tr.text.trim() : '';
      if (!text) throw new Error('Microsoft Translator 没有返回译文');
      const detected = item.detectedLanguage && item.detectedLanguage.language;
      return { text, sourceLang: shared.normalizeLangTag(detected) };
    });
  }

  /** Build a JSON-array translation prompt that is friendly to small models. */
  function buildLLMMessages(texts, targetLang) {
    const targetName = shared.targetCodeFor('llm', targetLang);
    const system = [
      '你是一个专业的翻译引擎，专门翻译 X（Twitter）推文。',
      `把用户给出的 JSON 字符串数组里的每一条文本翻译成${targetName}。`,
      '要求：',
      '1. 保留原文的语气、俚语、反讽和网络用语；译文要自然、口语化，不要写成新闻稿。',
      '2. 完整保留 @用户名、#话题、$代码、URL、表情符号、换行和标点结构。',
      '3. 不要翻译 @用户名 和 URL；不要添加解释、注释、引号或任何前后缀。',
      '4. 只输出一个 JSON 字符串数组，长度和顺序必须与输入完全一致；不要输出 JSON 以外的任何内容。'
    ].join('\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(texts) }
    ];
  }

  function extractJsonArray(content) {
    const s = stripCodeFence(content);
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      // Fall through to the bracket scan below.
    }
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(s.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {
        // Ignore.
      }
    }
    return null;
  }

  function parseLLMResponse(content, count) {
    const arr = extractJsonArray(content);
    if (arr) {
      if (arr.length !== count) throw new Error(`大模型返回了 ${arr.length} 条译文，预期 ${count} 条`);
      return arr.map((item) => {
        const value = typeof item === 'string'
          ? item
          : (item && (item.text || item.translation || item.t || item.translated)) || '';
        const text = cleanText(value);
        if (!text) throw new Error('大模型返回了空译文');
        return text;
      });
    }
    // A single, non-JSON answer is still usable.
    if (count === 1) {
      const text = stripCodeFence(content);
      if (text) return [text];
    }
    throw new Error('无法解析大模型返回的 JSON，请换一个模型或减少批量大小');
  }

  function normalizeBaseUrl(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('API 地址不能为空');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(s) ? 'http://' + s : 'https://' + s;
    }
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/chat\/completions$/i, '');
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('API 地址必须是 http(s)');
    return u.toString().replace(/\/+$/, '');
  }

  const RESERVED_X_PATHS = new Set([
    'about', 'account', 'bookmarks', 'communities', 'community', 'compose',
    'connect_people', 'download', 'explore', 'followers', 'following',
    'grok', 'hashtag', 'home', 'i', 'intent', 'jobs', 'likes', 'lists',
    'login', 'logout', 'messages', 'notifications', 'premium', 'privacy',
    'rules', 'search', 'settings', 'share', 'signup', 'status', 'tos',
    'topics', 'verified', 'who_to_follow'
  ]);
  const PROFILE_TABS = new Set([
    'articles', 'followers', 'following', 'header_photo', 'highlights',
    'likes', 'lists', 'media', 'photo', 'superfollows', 'verified_followers',
    'with_replies'
  ]);

  /**
   * True for an X profile page such as `/jack`, `/jack/with_replies`, but not
   * for `/home`, `/jack/status/123`, or other app routes.
   */
  function isProfilePath(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (!parts.length) return false;
    const first = parts[0].toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(first)) return false;
    if (RESERVED_X_PATHS.has(first)) return false;
    if (parts.length === 1) return true;
    return parts.length === 2 && PROFILE_TABS.has(parts[1].toLowerCase());
  }

  function llmEndpoint(baseUrl) {
    return normalizeBaseUrl(baseUrl) + '/chat/completions';
  }

  /** Normalize a user-supplied HTTP endpoint, keeping its path intact. */
  function normalizeEndpoint(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('接收地址不能为空');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(s) ? 'http://' + s : 'https://' + s;
    }
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('接收地址必须是 http(s)');
    u.hash = '';
    return u.toString();
  }

  function originPattern(url) {
    try {
      const u = new URL(url);
      // Chrome match patterns cannot contain a port; a host pattern covers
      // every port. This is what lets localhost:3425 / :11434 share one grant.
      return u.protocol + '//' + u.hostname + '/*';
    } catch (_) {
      return '';
    }
  }

  function isLocalhostUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]';
    } catch (_) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function mapLimit(items, limit, fn) {
    const list = Array.from(items);
    const results = new Array(list.length);
    let next = 0;
    const workers = new Array(Math.max(1, Math.min(limit, list.length))).fill(0).map(async () => {
      while (true) {
        const i = next++;
        if (i >= list.length) return;
        results[i] = await fn(list[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function truncate(text, max = 300) {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  return {
    cleanText,
    stripForDetection,
    scriptStats,
    detectScript,
    hasTranslatableText,
    hashText,
    shouldSkipTranslation,
    chunkText,
    stripCodeFence,
    parseGoogleResponse,
    parseMyMemoryResponse,
    parseAzureResponse,
    buildLLMMessages,
    parseLLMResponse,
    normalizeBaseUrl,
    normalizeEndpoint,
    llmEndpoint,
    originPattern,
    isLocalhostUrl,
    isProfilePath,
    sleep,
    mapLimit,
    truncate
  };
});
