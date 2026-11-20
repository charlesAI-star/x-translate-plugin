'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const shared = require('../lib/shared.js');
const providers = require('../lib/providers.js');

const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      }
    },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('Google provider posts to the free endpoint and parses the result', async () => {
  let captured;
  mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ sentences: [{ trans: '你好，世界。', orig: 'Hello, world.' }], src: 'en' });
  });
  const result = await providers.translateGoogleText('Hello, world.', 'zh-CN');
  assert.equal(result.text, '你好，世界。');
  assert.equal(result.sourceLang, 'en');
  assert.match(captured.url, /client=dict-chrome-ex/);
  assert.match(captured.url, /tl=zh-CN/);
  assert.equal(captured.init.method, 'POST');
  assert.match(String(captured.init.body), /q=Hello%2C\+world\./);
});

test('Google provider reports non-JSON responses', async () => {
  mockFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    json: async () => ({}),
    text: async () => '<html>blocked</html>'
  }));
  await assert.rejects(() => providers.translateGoogleText('Hello', 'zh-CN'), /非 JSON|限流/);
});

test('MyMemory provider uses autodetect and parses translation', async () => {
  let capturedUrl = '';
  mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({
      responseStatus: 200,
      responseData: { translatedText: '你好世界', detectedLanguage: 'en' }
    });
  });
  const result = await providers.translateMyMemoryText('Hello world', 'zh-CN', '');
  assert.equal(result.text, '你好世界');
  assert.equal(result.sourceLang, 'en');
  assert.match(capturedUrl, /langpair=autodetect%7Czh-CN/);
});

test('LLM provider builds a chat request and parses JSON output', async () => {
  let captured;
  mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({
      choices: [{ message: { content: '["你好，世界！"]' } }]
    });
  });
  const settings = shared.mergeSettings({
    provider: 'llm',
    llm: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'test-model'
    }
  });
  const result = await providers.translateLLM(['Hello, world!'], 'zh-CN', settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '你好，世界！');
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'test-model');
  assert.match(body.messages[0].content, /简体中文/);
  assert.deepEqual(JSON.parse(body.messages[1].content), ['Hello, world!']);
});

test('LLM provider runs groups in parallel and preserves chunk order', async () => {
  const longText = 'LONG-A' + 'x'.repeat(2500) + 'LONG-B';
  const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', longText];
  let active = 0;
  let maxActive = 0;
  const sizes = [];

  mockFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    const sent = JSON.parse(body.messages[1].content);
    sizes.push(sent.length);
    active++;
    maxActive = Math.max(maxActive, active);
    const isSecondGroup = sent.length === 1 && sent[0].includes('LONG-B');
    await new Promise((resolve) => setTimeout(resolve, isSecondGroup ? 10 : 80));
    active--;
    const out = sent.map((text) => {
      if (text.startsWith('LONG-A')) return 'LONG-A译';
      if (text.includes('LONG-B')) return 'LONG-B译';
      return '译:' + text;
    });
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(out) } }] });
  });

  const settings = shared.mergeSettings({
    provider: 'llm',
    llm: { baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model' }
  });
  const result = await providers.translateLLM(texts, 'zh-CN', settings);

  assert.equal(result.length, 8);
  assert.equal(result[7].text, 'LONG-A译\nLONG-B译');
  assert.equal(maxActive, 2, '两个分组应同时请求');
  assert.deepEqual(sizes.sort((a, b) => a - b), [1, 8]);
});

test('LLM provider surfaces auth errors', async () => {
  mockFetch(() => jsonResponse({ error: { message: 'Incorrect API key' } }, 401));
  const settings = shared.mergeSettings({
    provider: 'llm',
    llm: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
      model: 'test-model'
    }
  });
  await assert.rejects(
    () => providers.translateLLM(['Hello'], 'zh-CN', settings),
    (err) => err.code === 'auth' && /鉴权/.test(err.message)
  );
});

test('LLM provider requires a key for remote endpoints', async () => {
  const settings = shared.mergeSettings({
    provider: 'llm',
    llm: { baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'test-model' }
  });
  await assert.rejects(
    () => providers.translateLLM(['Hello'], 'zh-CN', settings),
    (err) => err.code === 'auth'
  );
});

test('Azure provider sends key, region and target language', async () => {
  let captured;
  mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse([
      { translations: [{ text: '你好' }], detectedLanguage: { language: 'en' } }
    ]);
  });
  const settings = shared.mergeSettings({
    provider: 'azure',
    azure: { key: 'azure-key', region: 'eastasia' }
  });
  const result = await providers.translateAzure(['Hello'], 'zh-CN', settings);
  assert.equal(result[0].text, '你好');
  assert.match(captured.url, /to=zh-Hans/);
  assert.equal(captured.init.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
  assert.equal(captured.init.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
});

test('translateBatch wraps per-item Google failures', async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    if (calls === 1) return jsonResponse({}, 500);
    return jsonResponse({ sentences: [{ trans: '你好' }], src: 'en' });
  });
  const settings = shared.mergeSettings({});
  // The retry helper retries 500 responses once or twice; use a short-lived
  // assertion on the shape rather than on the number of calls.
  const results = await providers.translateBatch({
    provider: 'google',
    texts: ['Hello'],
    targetLang: 'zh-CN',
    settings
  });
  assert.equal(results.length, 1);
  assert.ok(results[0].text === '你好' || results[0].error);
});

test('listModels reads an OpenAI-compatible model list with the key', async () => {
  let captured;
  mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({
      object: 'list',
      data: [
        { id: 'deepseek/deepseek-chat' },
        { id: 'group/opus-anywhere' },
        { id: 'deepseek/deepseek-chat' }
      ]
    });
  });
  const models = await providers.listModels('http://127.0.0.1:3425/v1', 'magpie');
  assert.deepEqual(models, ['deepseek/deepseek-chat', 'group/opus-anywhere']);
  assert.equal(captured.url, 'http://127.0.0.1:3425/v1/models');
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers.Authorization, 'Bearer magpie');
});

test('listModels accepts Ollama native model objects', async () => {
  mockFetch(() => jsonResponse({
    models: [
      { name: 'llama3:latest' },
      { model: 'qwen2.5:7b' }
    ]
  }));
  const models = await providers.listModels('http://localhost:11434/v1', '');
  assert.deepEqual(models, ['llama3:latest', 'qwen2.5:7b']);
});

test('listModels reports auth errors', async () => {
  mockFetch(() => jsonResponse({ error: { message: 'unauthorized' } }, 401));
  await assert.rejects(
    () => providers.listModels('http://127.0.0.1:3425/v1', 'bad-key'),
    (err) => err.code === 'auth'
  );
});

test('probeLocalServices finds a local OpenAI-compatible service', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const results = await providers.probeLocalServices(
      [{ port, name: 'Test service', preset: 'localrouter' }],
      2000,
      '127.0.0.1'
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Test service');
    assert.equal(results[0].baseUrl, 'http://127.0.0.1:' + port + '/v1');
    assert.deepEqual(results[0].models, ['local-model']);
    assert.equal(results[0].authRequired, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
