#!/usr/bin/env node
/**
 * End-to-end test for the X translation extension.
 *
 * Loads the real extension (with the content-script host changed to a local
 * fixture domain) into Chrome for Testing, serves a fake timeline, points the
 * LLM provider at a local mock endpoint, and checks the user-visible behavior.
 *
 * Run:
 *   npm install
 *   CHROME_PATH="/path/to/Google Chrome for Testing" npm run test:e2e
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const TEST_HOST = 'x.test';
const FIXTURE = path.join(__dirname, 'fixture.html');

const TRANSLATIONS = {
  'This is a test tweet about AI.': '这是一条关于人工智能的测试推文。',
  'これは日本語のツイートです。': '这是一条日语推文。',
  'Look at this quote:': '看看这个引用：',
  'This is the quoted tweet.': '这是被引用的推文。',
  'A newly inserted tweet.': '一条新插入的推文。'
};

const MOCK_MODELS = ['mock-model', 'mock-group/route'];

function profileHtml(count = 12) {
  const items = [];
  for (let i = 1; i <= count; i++) {
    items.push(
      '<article data-testid="tweet" id="tweet-' + i + '" style="display:block;height:300px;padding:20px;box-sizing:border-box">'
      + '<div data-testid="tweetText" lang="en">Profile tweet ' + i + ': a test post about AI and productivity.</div>'
      + '</article>'
    );
  }
  return '<!doctype html><html><head><meta charset="utf-8"><title>profile</title></head>'
    + '<body style="margin:0"><div id="timeline">' + items.join('') + '</div></body></html>';
}

function articleHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>article</title></head><body>'
    + '<article>'
    + '<h1 id="article-title" data-article-part="title">How to build a knowledge factory</h1>'
    + '<div data-article-part="body"><div class="x-article-body"><div class="contents">'
    + '<p id="article-p1">In order to make AI work for your company, you need better knowledge.</p>'
    + '<h3 id="article-h3">Context vs knowledge</h3>'
    + '<p id="article-p2">Context is what an agent has available when doing a task.</p>'
    + '<ul><li id="article-li">How to do the work - Skills.</li></ul>'
    + '</div></div></div>'
    + '</article></body></html>';
}

// Older X article reader: title is twitter-article-title, and the body is a
// read-only Draft.js editor. Paragraphs are div.longform-unstyled; headings are
// h2.longform-header-two wrapping a Draft block.
function draftArticleHtml() {
  const block = (id, text, tag) => {
    const inner = '<div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">'
      + '<span><span data-text="true"' + (id ? ' id="' + id + '"' : '') + '>' + text + '</span></span>'
      + '</div>';
    return tag === 'h2'
      ? '<div class="css-146c3p1"><h2 class="longform-header-two">' + inner + '</h2></div>'
      : '<div class="longform-unstyled">' + inner + '</div>';
  };
  return '<!doctype html><html><head><meta charset="utf-8"><title>draft article</title></head><body>'
    + '<article data-testid="tweet">'
    + '<article data-testid="twitterArticleReadView">'
    + '<div data-testid="twitter-article-title"><span id="draft-title">How to build a knowledge factory</span></div>'
    + '<div data-testid="twitterArticleRichTextView"><div><div class="DraftEditor-root">'
    + '<div class="DraftEditor-editorContainer">'
    + '<div data-testid="longformRichTextComponent" class="public-DraftEditor-content"><div>'
    + block('draft-p1', 'In order to make AI work for your company, you need better knowledge.')
    + block('draft-h2', 'Context vs knowledge', 'h2')
    + block('draft-p2', 'Context is what an agent has available when doing a task.')
    + '<ul><li id="draft-li" class="longform-unordered-list-item">Early AI frameworks.</li></ul>'
    + '</div></div></div></div></div></div>'
    + '</article></article></body></html>';
}

function copyTweetHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>copy tweet</title></head><body>'
    + '<article data-testid="tweet" id="copy-tweet">'
    + '<div data-testid="User-Name"><a href="/alice"><span>Alice</span></a>'
    + '<a href="/alice"><span>@alice</span></a></div>'
    + '<a href="/alice/status/789"><time datetime="2026-11-24T18:00:00.000Z">Nov 24</time></a>'
    + '<div data-testid="tweetText" lang="zh">第一行<img alt="😀"><br>第二行<br>看这个：'
    + '<a href="https://t.co/abc123" title="https://example.com/full/path?x=1">example.com/full/pa…</a>'
    + '<div data-testid="tweet-text-show-more-link">显示更多</div>'
    + '</div>'
    + '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/abc123?format=jpg&name=small" alt="一张图表"></div>'
    + '<div role="group" id="copy-actions"><button type="button" data-testid="reply">回复</button>'
    + '<button type="button" data-testid="like">喜欢</button></div>'
    + '<div role="link"><article data-testid="tweet" id="quoted-tweet">'
    + '<div data-testid="User-Name"><a href="/bob"><span>Bob</span></a></div>'
    + '<a href="/bob/status/654"><time datetime="2026-11-24T17:00:00.000Z">Nov 24</time></a>'
    + '<div data-testid="tweetText" lang="en">Quoted text should not be copied.</div>'
    + '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quotedimg?format=png&name=small" alt="引用图"></div>'
    + '<div role="group"><button type="button" data-testid="like">like</button></div>'
    + '</article></div>'
    + '</article></body></html>';
}

function copyArticleHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>copy article</title></head><body>'
    + '<article data-testid="tweet"><article data-testid="twitterArticleReadView">'
    + '<div data-testid="User-Name"><a href="/alice"><span>Alice</span></a></div>'
    + '<div data-testid="twitter-article-title"><span id="copy-article-title">如何构建知识工厂</span></div>'
    + '<div data-testid="twitterArticleRichTextView"><div>'
    + '<div class="longform-unstyled"><div class="public-DraftStyleDefault-block"><span>第一段。</span></div></div>'
    + '<div class="css-copy"><h2 class="longform-header-two"><div class="public-DraftStyleDefault-block"><span>小标题</span></div></h2></div>'
    + '<div class="longform-unstyled"><div class="public-DraftStyleDefault-block"><span>第二段，见 '
    + '<a href="https://t.co/xyz789" title="https://example.com/a/b?c=1">example.com/a/b…</a>。</span></div></div>'
    + '<ul><li class="longform-unordered-list-item">列表项一</li>'
    + '<li class="longform-unordered-list-item">列表项二</li></ul>'
    + '<figure><img src="https://pbs.twimg.com/media/def456?format=jpg&name=small" alt="架构图">'
    + '<figcaption>图片说明</figcaption></figure>'
    + '</div></div></article></article></body></html>';
}

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (_) {
  console.error('缺少 puppeteer-core。请先在项目目录运行：npm install');
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(ROOT, '.cache', 'chrome');
  if (!fs.existsSync(cache)) return '';
  const wanted = new Set(['Google Chrome for Testing', 'chrome', 'chrome.exe']);
  const stack = [cache];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.has(entry.name)) return full;
    }
  }
  return '';
}

function copyExtension(tmpRoot) {
  const extDir = path.join(tmpRoot, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  const items = [
    'manifest.json', 'background.js', 'content.js', 'content.css',
    'popup.html', 'popup.css', 'popup.js',
    'options.html', 'options.css', 'options.js',
    'lib', 'icons'
  ];
  for (const item of items) {
    fs.cpSync(path.join(ROOT, item), path.join(extDir, item), { recursive: true });
  }

  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const script of manifest.content_scripts || []) {
    script.matches = ['http://' + TEST_HOST + '/*', 'http://127.0.0.1/*'];
  }
  manifest.host_permissions = Array.from(new Set([
    ...(manifest.host_permissions || []),
    'http://127.0.0.1/*'
  ]));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return extDir;
}

function startServer() {
  const requests = [];
  const ingestRequests = [];
  const healthChecks = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/fixture.html')) {
      const html = fs.readFileSync(FIXTURE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      healthChecks.push({ authorization: req.headers.authorization || '' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        service: 'mock-agent',
        version: '0.1.0',
        schema: 'xtr.capture/1',
        authRequired: true
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/ingest') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'invalid JSON' } }));
          return;
        }
        if (req.headers.authorization !== 'Bearer test-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }));
          return;
        }
        ingestRequests.push({ headers: req.headers, body });
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          id: body.id,
          status: 'queued',
          category: '测试分类',
          message: '已入队'
        }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/alice') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(profileHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/alice/status/123') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(articleHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/alice/status/456') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(draftArticleHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/copy-tweet') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(copyTweetHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/copy-article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(copyArticleHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        object: 'list',
        data: MOCK_MODELS.map((id) => ({ id, object: 'model' }))
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
          return;
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const last = messages[messages.length - 1];
        let texts = [];
        try {
          texts = JSON.parse(last && last.content ? last.content : '[]');
        } catch (_) {
          texts = [];
        }
        if (!Array.isArray(texts)) texts = [];
        requests.push({ model: body.model, texts });
        const out = texts.map((text) => TRANSLATIONS[text] || ('译：' + text));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }]
        }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, requests, ingestRequests, healthChecks });
    });
  });
}

async function openExtensionPage(browser, extId, page = null) {
  const tab = page || await browser.newPage();
  await tab.goto('chrome-extension://' + extId + '/options.html', { waitUntil: 'domcontentloaded' });
  return tab;
}

async function setSettings(browser, extId, settings) {
  const tab = await openExtensionPage(browser, extId);
  await tab.evaluate(async (next) => {
    await chrome.storage.local.set({ settings: next });
  }, settings);
  await tab.close();
}

async function waitForTranslations(page, expected, timeout = 30000) {
  await page.waitForFunction((texts) => {
    const found = new Set(Array.from(document.querySelectorAll('.xtr-block .xtr-text'), (el) => el.textContent.trim()));
    return texts.every((text) => found.has(text));
  }, { timeout }, expected);
}

async function blockText(page, selector) {
  return page.$eval(selector, (el) => el.textContent.trim());
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('找不到 Chrome for Testing。请设置 CHROME_PATH，或用 npx @puppeteer/browsers 安装。');
    process.exit(1);
  }
  if (!fs.existsSync(chromePath)) {
    console.error('CHROME_PATH 不存在：' + chromePath);
    process.exit(1);
  }

  const { server, port, requests, ingestRequests, healthChecks } = await startServer();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtr-e2e-'));
  const extDir = copyExtension(tmpRoot);
  const profile = path.join(tmpRoot, 'profile');
  const pageUrl = 'http://' + TEST_HOST + ':' + port + '/fixture.html';

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-proxy-server',
        '--host-resolver-rules=MAP ' + TEST_HOST + ' 127.0.0.1',
        '--user-data-dir=' + profile,
        '--disable-extensions-except=' + extDir,
        '--load-extension=' + extDir
      ]
    });

    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 20000 }
    );
    const extId = new URL(workerTarget.url()).host;

    const settings = {
      enabled: true,
      autoTranslate: true,
      targetLang: 'zh-CN',
      provider: 'llm',
      skipTargetLang: true,
      translateQuotes: true,
      translateBios: false,
      prefetchProfile: true,
      showProviderLabel: true,
      minChars: 2,
      debug: true,
      llm: {
        preset: 'custom',
        baseUrl: 'http://127.0.0.1:' + port + '/v1',
        model: 'mock',
        apiKey: '',
        temperature: 0.2
      },
      superCopy: {
        enabled: true,
        endpoint: 'http://127.0.0.1:' + port + '/ingest',
        token: 'test-token',
        mode: 'full',
        includeQuoted: true,
        includeMedia: true
      }
    };
    await setSettings(browser, extId, settings);

    // Extension pages render and populate their language lists.
    const optionsPage = await browser.newPage();
    const optionsErrors = [];
    optionsPage.on('pageerror', (err) => optionsErrors.push(err.message));
    await optionsPage.goto('chrome-extension://' + extId + '/options.html', { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForSelector('#targetLang');
    assert.equal(await optionsPage.$$eval('input[name="provider"]', (els) => els.length), 6);
    assert.ok(await optionsPage.$$eval('#targetLang option', (els) => els.length) >= 20);
    assert.equal(await optionsPage.$eval('#targetLang', (el) => el.value), 'zh-CN');
    assert.equal(await optionsPage.$eval('#superCopyMode', (el) => el.value), 'full');

    // The LLM panel can list models from the configured /v1/models endpoint.
    await optionsPage.click('#loadModels');
    await optionsPage.waitForFunction(
      () => document.querySelectorAll('#llmModelOptions option').length >= 2,
      { timeout: 10000 }
    );
    const modelOptions = await optionsPage.$$eval('#llmModelOptions option', (els) => els.map((el) => el.value));
    assert.deepEqual(modelOptions.sort(), MOCK_MODELS.slice().sort());
    assert.match(await optionsPage.$eval('#llmToolsStatus', (el) => el.textContent), /2 个模型/);

    // The super-copy target can be checked from the options page.
    await optionsPage.click('#testSuperCopy');
    await optionsPage.waitForFunction(
      () => document.querySelector('#superCopyStatus').textContent.includes('✓'),
      { timeout: 10000 }
    );
    assert.match(await optionsPage.$eval('#superCopyStatus', (el) => el.textContent), /mock-agent/);
    assert.equal(healthChecks.length, 1);
    assert.equal(healthChecks[0].authorization, 'Bearer test-token');
    console.log('✓ 设置页测试 Agent 健康检查');

    // Choosing the Magpie preset fills its local gateway but does not switch
    // the provider by itself; the user still saves manually.
    await optionsPage.select('#llmPreset', 'magpie');
    const magpie = await optionsPage.evaluate(() => ({
      baseUrl: document.getElementById('llmBaseUrl').value,
      apiKey: document.getElementById('llmApiKey').value,
      model: document.getElementById('llmModel').value,
      provider: document.querySelector('input[name="provider"]:checked')?.value
    }));
    assert.equal(magpie.baseUrl, 'http://127.0.0.1:3425/v1');
    assert.equal(magpie.apiKey, 'magpie');
    assert.equal(magpie.model, '');
    assert.equal(magpie.provider, 'llm');
    assert.deepEqual(optionsErrors, []);
    if (process.env.XTR_E2E_SCREENSHOTS === '1') {
      const shots = path.join(__dirname, '.tmp');
      fs.mkdirSync(shots, { recursive: true });
      await optionsPage.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });
    }
    await optionsPage.close();

    const popupPage = await browser.newPage();
    const popupErrors = [];
    popupPage.on('pageerror', (err) => popupErrors.push(err.message));
    await popupPage.goto('chrome-extension://' + extId + '/popup.html', { waitUntil: 'domcontentloaded' });
    await popupPage.waitForSelector('#enabled');
    assert.ok(await popupPage.$$eval('#targetLang option', (els) => els.length) >= 20);
    assert.equal(await popupPage.$eval('#providerWarning', (el) => el.classList.contains('hidden')), true);
    assert.deepEqual(popupErrors, []);
    if (process.env.XTR_E2E_SCREENSHOTS === '1') {
      await popupPage.setViewport({ width: 380, height: 620, deviceScaleFactor: 2 });
      await popupPage.screenshot({ path: path.join(__dirname, '.tmp', 'popup.png') });
    }
    await popupPage.close();
    console.log('✓ 设置页和弹窗正常渲染');

    const page = await browser.newPage();
    const logs = [];
    page.on('console', (msg) => logs.push(msg.text()));
    page.on('pageerror', (err) => logs.push('PAGEERROR ' + err.message));
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const expected = [
      TRANSLATIONS['This is a test tweet about AI.'],
      TRANSLATIONS['これは日本語のツイートです。'],
      TRANSLATIONS['Look at this quote:'],
      TRANSLATIONS['This is the quoted tweet.']
    ];
    await waitForTranslations(page, expected);
    if (process.env.XTR_E2E_SCREENSHOTS === '1') {
      await page.screenshot({ path: path.join(__dirname, '.tmp', 'fixture.png'), fullPage: true });
    }
    console.log('✓ 外语推文自动翻译');
    console.log('✓ 引用推文一并翻译');

    assert.equal(await blockText(page, '#tweet-en .xtr-block .xtr-text'), expected[0]);
    assert.equal(await blockText(page, '#tweet-quote .quoted .xtr-block .xtr-text'), expected[3]);
    assert.equal(await page.$eval('#tweet-en .xtr-block .xtr-provider', (el) => el.textContent.trim()), 'AI');

    const chineseBlocks = await page.$$eval('#tweet-zh .xtr-block', (els) => els.length);
    assert.equal(chineseBlocks, 0, '中文推文不应出现译文');
    console.log('✓ 中文推文被跳过');

    // New tweet inserted into the virtualized timeline.
    await page.evaluate(() => {
      const article = document.createElement('article');
      article.dataset.testid = 'tweet';
      article.id = 'tweet-new';
      const text = document.createElement('div');
      text.dataset.testid = 'tweetText';
      text.lang = 'en';
      text.textContent = 'A newly inserted tweet.';
      article.appendChild(text);
      document.getElementById('timeline').appendChild(article);
    });
    await waitForTranslations(page, [TRANSLATIONS['A newly inserted tweet.']]);
    console.log('✓ 新推文插入后自动翻译');

    // Hide and restore.
    await page.evaluate(() => {
      const block = document.querySelector('#tweet-en .xtr-block');
      block.querySelector('[data-xtr-action="hide"]').click();
    });
    await page.waitForFunction(() => !!document.querySelector('#tweet-en .xtr-chip'), { timeout: 5000 });
    assert.equal(await page.$$eval('#tweet-en .xtr-block', (els) => els.length), 0);
    assert.equal(await page.$eval('#tweet-en .xtr-chip', (el) => el.textContent.trim()), '显示译文');
    await page.evaluate(() => document.querySelector('#tweet-en .xtr-chip').click());
    await page.waitForFunction(
      (text) => {
        const el = document.querySelector('#tweet-en .xtr-block .xtr-text');
        return !!el && el.textContent.trim() === text;
      },
      { timeout: 10000 },
      expected[0]
    );
    console.log('✓ 隐藏后可以再显示译文');

    // Manual mode: after reload no blocks, each tweet gets a "翻译" chip.
    settings.autoTranslate = false;
    await setSettings(browser, extId, settings);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#tweet-en .xtr-chip'), { timeout: 10000 });
    assert.equal(await page.$$eval('.xtr-block', (els) => els.length), 0, '手动模式不应自动出现译文');
    assert.equal(await page.$eval('#tweet-en .xtr-chip', (el) => el.textContent.trim()), '翻译');
    await page.evaluate(() => document.querySelector('#tweet-en .xtr-chip').click());
    await page.waitForFunction(
      (text) => {
        const el = document.querySelector('#tweet-en .xtr-block .xtr-text');
        return !!el && el.textContent.trim() === text;
      },
      { timeout: 15000 },
      expected[0]
    );
    console.log('✓ 手动模式点击后翻译');

    // Profile pages prefetch the first batch of posts, including posts below
    // the viewport, so scrolling does not wait for a new LLM round trip.
    settings.autoTranslate = true;
    await setSettings(browser, extId, settings);
    const profilePage = await browser.newPage();
    await profilePage.setViewport({ width: 1280, height: 800 });
    await profilePage.goto('http://' + TEST_HOST + ':' + port + '/alice', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await profilePage.waitForFunction(
      () => {
        const el = document.querySelector('#tweet-12 .xtr-block[data-xtr-state="done"] .xtr-text');
        return !!el && el.textContent.trim() === '译：Profile tweet 12: a test post about AI and productivity.';
      },
      { timeout: 15000 }
    );
    assert.equal(await profilePage.$$eval('.xtr-block', (els) => els.length), 12);
    console.log('✓ 个人主页提前翻译屏外推文');
    await profilePage.close();

    // X's new article view has no data-testid attributes. The title, body
    // paragraphs, headings and list items live under data-article-part and
    // .x-article-body.
    const articlePage = await browser.newPage();
    await articlePage.setViewport({ width: 1280, height: 1000 });
    await articlePage.goto('http://' + TEST_HOST + ':' + port + '/alice/status/123', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await articlePage.waitForFunction(
      () => document.querySelectorAll('.xtr-block[data-xtr-state="done"]').length >= 5,
      { timeout: 15000 }
    );
    assert.equal(
      await blockText(articlePage, '#article-title ~ .xtr-block .xtr-text'),
      '译：How to build a knowledge factory'
    );
    assert.equal(
      await blockText(articlePage, '#article-p1 + .xtr-block .xtr-text'),
      '译：In order to make AI work for your company, you need better knowledge.'
    );
    assert.equal(
      await blockText(articlePage, '#article-h3 + .xtr-block .xtr-text'),
      '译：Context vs knowledge'
    );
    assert.equal(
      await blockText(articlePage, '#article-li .xtr-block .xtr-text'),
      '译：How to do the work - Skills.'
    );
    console.log('✓ X 文章标题、正文段落和列表项翻译');
    await articlePage.close();

    // Older X article reader (Draft.js): paragraphs are div.longform-unstyled
    // instead of <p>, and the body has no .x-article-body wrapper.
    const draftPage = await browser.newPage();
    await draftPage.setViewport({ width: 1280, height: 1000 });
    await draftPage.goto('http://' + TEST_HOST + ':' + port + '/alice/status/456', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await draftPage.waitForFunction(
      () => document.querySelectorAll('.xtr-block[data-xtr-state="done"]').length >= 5,
      { timeout: 15000 }
    );
    assert.equal(
      await blockText(draftPage, '[data-testid="twitter-article-title"] ~ .xtr-block .xtr-text'),
      '译：How to build a knowledge factory'
    );
    assert.equal(
      await draftPage.evaluate(() => {
        const block = document.getElementById('draft-p1').closest('.longform-unstyled');
        return block && block.nextElementSibling && block.nextElementSibling.querySelector('.xtr-text').textContent.trim();
      }),
      '译：In order to make AI work for your company, you need better knowledge.'
    );
    assert.equal(
      await blockText(draftPage, '.longform-header-two + .xtr-block .xtr-text'),
      '译：Context vs knowledge'
    );
    assert.equal(
      await blockText(draftPage, '#draft-li .xtr-block .xtr-text'),
      '译：Early AI frameworks.'
    );
    console.log('✓ 旧版 Draft.js 文章正文翻译');
    await draftPage.close();

    // One-click copy: Chinese posts are skipped by the translator, but the
    // copy button must still appear. Copying expands truncated links, keeps
    // line breaks and emoji, skips "show more" and quoted tweets.
    const copyOrigin = 'http://127.0.0.1:' + port;
    await browser.defaultBrowserContext().overridePermissions(
      copyOrigin,
      ['clipboard-read', 'clipboard-write']
    );

    const copyPage = await browser.newPage();
    await copyPage.setViewport({ width: 1280, height: 900 });
    await copyPage.goto(copyOrigin + '/copy-tweet', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await copyPage.waitForSelector('#copy-actions .xtr-copy-btn[data-xtr-copy="tweet"]', { timeout: 10000 });
    await copyPage.bringToFront();
    await copyPage.hover('#copy-tweet');
    await copyPage.click('#copy-actions .xtr-copy-btn[data-xtr-copy="tweet"]');
    await copyPage.waitForFunction(
      () => {
        const toast = document.querySelector('.xtr-toast');
        return !!toast && toast.textContent.includes('已复制');
      },
      { timeout: 5000 }
    );
    assert.equal(
      await copyPage.evaluate(() => navigator.clipboard.readText()),
      '第一行😀\n第二行\n看这个：https://example.com/full/path?x=1'
    );
    console.log('✓ 推文一键复制保留换行、emoji 和完整链接');

    // Super copy sends a structured capture to the configured agent and also
    // leaves the text plus the post permalink on the clipboard.
    await copyPage.click('#copy-actions .xtr-super');
    await copyPage.waitForFunction(
      () => {
        const toast = document.querySelector('.xtr-toast');
        return !!toast && toast.textContent.includes('已复制并发送到知识库');
      },
      { timeout: 5000 }
    );
    assert.equal(
      await copyPage.evaluate(() => navigator.clipboard.readText()),
      '第一行😀\n第二行\n看这个：https://example.com/full/path?x=1\n\nhttps://x.com/alice/status/789'
    );
    assert.equal(ingestRequests.length, 1);
    const tweetCapture = ingestRequests[0].body;
    assert.equal(ingestRequests[0].headers.authorization, 'Bearer test-token');
    assert.equal(ingestRequests[0].headers['idempotency-key'], 'x:tweet:789');
    assert.match(ingestRequests[0].headers['content-type'], /application\/json/);
    assert.equal(tweetCapture.schema, 'xtr.capture/1');
    assert.equal(tweetCapture.id, 'x:tweet:789');
    assert.equal(tweetCapture.source.type, 'tweet');
    assert.equal(tweetCapture.source.url, 'https://x.com/alice/status/789');
    assert.equal(tweetCapture.source.author.handle, 'alice');
    assert.equal(tweetCapture.source.publishedAt, '2026-11-24T18:00:00.000Z');
    assert.equal(tweetCapture.content.text, '第一行😀\n第二行\n看这个：https://example.com/full/path?x=1');
    assert.deepEqual(tweetCapture.links, [
      { url: 'https://example.com/full/path?x=1', text: 'example.com/full/pa…' }
    ]);
    assert.equal(tweetCapture.quoted.content.text, 'Quoted text should not be copied.');
    assert.equal(tweetCapture.quoted.url, 'https://x.com/bob/status/654');
    assert.equal(tweetCapture.quoted.author.handle, 'bob');
    assert.equal(tweetCapture.quoted.media.length, 1);
    assert.equal(tweetCapture.quoted.media[0].url, 'https://pbs.twimg.com/media/quotedimg?format=png&name=large');
    assert.equal(tweetCapture.media.length, 1);
    assert.equal(tweetCapture.media[0].url, 'https://pbs.twimg.com/media/abc123?format=jpg&name=large');
    assert.equal(tweetCapture.media[0].alt, '一张图表');
    assert.equal(tweetCapture.thread, null);
    assert.equal(tweetCapture.processingMode, 'full');
    console.log('✓ 推文超级复制发送正文、链接、引用推文和图片');

    // The caret next to the super-copy button lets the user choose a different
    // processing mode for this copy only.
    await copyPage.click('#copy-actions .xtr-super-menu');
    await copyPage.waitForSelector('.xtr-mode-menu', { timeout: 5000 });
    await copyPage.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.xtr-mode-item'))
        .find((node) => node.textContent.includes('仅保存原文'));
      if (item) item.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await copyPage.waitForFunction(() => !document.querySelector('.xtr-mode-menu'), { timeout: 2000 });
    assert.equal(ingestRequests.length, 2);
    assert.equal(ingestRequests[1].body.processingMode, 'save');
    console.log('✓ 超级复制菜单可为本次复制选择仅保存');
    await copyPage.close();

    const copyArticlePage = await browser.newPage();
    await copyArticlePage.goto(copyOrigin + '/copy-article', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await copyArticlePage.waitForSelector(
      '[data-testid="twitter-article-title"] ~ .xtr-article-copy:not(.xtr-article-super)',
      { timeout: 10000 }
    );
    await copyArticlePage.bringToFront();
    await copyArticlePage.click('[data-testid="twitter-article-title"] ~ .xtr-article-copy:not(.xtr-article-super)');
    await copyArticlePage.waitForFunction(
      () => {
        const toast = document.querySelector('.xtr-toast');
        return !!toast && toast.textContent.includes('已复制');
      },
      { timeout: 5000 }
    );
    assert.equal(
      await copyArticlePage.evaluate(() => navigator.clipboard.readText()),
      '如何构建知识工厂\n\n第一段。\n\n小标题\n\n第二段，见 https://example.com/a/b?c=1。\n\n- 列表项一\n- 列表项二\n\n图片说明：图片说明'
    );
    console.log('✓ 文章一键复制标题、正文、列表和完整链接');

    const articleBodyText = '第一段。\n\n小标题\n\n第二段，见 https://example.com/a/b?c=1。\n\n- 列表项一\n- 列表项二\n\n图片说明：图片说明';
    await copyArticlePage.click('[data-testid="twitter-article-title"] ~ .xtr-article-super');
    await copyArticlePage.waitForFunction(
      () => {
        const toast = document.querySelector('.xtr-toast');
        return !!toast && toast.textContent.includes('已复制并发送到知识库');
      },
      { timeout: 5000 }
    );
    assert.equal(
      await copyArticlePage.evaluate(() => navigator.clipboard.readText()),
      '如何构建知识工厂\n\n' + articleBodyText + '\n\n' + copyOrigin + '/copy-article'
    );
    assert.equal(ingestRequests.length, 3);
    const articleCapture = ingestRequests[2].body;
    assert.equal(articleCapture.source.type, 'article');
    assert.equal(articleCapture.source.url, copyOrigin + '/copy-article');
    assert.equal(articleCapture.source.author.handle, 'alice');
    assert.equal(articleCapture.content.title, '如何构建知识工厂');
    assert.equal(articleCapture.content.text, articleBodyText);
    assert.deepEqual(articleCapture.links, [
      { url: 'https://example.com/a/b?c=1', text: 'example.com/a/b…' }
    ]);
    assert.equal(articleCapture.media.length, 1);
    assert.equal(articleCapture.media[0].url, 'https://pbs.twimg.com/media/def456?format=jpg&name=large');
    assert.equal(articleCapture.media[0].alt, '架构图');
    assert.equal(articleCapture.media[0].caption, '图片说明');
    assert.equal(articleCapture.processingMode, 'full');
    await copyArticlePage.click('[data-testid="twitter-article-title"] ~ .xtr-article-super-menu');
    await copyArticlePage.waitForSelector('.xtr-mode-menu', { timeout: 5000 });
    await copyArticlePage.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.xtr-mode-item'))
        .find((node) => node.textContent.includes('整理分类'));
      if (item) item.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await copyArticlePage.waitForFunction(() => !document.querySelector('.xtr-mode-menu'), { timeout: 2000 });
    assert.equal(ingestRequests.length, 4);
    assert.equal(ingestRequests[3].body.processingMode, 'classify');
    console.log('✓ 文章超级复制菜单可为本次复制选择整理分类');
    await copyArticlePage.close();

    assert.ok(requests.length > 0, '应该至少请求过一次大模型接口');
    console.log('✓ 请求经由后台 Service Worker 发往所配置的接口');

    await page.close();
  } catch (err) {
    console.error('\n端到端测试失败：');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log('\n全部端到端测试通过。');
}

main();
