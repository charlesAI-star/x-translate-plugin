(async function () {
  'use strict';

  const shared = window.XTR;
  const $ = (id) => document.getElementById(id);
  const els = {
    enabled: $('enabled'),
    autoTranslate: $('autoTranslate'),
    targetLang: $('targetLang'),
    providerName: $('providerName'),
    providerWarning: $('providerWarning'),
    siteHint: $('siteHint'),
    translatePage: $('translatePage'),
    openOptions: $('openOptions'),
    status: $('status'),
    version: $('version')
  };

  let settings = shared.mergeSettings(null);
  let tab = null;
  let status = null;
  let onX = false;
  let statusTimer = null;

  function tabHost() {
    try {
      return new URL(tab && tab.url ? tab.url : '').hostname;
    } catch (_) {
      return '';
    }
  }

  function isXHost(host) {
    return host === 'x.com' || host.endsWith('.x.com')
      || host === 'twitter.com' || host.endsWith('.twitter.com');
  }

  function populateLanguages() {
    els.targetLang.textContent = '';
    for (const lang of shared.LANGUAGES) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.label;
      els.targetLang.appendChild(option);
    }
  }

  function sendToTab(message, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!tab || !tab.id) return resolve({ error: { message: '没有活动标签页' } });
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ error: { message: '页面没有响应，请刷新 X 页面' } });
      }, timeoutMs);
      try {
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ error: { message: lastError.message } });
          } else {
            resolve(response || { error: { message: '页面没有响应' } });
          }
        });
      } catch (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ error: { message: String(err && err.message ? err.message : err) } });
      }
    });
  }

  function isLocalBaseUrl(raw) {
    try {
      const host = new URL(raw).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch (_) {
      return false;
    }
  }

  function renderWarning() {
    els.providerWarning.textContent = '';
    let message = '';
    if (settings.provider === 'llm' && !settings.llm.apiKey && !isLocalBaseUrl(settings.llm.baseUrl)) {
      message = '大模型还没有填写 API Key。';
    } else if (settings.provider === 'azure' && !settings.azure.key) {
      message = 'Microsoft Translator 还没有填写 Key。';
    } else if (settings.provider === 'chrome' && status && !status.chromeAvailable) {
      message = '当前 Chrome 不支持内置翻译，请在设置中换用 Google 或大模型。';
    } else if (settings.provider === 'auto' && status && !status.chromeAvailable) {
      message = '当前 Chrome 不支持内置翻译，将自动使用 Google。';
    }
    if (!message) {
      els.providerWarning.classList.add('hidden');
      return;
    }
    els.providerWarning.classList.remove('hidden');
    const text = document.createElement('span');
    text.textContent = message + ' ';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = '去设置';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    els.providerWarning.append(text, link);
  }

  function renderStatus() {
    els.status.classList.remove('error');
    if (!onX) {
      els.status.textContent = '当前标签页不在 X 上。';
      return;
    }
    if (!status) {
      els.status.textContent = '页面尚未连接。刷新 X 页面后即可使用。';
      return;
    }
    const parts = [];
    if (status.translated) parts.push(`已翻译 ${status.translated} 条`);
    if (status.pending) parts.push(`${status.pending} 条处理中`);
    if (status.errors) parts.push(`${status.errors} 条失败`);
    if (parts.length) {
      els.status.textContent = parts.join(' · ');
      if (status.errors) els.status.classList.add('error');
    } else {
      els.status.textContent = settings.autoTranslate
        ? '尚未翻译。向下滚动到外语推文即可自动翻译。'
        : '自动翻译已关闭。点击「翻译当前页」或推文下方的「翻译」。';
    }
  }

  function renderSiteHint() {
    els.siteHint.classList.remove('warn');
    if (!onX) {
      els.siteHint.textContent = '请打开 x.com 或 twitter.com 后再使用。';
      return;
    }
    if (!settings.enabled) {
      els.siteHint.textContent = '翻译已停用。打开右上角开关即可恢复。';
      return;
    }
    if (!status) {
      els.siteHint.textContent = '扩展已安装。刷新 X 页面后即可生效。';
      return;
    }
    els.siteHint.textContent = '已在当前 X 页面生效。译文会显示在原推文下方。';
  }

  function render() {
    els.enabled.checked = !!settings.enabled;
    els.autoTranslate.checked = !!settings.autoTranslate;
    els.targetLang.value = settings.targetLang;
    const info = shared.providerInfo(settings.provider);
    els.providerName.textContent = info.label;
    els.providerName.title = info.desc;
    els.translatePage.disabled = !onX || !settings.enabled;
    els.autoTranslate.disabled = !settings.enabled;
    els.targetLang.disabled = !settings.enabled;
    renderWarning();
    renderSiteHint();
    renderStatus();
  }

  async function refreshStatus() {
    if (!onX) {
      status = null;
      render();
      return;
    }
    const res = await sendToTab({ type: 'xtr:getStatus' }, 3500);
    if (res && !res.error) {
      status = res;
    } else {
      status = null;
    }
    render();
  }

  async function save(patch) {
    settings = shared.mergeSettings(Object.assign({}, settings, patch));
    try {
      await chrome.storage.local.set({ settings });
    } catch (_) {
      // Ignore storage failures; the UI still reflects the change.
    }
    render();
    refreshStatus();
  }

  function bind() {
    els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
    els.autoTranslate.addEventListener('change', () => save({ autoTranslate: els.autoTranslate.checked }));
    els.targetLang.addEventListener('change', () => save({ targetLang: els.targetLang.value }));
    els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

    els.translatePage.addEventListener('click', async () => {
      if (!onX || !settings.enabled) return;
      els.translatePage.disabled = true;
      els.translatePage.textContent = '正在排队…';
      const res = await sendToTab({ type: 'xtr:translatePage' }, 8000);
      els.translatePage.textContent = '翻译当前页';
      els.translatePage.disabled = !onX || !settings.enabled;
      if (res && !res.error) {
        if (res.status) status = res.status;
        els.status.textContent = '已开始翻译当前页面上的推文…';
        els.status.classList.remove('error');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(refreshStatus, 1400);
      } else {
        els.status.textContent = (res && res.error && res.error.message) || '无法连接当前页面，请刷新后重试。';
        els.status.classList.add('error');
      }
    });
  }

  async function init() {
    els.version.textContent = 'v' + chrome.runtime.getManifest().version;
    populateLanguages();
    bind();

    try {
      const [stored, tabs] = await Promise.all([
        chrome.storage.local.get('settings'),
        chrome.tabs.query({ active: true, currentWindow: true })
      ]);
      settings = shared.mergeSettings(stored && stored.settings);
      tab = tabs && tabs[0];
    } catch (_) {
      settings = shared.mergeSettings(null);
    }

    onX = isXHost(tabHost());
    render();
    await refreshStatus();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      settings = shared.mergeSettings(changes.settings.newValue);
      render();
    });
  }

  init();
})();
