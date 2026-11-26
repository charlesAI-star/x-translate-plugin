(() => {
  'use strict';

  const TOKEN_KEY = 'xtr.kb.token';
  const PAGE_SIZE = 30;
  const STATUS_LABELS = {
    pending: '待整理',
    processing: '整理中',
    saved: '仅保存',
    classified: '已分类待分析',
    ready: '已分析',
    failed: '失败',
    running: '运行中',
    completed: '已完成',
    interrupted: '已中断',
    cancelled: '已取消'
  };
  const MODE_LABELS = { save: '仅保存', classify: '仅整理', full: '完整分析' };
  const PHASE_LABELS = {
    scan: '扫描',
    govern: '分类治理',
    analyze: '全量分析',
    summarize: '分类总结',
    report: '生成周报',
    done: '完成',
    cancelled: '已取消',
    failed: '失败'
  };

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    view: 'entries',
    category: '',
    status: '',
    deleted: false,
    q: '',
    sort: 'newest',
    limit: PAGE_SIZE,
    items: [],
    total: 0,
    loading: false,
    loadError: null,
    stats: null,
    tree: [],
    all: [],
    pendingProposals: [],
    entry: null,
    weekly: null,
    currentWeekly: null,
    listDirty: false
  };

  let entryPollTimer = null;
  let weeklyPollTimer = null;
  let searchTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function trustedHtml(tag, className, html) {
    const node = el(tag, { class: className });
    node.innerHTML = html || '';
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function badge(text, className = '') {
    return el('span', { class: `badge ${className}`.trim(), text });
  }

  function statusBadge(status) {
    return badge(STATUS_LABELS[status] || status, `status-${status}`);
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function fmtDate(value, withTime = true) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
      }).format(date);
    } catch {
      return String(value);
    }
  }

  function fmtShortDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
    } catch {
      return '';
    }
  }

  function toast(message, type = '') {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.className = `toast show ${type}`.trim();
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      node.className = 'toast';
    }, type === 'error' ? 4200 : 2600);
  }

  function notifyError(err) {
    if (!err || err.code === 'AUTH_REQUIRED') return;
    toast(err.message || '操作失败', 'error');
  }

  async function run(fn) {
    try {
      return await fn();
    } catch (err) {
      notifyError(err);
      return undefined;
    }
  }

  async function api(path, options = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(path, { method: options.method || 'GET', headers, body });
    } catch {
      const err = new Error('无法连接本地服务，请确认 agent 已启动');
      err.code = 'network_error';
      throw err;
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
    if (response.status === 401) {
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      showAuthDialog();
      const err = new Error('需要有效的访问 Token');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (!response.ok || data.ok === false) {
      const err = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
      err.code = data?.error?.code || 'http_error';
      err.status = response.status;
      throw err;
    }
    return data;
  }

  /* Dialogs */

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog(dialog) {
    if (!dialog || !dialog.open) return;
    dialog.close();
  }

  function closeAllDialogs(except = null) {
    $$('dialog[open]').forEach((dialog) => {
      if (dialog !== except) closeDialog(dialog);
    });
  }

  function showAuthDialog() {
    closeAllDialogs($('#auth-dialog'));
    openDialog($('#auth-dialog'));
    setTimeout(() => $('#auth-token')?.focus(), 30);
  }

  /* Status and categories */

  async function refreshStatus() {
    const data = await api('/api/status');
    state.stats = data.stats;
    state.currentWeekly = data.currentWeekly;
    updateCounts();
    updateLlmStatus(data.llm);
    updateRunButton();
    if (state.currentWeekly) startWeeklyPolling();
    return data;
  }

  function updateCounts() {
    const stats = state.stats;
    if (!stats) return;
    const by = stats.byStatus || {};
    const set = (id, value) => {
      const node = $(id);
      if (node) node.textContent = String(value || 0);
    };
    set('#count-all', stats.total);
    set('#count-pending', (by.pending || 0) + (by.processing || 0));
    set('#count-saved', by.saved);
    set('#count-classified', by.classified);
    set('#count-ready', by.ready);
    set('#count-failed', by.failed);
    set('#count-deleted', stats.deleted);
    set('#count-proposals', stats.pendingProposals);
    $('#count-proposals')?.classList.toggle('hidden', !stats.pendingProposals);
  }

  function updateLlmStatus(llm) {
    const node = $('#llm-status');
    if (!node) return;
    clear(node);
    const ok = llm && llm.status === 'ok';
    node.className = `llm-status ${ok ? 'ok' : 'bad'}`;
    node.append(el('i', { class: 'dot' }));
    node.append(
      document.createTextNode(ok ? 'Claude CLI 可用' : 'Claude CLI 不可用')
    );
    node.title = ok ? `引擎：${llm.provider || 'claude-cli'}` : '请检查 claude 命令是否可用';
  }

  function updateRunButton() {
    const button = $('#btn-run-weekly');
    if (!button) return;
    if (state.currentWeekly) {
      button.textContent = '查看正在进行的整理';
    } else {
      button.textContent = '开始每周整理';
    }
  }

  async function refreshCategories() {
    const data = await api('/api/categories');
    state.tree = data.tree || [];
    state.all = data.all || [];
    state.pendingProposals = data.pendingProposals || [];
    renderCategoryTree();
    const count = state.pendingProposals.length;
    const badgeNode = $('#count-proposals');
    if (badgeNode) {
      badgeNode.textContent = String(count);
      badgeNode.classList.toggle('hidden', !count);
    }
    return data;
  }

  function categoryName(key) {
    const category = state.all.find((item) => item.key === key);
    return category ? category.name : key;
  }

  function renderCategoryTree() {
    const root = $('#category-tree');
    if (!root) return;
    clear(root);
    if (!state.tree.length) {
      root.append(el('div', { class: 'muted small', text: '还没有分类' }));
      return;
    }
    for (const l1 of state.tree) {
      const group = el('div', { class: 'cat-group' });
      group.append(categoryRow(l1, 'l1'));
      if (l1.children?.length) {
        const children = el('div', { class: 'cat-children' });
        for (const l2 of l1.children) children.append(categoryRow(l2, 'l2'));
        group.append(children);
      }
      root.append(group);
    }
  }

  function categoryRow(category, level) {
    const active =
      state.view === 'entries' &&
      !state.deleted &&
      !state.status &&
      state.category === category.key;
    const row = el('div', { class: `cat-row ${level} ${active ? 'active' : ''}` });
    const button = el('button', {
      class: 'cat-name',
      type: 'button',
      title: category.description || category.name,
      onclick: () => filterByCategory(category.key)
    });
    button.append(el('span', { class: 'cat-dot' }));
    button.append(el('span', { text: category.name }));
    row.append(button);
    row.append(el('span', { class: 'cat-count', text: String(category.count || 0) }));
    return row;
  }

  function filterByCategory(key) {
    state.view = 'entries';
    state.category = key;
    state.status = '';
    state.deleted = false;
    state.limit = PAGE_SIZE;
    state.items = [];
    state.q = '';
    const search = $('#search');
    if (search) search.value = '';
    updateNav();
    refreshCategories().catch(() => {});
    loadEntries();
  }

  function updateNav() {
    $$('.nav-item').forEach((button) => button.classList.remove('active'));
    if (state.view === 'entries') {
      if (state.deleted) {
        const target = $$('.nav-item').find((button) => button.dataset.deleted === '1');
        target?.classList.add('active');
        return;
      }
      if (state.category) return;
      const status = state.status || '';
      const target = $$('.nav-item').find(
        (button) =>
          button.dataset.view === 'entries' &&
          !button.dataset.deleted &&
          (button.dataset.status || '') === status
      );
      target?.classList.add('active');
      return;
    }
    const target = $$('.nav-item').find((button) => button.dataset.view === state.view);
    target?.classList.add('active');
  }

  /* Entries view */

  async function loadEntries() {
    state.loading = true;
    state.loadError = null;
    renderEntriesView();
    try {
      const params = new URLSearchParams();
      if (state.q) params.set('q', state.q);
      if (state.category) params.set('category', state.category);
      if (state.status) params.set('status', state.status);
      if (state.deleted) params.set('deleted', '1');
      params.set('sort', state.sort);
      params.set('limit', String(state.limit));
      const data = await api(`/api/entries?${params.toString()}`);
      state.items = data.items || [];
      state.total = data.total || 0;
    } catch (err) {
      state.loadError = err.message || '加载失败';
      if (err.code !== 'AUTH_REQUIRED') notifyError(err);
    } finally {
      state.loading = false;
      renderEntriesView();
    }
  }

  function entriesTitle() {
    if (state.deleted) return '回收站';
    if (state.category) return categoryName(state.category);
    if (!state.status) return '全部内容';
    if (state.status === 'pending,processing') return '待整理';
    return STATUS_LABELS[state.status] || state.status;
  }

  function entriesSubtitle() {
    if (state.loading && !state.items.length) return '正在加载…';
    if (state.deleted) return `共 ${state.total} 条已删除内容，可恢复或彻底忽略。`;
    if (state.category) return `该分类下共 ${state.total} 条内容。`;
    return `共 ${state.total} 条内容。超级复制会自动进入这里。`;
  }

  function renderEntriesView() {
    const content = $('#content');
    if (!content) return;
    clear(content);
    content.append(
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h2', { text: entriesTitle() }),
          el('p', { text: entriesSubtitle() })
        ),
        el(
          'div',
          { class: 'page-actions' },
          state.category
            ? el('button', {
                class: 'btn btn-sm',
                type: 'button',
                text: '清除分类筛选',
                onclick: () => {
                  state.category = '';
                  state.items = [];
                  updateNav();
                  loadEntries();
                }
              })
            : null
        )
      )
    );

    if (state.loading && !state.items.length) {
      const list = el('div', { class: 'entry-list' });
      for (let i = 0; i < 3; i += 1) list.append(el('div', { class: 'skeleton' }));
      content.append(list);
      return;
    }

    if (state.loadError) {
      content.append(
        el(
          'div',
          { class: 'empty' },
          el('h3', { text: '加载失败' }),
          el('p', { text: state.loadError })
        )
      );
      return;
    }

    if (!state.items.length) {
      content.append(emptyEntries());
      return;
    }

    const list = el('div', { class: 'entry-list' });
    for (const entry of state.items) list.append(entryCard(entry));
    content.append(list);

    if (state.items.length < state.total) {
      content.append(
        el('button', {
          class: 'btn load-more',
          type: 'button',
          text: `加载更多（${state.items.length}/${state.total}）`,
          onclick: async () => {
            state.limit += PAGE_SIZE;
            await loadEntries();
          }
        })
      );
    }
  }

  function emptyEntries() {
    if (state.deleted) {
      return el(
        'div',
        { class: 'empty' },
        el('h3', { text: '回收站是空的' }),
        el('p', { text: '删除的条目会先进入这里，不会立刻丢失。' })
      );
    }
    if (state.q) {
      return el(
        'div',
        { class: 'empty' },
        el('h3', { text: '没有匹配的内容' }),
        el('p', { text: '换一个关键词，或清除筛选后再试。' })
      );
    }
    if (state.category || state.status) {
      return el(
        'div',
        { class: 'empty' },
        el('h3', { text: '这里还没有内容' }),
        el('p', { text: '换个分类看看，或在 X 上超级复制一条内容。' })
      );
    }
    return el(
      'div',
      { class: 'empty' },
      el('h3', { text: '知识库还是空的' }),
      el('p', {
        text: '在 X 上使用插件的「超级复制」按钮，内容会自动发送到本地 agent。可以先只保存，也可以立刻整理分析。'
      })
    );
  }

  function entryCard(entry) {
    const card = el('article', {
      class: 'entry-card',
      tabindex: '0',
      role: 'button',
      'aria-label': entry.title || '查看内容'
    });
    card.addEventListener('click', () => openEntry(entry.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openEntry(entry.id);
      }
    });

    const top = el('div', { class: 'entry-card-top' });
    top.append(statusBadge(entry.status));
    if (entry.category_l1_name && entry.category_l1 !== 'inbox') {
      top.append(
        badge(
          entry.category_l2_name
            ? `${entry.category_l1_name} · ${entry.category_l2_name}`
            : entry.category_l1_name,
          'cat'
        )
      );
    }
    if (entry.category_source === 'manual') top.append(badge('手动分类', 'manual'));
    top.append(badge(MODE_LABELS[entry.processing_mode] || entry.processing_mode, 'mode'));
    card.append(top);

    card.append(el('h3', { text: entry.title || '未命名内容' }));
    card.append(
      el('p', {
        class: 'entry-summary',
        text:
          entry.summary ||
          (entry.status === 'saved'
            ? '只保存了原文，还没有整理分类。'
            : entry.status === 'classified'
              ? '已整理标题、分类和标签，还没有生成摘要。'
              : '点击查看原文。')
      })
    );

    if (entry.tags?.length) {
      const tags = el('div', { class: 'tag-row' });
      for (const tag of entry.tags.slice(0, 6)) tags.append(el('span', { class: 'tag', text: tag }));
      card.append(tags);
    }

    const foot = el('div', { class: 'entry-card-foot' });
    const author = entry.source?.author_handle
      ? `@${entry.source.author_handle}`
      : entry.source?.author_name || '';
    if (author) foot.append(el('span', { text: author }));
    const date = fmtDate(entry.source?.published_at || entry.source?.captured_at, false);
    if (date) foot.append(el('span', { text: date }));
    if (entry.note_count) foot.append(el('span', { text: `${entry.note_count} 条想法` }));
    card.append(foot);
    return card;
  }

  /* Entry detail */

  async function openEntry(id) {
    closeAllDialogs($('#entry-dialog'));
    state.entry = null;
    const dialog = $('#entry-dialog');
    const body = $('#entry-body');
    clear(body);
    body.append(el('div', { class: 'skeleton', style: 'height:160px' }));
    openDialog(dialog);
    try {
      const data = await api(`/api/entries/${encodeURIComponent(id)}`);
      state.entry = data.entry;
      renderEntryDetail();
    } catch (err) {
      if (err.code !== 'AUTH_REQUIRED') {
        closeDialog(dialog);
        notifyError(err);
      }
    }
  }

  function renderEntryDetail() {
    const entry = state.entry;
    if (!entry) return;
    const badges = $('#entry-badges');
    const title = $('#entry-title');
    const meta = $('#entry-meta');
    const body = $('#entry-body');
    clear(badges);
    clear(meta);
    clear(body);

    if (title) title.textContent = entry.title || '未命名内容';
    badges.append(statusBadge(entry.status));
    if (entry.category_l1_name && entry.category_l1 !== 'inbox') {
      badges.append(
        badge(
          entry.category_l2_name
            ? `${entry.category_l1_name} · ${entry.category_l2_name}`
            : entry.category_l1_name,
          'cat'
        )
      );
    }
    if (entry.category_source === 'manual') badges.append(badge('手动分类', 'manual'));
    badges.append(badge(MODE_LABELS[entry.processing_mode] || entry.processing_mode, 'mode'));
    if (entry.deleted_at) badges.append(badge('已删除', 'status-failed'));

    const author = entry.source?.author_handle
      ? `@${entry.source.author_handle}`
      : entry.source?.author_name || '';
    if (author) meta.append(el('span', { text: author }));
    const date = fmtDate(entry.source?.published_at || entry.source?.captured_at);
    if (date) meta.append(el('span', { text: date }));
    if (isHttpUrl(entry.source?.url)) {
      meta.append(
        el('a', {
          href: entry.source.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '打开原帖'
        })
      );
    }

    if (entry.status === 'processing') {
      body.append(
        el('div', {
          class: 'notice',
          text: '这条内容正在整理中，请稍候；整理完成前请勿删除，删除会中断当前任务。'
        })
      );
    } else if (entry.status === 'saved') {
      body.append(
        el('div', {
          class: 'notice',
          text: '这条内容目前只保存了原文，还没有整理分类和生成摘要。可以点击「完整分析」立即处理。'
        })
      );
    } else if (entry.status === 'classified') {
      body.append(
        el('div', {
          class: 'notice',
          text: '已完成标题、分类和标签，还没有生成摘要与要点。周整理会对全部内容重新分析。'
        })
      );
    }
    if (entry.status === 'failed') {
      body.append(
        el('div', {
          class: 'notice error',
          text: `上次处理失败：${entry.error || '未知错误'}`
        })
      );
    }

    const actions = el('div', { class: 'detail-actions' });
    if (!entry.deleted_at) {
      if (entry.status !== 'processing') {
        actions.append(
          el('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: entry.status === 'ready' ? '重新完整分析' : '完整分析',
            onclick: () => processEntry('full')
          })
        );
        actions.append(
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: '仅整理分类',
            onclick: () => processEntry('classify')
          })
        );
        if (entry.status === 'failed') {
          actions.append(
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: '重试',
              onclick: () => retryEntry()
            })
          );
        }
      } else {
        actions.append(el('span', { class: 'badge status-processing', text: '正在处理…' }));
      }
      actions.append(
        el('button', {
          class: 'btn btn-danger btn-sm',
          type: 'button',
          text: '删除',
          onclick: () => deleteEntry()
        })
      );
    } else {
      actions.append(
        el('button', {
          class: 'btn btn-primary btn-sm',
          type: 'button',
          text: '恢复',
          onclick: () => restoreEntry()
        })
      );
    }
    if (isHttpUrl(entry.source?.url)) {
      actions.append(
        el('a', {
          class: 'btn btn-sm',
          href: entry.source.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '查看原帖'
        })
      );
    }
    body.append(actions);

    if (!entry.deleted_at) body.append(categoryEditor(entry));

    if (entry.summary) {
      const section = el('section', { class: 'detail-section' });
      section.append(el('h4', { text: '摘要' }));
      section.append(el('p', { class: 'summary-text', text: entry.summary }));
      const analysis = entry.analysis || {};
      if (Array.isArray(analysis.key_points) && analysis.key_points.length) {
        const points = el('ul', { class: 'point-list' });
        for (const point of analysis.key_points) points.append(el('li', { text: point }));
        section.append(points);
      }
      const info = el('div', { class: 'meta-line' });
      if (analysis.content_type) info.append(el('span', { text: `类型：${analysis.content_type}` }));
      if (analysis.language) info.append(el('span', { text: `语言：${analysis.language}` }));
      if (entry.tags?.length) {
        const tags = el('div', { class: 'tag-row' });
        for (const tag of entry.tags) tags.append(el('span', { class: 'tag', text: tag }));
        section.append(tags);
      }
      if (info.childNodes.length) section.append(info);
      body.append(section);
    } else if (entry.tags?.length) {
      const section = el('section', { class: 'detail-section' });
      section.append(el('h4', { text: '标签' }));
      const tags = el('div', { class: 'tag-row' });
      for (const tag of entry.tags) tags.append(el('span', { class: 'tag', text: tag }));
      section.append(tags);
      body.append(section);
    }

    body.append(notesSection(entry));

    const original = el('section', { class: 'detail-section' });
    original.append(el('h4', { text: '原文' }));
    const text = entry.content?.text || '';
    original.append(
      el('pre', { class: 'original-text', text: text || '（没有正文，可能只有链接或媒体）' })
    );
    if (entry.content?.truncated) {
      original.append(el('p', { class: 'muted small', text: '原文较长，插件保存的是截断后的文本。' }));
    }
    body.append(original);

    if (entry.quoted?.content?.text || entry.quoted?.url) {
      const quoted = el('section', { class: 'detail-section' });
      quoted.append(el('h4', { text: '引用内容' }));
      const quote = el('div', { class: 'quoted-box' });
      const qAuthor = entry.quoted.author?.handle
        ? `@${entry.quoted.author.handle}`
        : entry.quoted.author?.name || '';
      if (qAuthor) quote.append(el('div', { class: 'small muted', text: qAuthor }));
      quote.append(document.createTextNode(entry.quoted.content?.text || ''));
      quoted.append(quote);
      if (isHttpUrl(entry.quoted.url)) {
        quoted.append(
          el('p', {
            class: 'small'
          })
        );
        quoted.lastChild.append(
          el('a', {
            href: entry.quoted.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: '打开引用原帖'
          })
        );
      }
      body.append(quoted);
    }

    if (entry.links?.length) {
      const section = el('section', { class: 'detail-section' });
      section.append(el('h4', { text: '链接' }));
      const list = el('ul', { class: 'link-list' });
      for (const link of entry.links) {
        if (!isHttpUrl(link.url)) continue;
        list.append(
          el(
            'li',
            {},
            el('a', {
              href: link.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: link.text || link.url
            })
          )
        );
      }
      if (list.childNodes.length) section.append(list);
      body.append(section);
    }

    if (entry.media?.length) {
      const section = el('section', { class: 'detail-section' });
      section.append(el('h4', { text: '媒体' }));
      const list = el('ul', { class: 'media-list' });
      entry.media.forEach((item, index) => {
        const label = item.alt || item.caption || `媒体 ${index + 1}`;
        const url = item.url || item.previewUrl;
        if (isHttpUrl(url)) {
          list.append(
            el(
              'li',
              {},
              el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: label })
            )
          );
        } else {
          list.append(el('li', { text: label }));
        }
      });
      section.append(list);
      body.append(section);
    }

    if (entry.l1_summary?.content_html) {
      const section = el('section', { class: 'detail-section' });
      const details = el('details', {});
      details.append(el('summary', { class: 'muted', text: '查看所属分类的总结' }));
      details.append(trustedHtml('div', 'markdown', entry.l1_summary.content_html));
      section.append(details);
      body.append(section);
    }

    const metaGrid = el('dl', { class: 'meta-grid' });
    const metaItems = [
      ['条目 ID', entry.id],
      ['采集时间', fmtDate(entry.source?.captured_at)],
      ['处理模式', MODE_LABELS[entry.processing_mode] || entry.processing_mode],
      ['分类来源', entry.category_source === 'manual' ? '手动' : '自动'],
      ['最近更新', fmtDate(entry.updated_at)],
      ['Markdown', entry.markdown_path || '尚未导出']
    ];
    for (const [label, value] of metaItems) {
      const wrap = el('div');
      wrap.append(el('dt', { text: label }));
      wrap.append(el('dd', { text: value || '—' }));
      metaGrid.append(wrap);
    }
    body.append(metaGrid);
  }

  function categoryEditor(entry) {
    const section = el('section', { class: 'detail-section' });
    section.append(el('h4', { text: '分类' }));
    const row = el('div', { class: 'category-editor' });

    const l1Select = el('select', { class: 'select', 'aria-label': '一级分类' });
    for (const category of state.tree) {
      l1Select.append(
        el('option', { value: category.key, text: category.name, selected: category.key === entry.category_l1 })
      );
    }
    if (!state.tree.some((category) => category.key === entry.category_l1)) {
      l1Select.append(
        el('option', { value: entry.category_l1, text: entry.category_l1_name || entry.category_l1 })
      );
      l1Select.value = entry.category_l1;
    }

    const l2Select = el('select', { class: 'select', 'aria-label': '二级分类' });
    const fillL2 = (l1Key, selected) => {
      clear(l2Select);
      l2Select.append(el('option', { value: '', text: '未细分' }));
      const l1 = state.tree.find((category) => category.key === l1Key);
      for (const child of l1?.children || []) {
        l2Select.append(el('option', { value: child.key, text: child.name }));
      }
      if (selected && !Array.from(l2Select.options).some((option) => option.value === selected)) {
        const known = state.all.find((category) => category.key === selected);
        l2Select.append(el('option', { value: selected, text: known?.name || selected }));
      }
      l2Select.value = selected || '';
    };
    fillL2(entry.category_l1, entry.category_l2 || '');
    l1Select.addEventListener('change', () => fillL2(l1Select.value, ''));

    const save = el('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: '保存分类',
      onclick: async () => {
        await run(async () => {
          const data = await api(`/api/entries/${encodeURIComponent(entry.id)}`, {
            method: 'PATCH',
            body: {
              category_l1: l1Select.value,
              category_l2: l2Select.value || null
            }
          });
          state.entry = data.entry;
          state.listDirty = true;
          toast('分类已更新');
          await Promise.all([refreshCategories(), refreshStatus()]);
          renderEntryDetail();
        });
      }
    });

    row.append(l1Select, l2Select, save);
    section.append(row);
    section.append(el('p', { class: 'muted small', text: '手动修改后，每周全量整理仍可能重新分类，并会在周报中标注。' }));
    return section;
  }

  function notesSection(entry) {
    const section = el('section', { class: 'detail-section' });
    section.append(el('h4', { text: `我的想法${entry.notes?.length ? `（${entry.notes.length}）` : ''}` }));
    const list = el('div', { class: 'notes-list' });
    if (!entry.notes?.length) {
      list.append(el('p', { class: 'muted small', text: '还没有想法。记录你当时的判断，周整理会把它作为上下文。' }));
    }
    for (const note of entry.notes || []) list.append(noteItem(note));
    section.append(list);

    if (!entry.deleted_at) {
      const form = el('form', { class: 'note-form' });
      const textarea = el('textarea', {
        rows: '3',
        maxlength: '2000',
        placeholder: '写下你的想法、疑问或之后要跟进的事…'
      });
      const actions = el('div', { class: 'note-form-actions' });
      actions.append(
        el('button', {
          class: 'btn btn-primary btn-sm',
          type: 'submit',
          text: '添加想法'
        })
      );
      form.append(textarea, actions);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = textarea.value.trim();
        if (!body) {
          toast('想法不能为空', 'error');
          return;
        }
        await run(async () => {
          const data = await api(`/api/entries/${encodeURIComponent(entry.id)}/notes`, {
            method: 'POST',
            body: { body }
          });
          state.entry = data.entry;
          state.listDirty = true;
          toast('想法已添加');
          renderEntryDetail();
        });
      });
      section.append(form);
    }
    return section;
  }

  function noteItem(note) {
    const wrap = el('div', { class: 'note' });
    const head = el('div', { class: 'note-head' });
    head.append(el('span', { text: fmtDate(note.created_at) }));
    head.append(el('span', { class: 'spacer' }));
    const edit = el('button', { class: 'link-btn', type: 'button', text: '编辑' });
    const remove = el('button', { class: 'link-btn', type: 'button', text: '删除' });
    head.append(edit, remove);
    wrap.append(head);
    const body = trustedHtml('div', 'note-body', note.body_html || '');
    wrap.append(body);

    edit.addEventListener('click', () => {
      clear(wrap);
      const form = el('form', { class: 'note-form' });
      const textarea = el('textarea', { rows: '3', maxlength: '2000' });
      textarea.value = note.body || '';
      const actions = el('div', { class: 'note-form-actions' });
      const cancel = el('button', { class: 'btn btn-sm', type: 'button', text: '取消' });
      const save = el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: '保存' });
      cancel.addEventListener('click', () => renderEntryDetail());
      actions.append(cancel, save);
      form.append(textarea, actions);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = textarea.value.trim();
        if (!value) {
          toast('想法不能为空', 'error');
          return;
        }
        await run(async () => {
          const data = await api(`/api/notes/${note.id}`, {
            method: 'PATCH',
            body: { body: value }
          });
          state.entry = data.entry;
          toast('想法已更新');
          renderEntryDetail();
        });
      });
      wrap.append(form);
      textarea.focus();
    });

    remove.addEventListener('click', async () => {
      if (!window.confirm('删除这条想法？')) return;
      await run(async () => {
        const data = await api(`/api/notes/${note.id}`, { method: 'DELETE' });
        state.entry = data.entry;
        toast('想法已删除');
        renderEntryDetail();
      });
    });

    return wrap;
  }

  async function processEntry(mode) {
    const entry = state.entry;
    if (!entry) return;
    const label = mode === 'full' ? '完整分析' : '整理分类';
    await run(async () => {
      const data = await api(`/api/entries/${encodeURIComponent(entry.id)}/process`, {
        method: 'POST',
        body: { mode }
      });
      state.entry = data.entry;
      state.listDirty = true;
      toast(`已加入队列：${label}`);
      renderEntryDetail();
      pollEntry(entry.id);
      refreshStatus().catch(() => {});
    });
  }

  async function retryEntry() {
    const entry = state.entry;
    if (!entry) return;
    await run(async () => {
      const data = await api(`/api/entries/${encodeURIComponent(entry.id)}/retry`, {
        method: 'POST',
        body: {}
      });
      state.entry = data.entry;
      toast('已重新加入队列');
      renderEntryDetail();
      pollEntry(entry.id);
    });
  }

  async function deleteEntry() {
    const entry = state.entry;
    if (!entry) return;
    const message = entry.status === 'processing'
      ? '这条内容正在整理，删除会中断本次任务。确定移入回收站？'
      : '删除这条内容？会先进入回收站。';
    if (!window.confirm(message)) return;
    await run(async () => {
      await api(`/api/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body: { deleted: true }
      });
      state.listDirty = true;
      toast('已移入回收站');
      closeDialog($('#entry-dialog'));
      await Promise.all([refreshStatus(), refreshCategories()]);
      if (state.view === 'entries') loadEntries();
    });
  }

  async function restoreEntry() {
    const entry = state.entry;
    if (!entry) return;
    await run(async () => {
      const data = await api(`/api/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body: { restore: true }
      });
      state.entry = data.entry;
      state.listDirty = true;
      toast('已恢复');
      renderEntryDetail();
      await Promise.all([refreshStatus(), refreshCategories()]);
    });
  }

  function pollEntry(id) {
    if (entryPollTimer) clearInterval(entryPollTimer);
    let attempts = 0;
    entryPollTimer = setInterval(async () => {
      attempts += 1;
      try {
        const data = await api(`/api/entries/${encodeURIComponent(id)}`);
        const entry = data.entry;
        if (!entry) {
          clearInterval(entryPollTimer);
          entryPollTimer = null;
          return;
        }
        if (state.entry && state.entry.id === id && $('#entry-dialog')?.open) {
          state.entry = entry;
          renderEntryDetail();
        }
        if (!['pending', 'processing'].includes(entry.status) || attempts > 60) {
          clearInterval(entryPollTimer);
          entryPollTimer = null;
          refreshStatus().catch(() => {});
          refreshCategories().catch(() => {});
          if (state.view === 'entries') loadEntries();
        }
      } catch {
        if (attempts > 10) {
          clearInterval(entryPollTimer);
          entryPollTimer = null;
        }
      }
    }, 2000);
  }

  /* Weekly */

  async function loadWeeklyData() {
    const [weekly, proposals] = await Promise.all([
      api('/api/weekly?limit=30'),
      api('/api/proposals?status=pending')
    ]);
    state.weekly = weekly;
    state.pendingProposals = proposals.proposals || [];
    state.currentWeekly = weekly.current || null;
    updateRunButton();
    if (state.currentWeekly) startWeeklyPolling();
    return weekly;
  }

  async function renderWeeklyView() {
    const content = $('#content');
    if (!content) return;
    clear(content);
    content.append(el('div', { class: 'skeleton', style: 'height:140px' }));
    try {
      await loadWeeklyData();
    } catch (err) {
      clear(content);
      content.append(
        el(
          'div',
          { class: 'empty' },
          el('h3', { text: '加载失败' }),
          el('p', { text: err.message || '无法读取周报' })
        )
      );
      return;
    }
    clear(content);

    const head = el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h2', { text: '每周整理' }),
        el('p', { text: '全量重新分析所有内容，调整二级分类，并生成分类总结和周报。' })
      ),
      el(
        'div',
        { class: 'page-actions' },
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: state.currentWeekly ? '整理进行中' : '立即整理',
          disabled: Boolean(state.currentWeekly),
          onclick: () => runWeeklyNow()
        })
      )
    );
    content.append(head);

    if (state.currentWeekly) content.append(activeRunCard(state.currentWeekly));

    if (state.pendingProposals.length) {
      content.append(
        el('div', { class: 'page-head', style: 'margin-top:24px' }, el('div', {}, el('h2', { text: '待确认的一级分类调整' }), el('p', { text: '一级分类不会由 agent 自动修改。' })))
      );
      const list = el('div', { class: 'proposal-list' });
      for (const proposal of state.pendingProposals) list.append(proposalCard(proposal));
      content.append(list);
    }

    const runs = state.weekly?.runs || [];
    content.append(
      el('div', { class: 'page-head', style: 'margin-top:26px' }, el('div', {}, el('h2', { text: '历史周报' })))
    );
    if (!runs.length) {
      content.append(
        el(
          'div',
          { class: 'empty' },
          el('h3', { text: '还没有周报' }),
          el('p', { text: '点击「立即整理」开始第一次全量整理。也可以等待每周一 02:00 的自动任务。' })
        )
      );
      return;
    }
    const list = el('div', { class: 'run-list' });
    for (const summary of runs) {
      const changes = summary.changes?.counts || {};
      const card = el('button', { class: 'run-card', type: 'button' });
      card.addEventListener('click', () => openWeekly(summary.id));
      const main = el('div', { class: 'run-main' });
      const titleRow = el('div', { class: 'badge-row' });
      titleRow.append(el('h3', { text: `${summary.week_key} 周报` }));
      titleRow.append(statusBadge(summary.status));
      main.append(titleRow);
      main.append(
        el('p', {
          text: `${summary.trigger === 'auto' ? '自动' : '手动'} · ${PHASE_LABELS[summary.phase] || summary.phase || '—'} · 重新分析 ${changes.analyzed || 0} 条 · 调整分类 ${changes.category_changes || 0} 条`
        })
      );
      const side = el('div', { class: 'run-side' });
      side.append(el('div', { text: fmtDate(summary.started_at) }));
      if (summary.changes?.manual_overrides?.length) {
        side.append(el('div', { text: `${summary.changes.manual_overrides.length} 条手动分类被覆盖` }));
      }
      card.append(main, side);
      list.append(card);
    }
    content.append(list);
  }

  function activeRunCard(run) {
    const box = el('div', { class: 'active-run' });
    const head = el('div', { class: 'active-run-head' });
    head.append(el('h3', { text: '正在整理知识库' }));
    head.append(statusBadge(run.status));
    head.append(el('span', { class: 'spacer' }));
    if (run.status === 'interrupted') {
      head.append(
        el('button', {
          class: 'btn btn-primary btn-sm',
          type: 'button',
          text: '恢复',
          onclick: () => runWeeklyAction(run.id, 'resume')
        })
      );
    }
    if (run.status === 'running') {
      head.append(
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '取消',
          onclick: () => runWeeklyAction(run.id, 'cancel')
        })
      );
    }
    box.append(head);
    const progress = run.progress || {};
    const total = Number(progress.total) || 0;
    const done = Number(progress.done) || 0;
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : run.status === 'completed' ? 100 : 8;
    const bar = el('div', { class: 'progress' });
    bar.append(el('span', { style: `width:${percent}%` }));
    box.append(bar);
    box.append(
      el('div', {
        class: 'muted small',
        text: `${progress.label || PHASE_LABELS[run.phase] || run.phase || '准备中'} ${total ? `· ${done}/${total}` : ''}`
      })
    );
    return box;
  }

  async function runWeeklyNow() {
    if (state.currentWeekly) {
      toast('已有整理任务在进行');
      return;
    }
    if (!window.confirm('开始全量整理？会调用 Claude CLI 分析所有内容，可能需要较长时间。')) return;
    await run(async () => {
      await api('/api/weekly/run', { method: 'POST', body: {} });
      toast('每周整理已开始');
      await refreshStatus();
      if (state.view === 'weekly') renderWeeklyView();
      startWeeklyPolling();
    });
  }

  async function runWeeklyAction(id, action) {
    const labels = { cancel: '取消整理', resume: '恢复整理', rollback: '撤销本次分类调整' };
    if (action === 'rollback') {
      if (!window.confirm('撤销本次整理对条目分类的调整？条目的摘要和标签不会被还原。')) return;
    } else if (action === 'cancel') {
      if (!window.confirm('取消正在进行的整理？已完成的部分会保留。')) return;
    }
    await run(async () => {
      await api(`/api/weekly/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      toast(`${labels[action]}成功`);
      await refreshStatus();
      if (state.view === 'weekly') renderWeeklyView();
      if ($('#weekly-dialog')?.open) openWeekly(id);
      if (action !== 'resume') stopWeeklyPolling();
    });
  }

  function startWeeklyPolling() {
    if (weeklyPollTimer) return;
    weeklyPollTimer = setInterval(async () => {
      try {
        const data = await api('/api/weekly/current');
        const run = data.run;
        state.currentWeekly = run && ['running', 'interrupted'].includes(run.status) ? run : null;
        updateRunButton();
        if (!state.currentWeekly) {
          stopWeeklyPolling();
          await refreshStatus().catch(() => {});
          if (state.view === 'weekly') renderWeeklyView();
          return;
        }
        if (state.view === 'weekly') await renderWeeklyView();
      } catch {
        stopWeeklyPolling();
      }
    }, 4000);
  }

  function stopWeeklyPolling() {
    if (weeklyPollTimer) clearInterval(weeklyPollTimer);
    weeklyPollTimer = null;
  }

  async function openWeekly(id) {
    closeAllDialogs($('#weekly-dialog'));
    const dialog = $('#weekly-dialog');
    dialog.dataset.runId = id;
    const body = $('#weekly-body');
    clear(body);
    body.append(el('div', { class: 'skeleton', style: 'height:200px' }));
    openDialog(dialog);
    try {
      const data = await api(`/api/weekly/${encodeURIComponent(id)}`);
      renderWeeklyDialog(data.run, data.proposals || []);
    } catch (err) {
      if (err.code !== 'AUTH_REQUIRED') {
        closeDialog(dialog);
        notifyError(err);
      }
    }
  }

  function renderWeeklyDialog(run, proposals) {
    if (!run) return;
    const badges = $('#weekly-badges');
    const title = $('#weekly-title');
    const meta = $('#weekly-meta');
    const body = $('#weekly-body');
    clear(badges);
    clear(meta);
    clear(body);

    title.textContent = `${run.week_key} 知识周报`;
    badges.append(statusBadge(run.status));
    badges.append(badge(run.trigger === 'auto' ? '自动触发' : '手动触发', 'mode'));
    meta.append(el('span', { text: `开始 ${fmtDate(run.started_at)}` }));
    if (run.finished_at) meta.append(el('span', { text: `结束 ${fmtDate(run.finished_at)}` }));

    const actions = el('div', { class: 'detail-actions' });
    if (['running', 'interrupted'].includes(run.status)) {
      if (run.status === 'running') {
        actions.append(
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: '取消',
            onclick: () => runWeeklyAction(run.id, 'cancel')
          })
        );
      } else {
        actions.append(
          el('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: '恢复',
            onclick: () => runWeeklyAction(run.id, 'resume')
          })
        );
      }
    }
    if (run.changes?.category_changes?.length || run.changes?.l2_actions?.length) {
      actions.append(
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '撤销本次分类调整',
          onclick: () => runWeeklyAction(run.id, 'rollback')
        })
      );
    }
    body.append(actions);

    if (run.status === 'running' || run.status === 'interrupted') {
      body.append(activeRunCard(run));
    }

    if (proposals.length) {
      body.append(el('h4', { class: 'section-label', text: '一级分类提案' }));
      const list = el('div', { class: 'proposal-list' });
      for (const proposal of proposals) list.append(proposalCard(proposal));
      body.append(list);
    }

    if (run.changes?.l2_actions?.length) {
      body.append(el('h4', { class: 'section-label', text: '二级分类调整' }));
      const list = el('div', { class: 'run-changes' });
      for (const action of run.changes.l2_actions) {
        const text = {
          create: `新建「${action.name}」于 ${action.parent_name || action.parent_key}`,
          rename: `「${action.from}」改名为「${action.to}」`,
          merge: `「${action.from}」合并到「${action.into}」`,
          archive: `归档「${action.name}」`
        }[action.action] || action.action;
        list.append(
          el(
            'div',
            { class: 'change-row' },
            el('strong', { text }),
            el('div', { class: 'muted small', text: action.reason || '' })
          )
        );
      }
      body.append(list);
    }

    const categoryChanges = run.changes?.category_changes || [];
    if (categoryChanges.length) {
      body.append(el('h4', { class: 'section-label', text: '条目重新分类' }));
      const list = el('div', { class: 'run-changes' });
      for (const change of categoryChanges) {
        const row = el('div', { class: 'change-row' });
        const line = el('div', {});
        line.append(el('strong', { text: change.title || change.entry_id }));
        if (change.manual_override) line.append(badge('手动分类被覆盖', 'manual'));
        row.append(line);
        const from = change.from?.l1_name || change.from?.l1 || '';
        const fromL2 = change.from?.l2_name ? ` · ${change.from.l2_name}` : '';
        const to = change.to?.l1_name || change.to?.l1 || '';
        const toL2 = change.to?.l2_name ? ` · ${change.to.l2_name}` : '';
        const path = el('div', { class: 'muted small' });
        path.append(document.createTextNode(`${from}${fromL2}`));
        path.append(el('span', { class: 'arrow', text: '→' }));
        path.append(document.createTextNode(`${to}${toL2}`));
        if (change.reason) path.append(document.createTextNode(` · ${change.reason}`));
        row.append(path);
        list.append(row);
      }
      body.append(list);
    }

    if (run.changes?.errors?.length) {
      body.append(el('h4', { class: 'section-label', text: '异常' }));
      const list = el('div', { class: 'run-changes' });
      for (const error of run.changes.errors) {
        list.append(
          el('div', { class: 'change-row' }, el('div', { class: 'muted small', text: error.message || String(error) }))
        );
      }
      body.append(list);
    }

    if (run.report_html) {
      body.append(el('h4', { class: 'section-label', text: '周报正文' }));
      body.append(trustedHtml('div', 'markdown weekly-report', run.report_html));
    } else {
      body.append(
        el('div', { class: 'empty' }, el('p', { text: '周报还没有生成。任务完成后会显示在这里。' }))
      );
    }
  }

  function proposalCard(proposal) {
    const payload = proposal.payload || {};
    const card = el('div', { class: 'proposal' });
    const head = el('div', { class: 'proposal-head' });
    head.append(
      badge(proposal.type === 'l1_create' ? '新建一级分类' : '归档一级分类', proposal.type === 'l1_create' ? 'cat' : 'manual')
    );
    head.append(el('strong', { text: payload.name || payload.key || '未命名' }));
    card.append(head);
    if (payload.description) card.append(el('p', { text: payload.description }));
    if (proposal.type === 'l1_archive') {
      card.append(el('p', { text: `迁移到：${payload.target_name || payload.target_key || '—'}` }));
    }
    card.append(el('p', { text: payload.reason || '' }));
    if (proposal.status === 'pending') {
      const actions = el('div', { class: 'proposal-actions' });
      actions.append(
        el('button', {
          class: 'btn btn-primary btn-sm',
          type: 'button',
          text: '批准',
          onclick: () => resolveProposal(proposal.id, 'approve')
        })
      );
      actions.append(
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '拒绝',
          onclick: () => resolveProposal(proposal.id, 'reject')
        })
      );
      card.append(actions);
    } else {
      card.append(badge(proposal.status === 'approved' ? '已批准' : '已拒绝', 'mode'));
    }
    return card;
  }

  async function resolveProposal(id, action) {
    if (action === 'approve' && !window.confirm('批准这个一级分类调整？')) return;
    await run(async () => {
      await api(`/api/proposals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      toast(action === 'approve' ? '提案已批准' : '提案已拒绝');
      await refreshCategories();
      await refreshStatus();
      if (state.view === 'weekly') renderWeeklyView();
      const dialog = $('#weekly-dialog');
      if (dialog?.open) {
        const runId = dialog.dataset.runId;
        if (runId) openWeekly(runId);
      }
    });
  }

  /* Summaries */

  async function renderSummariesView() {
    const content = $('#content');
    if (!content) return;
    clear(content);
    content.append(el('div', { class: 'skeleton', style: 'height:120px' }));
    let data;
    try {
      data = await api('/api/summaries');
    } catch (err) {
      clear(content);
      content.append(el('div', { class: 'empty' }, el('h3', { text: '加载失败' }), el('p', { text: err.message })));
      return;
    }
    clear(content);
    content.append(
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h2', { text: '分类总结' }),
          el('p', { text: '每次全量整理后按一级分类重新生成，按二级分类分节。' })
        ),
        el(
          'div',
          { class: 'page-actions' },
          el('button', {
            class: 'btn',
            type: 'button',
            text: '导出 Markdown',
            onclick: () =>
              run(async () => {
                const result = await api('/api/export/summaries', { method: 'POST', body: {} });
                toast(`已导出 ${result.files?.length || 0} 个文件`);
              })
          })
        )
      )
    );

    const summaries = data.summaries || [];
    if (!summaries.length) {
      content.append(
        el(
          'div',
          { class: 'empty' },
          el('h3', { text: '还没有分类总结' }),
          el('p', { text: '运行一次每周整理后，agent 会为每个一级分类生成总结。' })
        )
      );
      return;
    }

    const grid = el('div', { class: 'summary-grid' });
    for (const summary of summaries) {
      const card = el('article', { class: 'summary-card' });
      const head = el('div', { class: 'badge-row' });
      head.append(el('h3', { text: summary.category_name || summary.category_key }));
      head.append(badge(`${summary.entry_count || 0} 条`, 'mode'));
      card.append(head);
      card.append(
        el('div', { class: 'muted small', text: `生成于 ${fmtDate(summary.generated_at)}` })
      );
      card.append(trustedHtml('div', 'markdown', summary.content_html || ''));
      const themes = summary.themes || [];
      if (themes.length) {
        const tags = el('div', { class: 'tag-row', style: 'margin-top:10px' });
        for (const theme of themes) tags.append(el('span', { class: 'tag', text: theme }));
        card.append(tags);
      }
      if (summary.learning_order?.length) {
        const list = el('ol', { class: 'point-list', style: 'margin-top:10px' });
        for (const item of summary.learning_order) list.append(el('li', { text: item }));
        card.append(el('h4', { class: 'section-label', text: '学习顺序' }), list);
      }
      card.append(
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '查看分类内容',
          style: 'margin-top:12px',
          onclick: () => filterByCategory(summary.category_key)
        })
      );
      grid.append(card);
    }
    content.append(grid);
  }

  /* Categories management */

  async function renderCategoriesView() {
    const content = $('#content');
    if (!content) return;
    clear(content);
    try {
      await refreshCategories();
    } catch (err) {
      content.append(el('div', { class: 'empty' }, el('h3', { text: '加载失败' }), el('p', { text: err.message })));
      return;
    }
    clear(content);
    content.append(
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h2', { text: '分类管理' }),
          el('p', { text: '一级分类由你掌控；二级分类可以手动维护，每周整理也会自动调整。' })
        ),
        el(
          'div',
          { class: 'page-actions' },
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '新建分类',
            onclick: () => openCategoryDialog({ mode: 'create' })
          })
        )
      )
    );

    const tree = state.tree || [];
    if (!tree.length) {
      content.append(el('div', { class: 'empty' }, el('h3', { text: '还没有分类' })));
      return;
    }
    const table = el('div', { class: 'cat-table' });
    for (const l1 of tree) {
      table.append(manageRow(l1, 'l1'));
      for (const l2 of l1.children || []) table.append(manageRow(l2, 'l2'));
    }
    content.append(table);

    const archived = state.all.filter((category) => category.status === 'archived');
    if (archived.length) {
      content.append(el('h3', { class: 'section-label', text: '已归档' }));
      const list = el('div', { class: 'cat-table' });
      for (const category of archived) {
        const row = el('div', { class: 'cat-manage-row' });
        const name = el('div', { class: 'cat-manage-name' });
        name.append(el('strong', { text: category.name }));
        name.append(el('p', { text: category.description || '' }));
        row.append(name);
        row.append(badge('已归档', 'mode'));
        list.append(row);
      }
      content.append(list);
    }
  }

  function manageRow(category, level) {
    const row = el('div', { class: `cat-manage-row ${level}` });
    const name = el('div', { class: 'cat-manage-name' });
    name.append(el('strong', { text: category.name }));
    name.append(el('p', { text: category.description || '—' }));
    row.append(name);
    row.append(badge(`${category.count || 0} 条`, 'mode'));
    if (category.created_by === 'agent') row.append(badge('agent 创建', 'mode'));
    const actions = el('div', { class: 'cat-manage-actions' });
    if (level === 'l1') {
      actions.append(
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '加二级',
          onclick: () => openCategoryDialog({ mode: 'create', parentKey: category.key })
        })
      );
    }
    actions.append(
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '编辑',
        onclick: () => openCategoryDialog({ mode: 'edit', category })
      })
    );
    actions.append(
      el('button', {
        class: 'btn btn-sm btn-danger',
        type: 'button',
        text: '归档',
        onclick: () => openArchiveDialog(category)
      })
    );
    row.append(actions);
    return row;
  }

  function openCategoryDialog({ mode, category = null, parentKey = null }) {
    const dialog = $('#category-dialog');
    const form = $('#category-form');
    form.reset();
    $('#category-key').value = category?.key || '';
    $('#category-dialog-title').textContent = mode === 'edit' ? '编辑分类' : '新建分类';
    $('#category-dialog-hint').textContent =
      mode === 'edit'
        ? '修改名称或说明，不会影响已有条目。'
        : '二级分类可以自由调整；一级分类建议保持稳定。';

    const levelSelect = $('#category-level');
    const parentSelect = $('#category-parent');
    clear(parentSelect);
    for (const l1 of state.tree) {
      parentSelect.append(el('option', { value: l1.key, text: l1.name }));
    }
    levelSelect.value = category ? String(category.level) : parentKey ? '2' : '2';
    parentSelect.value = category?.parent_key || parentKey || state.tree[0]?.key || '';
    levelSelect.disabled = Boolean(category);
    $('#category-level-field').classList.toggle('hidden', Boolean(category));
    $('#category-parent-field').classList.toggle('hidden', levelSelect.value === '1');
    if (category) {
      $('#category-name').value = category.name || '';
      $('#category-desc').value = category.description || '';
      $('#category-parent-field').classList.toggle('hidden', category.level === 1);
    }

    levelSelect.onchange = () => {
      $('#category-parent-field').classList.toggle('hidden', levelSelect.value === '1');
    };

    form.onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        const name = $('#category-name').value.trim();
        const description = $('#category-desc').value.trim();
        if (!name) {
          toast('分类名称不能为空', 'error');
          return;
        }
        if (mode === 'edit') {
          await api(`/api/categories/${encodeURIComponent(category.key)}`, {
            method: 'PATCH',
            body: { name, description }
          });
          toast('分类已更新');
        } else {
          const level = Number(levelSelect.value);
          await api('/api/categories', {
            method: 'POST',
            body: {
              level,
              parentKey: level === 2 ? parentSelect.value : null,
              name,
              description
            }
          });
          toast('分类已创建');
        }
        closeDialog(dialog);
        await refreshCategories();
        await refreshStatus();
        if (state.view === 'categories') renderCategoriesView();
      });
    };

    openDialog(dialog);
  }

  function openArchiveDialog(category) {
    const dialog = $('#archive-dialog');
    const form = $('#archive-form');
    form.reset();
    $('#archive-key').value = category.key;
    $('#archive-desc').textContent = `「${category.name}」下的条目会迁移到目标分类，分类本身会归档，不会删除内容。`;
    const select = $('#archive-target');
    clear(select);
    if (category.level === 2) {
      select.append(el('option', { value: '', text: '迁回父分类（未细分）' }));
      const parent = state.tree.find((l1) => l1.key === category.parent_key);
      for (const sibling of parent?.children || []) {
        if (sibling.key !== category.key) {
          select.append(el('option', { value: sibling.key, text: sibling.name }));
        }
      }
    } else {
      for (const l1 of state.tree) {
        if (l1.key !== category.key) {
          select.append(el('option', { value: l1.key, text: l1.name }));
        }
      }
    }
    $('#archive-target-field').classList.toggle('hidden', category.level === 2 && select.options.length <= 1);
    form.onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        if (category.level === 1 && !select.value) {
          toast('一级分类归档需要选择迁移目标', 'error');
          return;
        }
        await api(`/api/categories/${encodeURIComponent(category.key)}`, {
          method: 'DELETE',
          body: { targetKey: select.value || null }
        });
        toast('分类已归档');
        closeDialog(dialog);
        await refreshCategories();
        await refreshStatus();
        if (state.view === 'categories') renderCategoriesView();
      });
    };
    openDialog(dialog);
  }

  /* Settings */

  function updateEndpoint() {
    const input = $('#settings-endpoint');
    if (input) input.value = `${window.location.origin}/ingest`;
  }

  async function checkConnection() {
    const statusNode = $('#settings-status');
    if (statusNode) statusNode.textContent = '检查中…';
    try {
      const healthResponse = await fetch('/health');
      const health = await healthResponse.json();
      let apiText = '';
      if (state.token) {
        try {
          await api('/api/status');
          apiText = '，Token 有效';
        } catch {
          apiText = '，Token 无效';
        }
      }
      if (statusNode) {
        statusNode.textContent = `服务正常（v${health.version || '?'}），Claude CLI ${
          health.llm === 'ok' ? '可用' : '不可用'
        }${apiText}`;
      }
    } catch {
      if (statusNode) statusNode.textContent = '无法连接服务';
    }
  }

  /* Event wiring */

  function bindEvents() {
    for (const button of $$('.nav-item')) {
      button.addEventListener('click', () => {
        const view = button.dataset.view || 'entries';
        state.view = view;
        state.category = '';
        state.status = button.dataset.status || '';
        state.deleted = button.dataset.deleted === '1';
        state.limit = PAGE_SIZE;
        state.items = [];
        state.q = '';
        const search = $('#search');
        if (search) search.value = '';
        if (view !== 'entries') {
          state.category = '';
        }
        updateNav();
        $('#topbar')?.classList.toggle('hidden', view !== 'entries');
        if (view === 'entries') loadEntries();
        else if (view === 'weekly') renderWeeklyView();
        else if (view === 'summaries') renderSummariesView();
        else if (view === 'categories') renderCategoriesView();
      });
    }

    $('#btn-refresh')?.addEventListener('click', () => {
      refreshStatus().catch(notifyError);
      refreshCategories().catch(notifyError);
      if (state.view === 'entries') loadEntries();
      else if (state.view === 'weekly') renderWeeklyView();
      else if (state.view === 'summaries') renderSummariesView();
      else if (state.view === 'categories') renderCategoriesView();
    });

    const search = $('#search');
    search?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = search.value.trim();
        state.limit = PAGE_SIZE;
        state.items = [];
        if (state.view !== 'entries') {
          state.view = 'entries';
          state.category = '';
          state.status = '';
          state.deleted = false;
          $('#topbar')?.classList.remove('hidden');
          updateNav();
        }
        loadEntries();
      }, 260);
    });

    $('#sort-select')?.addEventListener('change', (event) => {
      state.sort = event.target.value;
      state.items = [];
      loadEntries();
    });

    $('#btn-run-weekly')?.addEventListener('click', () => {
      state.view = 'weekly';
      state.category = '';
      state.status = '';
      state.deleted = false;
      updateNav();
      $('#topbar')?.classList.add('hidden');
      renderWeeklyView();
    });

    $('#btn-add-category')?.addEventListener('click', () => openCategoryDialog({ mode: 'create' }));
    $('#btn-settings')?.addEventListener('click', () => {
      $('#settings-token').value = state.token;
      updateEndpoint();
      $('#settings-status').textContent = '未检查';
      openDialog($('#settings-dialog'));
    });
    $('#btn-test')?.addEventListener('click', () => checkConnection());
    $('#btn-copy-endpoint')?.addEventListener('click', async () => {
      const value = $('#settings-endpoint')?.value || '';
      try {
        await navigator.clipboard.writeText(value);
        toast('接收地址已复制');
      } catch {
        $('#settings-endpoint')?.select();
        toast('请手动复制');
      }
    });

    $('#settings-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      state.token = $('#settings-token').value.trim();
      if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
      else localStorage.removeItem(TOKEN_KEY);
      closeDialog($('#settings-dialog'));
      toast('设置已保存');
      bootstrap();
    });

    $('#auth-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const token = $('#auth-token').value.trim();
      if (!token) return;
      state.token = token;
      localStorage.setItem(TOKEN_KEY, token);
      closeDialog($('#auth-dialog'));
      bootstrap();
    });

    $$('[data-close]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(button.closest('dialog')));
    });

    for (const dialog of $$('dialog')) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog && !dialog.classList.contains('drawer')) closeDialog(dialog);
      });
      dialog.addEventListener('close', () => {
        if (dialog.id === 'entry-dialog') {
          if (entryPollTimer) {
            clearInterval(entryPollTimer);
            entryPollTimer = null;
          }
          if (state.listDirty && state.view === 'entries') {
            state.listDirty = false;
            loadEntries();
          }
        }
      });
    }
  }

  async function bootstrap() {
    try {
      await refreshStatus();
      await refreshCategories();
    } catch (err) {
      if (err.code !== 'AUTH_REQUIRED') {
        const content = $('#content');
        if (content) {
          clear(content);
          content.append(
            el(
              'div',
              { class: 'empty' },
              el('h3', { text: '无法连接本地服务' }),
              el('p', { text: err.message || '请先启动 agent：node agent/server.js' })
            )
          );
        }
      }
      return;
    }
    updateNav();
    $('#topbar')?.classList.toggle('hidden', state.view !== 'entries');
    if (state.view === 'entries') loadEntries();
    else if (state.view === 'weekly') renderWeeklyView();
    else if (state.view === 'summaries') renderSummariesView();
    else if (state.view === 'categories') renderCategoriesView();
    updateEndpoint();
  }

  bindEvents();
  updateEndpoint();
  bootstrap();
})();
