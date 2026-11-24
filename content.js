/*
 * X 翻译 — content script.
 *
 * Finds tweet text on x.com/twitter.com, decides whether it needs translation,
 * and renders a bilingual block below the original. Network providers are
 * called through the service worker; Chrome's built-in translator runs
 * locally in this context.
 */
(function () {
  'use strict';

  const shared = window.XTR;
  const core = window.XTRCore;
  if (!shared || !core) {
    console.error('[X 翻译] 核心脚本未加载');
    return;
  }

  const SETTINGS_KEY = 'settings';
  const TWEET_TEXT = '[data-testid="tweetText"]';
  const ARTICLE_TITLE = '[data-testid="twitter-article-title"], [data-testid="twitterArticleTitle"], [data-article-part="title"]';
  const ARTICLE_BODY_ROOTS = ['.x-article-body', '[data-testid="twitterArticleRichTextView"]'];
  // X serves two article DOMs. The newer one uses real p/h2/li elements; the
  // older Draft.js reader keeps each paragraph in a div.longform-unstyled and
  // its headings in h1-h3.longform-header-*. Both are handled here.
  const ARTICLE_BODY_TAGS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, div.longform-unstyled';
  const ARTICLE_BODY_BLOCK = ARTICLE_BODY_ROOTS
    .map((root) => root + ' :is(' + ARTICLE_BODY_TAGS + ')')
    .join(', ');
  // Copying uses the same article blocks plus <pre>, so code samples survive.
  const ARTICLE_COPY_BLOCK = ARTICLE_BODY_ROOTS
    .map((root) => root + ' :is(' + ARTICLE_BODY_TAGS + ', pre)')
    .join(', ');
  const USER_DESCRIPTION = '[data-testid="UserDescription"]';
  const TWEET_ARTICLE = 'article[data-testid="tweet"]';
  const MAX_BATCH = 16;
  const FLUSH_DELAY = 240;
  const PROFILE_PREFETCH_LIMIT = 12;
  const PAGE_CACHE_LIMIT = 600;
  const REMOTE_TIMEOUT_MS = 190000;
  const LOCAL_TIMEOUT_MS = 240000;

  let settings = shared.mergeSettings(null);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  let activeStates = new Set();
  let states = new WeakMap();
  let blockStates = new WeakMap();
  let chipStates = new WeakMap();
  let copyActions = new WeakMap();
  let tweetCopyButtons = new WeakMap();
  let articleCopyButtons = new WeakMap();
  let intersection = null;
  let mutationObserver = null;
  let scanTimer = null;
  let flushTimer = null;
  let stateSeq = 0;
  let started = false;
  const pending = new Set();
  const pageCache = new Map();
  const toastSeen = new Map();
  const localPrompted = new Set();
  let activeProfileKey = '';
  let profilePrefetchLeft = 0;
  let toast = null;
  let toastTimer = null;

  class LocalError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'LocalError';
      this.code = code;
    }
  }

  /* ------------------------------------------------------------- settings */

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = shared.mergeSettings(stored && stored.settings);
    } catch (err) {
      settings = shared.mergeSettings(null);
      debug('读取设置失败', err);
    }
  }

  function applyClasses() {
    const html = document.documentElement;
    if (!html) return;
    html.classList.toggle('xtr-disabled', !settings.enabled);
    html.classList.toggle('xtr-hide-provider', !settings.showProviderLabel);
  }

  function onSettingsChanged(prev, next) {
    applyClasses();
    const resetNeeded = prev.targetLang !== next.targetLang
      || prev.provider !== next.provider
      || prev.skipTargetLang !== next.skipTargetLang
      || prev.minChars !== next.minChars
      || prev.translateBios !== next.translateBios
      || prev.translateQuotes !== next.translateQuotes;

    if (resetNeeded) {
      resetAll();
      return;
    }

    if (!next.enabled) {
      pending.clear();
      debug('已关闭');
      return;
    }

    if (prev.autoTranslate !== next.autoTranslate) {
      activeProfileKey = '';
      profilePrefetchLeft = 0;
      scan();
    }
    if (prev.prefetchProfile !== next.prefetchProfile) {
      activeProfileKey = '';
      profilePrefetchLeft = 0;
      scan();
    }
    if (!prev.enabled && next.enabled) {
      scan();
    }
  }

  function loggerEnabled() {
    return !!settings.debug;
  }

  function debug(...args) {
    if (loggerEnabled()) console.log('[X 翻译]', ...args);
  }

  /* ---------------------------------------------------------- local chrome */

  function withTimeout(promise, ms, code, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LocalError(code, message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  class ChromeLocalTranslator {
    constructor() {
      this.entries = new Map();
    }

    get available() {
      return typeof Translator !== 'undefined';
    }

    key(source, target) {
      return source + '>' + target;
    }

    isUnsupported(source, target) {
      const entry = this.entries.get(this.key(source, target));
      return !!(entry && entry.unsupported);
    }

    entryFor(source, target) {
      const key = this.key(source, target);
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          translator: null,
          promise: null,
          unsupported: false,
          progress: new Set(),
          queue: Promise.resolve()
        };
        this.entries.set(key, entry);
      }
      return entry;
    }

    async createTranslator(source, target, entry) {
      try {
        const translator = await Translator.create({
          sourceLanguage: source,
          targetLanguage: target,
          monitor(m) {
            m.addEventListener('downloadprogress', (ev) => {
              const total = Number(ev.total);
              const loaded = Number(ev.loaded);
              const pct = total > 1 ? loaded / total : loaded;
              for (const fn of entry.progress) {
                try { fn(Math.max(0, Math.min(1, pct))); } catch (_) { /* ignore */ }
              }
            });
          }
        });
        entry.translator = translator;
        return translator;
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        if (/user gesture|NotAllowedError/i.test(message)) {
          throw new LocalError('gesture', '本地翻译模型尚未下载，需要点击一下授权下载');
        }
        if (/not supported|unsupported|language/i.test(message)) entry.unsupported = true;
        throw new LocalError('download', '本地翻译模型准备失败：' + message);
      }
    }

    ensure(source, target, onProgress) {
      const entry = this.entryFor(source, target);
      if (entry.translator) return Promise.resolve(entry.translator);
      if (onProgress) entry.progress.add(onProgress);
      if (!entry.promise) {
        entry.promise = (async () => {
          if (typeof Translator === 'undefined') {
            throw new LocalError('unsupported', '当前 Chrome 不支持内置翻译');
          }
          let availability;
          try {
            availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
          } catch (err) {
            throw new LocalError('unsupported', '无法查询 Chrome 内置翻译是否可用');
          }
          if (availability === 'unavailable') {
            entry.unsupported = true;
            throw new LocalError('unsupported', 'Chrome 内置翻译不支持这个语言对');
          }
          return this.createTranslator(source, target, entry);
        })().finally(() => {
          entry.promise = null;
        });
      }
      return entry.promise.finally(() => {
        if (onProgress) entry.progress.delete(onProgress);
      });
    }

    /**
     * Start creating the translator immediately, without the async availability
     * check. Call this synchronously from a click handler: Chrome requires a
     * user gesture before it will download a translation model.
     */
    prepareNow(source, target, onProgress) {
      const entry = this.entryFor(source, target);
      if (entry.translator) return Promise.resolve(entry.translator);
      if (onProgress) entry.progress.add(onProgress);
      if (!entry.promise) {
        const started = typeof Translator === 'undefined'
          ? Promise.reject(new LocalError('unsupported', '当前 Chrome 不支持内置翻译'))
          : this.createTranslator(source, target, entry);
        entry.promise = started.finally(() => {
          entry.promise = null;
        });
      }
      return entry.promise.finally(() => {
        if (onProgress) entry.progress.delete(onProgress);
      });
    }

    async translate(text, source, target, onProgress) {
      if (!source || !target) throw new LocalError('unknown_source', '无法识别源语言');
      if (source === target) throw new LocalError('unsupported', '源语言和目标语言相同');
      const translator = await this.ensure(source, target, onProgress);
      const entry = this.entries.get(this.key(source, target));
      const chunks = core.chunkText(text, 3500);
      const run = async () => {
        const parts = [];
        for (const chunk of chunks) {
          let out;
          try {
            out = await translator.translate(chunk);
          } catch (err) {
            throw new LocalError('error', 'Chrome 内置翻译失败：' + (err && err.message ? err.message : err));
          }
          if (typeof out !== 'string' || !out.trim()) {
            throw new LocalError('error', 'Chrome 内置翻译没有返回译文');
          }
          parts.push(out.trim());
        }
        return parts.join(chunks.length > 1 ? '\n' : '');
      };
      const p = entry.queue.then(run, run);
      entry.queue = p.catch(() => {});
      return p;
    }
  }

  const chromeLocal = new ChromeLocalTranslator();

  /* ------------------------------------------------------------ utilities */

  function extractText(node) {
    let text = '';
    try {
      text = node.innerText || node.textContent || '';
    } catch (_) {
      text = node.textContent || '';
    }
    text = core.cleanText(text);
    // "Show more" is normally a sibling, but strip it if X put it in the text.
    text = text.replace(/\n?\s*(Show more|显示更多|もっと見る|Mehr anzeigen)$/i, '').trim();
    return text.slice(0, 30000);
  }

  function isQuoteText(node) {
    return !!node.closest('[role="link"]');
  }

  /* --------------------------------------------------------------- copy */

  const COPY_BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'PRE'
  ]);

  function copyUrlFor(anchor) {
    const candidates = [
      anchor.getAttribute('title'),
      anchor.getAttribute('data-expanded-url'),
      anchor.getAttribute('data-full-url')
    ];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (/^https?:\/\//i.test(value)) return value;
    }
    const href = String(anchor.getAttribute('href') || '').trim();
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/') && !href.startsWith('//') && looksLikeUrlText(anchor.textContent || '')) {
      return location.origin + href;
    }
    return '';
  }

  function looksLikeUrlText(text) {
    const value = String(text || '').trim();
    return /^(?:https?:\/\/|www\.)/i.test(value)
      || (!/\s/.test(value) && /^[^/]+\.[^/]+/.test(value));
  }

  /** Walk a tweet/article text node and keep line breaks plus full link URLs. */
  function textForCopy(root) {
    let out = '';
    const appendNewline = () => {
      if (out && !out.endsWith('\n')) out += '\n';
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (el.matches && el.matches('[data-testid="tweet-text-show-more-link"]')) return;
      if (el.closest && el.closest('.xtr-block, .xtr-chip, [data-xtr-copy]')) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        // X renders emoji as <img alt="…">; article photos are replaced by
        // their figcaption instead of alt text.
        if (!el.closest('figure')) out += el.getAttribute('alt') || '';
        return;
      }
      if (tag === 'A') {
        const text = el.textContent || '';
        const full = copyUrlFor(el);
        if (full && (el.hasAttribute('title')
          || el.hasAttribute('data-expanded-url')
          || el.hasAttribute('data-full-url')
          || looksLikeUrlText(text))) {
          out += full;
        } else {
          out += text;
        }
        return;
      }
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      const block = COPY_BLOCK_TAGS.has(tag);
      if (block) appendNewline();
      for (const child of el.childNodes) walk(child);
      if (block) appendNewline();
    };
    walk(root);
    let text = out
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    text = text.replace(/\n?\s*(Show more|显示更多|もっと見る|Mehr anzeigen)$/i, '').trim();
    return core.cleanText(text);
  }

  function mainTweetTextNode(article) {
    const nodes = Array.from(article.querySelectorAll(TWEET_TEXT));
    return nodes.find((node) => node.closest(TWEET_ARTICLE) === article) || null;
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      // Fall back to the selection-based copy below.
    }
    let area = null;
    try {
      area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.left = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      return document.execCommand('copy');
    } catch (_) {
      return false;
    } finally {
      if (area) area.remove();
    }
  }

  function listDepth(li) {
    let depth = 0;
    let node = li;
    while (node) {
      if (node.tagName === 'LI') depth++;
      node = node.parentElement;
    }
    return depth;
  }

  function articleRoot() {
    const body = document.querySelector(ARTICLE_BODY_ROOTS.join(','));
    if (!body) return null;
    return body.closest('article') || document;
  }

  function articleCopyText() {
    const root = articleRoot();
    if (!root) return '';
    const titleEl = root.querySelector(ARTICLE_TITLE);
    const title = titleEl ? textForCopy(titleEl) : '';
    const nodes = Array.from(root.querySelectorAll(ARTICLE_COPY_BLOCK))
      .filter((node) => !node.closest('.xtr-block, .xtr-chip'))
      .filter((node) => !node.querySelector(ARTICLE_COPY_BLOCK));

    const parts = [];
    let lastLi = null;
    for (const node of nodes) {
      const text = textForCopy(node);
      if (!text) continue;
      const li = node.closest('li');
      let prefix = '';
      let kind = 'block';
      if (li) {
        kind = 'li';
        const depth = listDepth(li);
        if (li === lastLi) {
          prefix = '  '.repeat(depth);
        } else {
          const parent = li.parentElement;
          let bullet = '';
          if (parent && parent.tagName === 'OL') {
            bullet = (Array.prototype.indexOf.call(parent.children, li) + 1) + '. ';
          } else if (parent && parent.tagName === 'UL') {
            bullet = '- ';
          }
          prefix = '  '.repeat(Math.max(0, depth - 1)) + bullet;
          lastLi = li;
        }
      } else if (node.closest('blockquote')) {
        prefix = '> ';
      } else if (node.tagName === 'FIGCAPTION') {
        prefix = '图片说明：';
        kind = 'caption';
      }
      parts.push({ text: prefix + text, kind });
    }

    let out = title;
    let prevKind = '';
    for (const part of parts) {
      if (out) out += part.kind === 'li' && prevKind === 'li' ? '\n' : '\n\n';
      out += part.text;
      prevKind = part.kind;
    }
    return core.cleanText(out);
  }

  async function copyTweetArticle(article) {
    const node = mainTweetTextNode(article);
    const text = node ? textForCopy(node) : '';
    const ok = await copyTextToClipboard(text);
    showToast(ok ? '已复制到剪贴板' : (text ? '复制失败，请重试' : '这条推文没有可复制的文字'), { timeout: 2600 });
  }

  async function copyArticle() {
    const text = articleCopyText();
    const ok = await copyTextToClipboard(text);
    showToast(ok ? '已复制到剪贴板' : (text ? '复制失败，请重试' : '没有找到可复制的文章内容'), { timeout: 2600 });
  }

  function createCopyButton(kind, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind === 'article' ? 'xtr-article-copy' : 'xtr-copy-btn';
    button.setAttribute('data-xtr-copy', kind);
    button.setAttribute('aria-label', kind === 'article' ? '复制文章全文' : '复制推文文字');
    button.title = kind === 'article' ? '复制文章全文' : '复制推文文字';
    button.textContent = kind === 'article' ? '复制全文' : '复制';
    copyActions.set(button, action);
    return button;
  }

  function insertCopyButtonAfter(node, button) {
    const parent = node.parentElement;
    if (!parent) return false;
    parent.insertBefore(button, node.nextSibling);
    return true;
  }

  function ensureCopyButtons() {
    if (!settings.enabled) return;

    const root = articleRoot();
    if (root) {
      const articleTitle = root.querySelector(ARTICLE_TITLE);
      const articleBody = root.querySelector(ARTICLE_BODY_ROOTS.join(','));
      if (articleTitle && articleBody) {
        let articleButton = articleCopyButtons.get(articleTitle);
        if (!articleButton || !articleButton.isConnected) {
          articleButton = createCopyButton('article', copyArticle);
          articleCopyButtons.set(articleTitle, articleButton);
          if (!insertCopyButtonAfter(articleTitle, articleButton)) {
            articleCopyButtons.delete(articleTitle);
          }
        }
      }
    }

    for (const article of document.querySelectorAll(TWEET_ARTICLE)) {
      if (article.querySelector(ARTICLE_BODY_ROOTS.join(','))) continue;
      const textNode = mainTweetTextNode(article);
      if (!textNode) continue;
      const groups = Array.from(article.querySelectorAll('[role="group"]'))
        .filter((group) => group.closest(TWEET_ARTICLE) === article);
      const group = groups.length ? groups[groups.length - 1] : null;
      let button = tweetCopyButtons.get(article);
      if (button && button.isConnected) {
        if (group && button.parentElement !== group) group.appendChild(button);
        continue;
      }
      button = createCopyButton('tweet', () => copyTweetArticle(article));
      tweetCopyButtons.set(article, button);
      if (group) {
        group.appendChild(button);
      } else if (!insertCopyButtonAfter(textNode, button)) {
        tweetCopyButtons.delete(article);
      }
    }
  }

  function collectTargets() {
    const selectors = [TWEET_TEXT, ARTICLE_TITLE, ARTICLE_BODY_BLOCK];
    if (settings.translateBios) selectors.push(USER_DESCRIPTION);
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    return nodes.filter((node) => {
      if (node.closest('.xtr-block, .xtr-chip')) return false;
      if (node.matches(USER_DESCRIPTION)) return settings.translateBios;
      const inTweet = !!node.closest(TWEET_ARTICLE);
      const isArticleTitle = node.matches(ARTICLE_TITLE);
      const isArticleBody = node.matches(ARTICLE_BODY_BLOCK);
      if (!inTweet && !isArticleTitle && !isArticleBody) return false;
      // Prefer the innermost block: a list item containing a paragraph should
      // be translated through the paragraph, not twice.
      if (isArticleBody && node.querySelector(ARTICLE_BODY_BLOCK)) return false;
      if (!settings.translateQuotes && inTweet && isQuoteText(node)) return false;
      return true;
    });
  }

  function getIntersectionObserver() {
    if (intersection) return intersection;
    if (typeof IntersectionObserver === 'undefined') return null;
    intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (state.visible && settings.enabled && settings.autoTranslate) {
          maybeTranslate(state);
        }
      }
    }, { root: null, rootMargin: '400px 0px', threshold: 0 });
    return intersection;
  }

  function ensureState(node) {
    let state = states.get(node);
    if (state) {
      activeStates.add(state);
      return state;
    }
    state = {
      node,
      id: ++stateSeq,
      text: '',
      sourceLang: '',
      hash: '',
      status: 'idle',
      token: 0,
      translation: '',
      provider: '',
      uiProvider: '',
      error: null,
      hidden: false,
      skipped: false,
      visible: false,
      manual: false,
      block: null,
      chip: null,
      createdAt: Date.now()
    };
    states.set(node, state);
    activeStates.add(state);
    const io = getIntersectionObserver();
    if (io) io.observe(node);
    else state.visible = true;
    return state;
  }

  function readNode(state) {
    const text = extractText(state.node);
    let attr = state.node.getAttribute('lang') || '';
    if (!attr) {
      const langEl = state.node.closest('[lang]');
      if (langEl && langEl !== document.documentElement && langEl !== document.body) {
        attr = langEl.getAttribute('lang') || '';
      }
    }
    let sourceLang = shared.normalizeLangTag(attr);
    if (!sourceLang) sourceLang = core.detectScript(text);
    const hash = core.hashText(text + '|' + sourceLang);
    if (hash === state.hash) return false;

    state.text = text;
    state.sourceLang = sourceLang;
    state.hash = hash;
    state.token++;
    state.status = 'idle';
    state.translation = '';
    state.provider = '';
    state.uiProvider = '';
    state.error = null;
    state.skipped = false;
    state.hidden = false;
    state.manual = false;
    removeBlock(state);
    removeChip(state);
    return true;
  }

  function pruneStates() {
    for (const state of activeStates) {
      if (!state.node.isConnected) activeStates.delete(state);
    }
  }

  function pageCacheKey(text) {
    return settings.targetLang + '|' + core.hashText(text);
  }

  function pageCacheGet(text) {
    const key = pageCacheKey(text);
    const value = pageCache.get(key);
    if (!value) return null;
    pageCache.delete(key);
    pageCache.set(key, value);
    return value;
  }

  function pageCacheSet(text, result) {
    if (!result || !result.ok) return;
    const key = pageCacheKey(text);
    if (pageCache.has(key)) pageCache.delete(key);
    pageCache.set(key, result);
    while (pageCache.size > PAGE_CACHE_LIMIT) {
      const first = pageCache.keys().next();
      if (first.done) break;
      pageCache.delete(first.value);
    }
  }

  function insertAfter(node, el) {
    const parent = node.parentElement;
    if (!parent) return false;
    // A <div> directly under <ul>/<ol> is invalid HTML. For list items with
    // direct text, keep the translation inside the item instead.
    if (parent.tagName === 'UL' || parent.tagName === 'OL') {
      node.appendChild(el);
      return true;
    }
    parent.insertBefore(el, node.nextSibling);
    try {
      const style = getComputedStyle(parent);
      if (/flex/.test(style.display) && /row/.test(style.flexDirection)) {
        el.style.flexBasis = '100%';
        el.style.width = '100%';
      }
    } catch (_) {
      // Ignore style errors.
    }
    return true;
  }

  /* ------------------------------------------------------------ rendering */

  function ensureBlock(state) {
    if (state.block && state.block.isConnected) return state.block;
    const block = document.createElement('div');
    block.className = 'xtr-block';
    block.setAttribute('data-xtr-block', '1');
    block.setAttribute('dir', 'auto');

    const text = document.createElement('div');
    text.className = 'xtr-text';
    text.setAttribute('dir', 'auto');
    text.setAttribute('lang', settings.targetLang);

    const bar = document.createElement('div');
    bar.className = 'xtr-bar';
    const provider = document.createElement('span');
    provider.className = 'xtr-provider';
    const sep = document.createElement('span');
    sep.className = 'xtr-sep';
    sep.textContent = '·';
    const actions = document.createElement('span');
    actions.className = 'xtr-actions';
    bar.append(provider, sep, actions);

    block.append(text, bar);
    blockStates.set(block, state);
    state.block = block;
    if (!insertAfter(state.node, block)) {
      state.block = null;
      blockStates.delete(block);
      return null;
    }
    // A quoted tweet is often wrapped in a link; don't navigate when the
    // reader interacts with the translation block.
    block.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      e.stopPropagation();
    });
    return block;
  }

  function blockParts(state) {
    const block = ensureBlock(state);
    if (!block) return null;
    return {
      block,
      text: block.querySelector('.xtr-text'),
      provider: block.querySelector('.xtr-provider'),
      actions: block.querySelector('.xtr-actions')
    };
  }

  function providerText(providerId) {
    if (providerId === 'chrome') return '本地';
    return shared.providerLabel(providerId);
  }

  function setProvider(state, parts, providerId) {
    const info = shared.providerInfo(providerId);
    parts.provider.textContent = providerText(providerId);
    parts.provider.title = info.label;
  }

  function renderLoading(state, message) {
    const parts = blockParts(state);
    if (!parts) return;
    parts.block.setAttribute('data-xtr-state', 'loading');
    parts.text.className = 'xtr-text xtr-loading';
    parts.text.textContent = message || '翻译中…';
    setProvider(state, parts, state.uiProvider || effectiveProviderFor(state));
    parts.actions.textContent = '';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'xtr-action';
    cancel.setAttribute('data-xtr-action', 'hide');
    cancel.textContent = '取消';
    parts.actions.appendChild(cancel);
  }

  function updateLoadingProgress(state, token, pct) {
    if (state.token !== token || !state.block) return;
    const text = state.block.querySelector('.xtr-text');
    if (!text) return;
    if (pct >= 1) {
      text.textContent = '翻译中…';
    } else {
      text.textContent = '正在准备本地翻译模型… ' + Math.round(pct * 100) + '%';
    }
  }

  function renderSuccess(state) {
    if (!state.translation) return;
    state.hidden = false;
    removeChip(state);
    const parts = blockParts(state);
    if (!parts) return;
    parts.block.setAttribute('data-xtr-state', 'done');
    parts.text.className = 'xtr-text';
    parts.text.textContent = state.translation;
    setProvider(state, parts, state.provider || state.uiProvider || settings.provider);
    parts.actions.textContent = '';
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'xtr-action';
    hide.setAttribute('data-xtr-action', 'hide');
    hide.textContent = '隐藏';
    parts.actions.appendChild(hide);
  }

  function renderError(state) {
    const parts = blockParts(state);
    if (!parts) return;
    parts.block.setAttribute('data-xtr-state', 'error');
    parts.text.className = 'xtr-text xtr-error-text';
    parts.text.textContent = state.error && state.error.message ? state.error.message : '翻译失败';
    setProvider(state, parts, state.uiProvider || state.provider || settings.provider);
    parts.actions.textContent = '';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'xtr-action';
    retry.setAttribute('data-xtr-action', 'retry');
    retry.textContent = '重试';
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'xtr-action';
    hide.setAttribute('data-xtr-action', 'hide');
    hide.textContent = '隐藏';
    parts.actions.append(retry, hide);
  }

  function renderChip(state, mode) {
    removeChip(state);
    if (state.skipped || !settings.enabled) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'xtr-chip';
    chip.setAttribute('data-xtr-chip', '1');
    chip.textContent = mode === 'hidden' ? '显示译文' : '翻译';
    chip.title = mode === 'hidden' ? '显示这条推文的译文' : '翻译这条推文';
    chipStates.set(chip, state);
    state.chip = chip;
    insertAfter(state.node, chip);
  }

  function removeBlock(state) {
    if (state.block) {
      blockStates.delete(state.block);
      state.block.remove();
      state.block = null;
    }
  }

  function removeChip(state) {
    if (state.chip) {
      chipStates.delete(state.chip);
      state.chip.remove();
      state.chip = null;
    }
  }

  function cleanupStateUI(state) {
    removeBlock(state);
    removeChip(state);
  }

  /* -------------------------------------------------------------- toasts */

  function showToast(message, options = {}) {
    removeToast();
    const el = document.createElement('div');
    el.className = 'xtr-toast';
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'xtr-toast-text';
    text.textContent = message;
    el.appendChild(text);
    if (options.actionLabel && typeof options.onAction === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'xtr-toast-action';
      action.textContent = options.actionLabel;
      action.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeToast();
        try { options.onAction(); } catch (_) { /* ignore */ }
      });
      el.appendChild(action);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'xtr-toast-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeToast();
    });
    el.appendChild(close);
    (document.body || document.documentElement).appendChild(el);
    toast = el;
    const timeout = options.timeout === 0 ? 0 : (options.timeout || 9000);
    if (timeout > 0) toastTimer = setTimeout(removeToast, timeout);
  }

  function removeToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toast) {
      toast.remove();
      toast = null;
    }
  }

  function maybeToastError(error) {
    if (!error) return;
    if (!['auth', 'rate_limit', 'network', 'timeout', 'server'].includes(error.code)) return;
    const key = error.code + '|' + error.message;
    const now = Date.now();
    if (now - (toastSeen.get(key) || 0) < 30000) return;
    toastSeen.set(key, now);
    showToast(error.message, {
      actionLabel: '设置',
      onAction: () => sendBgMessage({ type: 'xtr:openOptions' }, 3000)
    });
  }

  function chromeLanguageLabel(code) {
    const lang = shared.LANGUAGES.find((item) => item.chrome === code);
    return lang ? lang.label : code;
  }

  /**
   * Chrome only lets an extension download a translation model from a user
   * gesture. The first time a pair needs a model, offer a button that starts
   * the download inside its click handler, then retry the affected tweets.
   */
  function promptLocalActivation(source, target, options = {}) {
    const key = source + '>' + target;
    if (localPrompted.has(key)) return;
    localPrompted.add(key);
    const pair = chromeLanguageLabel(source) + ' → ' + chromeLanguageLabel(target);
    const message = options.fallback
      ? '本地翻译模型（' + pair + '）还没下载，这条推文已暂用 Google 翻译。'
      : '本地翻译模型（' + pair + '）还没下载。';
    showToast(message, {
      actionLabel: '启用本地翻译',
      timeout: 20000,
      onAction: () => {
        showToast('正在准备本地翻译模型（' + pair + '）…', { timeout: 0 });
        chromeLocal.prepareNow(source, target, (pct) => {
          if (pct > 0 && pct < 1) {
            showToast('正在下载本地翻译模型（' + pair + '）… ' + Math.round(pct * 100) + '%', { timeout: 0 });
          }
        }).then(() => {
          showToast('本地翻译已启用。', { timeout: 6000 });
          if (typeof options.onReady === 'function') {
            try { options.onReady(); } catch (_) { /* ignore */ }
          }
        }).catch((err) => {
          const message = err && err.message ? err.message : String(err);
          showToast('本地翻译启用失败：' + message, {
            actionLabel: '设置',
            onAction: () => sendBgMessage({ type: 'xtr:openOptions' }, 3000),
            timeout: 15000
          });
          localPrompted.delete(key);
        });
      }
    });
  }

  /* ----------------------------------------------------------- translation */

  function effectiveProviderFor(state) {
    if (settings.provider === 'auto') {
      if (chromeLocal.available && state.sourceLang) {
        const src = shared.chromeLangCode(state.sourceLang);
        const tgt = shared.chromeLangCode(settings.targetLang);
        if (src && tgt && !chromeLocal.isUnsupported(src, tgt)) return 'chrome';
      }
      return 'google';
    }
    return settings.provider;
  }

  function isEligible(state) {
    return !!(
      state.node.isConnected
      && state.text
      && !state.hidden
      && !state.skipped
      && state.status === 'queued'
      && (settings.autoTranslate || state.manual)
    );
  }

  function scheduleFlush(delay = FLUSH_DELAY) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, delay);
  }

  async function maybeTranslate(state, options = {}) {
    if (!settings.enabled || !state.text || state.skipped || state.hidden) return;
    if (state.status === 'loading' || state.status === 'queued' || state.status === 'preparing') return;
    if (state.translation) {
      if (state.hidden) renderChip(state, 'hidden');
      else renderSuccess(state);
      return;
    }
    if (!settings.autoTranslate && !options.manual && !options.prefetch && !state.manual) return;
    if (!options.manual && !options.prefetch && !state.manual && !state.visible) return;

    const pre = core.shouldSkipTranslation({
      text: state.text,
      sourceLang: state.sourceLang,
      targetLang: settings.targetLang,
      skipTargetLang: settings.skipTargetLang,
      minChars: settings.minChars
    });
    if (pre.skip) {
      state.skipped = true;
      state.status = 'done';
      cleanupStateUI(state);
      if (options.manual) showToast('这条推文已经是目标语言，无需翻译');
      return;
    }

    state.status = 'preparing';
    const token = ++state.token;
    let provider = effectiveProviderFor(state);

    if (provider === 'chrome' && !state.sourceLang) {
      const detected = await detectViaBackground(state.text);
      if (state.token !== token) return;
      if (detected) {
        state.sourceLang = detected;
        const post = core.shouldSkipTranslation({
          text: state.text,
          sourceLang: state.sourceLang,
          targetLang: settings.targetLang,
          skipTargetLang: settings.skipTargetLang,
          minChars: settings.minChars
        });
        if (post.skip) {
          state.skipped = true;
          state.status = 'done';
          cleanupStateUI(state);
          if (options.manual || state.manual) showToast('这条推文已经是目标语言，无需翻译');
          return;
        }
      } else if (settings.provider === 'chrome') {
        applyError(state, { code: 'unknown_source', message: '无法识别这条推文的语言，请换用 Google 或大模型' }, token);
        return;
      } else {
        provider = 'google';
      }
    }

    if (state.token !== token) return;

    if (provider === 'chrome') {
      const src = shared.chromeLangCode(state.sourceLang);
      const tgt = shared.chromeLangCode(settings.targetLang);
      if (!chromeLocal.available || !src || !tgt || chromeLocal.isUnsupported(src, tgt)) {
        if (settings.provider === 'chrome') {
          applyError(state, { code: 'unsupported', message: '当前 Chrome 或这个语言对不支持本地翻译，请换用 Google 或大模型' }, token);
          return;
        }
        provider = 'google';
      }
    }

    state.status = 'queued';
    state.uiProvider = provider;
    pending.add(state);
    scheduleFlush(options.manual || state.manual ? 20 : FLUSH_DELAY);
  }

  async function flushQueue() {
    if (!settings.enabled) {
      pending.clear();
      return;
    }

    const ready = [];
    for (const state of Array.from(pending)) {
      pending.delete(state);
      if (ready.length >= MAX_BATCH) {
        pending.add(state);
        continue;
      }
      if (!isEligible(state)) continue;
      ready.push(state);
    }
    if (pending.size) scheduleFlush(40);
    if (!ready.length) return;

    const batch = [];
    for (const state of ready) {
      const cached = pageCacheGet(state.text);
      if (cached) {
        applyResult(state, cached, state.token);
        continue;
      }
      state.status = 'loading';
      state.token++;
      renderLoading(state);
      batch.push(state);
    }
    if (!batch.length) return;

    const local = [];
    const remote = [];
    for (const state of batch) {
      if (state.uiProvider === 'chrome') local.push(state);
      else remote.push(state);
    }
    const remoteProvider = (settings.provider === 'auto' || settings.provider === 'chrome')
      ? 'google'
      : settings.provider;

    await Promise.all([
      local.length ? runLocalBatch(local) : Promise.resolve(),
      remote.length ? runRemoteBatch(remote, remoteProvider) : Promise.resolve()
    ]);

    if (pending.size) scheduleFlush(40);
  }

  async function runRemoteBatch(states, provider) {
    if (!states.length) return;
    // The background returns a whole batch at once. For LLM requests, split
    // into groups that match the provider's group size and apply each group as
    // soon as it finishes, so the first screen does not wait for the rest of
    // an off-screen prefetch batch. The first group is deliberately smaller:
    // a 4-tweet request returns noticeably faster than an 8-tweet one.
    if (provider === 'llm' && states.length > 8) {
      const chunks = states.length <= 12
        ? [states.slice(0, 4), states.slice(4)]
        : [states.slice(0, 8), states.slice(8)];
      await core.mapLimit(chunks, 2, (chunk) => runRemoteChunk(chunk, provider));
      return;
    }
    await runRemoteChunk(states, provider);
  }

  async function runRemoteChunk(states, provider) {
    const tokens = new Map();
    for (const state of states) tokens.set(state.id, state.token);
    const res = await sendBgMessage({
      type: 'xtr:translate',
      provider,
      targetLang: settings.targetLang,
      texts: states.map((s) => s.text),
      sourceLangs: states.map((s) => s.sourceLang),
      ids: states.map((s) => s.id),
      skipTargetLang: settings.skipTargetLang,
      minChars: settings.minChars
    }, REMOTE_TIMEOUT_MS);

    if (!res || res.error) {
      const error = (res && res.error) || { code: 'empty', message: '翻译服务没有响应' };
      for (const state of states) applyError(state, error, tokens.get(state.id));
      return;
    }
    const byId = new Map();
    if (Array.isArray(res.results)) {
      for (const result of res.results) byId.set(result.id, result);
    }
    for (const state of states) {
      const result = byId.get(state.id);
      if (!result) {
        applyError(state, { code: 'empty', message: '翻译服务没有返回这条推文的结果' }, tokens.get(state.id));
      } else {
        applyResult(state, result, tokens.get(state.id));
      }
    }
  }

  async function runLocalBatch(states) {
    if (!states.length) return;
    if (!chromeLocal.available) {
      if (settings.provider === 'chrome') {
        for (const state of states) {
          applyError(state, { code: 'unsupported', message: '当前 Chrome 不支持内置翻译，请在设置中换用 Google 或大模型' }, state.token);
        }
      } else {
        await runRemoteBatch(states, 'google');
      }
      return;
    }

    const fallback = [];
    await core.mapLimit(states, 2, async (state) => {
      const token = state.token;
      const source = shared.chromeLangCode(state.sourceLang);
      const target = shared.chromeLangCode(settings.targetLang);
      if (!source || !target) {
        if (settings.provider === 'chrome') {
          applyError(state, { code: 'unknown_source', message: '无法识别这条推文的语言' }, token);
        } else {
          fallback.push(state);
        }
        return;
      }
      try {
        const result = await withTimeout(
          chromeLocal.translate(state.text, source, target, (pct) => updateLoadingProgress(state, token, pct)),
          LOCAL_TIMEOUT_MS,
          'timeout',
          '本地翻译超时'
        );
        if (state.token !== token) return;
        if (core.cleanText(result) === core.cleanText(state.text)) {
          applyResult(state, { ok: true, skip: true, reason: 'identical' }, token);
        } else {
          applyResult(state, { ok: true, text: result, sourceLang: state.sourceLang, provider: 'chrome' }, token);
        }
      } catch (err) {
        if (state.token !== token) return;
        if (settings.provider === 'chrome') {
          applyError(state, { code: err.code || 'error', message: err.message || 'Chrome 内置翻译失败' }, token);
          if (err.code === 'gesture') {
            promptLocalActivation(source, target, { onReady: () => retryLocalPair(source, target) });
          }
        } else {
          fallback.push(state);
          if (err.code === 'gesture') {
            promptLocalActivation(source, target, { fallback: true });
          }
        }
      }
    });

    if (fallback.length) {
      await runRemoteBatch(fallback, 'google');
    }
  }

  function applyResult(state, result, token) {
    if (!state || state.token !== token || !state.node.isConnected) return;
    if (result.ok && result.skip) {
      state.status = 'done';
      state.skipped = true;
      state.translation = '';
      cleanupStateUI(state);
      pageCacheSet(state.text, result);
      if (state.manual) showToast('这条推文已经是目标语言，无需翻译');
      return;
    }
    if (result.ok && result.text) {
      state.status = 'done';
      state.skipped = false;
      state.translation = result.text;
      state.provider = result.provider || state.uiProvider || settings.provider;
      state.error = null;
      pageCacheSet(state.text, result);
      if (state.hidden) {
        removeBlock(state);
        renderChip(state, 'hidden');
      } else {
        renderSuccess(state);
      }
      return;
    }
    applyError(state, result.error || { code: 'error', message: '翻译失败' }, token);
  }

  function applyError(state, error, token) {
    if (!state || state.token !== token) return;
    state.status = 'error';
    state.error = error;
    state.translation = '';
    if (state.hidden) {
      removeBlock(state);
      renderChip(state, 'manual');
    } else {
      renderError(state);
    }
    maybeToastError(error);
  }

  /* ----------------------------------------------------------- interactions */

  function hideState(state) {
    state.hidden = true;
    state.token++;
    if (state.status === 'loading' || state.status === 'queued') {
      pending.delete(state);
      state.status = 'idle';
    }
    removeBlock(state);
    removeChip(state);
    if (state.translation) renderChip(state, 'hidden');
    else renderChip(state, 'manual');
  }

  function retryState(state) {
    state.hidden = false;
    state.error = null;
    state.skipped = false;
    state.translation = '';
    state.status = 'idle';
    state.manual = true;
    state.token++;
    cleanupStateUI(state);
    maybeTranslate(state, { manual: true });
  }

  function retryLocalPair(source, target) {
    for (const node of collectTargets()) {
      const state = states.get(node);
      if (!state || state.status !== 'error') continue;
      if (!state.sourceLang) continue;
      if (shared.chromeLangCode(state.sourceLang) !== source) continue;
      retryState(state);
    }
  }

  function clickChip(state) {
    removeChip(state);
    state.hidden = false;
    if (state.translation) {
      renderSuccess(state);
      return;
    }
    state.manual = true;
    state.status = 'idle';
    state.error = null;
    maybeTranslate(state, { manual: true });
  }

  function onClickCapture(event) {
    const copyEl = event.target.closest && event.target.closest('[data-xtr-copy]');
    if (copyEl) {
      event.preventDefault();
      event.stopPropagation();
      const action = copyActions.get(copyEl);
      if (action) {
        try { action(); } catch (_) { /* ignore */ }
      }
      return;
    }
    const actionEl = event.target.closest && event.target.closest('[data-xtr-action]');
    if (actionEl) {
      const block = actionEl.closest('.xtr-block');
      const state = block && blockStates.get(block);
      if (state) {
        event.preventDefault();
        event.stopPropagation();
        const action = actionEl.getAttribute('data-xtr-action');
        if (action === 'hide') hideState(state);
        else if (action === 'retry') retryState(state);
      }
      return;
    }
    const chip = event.target.closest && event.target.closest('.xtr-chip');
    if (chip) {
      const state = chipStates.get(chip);
      if (state) {
        event.preventDefault();
        event.stopPropagation();
        clickChip(state);
      }
    }
  }

  /* ---------------------------------------------------------- page control */

  function scan() {
    if (!settings.enabled) {
      applyClasses();
      return;
    }
    pruneStates();
    ensureCopyButtons();

    // On a blogger's profile, translate the first screen's worth of posts up
    // front. The model is the slow part; doing this while the user is still
    // reading the top of the page removes the wait when they scroll.
    const profileKey = settings.prefetchProfile
      && settings.provider === 'llm'
      && core.isProfilePath(location.pathname)
      ? location.pathname.toLowerCase()
      : '';
    if (profileKey !== activeProfileKey) {
      activeProfileKey = profileKey;
      profilePrefetchLeft = profileKey ? PROFILE_PREFETCH_LIMIT : 0;
    }

    for (const node of collectTargets()) {
      if (!node.isConnected) continue;
      const state = ensureState(node);
      readNode(state);
      if (!state.text) {
        cleanupStateUI(state);
        state.status = 'idle';
        continue;
      }
      if (state.skipped) {
        cleanupStateUI(state);
        continue;
      }
      if (state.translation) {
        if (state.hidden) {
          removeBlock(state);
          renderChip(state, 'hidden');
        } else {
          renderSuccess(state);
        }
        continue;
      }
      if (state.status === 'loading' || state.status === 'queued' || state.status === 'preparing') continue;
      if (state.status === 'error' && state.block) continue;

      if (settings.autoTranslate) {
        const withinPrefetch = profilePrefetchLeft > 0;
        const prefetch = withinPrefetch && !state.visible;
        if (state.hidden) {
          renderChip(state, 'manual');
        } else if (state.visible || !intersection || prefetch) {
          if (withinPrefetch) profilePrefetchLeft--;
          maybeTranslate(state, prefetch ? { prefetch: true } : undefined);
        }
      } else {
        renderChip(state, 'manual');
      }
    }
  }

  function scheduleScan(delay = 250) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function isRelevantMutation(mutation) {
    if (mutation.type === 'characterData') {
      const parent = mutation.target.parentElement;
      return !!(parent && parent.closest(TWEET_TEXT + ',' + ARTICLE_TITLE + ',' + ARTICLE_BODY_BLOCK + ',' + USER_DESCRIPTION));
    }
    if (mutation.type === 'childList') {
      const selector = TWEET_TEXT + ',' + ARTICLE_TITLE + ',' + ARTICLE_BODY_BLOCK + ',' + USER_DESCRIPTION;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(selector)) return true;
        if (node.querySelector && node.querySelector(selector)) return true;
      }
    }
    return false;
  }

  function startMutationObserver() {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (isRelevantMutation(mutation)) {
          scheduleScan();
          return;
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function resetAll() {
    pending.clear();
    activeProfileKey = '';
    profilePrefetchLeft = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const state of activeStates) {
      state.token++;
      cleanupStateUI(state);
    }
    document.querySelectorAll('.xtr-block, .xtr-chip').forEach((el) => el.remove());
    activeStates.clear();
    states = new WeakMap();
    blockStates = new WeakMap();
    chipStates = new WeakMap();
    pageCache.clear();
    if (intersection) {
      intersection.disconnect();
      intersection = null;
    }
    if (settings.enabled) scan();
  }

  function translatePage() {
    scan();
    for (const state of activeStates) {
      if (!state.node.isConnected) continue;
      if (state.translation || state.skipped) continue;
      if (state.status === 'loading' || state.status === 'queued') continue;
      state.manual = true;
      state.hidden = false;
      state.status = 'idle';
      maybeTranslate(state, { manual: true });
    }
  }

  function getStatus() {
    let translated = 0;
    let pendingCount = 0;
    let errors = 0;
    for (const state of activeStates) {
      if (!state.node.isConnected) continue;
      if (state.translation) translated++;
      if (state.status === 'loading' || state.status === 'queued') pendingCount++;
      if (state.status === 'error') errors++;
    }
    return {
      enabled: settings.enabled,
      autoTranslate: settings.autoTranslate,
      targetLang: settings.targetLang,
      provider: settings.provider,
      translated,
      pending: pendingCount,
      errors,
      chromeAvailable: chromeLocal.available
    };
  }

  /* ------------------------------------------------------------- messaging */

  function sendBgMessage(message, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ error: { code: 'timeout', message: '与扩展后台通信超时' } });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ error: { code: 'extension', message: '扩展通信失败：' + lastError.message } });
          } else {
            resolve(response || { error: { code: 'empty', message: '扩展后台没有响应' } });
          }
        });
      } catch (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ error: { code: 'extension', message: String(err && err.message ? err.message : err) } });
      }
    });
  }

  async function detectViaBackground(text) {
    const res = await sendBgMessage({ type: 'xtr:detect', text }, 15000);
    if (res && res.lang) return shared.normalizeLangTag(res.lang);
    return '';
  }

  function handleRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'xtr:translatePage') {
      ready.then(() => {
        translatePage();
        sendResponse({ ok: true, status: getStatus() });
      });
      return true;
    }
    if (msg.type === 'xtr:getStatus') {
      ready.then(() => sendResponse(getStatus()));
      return true;
    }
    if (msg.type === 'xtr:resetPage') {
      ready.then(() => {
        resetAll();
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------- init */

  async function init() {
    await loadSettings();
    applyClasses();
    started = true;
    startMutationObserver();
    scan();
    readyResolve(getStatus());
  }

  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const prev = settings;
      settings = shared.mergeSettings(changes.settings.newValue);
      if (started) onSettingsChanged(prev, settings);
      else applyClasses();
    });
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  document.addEventListener('click', onClickCapture, true);
  applyClasses();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); }, { once: true });
  } else {
    init();
  }
})();
