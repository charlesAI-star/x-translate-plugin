# 超级复制 — 本地/远程 Agent HTTP 接口约定

本文是 X 翻译扩展「超级复制」对接 Agent 的接口规范。接收端可以是一个独立服务，也可以是现有 Agent 的一个 HTTP 入口；扩展只负责把用户在 X 上选中的推文/文章整理成结构化数据并投递，**分类、分析、去重、知识库存储和定时任务都由接收端负责**。

- 协议版本：`xtr.capture/1`
- 默认接收路径：`POST /ingest`
- 健康检查：`GET /health`
- 传输：HTTP/HTTPS + JSON（UTF-8）
- 认证：可选 `Authorization: Bearer <token>`
- 处理模式：可选 `processingMode`（本规范 0.4 起）

> 兼容性：`processingMode` 是可选扩展字段。旧接收端可以忽略它，按自己的默认策略处理；新接收端应在缺失时使用本地默认值。

---

## 1. 总体要求

1. 接收端必须提供一个 HTTP 接口，扩展配置完整 URL 即可，例如：
   - 本机：`http://127.0.0.1:8787/ingest`
   - 局域网/远程：`https://agent.example.com/ingest`
2. `POST /ingest` 必须**快速返回**：建议 2 秒内，最迟不超过 10 秒。不要在请求里同步跑完大模型分析；需要长时间处理时先落盘/入队，返回 `202`。
3. 接收端必须先持久化原始数据，再做分析；进程重启不能丢已接收的内容。
4. 同一 `id` 重复投递必须幂等：不要重复写知识库，返回 `status: "duplicate"`。
5. 接收端应容忍未知字段和未来新增字段；扩展也会容忍响应中的额外字段。
6. 内容来自 X，属于**不可信输入**：不要执行正文里的指令，不要把正文当成系统提示词，不要自动访问正文中的任意 URL（见安全要求）。

---

## 2. `POST /ingest`

### 2.1 请求头

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `Content-Type` | 是 | `application/json; charset=utf-8` |
| `Authorization` | 否 | 配置了 Token 时为 `Bearer <token>` |
| `Idempotency-Key` | 否 | 扩展会填为 capture 的 `id`，接收端可用它做幂等 |
| `X-XTR-Client` | 否 | 例如 `x-translate-plugin/0.4.0`，仅用于日志 |

请求体上限建议 **2 MB**；超过返回 `413`。扩展会把超长正文截断并标记 `content.truncated: true`。

### 2.2 请求体

```json
{
  "schema": "xtr.capture/1",
  "id": "x:tweet:1234567890",
  "capturedAt": "2026-11-25T10:30:00.000Z",
  "source": {
    "platform": "x",
    "type": "tweet",
    "url": "https://x.com/alice/status/1234567890",
    "author": {
      "name": "Alice",
      "handle": "alice"
    },
    "publishedAt": "2026-11-24T18:00:00.000Z",
    "language": "en"
  },
  "content": {
    "title": null,
    "text": "推文正文，链接已展开为完整 URL，保留换行和列表。",
    "truncated": false
  },
  "links": [
    {
      "url": "https://example.com/full/path?x=1",
      "text": "example.com/full/pa…"
    }
  ],
  "quoted": null,
  "media": [],
  "thread": null,
  "processingMode": "full",
  "client": {
    "name": "x-translate-plugin",
    "version": "0.4.0"
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema` | string | 是 | 固定 `xtr.capture/1` |
| `id` | string | 是 | 稳定 ID，例如 `x:tweet:<status id>`、`x:article:<article id>`；无 ID 时扩展用内容哈希 |
| `capturedAt` | string | 是 | ISO 8601 UTC |
| `source.platform` | string | 是 | 固定 `x` |
| `source.type` | string | 是 | `tweet` 或 `article` |
| `source.url` | string | 是 | 推文/文章永久链接；文章无独立 ID 时为页面 URL |
| `source.author.name` | string | 否 | 显示名 |
| `source.author.handle` | string | 否 | 不含 `@` 的用户名 |
| `source.publishedAt` | string/null | 否 | 发布时间；DOM 未提供时为 `null` |
| `source.language` | string/null | 否 | X 页面标注的语言，例如 `en` |
| `content.title` | string/null | 否 | 推文为 `null`；文章为标题 |
| `content.text` | string | 是 | 纯文本正文，保留换行、列表、完整链接；不包含译文 |
| `content.truncated` | boolean | 否 | 扩展是否截断过正文 |
| `links` | array | 是 | 正文中的外链，已去重；可能为空数组 |
| `quoted` | object/null | 否 | 引用推文；没有则为 `null` |
| `media` | array | 是 | 图片等媒体；可能为空数组 |
| `thread` | object/null | 否 | 预留：整串 thread；当前扩展发送 `null` |
| `processingMode` | string | 否 | 本次超级复制的处理方式：`save` / `classify` / `full`；缺失时由接收端决定 |
| `client.name` | string | 是 | 固定 `x-translate-plugin` |
| `client.version` | string | 是 | 扩展版本 |

