'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../lib/shared.js');
const core = require('../lib/core.js');

test('mergeSettings fills defaults and validates values', () => {
  const s = shared.mergeSettings({ targetLang: 'zh-CN' });
  assert.equal(s.minChars, 2);
  assert.equal(s.llm.temperature, 0.2);
  assert.equal(s.provider, 'auto');
  assert.equal(s.prefetchProfile, true);

  const s2 = shared.mergeSettings({
    targetLang: 'fr',
    provider: 'llm',
    minChars: 5,
    prefetchProfile: false,
    llm: { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' }
  });
  assert.equal(s2.targetLang, 'fr');
  assert.equal(s2.provider, 'llm');
  assert.equal(s2.minChars, 5);
  assert.equal(s2.prefetchProfile, false);
  assert.equal(s2.llm.temperature, 0.2);

  const s3 = shared.mergeSettings({ targetLang: 'xx', provider: 'nope', minChars: null });
  assert.equal(s3.targetLang, 'zh-CN');
  assert.equal(s3.provider, 'auto');
  assert.equal(s3.minChars, 2);
});

test('super copy settings use safe defaults and normalize input', () => {
  const defaults = shared.mergeSettings({});
  assert.equal(defaults.superCopy.enabled, false);
  assert.equal(defaults.superCopy.endpoint, '');
  assert.equal(defaults.superCopy.token, '');
  assert.equal(defaults.superCopy.mode, 'full');
  assert.equal(defaults.superCopy.includeQuoted, true);
  assert.equal(defaults.superCopy.includeMedia, true);

  const s = shared.mergeSettings({
    superCopy: {
      enabled: true,
      endpoint: '  http://127.0.0.1:8787/ingest  ',
      token: '  secret  ',
      mode: 'classify',
      includeQuoted: false,
      includeMedia: false
    }
  });
  assert.equal(s.superCopy.enabled, true);
  assert.equal(s.superCopy.endpoint, 'http://127.0.0.1:8787/ingest');
  assert.equal(s.superCopy.token, 'secret');
  assert.equal(s.superCopy.mode, 'classify');
  assert.equal(s.superCopy.includeQuoted, false);
  assert.equal(s.superCopy.includeMedia, false);

  const bad = shared.mergeSettings({ superCopy: { enabled: 'yes', mode: 'everything', includeQuoted: 'no' } });
  assert.equal(bad.superCopy.enabled, false);
  assert.equal(bad.superCopy.mode, 'full');
  assert.equal(bad.superCopy.includeQuoted, true);

  assert.equal(core.normalizeEndpoint('127.0.0.1:8787/ingest'), 'http://127.0.0.1:8787/ingest');
  assert.equal(core.normalizeEndpoint('agent.example.com/ingest'), 'https://agent.example.com/ingest');
  assert.equal(core.normalizeEndpoint('https://agent.example.com/ingest#x'), 'https://agent.example.com/ingest');
  assert.throws(() => core.normalizeEndpoint('ftp://example.com/ingest'));
});

test('Magpie preset points at the local gateway', () => {
  assert.equal(shared.LLM_PRESETS.magpie.baseUrl, 'http://127.0.0.1:3425/v1');
  assert.equal(shared.LLM_PRESETS.magpie.apiKey, 'magpie');
  assert.equal(shared.LLM_PRESETS.magpie.needsKey, false);
});

test('normalizeLangTag and sameLanguage', () => {
  assert.equal(shared.normalizeLangTag('en-US'), 'en');
  assert.equal(shared.normalizeLangTag('zh-CN'), 'zh');
  assert.equal(shared.normalizeLangTag('zh_TW'), 'zh-Hant');
  assert.equal(shared.normalizeLangTag('zh-HK'), 'zh-Hant');
  assert.equal(shared.normalizeLangTag('iw'), 'he');
  assert.equal(shared.normalizeLangTag('in'), 'id');
  assert.equal(shared.normalizeLangTag('und'), '');
  assert.equal(shared.normalizeLangTag('qme'), '');

  assert.equal(shared.sameLanguage('zh-CN', 'zh-TW'), true);
  assert.equal(shared.sameLanguage('en-US', 'en'), true);
  assert.equal(shared.sameLanguage('en', 'fr'), false);
  assert.equal(shared.isChinese('zh-Hant'), true);
});

test('target codes per provider', () => {
  assert.equal(shared.targetCodeFor('google', 'zh-CN'), 'zh-CN');
  assert.equal(shared.targetCodeFor('azure', 'zh-CN'), 'zh-Hans');
  assert.equal(shared.targetCodeFor('azure', 'zh-TW'), 'zh-Hant');
  assert.equal(shared.targetCodeFor('chrome', 'zh-CN'), 'zh');
  assert.equal(shared.targetCodeFor('chrome', 'zh-TW'), 'zh-Hant');
  assert.equal(shared.targetCodeFor('llm', 'zh-CN'), '简体中文');
  assert.equal(shared.chromeLangCode('en-US'), 'en');
  assert.equal(shared.chromeLangCode('zh-CN'), 'zh');
});

test('isProfilePath recognizes profile pages but not app routes', () => {
  assert.equal(core.isProfilePath('/jack'), true);
  assert.equal(core.isProfilePath('/jack/'), true);
  assert.equal(core.isProfilePath('/jack/with_replies'), true);
  assert.equal(core.isProfilePath('/jack/media'), true);
  assert.equal(core.isProfilePath('/jack/likes'), true);
  assert.equal(core.isProfilePath('/'), false);
  assert.equal(core.isProfilePath('/home'), false);
  assert.equal(core.isProfilePath('/explore'), false);
  assert.equal(core.isProfilePath('/notifications'), false);
  assert.equal(core.isProfilePath('/settings'), false);
  assert.equal(core.isProfilePath('/jack/status/123'), false);
  assert.equal(core.isProfilePath('/jack/status/123/photo/1'), false);
  assert.equal(core.isProfilePath('/i/status/123'), false);
  assert.equal(core.isProfilePath('/hashtag/ai'), false);
});

test('detectScript distinguishes CJK and non-Latin scripts', () => {
  assert.equal(core.detectScript('Hello world, this is a test.'), '');
  assert.equal(core.detectScript('Bonjour le monde'), '');
  assert.equal(core.detectScript('你好世界，这是一条推文。'), 'zh');
  assert.equal(core.detectScript('こんにちは世界'), 'ja');
  assert.equal(core.detectScript('안녕하세요 세계'), 'ko');
  assert.equal(core.detectScript('Привет, мир'), 'ru');
  assert.equal(core.detectScript('مرحبا بالعالم'), 'ar');
  assert.equal(core.detectScript('สวัสดีชาวโลก'), 'th');
});

test('hasTranslatableText ignores links, emoji and handles', () => {
  assert.equal(core.hasTranslatableText('https://t.co/abc'), false);
  assert.equal(core.hasTranslatableText('😂😂😂'), false);
  assert.equal(core.hasTranslatableText('@someone +1'), false);
  assert.equal(core.hasTranslatableText('Hello'), true);
  assert.equal(core.hasTranslatableText('你好'), true);
});

test('shouldSkipTranslation handles same language and empty content', () => {
  assert.equal(core.shouldSkipTranslation({
    text: '你好，世界', sourceLang: 'zh', targetLang: 'zh-CN'
  }).skip, true);

  assert.equal(core.shouldSkipTranslation({
    text: 'Hello world', sourceLang: 'en', targetLang: 'zh-CN'
  }).skip, false);

  assert.equal(core.shouldSkipTranslation({
    text: 'Hello world', sourceLang: '', targetLang: 'zh-CN'
  }).skip, false);

  assert.equal(core.shouldSkipTranslation({
    text: '你好世界', sourceLang: '', targetLang: 'zh-CN'
  }).skip, true);

  assert.equal(core.shouldSkipTranslation({
    text: '你好世界', sourceLang: 'zh', targetLang: 'zh-CN', skipTargetLang: false
  }).skip, false);

  assert.equal(core.shouldSkipTranslation({
    text: '😂', targetLang: 'zh-CN'
  }).skip, true);
});

test('chunkText keeps short text intact and splits long text', () => {
  assert.deepEqual(core.chunkText('Hello world', 100), ['Hello world']);
  const long = 'This is a sentence. '.repeat(200);
  const chunks = core.chunkText(long, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 300, `chunk too long: ${chunk.length}`);
  assert.ok(chunks.join(' ').includes('This is a sentence.'));
});

test('hashText is stable and distinguishes content', () => {
  assert.equal(core.hashText('hello'), core.hashText('hello'));
  assert.notEqual(core.hashText('hello'), core.hashText('hello!'));
  assert.match(core.hashText('hello'), /^[0-9a-f]{16}-[0-9a-z]+$/);
});

test('parseGoogleResponse joins sentences', () => {
  const parsed = core.parseGoogleResponse({
    sentences: [
      { trans: '你好，', orig: 'Hello, ' },
      { trans: '世界。', orig: 'world.' }
    ],
    src: 'en'
  });
  assert.equal(parsed.text, '你好，世界。');
  assert.equal(parsed.sourceLang, 'en');

  assert.throws(() => core.parseGoogleResponse({ sentences: [] }));
  assert.throws(() => core.parseGoogleResponse('html'));
});

test('parseMyMemoryResponse handles normal and quota responses', () => {
  const parsed = core.parseMyMemoryResponse({
    responseStatus: 200,
    responseData: { translatedText: '你好世界', detectedLanguage: 'en' }
  });
  assert.equal(parsed.text, '你好世界');
  assert.equal(parsed.sourceLang, 'en');

  assert.throws(() => core.parseMyMemoryResponse({
    responseStatus: 200,
    responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }
  }), /额度/);
});

