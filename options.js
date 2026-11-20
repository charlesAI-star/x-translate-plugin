(async function () {
  'use strict';

  const shared = window.XTR;
  const core = window.XTRCore;
  const $ = (id) => document.getElementById(id);

  const els = {
    saveTop: $('saveTop'),
    saveBottom: $('saveBottom'),
    saveStatus: $('saveStatus'),
    version: $('version'),
    enabled: $('enabled'),
    autoTranslate: $('autoTranslate'),
    targetLang: $('targetLang'),
    skipTargetLang: $('skipTargetLang'),
    translateQuotes: $('translateQuotes'),
    translateBios: $('translateBios'),
    prefetchProfile: $('prefetchProfile'),
    showProviderLabel: $('showProviderLabel'),
    llmPreset: $('llmPreset'),
    llmBaseUrl: $('llmBaseUrl'),
    llmModel: $('llmModel'),
    llmApiKey: $('llmApiKey'),
    toggleApiKey: $('toggleApiKey'),
    loadModels: $('loadModels'),
    detectLocal: $('detectLocal'),
    llmToolsStatus: $('llmToolsStatus'),
    localScanResult: $('localScanResult'),
    llmModelOptions: $('llmModelOptions'),
    llmPermissionHint: $('llmPermissionHint'),
    azureKey: $('azureKey'),
    azureRegion: $('azureRegion'),
    mymemoryEmail: $('mymemoryEmail'),
    testText: $('testText'),
    testBtn: $('testBtn'),
    testResult: $('testResult'),
    minChars: $('minChars'),
    debug: $('debug'),
    clearCache: $('clearCache'),
    resetSettings: $('resetSettings')
  };

  const panels = {
    auto: $('panel-auto'),
    chrome: $('panel-chrome'),
    google: $('panel-google'),
    llm: $('panel-llm'),
    azure: $('panel-azure'),
    mymemory: $('panel-mymemory')
  };

  // The scanner talks to 127.0.0.1 only. Requesting localhost as well would
  // trigger a second prompt even when the user only has Magpie.
  const LOCAL_ORIGINS = ['http://127.0.0.1/*'];

  let settings = shared.mergeSettings(null);
  let saving = false;

  function populate() {
    els.targetLang.textContent = '';
    for (const lang of shared.LANGUAGES) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.label;
      els.targetLang.appendChild(option);
    }

    els.llmPreset.textContent = '';
    for (const [key, preset] of Object.entries(shared.LLM_PRESETS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = preset.label;
      els.llmPreset.appendChild(option);
    }
  }

  function selectedProvider() {
    const checked = document.querySelector('input[name="provider"]:checked');
    return checked ? checked.value : 'auto';
  }

  function updatePanels() {
    const provider = selectedProvider();
    for (const [id, panel] of Object.entries(panels)) {
      if (panel) panel.classList.toggle('active', id === provider);
    }
    els.llmPermissionHint.classList.add('hidden');
  }

  function applyToForm(next) {
    els.enabled.checked = !!next.enabled;
    els.autoTranslate.checked = !!next.autoTranslate;
    els.targetLang.value = next.targetLang;
    els.skipTargetLang.checked = !!next.skipTargetLang;
    els.translateQuotes.checked = !!next.translateQuotes;
    els.translateBios.checked = !!next.translateBios;
    els.prefetchProfile.checked = !!next.prefetchProfile;
    els.showProviderLabel.checked = !!next.showProviderLabel;
    els.minChars.value = String(next.minChars);
    els.debug.checked = !!next.debug;
    els.llmPreset.value = next.llm.preset;
    els.llmBaseUrl.value = next.llm.baseUrl;
    els.llmModel.value = next.llm.model;
    els.llmApiKey.value = next.llm.apiKey;
    els.azureKey.value = next.azure.key;
    els.azureRegion.value = next.azure.region;
    els.mymemoryEmail.value = next.mymemory.email;
    const radio = document.querySelector(`input[name="provider"][value="${next.provider}"]`);
    if (radio) radio.checked = true;
    updatePanels();
  }

  function readForm() {
    return shared.mergeSettings({
      enabled: els.enabled.checked,
      autoTranslate: els.autoTranslate.checked,
      targetLang: els.targetLang.value,
      provider: selectedProvider(),
      skipTargetLang: els.skipTargetLang.checked,
      translateQuotes: els.translateQuotes.checked,
      translateBios: els.translateBios.checked,
      prefetchProfile: els.prefetchProfile.checked,
      showProviderLabel: els.showProviderLabel.checked,
      minChars: Number(els.minChars.value),
      debug: els.debug.checked,
      llm: {
        preset: els.llmPreset.value,
        baseUrl: els.llmBaseUrl.value,
        apiKey: els.llmApiKey.value,
        model: els.llmModel.value,
        temperature: 0.2
      },
      azure: {
        key: els.azureKey.value,
        region: els.azureRegion.value
      },
      mymemory: {
        email: els.mymemoryEmail.value
      }
    });
  }

  function validate(next) {
    if (next.provider === 'llm') {
      if (!next.llm.baseUrl) return '请填写大模型的 API 地址。';
      if (!next.llm.model) return '请填写模型名称。';
      try {
        core.normalizeBaseUrl(next.llm.baseUrl);
      } catch (err) {
        return 'API 地址无效：' + err.message;
      }
      if (!next.llm.apiKey && !core.isLocalhostUrl(next.llm.baseUrl)) {
        return '大模型还没有填写 API Key。';
      }
    }
    if (next.provider === 'azure' && !next.azure.key) {
      return 'Microsoft Translator 还没有填写 Key。';
    }
    return '';
  }

  function setSaveStatus(message, type = '') {
    els.saveStatus.textContent = message;
    els.saveStatus.className = 'save-status' + (type ? ' ' + type : '');
  }

  let toastTimer = null;
  function showToast(message) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3000);
  }

  /**
   * Must be called synchronously from a click handler: Chrome only allows
   * permissions.request during a user gesture. Resolves true if the origin is
   * already granted.
   */
  function requestLlmPermission() {
    if (selectedProvider() !== 'llm') return Promise.resolve(true);
    const raw = els.llmBaseUrl.value.trim();
    if (!raw) return Promise.resolve(true);
    let origin;
    try {
      origin = core.originPattern(core.normalizeBaseUrl(raw));
    } catch (_) {
      return Promise.resolve(true);
    }
    if (!origin) return Promise.resolve(true);
    try {
      return chrome.permissions.request({ origins: [origin] });
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  function showPermissionHint(granted) {
    if (granted) {
      els.llmPermissionHint.classList.add('hidden');
      return;
    }
    els.llmPermissionHint.classList.remove('hidden');
    els.llmPermissionHint.textContent = '未授权访问这个大模型 API 域名。扩展可能无法发出翻译请求，请重新保存并允许权限。';
  }

  function setLlmToolsStatus(message, type = '') {
    els.llmToolsStatus.textContent = message || '';
    els.llmToolsStatus.className = 'scan-status' + (type ? ' ' + type : '');
  }

  function clearModelOptions() {
    els.llmModelOptions.textContent = '';
  }

  function fillModelOptions(models) {
    clearModelOptions();
    for (const model of models || []) {
      const option = document.createElement('option');
      option.value = model;
      els.llmModelOptions.appendChild(option);
    }
  }

  function requestLocalPermissions() {
    try {
      return chrome.permissions.request({ origins: LOCAL_ORIGINS });
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  function renderScanResults(results) {
    els.localScanResult.textContent = '';
    els.localScanResult.classList.toggle('hidden', !results.length);
    for (const item of results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scan-item';

      const name = document.createElement('span');
      name.className = 'scan-name';
      name.textContent = item.name;

      const meta = document.createElement('span');
      meta.className = 'scan-meta';
      const count = item.authRequired ? '需要 API Key' : ((item.models || []).length + ' 个模型');
      meta.textContent = item.baseUrl + ' · ' + count;

      button.append(name, meta);
      button.addEventListener('click', () => {
        for (const other of els.localScanResult.querySelectorAll('.scan-item')) {
          other.classList.remove('active');
        }
        button.classList.add('active');
        if (item.preset) els.llmPreset.value = item.preset;
        els.llmBaseUrl.value = item.baseUrl;
        if (item.apiKey) els.llmApiKey.value = item.apiKey;
        const models = item.models || [];
        fillModelOptions(models);
        const currentModel = els.llmModel.value.trim();
        if (models.length === 1) els.llmModel.value = models[0];
        else if (currentModel && !models.includes(currentModel)) els.llmModel.value = '';
        if (item.authRequired) {
          setLlmToolsStatus('已填入地址，请填写 API Key 后点「获取模型」。');
        } else if (models.length) {
          setLlmToolsStatus('找到 ' + models.length + ' 个模型，请从「模型名称」下拉选择。', 'success');
        } else {
          setLlmToolsStatus('已填入地址；请手动填写模型名称。');
        }
      });
      els.localScanResult.appendChild(button);
    }
  }

  async function detectLocalServices() {
    // permissions.request must run before the first await (user gesture).
    const permissionPromise = requestLocalPermissions();
    const granted = await permissionPromise;
    if (!granted) {
      setLlmToolsStatus('未授权访问本机服务。可以在扩展详情页的「网站访问权限」里允许 127.0.0.1。', 'error');
      return;
    }
    els.detectLocal.disabled = true;
    els.localScanResult.textContent = '';
    els.localScanResult.classList.add('hidden');
    setLlmToolsStatus('正在扫描 127.0.0.1 常见端口…');
    const res = await sendRuntime({ type: 'xtr:scanLocal' }, 15000);
    els.detectLocal.disabled = false;
    if (!res || !res.ok) {
      setLlmToolsStatus((res && res.error && res.error.message) || '检测失败', 'error');
      return;
    }
    const results = Array.isArray(res.results) ? res.results : [];
    if (!results.length) {
      setLlmToolsStatus('没有找到本地服务。请确认 Magpie / Ollama / LM Studio 已启动，或手动填写 Base URL。', 'error');
      return;
    }
    setLlmToolsStatus('找到 ' + results.length + ' 个本地服务，点一项填入。', 'success');
    renderScanResults(results);
  }

  async function loadModelList() {
    const raw = els.llmBaseUrl.value.trim();
    if (!raw) {
      setLlmToolsStatus('请先填写或检测 Base URL。', 'error');
      return;
    }
    // Keep this synchronous: Chrome needs the click's user gesture.
    const permissionPromise = requestLlmPermission();
    const granted = await permissionPromise;
    if (!granted) {
      setLlmToolsStatus('未授权访问这个 API 域名，请重新点「获取模型」并允许权限。', 'error');
      return;
    }
    els.loadModels.disabled = true;
    setLlmToolsStatus('正在读取模型列表…');
    const res = await sendRuntime({
      type: 'xtr:listModels',
      baseUrl: raw,
      apiKey: els.llmApiKey.value.trim()
    }, 20000);
    els.loadModels.disabled = false;
    if (!res || !res.ok) {
      setLlmToolsStatus((res && res.error && res.error.message) || '读取模型列表失败', 'error');
      return;
    }
    const models = Array.isArray(res.models) ? res.models : [];
    fillModelOptions(models);
    if (models.length === 1) els.llmModel.value = models[0];
    if (models.length) {
      setLlmToolsStatus('找到 ' + models.length + ' 个模型，请从「模型名称」下拉选择。', 'success');
    } else {
      setLlmToolsStatus('服务已连接，但没有返回模型；请手动填写模型名称。', 'error');
    }
  }

  async function save() {
    if (saving) return;
    saving = true;
    const permissionPromise = requestLlmPermission();
    const next = readForm();
    const problem = validate(next);
    if (problem) {
      setSaveStatus(problem, 'error');
      saving = false;
      return;
    }

    const granted = await permissionPromise;
    showPermissionHint(granted);

    try {
      await chrome.storage.local.set({ settings: next });
      settings = next;
      setSaveStatus('已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'success');
      showToast('设置已保存');
    } catch (err) {
      setSaveStatus('保存失败：' + (err && err.message ? err.message : err), 'error');
    } finally {
      saving = false;
    }
  }

  function sendRuntime(message, timeoutMs = 130000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: { message: '测试超时，请检查网络或代理' } });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: { message: lastError.message } });
          } else {
            resolve(response || { ok: false, error: { message: '后台没有响应' } });
          }
        });
      } catch (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: { message: String(err && err.message ? err.message : err) } });
      }
    });
  }

  function detectLanguage(text) {
    return new Promise((resolve) => {
      try {
        if (!chrome.i18n || !chrome.i18n.detectLanguage) return resolve('');
        chrome.i18n.detectLanguage(text, (result) => {
          const langs = result && Array.isArray(result.languages) ? result.languages : [];
          resolve(langs.length ? shared.normalizeLangTag(langs[0].language) : '');
        });
      } catch (_) {
        resolve('');
      }
    });
  }

  function setTestResult(text, type = '') {
    els.testResult.textContent = text;
    els.testResult.className = 'test-result' + (type ? ' ' + type : '');
  }

  async function testLocal(next, text) {
    if (typeof Translator === 'undefined') {
      throw new Error('当前 Chrome 不支持内置翻译 API（需要 Chrome 138+）');
    }
    let source = await detectLanguage(text);
    if (!source) source = core.detectScript(text) || 'en';
    const target = shared.chromeLangCode(next.targetLang);
    if (!target) throw new Error('目标语言无效');
    if (shared.sameLanguage(source, target)) {
      throw new Error('测试文本已经是目标语言，请换一段外文文本');
    }
    const availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    if (availability === 'unavailable') {
      throw new Error(`Chrome 内置翻译不支持 ${source} → ${target}`);
    }
    const translator = await Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener('downloadprogress', (ev) => {
          const total = Number(ev.total);
          const loaded = Number(ev.loaded);
          const pct = total > 1 ? loaded / total : loaded;
          if (pct < 1) {
            setTestResult('正在下载本地翻译模型… ' + Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%');
          }
        });
      }
    });
    const started = Date.now();
    const out = await translator.translate(text);
    return { ok: true, text: out, sourceLang: source, provider: 'chrome', ms: Date.now() - started };
  }

  async function runTest() {
    const permissionPromise = requestLlmPermission();
    const next = readForm();
    const provider = next.provider;
    const problem = validate(next);
    if (problem) {
      setTestResult(problem, 'error');
      return;
    }
    if (provider === 'llm' || provider === 'azure') {
      const granted = await permissionPromise;
      showPermissionHint(granted);
    }

    const text = (els.testText.value || '').trim().slice(0, 2000);
    if (!text) {
      setTestResult('请输入测试文本。', 'error');
      return;
    }

    els.testBtn.disabled = true;
    els.testBtn.textContent = '测试中…';
    setTestResult('正在测试…');
    const started = Date.now();

    try {
      let result;
      if (provider === 'auto' || provider === 'chrome') {
        try {
          result = await testLocal(next, text);
        } catch (localErr) {
          if (provider === 'chrome') throw localErr;
          const remote = await sendRuntime({
            type: 'xtr:test',
            provider: 'google',
            targetLang: next.targetLang,
            text,
            overrides: { llm: next.llm, azure: next.azure, mymemory: next.mymemory }
          });
          if (!remote || !remote.ok) {
            throw new Error('本地翻译不可用（' + localErr.message + '），Google 也失败：' + ((remote && remote.error && remote.error.message) || '未知错误'));
          }
          result = remote;
        }
      } else {
        const remote = await sendRuntime({
          type: 'xtr:test',
          provider,
          targetLang: next.targetLang,
          text,
          overrides: { llm: next.llm, azure: next.azure, mymemory: next.mymemory }
        });
        if (!remote || !remote.ok) {
          throw new Error((remote && remote.error && remote.error.message) || '测试失败');
        }
        result = remote;
      }

      const info = shared.providerInfo(result.provider || provider);
      const label = result.provider === 'chrome' ? 'Chrome 本地' : info.label;
      const ms = result.ms != null ? result.ms : Date.now() - started;
      setTestResult(`✓ ${label}（${ms} ms）\n${result.text}`, 'success');
    } catch (err) {
      setTestResult('✗ ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      els.testBtn.disabled = false;
      els.testBtn.textContent = '测试当前配置';
    }
  }

  function bind() {
    elSaveButtons();
    document.querySelectorAll('input[name="provider"]').forEach((input) => {
      input.addEventListener('change', updatePanels);
    });

    els.llmPreset.addEventListener('change', () => {
      const preset = shared.LLM_PRESETS[els.llmPreset.value];
      if (!preset) return;
      if (preset.baseUrl) els.llmBaseUrl.value = preset.baseUrl;
      if (preset.model) els.llmModel.value = preset.model;
      else if (els.llmPreset.value === 'magpie' || els.llmPreset.value === 'localrouter') els.llmModel.value = '';
      if (preset.apiKey) els.llmApiKey.value = preset.apiKey;
      clearModelOptions();
      setLlmToolsStatus('');
      els.localScanResult.classList.add('hidden');
      els.llmPermissionHint.classList.add('hidden');
    });

    els.llmBaseUrl.addEventListener('input', () => {
      clearModelOptions();
      setLlmToolsStatus('');
    });

    els.detectLocal.addEventListener('click', detectLocalServices);
    els.loadModels.addEventListener('click', loadModelList);

    els.toggleApiKey.addEventListener('click', () => {
      const showing = els.llmApiKey.type === 'text';
      els.llmApiKey.type = showing ? 'password' : 'text';
      els.toggleApiKey.textContent = showing ? '显示' : '隐藏';
    });

    els.testBtn.addEventListener('click', runTest);
    els.clearCache.addEventListener('click', async () => {
      const res = await sendRuntime({ type: 'xtr:clearCache' }, 10000);
      if (res && res.ok) showToast('翻译缓存已清除');
      else showToast('清除缓存失败');
    });

    els.resetSettings.addEventListener('click', async () => {
      if (!window.confirm('恢复默认设置？API Key 等配置也会被清空。')) return;
      settings = shared.mergeSettings(null);
      await chrome.storage.local.set({ settings });
      applyToForm(settings);
      setSaveStatus('已恢复默认设置', 'success');
      showToast('已恢复默认设置');
    });

    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    });
  }

  function elSaveButtons() {
    els.saveTop.addEventListener('click', save);
    els.saveBottom.addEventListener('click', save);
  }

  async function init() {
    populate();
    els.version.textContent = chrome.runtime.getManifest().version;
    try {
      const stored = await chrome.storage.local.get('settings');
      settings = shared.mergeSettings(stored && stored.settings);
    } catch (_) {
      settings = shared.mergeSettings(null);
    }
    applyToForm(settings);
    bind();
  }

  init();
})();