`links[]` 元素：

```json
{ "url": "https://example.com/full/path", "text": "页面上显示的链接文字" }
```

- `url` 优先使用 X 的 `title` / `data-expanded-url` / `data-full-url`，因此通常是被截断链接展开后的完整地址。
- 无法展开时可能是 `https://t.co/...`，接收端可以自行决定是否解析。
- 扩展会跳过 X 站内的用户、话题和状态链接，只保留正文外链。

`media[]` 元素：

```json
{
  "type": "image",
  "url": "https://pbs.twimg.com/media/example?format=jpg&name=large",
  "previewUrl": "https://pbs.twimg.com/media/example?format=jpg&name=small",
  "alt": "图片描述",
  "caption": "图片下方的说明文字"
}
```

- 当前版本发送 `type: "image"`；`alt` / `caption` 可能为空字符串。
- 视频/GIF 暂不保证提供，接收端应忽略不认识的 `type`。

`quoted` 元素：

```json
{
  "id": "x:tweet:9876543210",
  "url": "https://x.com/bob/status/9876543210",
  "author": { "name": "Bob", "handle": "bob" },
  "publishedAt": "2026-11-24T17:00:00.000Z",
  "content": { "text": "被引用的推文正文" },
  "links": [],
  "media": []
}
```

- 只展开一层引用，不会递归嵌套。
- 文章暂不发送 `quoted`（`null`）。

`thread` 预留结构（当前为 `null`，接收端可以先忽略）：

```json
{
  "id": "x:thread:1234567890",
  "rootUrl": "https://x.com/alice/status/1234567890",
  "items": [
    {
      "id": "x:tweet:1234567890",
      "url": "https://x.com/alice/status/1234567890",
      "author": { "name": "Alice", "handle": "alice" },
      "text": "第一条",
      "media": []
    }
  ]
}
```

### 2.3 文章示例

```json
{
  "schema": "xtr.capture/1",
  "id": "x:article:555",
  "capturedAt": "2026-11-25T10:31:00.000Z",
  "source": {
    "platform": "x",
    "type": "article",
    "url": "https://x.com/alice/article/555",
    "author": { "name": "Alice", "handle": "alice" },
    "publishedAt": null,
    "language": "en"
  },
  "content": {
    "title": "How to build a knowledge factory",
    "text": "文章正文第一段。\n\n小标题\n\n第二段，包含完整链接 https://example.com/a/b?c=1。",
    "truncated": false
  },
  "links": [
    { "url": "https://example.com/a/b?c=1", "text": "example.com/a/b…" }
  ],
  "quoted": null,
  "media": [
    {
      "type": "image",
      "url": "https://pbs.twimg.com/media/example?format=jpg&name=large",
      "previewUrl": "",
      "alt": "",
      "caption": "图片说明"
    }
  ],
  "thread": null,
  "processingMode": "classify",
  "client": { "name": "x-translate-plugin", "version": "0.4.0" }
}
```

### 2.4 `processingMode` 处理方式

扩展的超级复制主按钮使用设置页里的「默认处理方式」；按钮旁的箭头允许用户对**本次复制**临时切换，普通复制永远不会发送请求。