test('parseAzureResponse validates shape', () => {
  const parsed = core.parseAzureResponse([
    { translations: [{ text: '你好' }], detectedLanguage: { language: 'en' } }
  ], 1);
  assert.equal(parsed[0].text, '你好');
  assert.equal(parsed[0].sourceLang, 'en');
  assert.throws(() => core.parseAzureResponse([], 1));
});

test('buildLLMMessages embeds the target and a JSON array', () => {
  const messages = core.buildLLMMessages(['Hello', 'World'], 'zh-CN');
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /简体中文/);
  assert.match(messages[0].content, /JSON/);
  assert.deepEqual(JSON.parse(messages[1].content), ['Hello', 'World']);
});

test('parseLLMResponse accepts plain, fenced and embedded JSON', () => {
  assert.deepEqual(core.parseLLMResponse('["你好","世界"]', 2), ['你好', '世界']);
  assert.deepEqual(core.parseLLMResponse('```json\n["你好","世界"]\n```', 2), ['你好', '世界']);
  assert.deepEqual(core.parseLLMResponse('Here you go: ["你好","世界"] thanks', 2), ['你好', '世界']);
  assert.deepEqual(core.parseLLMResponse('你好', 1), ['你好']);
  assert.throws(() => core.parseLLMResponse('["only one"]', 2), /预期 2 条/);
});

test('URL helpers', () => {
  assert.equal(core.normalizeBaseUrl('api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(core.normalizeBaseUrl('localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(core.normalizeBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
  assert.equal(core.llmEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.throws(() => core.normalizeBaseUrl('ftp://example.com'));
  assert.equal(core.originPattern('https://api.deepseek.com/v1'), 'https://api.deepseek.com/*');
  assert.equal(core.originPattern('http://127.0.0.1:3425/v1'), 'http://127.0.0.1/*');
  assert.equal(core.originPattern('http://localhost:11434/v1'), 'http://localhost/*');
  assert.equal(core.isLocalhostUrl('http://127.0.0.1:1234/v1'), true);
});

test('mapLimit preserves order', async () => {
  const result = await core.mapLimit([1, 2, 3, 4], 2, async (n) => {
    await new Promise((r) => setTimeout(r, n === 1 ? 20 : 1));
    return n * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
});
