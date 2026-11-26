import { isHttpUrl } from './util.js';

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

const LIMITS = {
  text: 200000,
  title: 1000,
  author: 200,
  linkText: 500,
  mediaText: 500,
  links: 100,
  media: 50
};

function cut(value, max) {
  const text = asString(value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeAuthor(author) {
  if (!author || typeof author !== 'object') return null;
  const name = cut(author.name, LIMITS.author).trim();
  const handle = cut(author.handle, LIMITS.author).trim().replace(/^@/, '');
  if (!name && !handle) return null;
  return { name: name || handle, handle };
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  const seen = new Set();
  for (const link of links) {
    if (out.length >= LIMITS.links) break;
    if (!link || typeof link !== 'object') continue;
    const url = cut(link.url, 2000).trim();
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: cut(link.text, LIMITS.linkText) });
  }
  return out;
}

function normalizeMedia(media) {
  if (!Array.isArray(media)) return [];
  const out = [];
  for (const item of media) {
    if (out.length >= LIMITS.media) break;
    if (!item || typeof item !== 'object') continue;
    const url = cut(item.url, 2000).trim();
    const previewUrl = cut(item.previewUrl, 2000).trim();
    if (!isHttpUrl(url) && !isHttpUrl(previewUrl)) continue;
    out.push({
      type: cut(item.type, 50) || 'image',
      url: isHttpUrl(url) ? url : '',
      previewUrl: isHttpUrl(previewUrl) ? previewUrl : '',
      alt: cut(item.alt, LIMITS.mediaText),
      caption: cut(item.caption, LIMITS.mediaText)
    });
  }
  return out;
}

function normalizeQuoted(quoted) {
  if (!quoted || typeof quoted !== 'object') return null;
  const content = quoted.content && typeof quoted.content === 'object' ? quoted.content : {};
  const text = cut(content.text, LIMITS.text);
  const rawUrl = cut(quoted.url, 2000).trim();
  const url = isHttpUrl(rawUrl) ? rawUrl : '';
  if (!text && !url) return null;
  return {
    id: cut(quoted.id, 500),
    url,
    author: normalizeAuthor(quoted.author),
    publishedAt: cut(quoted.publishedAt, 100) || null,
    content: { text },
    links: normalizeLinks(quoted.links),
    media: normalizeMedia(quoted.media)
  };
}

const PROCESSING_MODES = new Set(['save', 'classify', 'full']);

export function validateCapture(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('invalid_json', '请求体必须是 JSON 对象');
  }
  if (raw.schema !== 'xtr.capture/1') {
    return fail('unsupported_schema', '不支持的 schema，应为 xtr.capture/1');
  }
  const id = asString(raw.id).trim();
  if (!id) return fail('missing_id', '缺少 id');
  if (id.length > 500) return fail('invalid_id', 'id 过长');
  const capturedAt = asString(raw.capturedAt).trim();
  if (!capturedAt || Number.isNaN(new Date(capturedAt).getTime())) {
    return fail('invalid_captured_at', 'capturedAt 不是有效的 ISO 时间');
  }
  const source = raw.source;
  if (!source || typeof source !== 'object') return fail('invalid_source', '缺少 source');
  if (source.platform !== 'x') return fail('unsupported_platform', '只接受 X 内容');
  if (source.type !== 'tweet' && source.type !== 'article') {
    return fail('invalid_source_type', 'source.type 必须是 tweet 或 article');
  }
  const sourceUrl = asString(source.url).trim();
  if (!isHttpUrl(sourceUrl)) return fail('invalid_source_url', 'source.url 必须是 http/https 地址');
  const content = raw.content;
  if (!content || typeof content !== 'object') return fail('invalid_content', '缺少 content');
  const rawText = asString(content.text);
  if (!rawText.trim()) return fail('empty_text', 'content.text 不能为空');
  const text = rawText.slice(0, LIMITS.text);

  const capture = {
    schema: 'xtr.capture/1',
    id,
    capturedAt,
    processingMode: PROCESSING_MODES.has(raw.processingMode) ? raw.processingMode : null,
    source: {
      platform: 'x',
      type: source.type,
      url: sourceUrl,
      author: normalizeAuthor(source.author),
      publishedAt: cut(source.publishedAt, 100) || null,
      language: cut(source.language, 50) || null
    },
    content: {
      title: content.title === null || content.title === undefined
        ? null
        : cut(content.title, LIMITS.title),
      text,
      truncated: Boolean(content.truncated) || rawText.length > LIMITS.text
    },
    links: normalizeLinks(raw.links),
    quoted: normalizeQuoted(raw.quoted),
    media: normalizeMedia(raw.media),
    thread: raw.thread && typeof raw.thread === 'object' ? raw.thread : null,
    client: raw.client && typeof raw.client === 'object'
      ? { name: cut(raw.client.name, 100), version: cut(raw.client.version, 100) }
      : { name: '', version: '' }
  };
  return { ok: true, capture };
}