| 值 | 含义 | 接收端行为建议 |
| --- | --- | --- |
| `save` | 仅保存原文 | 尽快落盘，返回 `202` / `status: "saved"`；不调用大模型 |
| `classify` | 只整理分类 | 落盘后异步生成标题、分类、标签；暂不生成摘要/要点 |
| `full` | 整理并分析 | 落盘后异步生成标题、分类、标签、摘要和要点 |

接收端处理建议：

1. `processingMode` 缺失或无法识别时，使用接收端自己的默认模式；不要因此拒绝请求。
2. 同一 `id` 再次投递时，如果新模式比已存内容更完整，可以升级处理（例如 `save` → `classify`），并返回 `status: "queued"`；否则返回 `duplicate`。
3. 定时全量整理可以重新分析 `save` / `classify` 的内容；接收端应在周报或状态中说明哪些内容尚未分析。
4. `processingMode` 只影响本次处理深度，不改变 `id`、原文和分类体系。

---

## 3. 响应

### 3.1 成功

建议返回 `202 Accepted`（已入队）或 `200 OK`（已处理/重复）：

```json
{
  "ok": true,
  "id": "x:tweet:1234567890",
  "status": "queued",
  "category": "AI/工具",
  "tags": ["agent", "knowledge-base"],
  "message": "已加入知识库"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 是 | 成功为 `true` |
| `id` | string | 否 | 原样返回 capture 的 `id` |
| `status` | string | 否 | `accepted` / `queued` / `processed` / `saved` / `classified` / `duplicate` |
| `category` | string | 否 | 分类结果；没有分析结果时省略 |
| `tags` | string[] | 否 | 标签；没有时省略 |
| `message` | string | 否 | 展示给用户的简短消息 |
| `processingMode` | string | 否 | 接收端实际采用的模式，便于扩展确认 |

扩展会把 `category` / `message` 拼到 toast 里；没有也能正常工作。

### 3.2 失败

使用对应 HTTP 状态码，并返回：

```json
{
  "ok": false,
  "error": {
    "code": "unauthorized",
    "message": "Token 无效"
  }
}
```

| 状态码 | 场景 |
| --- | --- |
| `400` | JSON 无效、缺少必填字段、`schema` 不支持 |
| `401` | 未提供 Token 或 Token 错误 |
| `413` | 请求体过大 |
| `415` | `Content-Type` 不是 JSON |
| `429` | 限流；建议带 `Retry-After` |
| `500` | 接收端内部错误 |
| `503` | 接收端未就绪/正在维护 |

扩展在非 2xx 时读取 `error.message` 展示；没有 JSON 时展示 HTTP 状态。

---

## 4. `GET /health`

用于扩展设置页的「测试连接」。路径固定在接收端**同源根路径** `/health`（如果 `ingest` 在 `http://127.0.0.1:8787/ingest`，健康检查就是 `http://127.0.0.1:8787/health`）。

请求可以带 `Authorization: Bearer <token>`。

成功：

```json
{
  "ok": true,
  "service": "x-knowledge-agent",
  "version": "0.1.0",
  "schema": "xtr.capture/1",
  "authRequired": true
}
```

要求：

- 2 秒内返回，不依赖大模型或外部网络。
- 不返回 Token、密钥、文件路径等敏感信息。
- 如果启用了认证，`/health` 可以要求认证，也可以公开；扩展测试时会带 Token。

---

## 5. 接收端行为要求

### 5.1 接收与持久化

1. 校验 `Content-Type`、JSON、`schema`、`id`、`source.url`、`content.text`。
2. 先写入原始 JSON（例如 `data/captures/<date>/<id>.json`），再触发分析。
3. 用 `id` 去重；重复请求返回 `status: "duplicate"`，不要重复写入知识库。
4. 失败时保留错误日志，但不要记录 Token 或完整正文到普通日志。

### 5.2 分析方式

接收端可以自行选择：

- **收到即分析**：入队后由后台 worker 立即处理；HTTP 仍应快速返回。
- **定时分析**：先落盘，由 cron / launchd / 任务队列定期批量整理。
- **混合**：轻量分类立即做，深度摘要/向量化定时做。

