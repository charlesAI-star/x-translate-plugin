import { isHttpUrl } from './util.js';

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeAuthor(author) {
  if (!author || typeof author !== 'object') return null;
  const name = asString(author.name).trim();
  const handle = asString(author.handle).trim().replace(/^@/, '');
  if (!name && !handle) return null;
  return { name: name || handle, handle };
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  const seen = new Set();
  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    const url = asString(link.url).trim();
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: asString(link.text) });
  }
  return out;
}

function normalizeMedia(media) {
  if (!Array.isArray(media)) return [];
  const out = [];
  for (const item of media) {
    if (!item || typeof item !== 'object') continue;
    const url = asString(item.url).trim();
    const previewUrl = asString(item.previewUrl).trim();
    if (!isHttpUrl(url) && !isHttpUrl(previewUrl)) continue;
    out.push({
      type: asString(item.type) || 'image',
      url: isHttpUrl(url) ? url : '',
      previewUrl: isHttpUrl(previewUrl) ? previewUrl : '',
      alt: asString(item.alt),
      caption: asString(item.caption)
    });
  }
  return out;
}

function normalizeQuoted(quoted) {
  if (!quoted || typeof quoted !== 'object') return null;
  const content = quoted.content && typeof quoted.content === 'object' ? quoted.content : {};
  const text = asString(content.text);
  const url = asString(quoted.url).trim();
  if (!text && !url) return null;
  return {
    id: asString(quoted.id),
    url,
    author: normalizeAuthor(quoted.author),
    publishedAt: asString(quoted.publishedAt) || null,
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
  const text = asString(content.text);
  if (!text.trim()) return fail('empty_text', 'content.text 不能为空');

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
      publishedAt: asString(source.publishedAt) || null,
      language: asString(source.language) || null
    },
    content: {
      title: content.title === null || content.title === undefined ? null : asString(content.title),
      text,
      truncated: Boolean(content.truncated)
    },
    links: normalizeLinks(raw.links),
    quoted: normalizeQuoted(raw.quoted),
    media: normalizeMedia(raw.media),
    thread: raw.thread && typeof raw.thread === 'object' ? raw.thread : null,
    client: raw.client && typeof raw.client === 'object'
      ? { name: asString(raw.client.name), version: asString(raw.client.version) }
      : { name: '', version: '' }
  };
  return { ok: true, capture };
}