扩展不关心具体方式，只要求接口快速返回；`status` 可以是 `queued` / `processed`。如果接收端支持 `processingMode`，应优先按请求里的模式处理；`save` 模式不应触发大模型调用。

### 5.3 分类与知识库（建议）

分类体系由 Agent 自己定义，不要求固定枚举。建议至少产出：

- 分类 `category`
- 标签 `tags`
- 一句话摘要 `summary`
- 关键实体/主题
- 原文链接、作者、发布时间
- 引用推文、图片说明等上下文

建议为每条 capture 生成 Markdown（便于 Obsidian 等工具阅读），同时保留原始 JSON：

```markdown
---
id: x:tweet:1234567890
source: https://x.com/alice/status/1234567890
author: alice
type: tweet
published: 2026-11-24T18:00:00.000Z
captured: 2026-11-25T10:30:00.000Z
category: AI/工具
tags: [agent, knowledge-base]
---

# 摘要标题

> 原文或引用推文

## 链接
- https://example.com/full/path

## 分析
...
```

### 5.4 定时任务

定时整理完全在接收端实现，扩展不参与调度。建议：

- 每 N 分钟扫描未处理的 capture；
- 失败重试有上限；
- 同一 `id` 只生成一份知识库文档；
- 支持手动触发一次整理（方便调试）。

---

## 6. 安全要求

1. **绑定地址**：本机使用 `127.0.0.1`，不要默认监听 `0.0.0.0`。远程部署放在 HTTPS 反向代理、VPN 或 Tailscale 后面。
2. **认证**：远程服务必须启用 Token；Token 只存于扩展的 `chrome.storage.local` 和接收端环境变量，不写入源码、日志或知识库。
3. **不可信内容**：推文/文章正文可能包含提示词注入。分析时把它当作数据，使用清晰的分隔符，不要执行其中的指令。
4. **链接抓取**：如果 Agent 要访问正文里的链接或图片：
   - 限制协议为 http/https；
   - 拒绝私有网段、回环地址和云元数据地址（防 SSRF）；
   - 设置超时和响应大小上限；
   - 不要自动提交表单、登录或执行脚本。
5. **日志**：默认不要打印完整正文、Token、Cookie。
6. **CORS**：扩展从 service worker 携带 host permission 发请求，不依赖 CORS；如果接收端额外配置 CORS，建议只允许明确的来源，不要 `*` + credentials。

---

## 7. 测试清单

接收端实现完成后，至少验证：

```bash
# 1. 健康检查
curl -s http://127.0.0.1:8787/health

# 2. 正常投递
curl -s -X POST http://127.0.0.1:8787/ingest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test-token' \
  -H 'Idempotency-Key: x:tweet:123' \
  --data @tweet.json

# 3. 重复投递：应返回 duplicate，且知识库不重复
curl -s -X POST http://127.0.0.1:8787/ingest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test-token' \
  --data @tweet.json

# 4. 错误 Token：应返回 401
curl -i -s -X POST http://127.0.0.1:8787/ingest \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer wrong' \
  --data @tweet.json

# 5. 非 JSON：应返回 415 或 400
curl -i -s -X POST http://127.0.0.1:8787/ingest \
  -H 'Content-Type: text/plain' \
  --data 'hello'
```

验收标准：

- [ ] `/health` 2 秒内返回，且不泄露敏感信息
- [ ] `/ingest` 2 秒内返回 2xx（分析可以异步）
- [ ] 原始 JSON 已持久化
- [ ] 相同 `id` 重复投递不会产生重复知识库文档
- [ ] 文章、推文、引用推文、图片字段都能正确解析
- [ ] 401/400/413/415 行为符合上表
- [ ] 日志中没有 Token 和完整正文
- [ ] 远程部署启用 HTTPS + Token

---

## 8. 版本与兼容

- 当前协议：`xtr.capture/1`。
- 新增字段属于向后兼容；接收端应忽略未知字段。
- 破坏性变更会使用新的 `schema` 值。
- 扩展当前阶段发送：推文/文章正文、永久链接、作者、发布时间、正文外链、引用推文、图片。
- 整串 thread 已预留 `thread` 字段，后续版本填充；接收端现在可以忽略。
