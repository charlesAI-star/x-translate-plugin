# X 知识库 Agent

本地知识库 Agent，用来接收浏览器扩展 [x-translate-plugin](../README.md) 的「超级复制」内容，完成整理、分类、分析、每周全量复盘，并提供 Web UI 和 CLI。

- 接收协议：[`docs/super-copy-agent-api.md`](../docs/super-copy-agent-api.md)（`POST /ingest`、`GET /health`）
- 分析引擎：本机 **Claude Code CLI**（无 Anthropic API Key 也能用）
- 存储：SQLite + 原始 JSON + Markdown
- 分类：一级分类稳定，二级分类可动态调整；一级分类调整必须由你确认
- 处理模式：`save`（只保存）/ `classify`（只整理分类）/ `full`（整理并分析）

---

## 快速开始

要求：

- Node.js **>= 22.13**（使用内置 `node:sqlite`）
- 已安装并登录 Claude Code CLI：`claude --version` 能正常运行
- 本机端口 `8787` 未被占用（可在 `config.json` 修改）

```bash
# 在项目根目录
node agent/server.js
```

打开 <http://127.0.0.1:8787>。

插件设置：

1. 打开扩展设置页 →「超级复制」→ 启用。
2. Agent 接收地址填 `http://127.0.0.1:8787/ingest`。
3. 如果 `config.json` 配置了 `token`，在插件里填同一个 Token。
4. 默认处理方式建议选「整理并分析」；推文「存知识库」旁的箭头可以对**本次复制**临时切换。

> 普通「复制」不会发送任何请求；只有点击「存知识库 / 存全文」或其模式菜单才会投递。

### Claude Code CLI 说明

Agent 通过无头模式调用：

```bash
claude -p --output-format json --json-schema <schema> --model sonnet ...
```

`config.json` 默认显式传 `--model sonnet`，避免本机 `~/.claude/settings.json` 里的默认模型不可用。若你使用本地路由或特定模型，可修改：

```json
{
  "llm": {
    "provider": "claude-cli",
    "command": "claude",
    "model": "sonnet",
    "timeoutMs": 180000,
    "maxTurns": 3,
    "maxBudgetUsd": 0.5,
    "retries": 2
  }
}
```

Agent 会禁用 Claude CLI 的工具（Bash、文件读写、Web 访问等），只让模型做结构化判断。输入内容被标记为不可信数据，不执行其中的指令。

---

## 三种处理模式

| 模式 | 超级复制后发生什么 | 状态 |
| --- | --- | --- |
| `save` | 只保存原文和 Markdown，不调用模型 | `saved` |
| `classify` | 异步生成标题、一级/二级分类、标签，不生成摘要 | `classified` |
| `full` | 异步生成标题、分类、标签、摘要、要点 | `ready` |
| 每周整理 | 对**所有**条目重新分析，刷新摘要、分类和分类总结 | `ready` |

- 模式由插件在发送时决定；缺失时使用 `config.json` 的 `processing.defaultMode`（默认 `full`）。
- 同一 `id` 再次投递时，如果新模式更完整，会升级处理。例如先 `save`，之后又用 `full` 发送同一推文，会重新分析。
- Agent 的 `POST /ingest` 始终快速返回 `202`；模型分析在后台队列执行。

---

## Web UI

- **全部内容 / 待整理 / 仅保存 / 待分析 / 已分析 / 失败**：按状态筛选。
- **分类树**：点击一级或二级分类过滤内容。
- **内容详情**：
  - 查看摘要、要点、标签、原文、引用推文、链接和媒体说明；
  - 手动移动分类；
  - 添加、编辑、删除「我的想法」；
  - 立即「完整分析」或「仅整理分类」；
  - 删除/恢复（软删除，进入回收站）。
- **每周报告**：查看历史周报、分类变化、手动分类被覆盖的条目、一级分类提案；可以取消/恢复任务或回滚本次分类调整。
- **分类总结**：每次全量整理后按一级分类生成，可导出 Markdown。
- **分类管理**：新建一级/二级分类、改名、归档。一级分类也可以手动维护。
- **设置**：配置访问 Token（只保存在浏览器 `localStorage`），复制插件接收地址。

移动、删除、添加想法只会在你主动操作时发生，Agent 不会自动执行。

---

## 每周全量整理

默认每周一 09:00（本机时区）执行；服务不在线时会在一周内补跑；同一 ISO 周已有任务时跳过。也可以在 UI 或 CLI 手动触发。

阶段：

1. **scan**：扫描全部条目和分类统计。
2. **govern**：模型判断二级分类的创建/改名/合并/归档；一级分类只生成提案，不自动执行。
3. **analyze**：分批（默认 20 条/批）重新分析**所有**条目，刷新摘要、要点、标签；分类变化有稳定性上限（默认最多 30%，且至少 15 条），避免一次改动过多。
4. **summarize**：按一级分类生成学习总结，包含二级分类小节、主题和学习顺序。
5. **report**：生成周报，列出新增、分析量、分类变化、手动分类覆盖、待确认提案和数据质量。

规则：

- 二级分类由 Agent 自主管理，归档不删除内容；条目会迁移到父级或目标分类。
- 一级分类的创建/归档只写入 `proposals`，必须在 UI/CLI 中批准。
- 你手动设置过的分类允许被每周分析覆盖，但会在周报中标注 `manual_override`；可在周报里复核。
- 回滚只撤销该次任务产生的**分类移动**，不会回滚摘要/标签等分析结果。
- 任务状态保存在 SQLite，服务重启后可以从断点恢复。

相关参数在 `config.json` 的 `weekly`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用自动周任务 |
| `dayOfWeek` | `1` | 1=周一 … 7=周日 |
| `hour` / `minute` | `9` / `0` | 本机时间 |
| `analyzeBatchSize` | `20` | 每批分析条数 |
| `analyzeTextChars` | `3000` | 每条送入模型的正文上限 |
| `maxL2Actions` | `8` | 每次最多执行的二级分类调整 |
| `maxCategoryChangesRatio` | `0.3` | 分类变化上限比例 |
| `minCategoryChanges` | `15` | 分类变化上限的最小值 |
| `maxSummariesPerRun` | `20` | 每次最多生成的分类总结数 |

---

## CLI

CLI 通过 HTTP API 操作正在运行的 Agent：

```bash
node agent/cli.js status
node agent/cli.js list --limit 20
node agent/cli.js list --status saved
node agent/cli.js search 知识库
node agent/cli.js show x:tweet:1234567890
node agent/cli.js notes x:tweet:1234567890
node agent/cli.js note x:tweet:1234567890 "这个思路可以用在周报里"
node agent/cli.js move x:tweet:1234567890 --l1 product --l2 l2_xxx
node agent/cli.js process x:tweet:1234567890 --mode full
node agent/cli.js delete x:tweet:1234567890
node agent/cli.js restore x:tweet:1234567890
node agent/cli.js categories
node agent/cli.js weekly run
node agent/cli.js weekly list
node agent/cli.js weekly show 2026-W48-xxxx
node agent/cli.js proposals --status pending
node agent/cli.js approve prop_xxx
node agent/cli.js summaries
```

连接参数：

```bash
KB_ENDPOINT=http://127.0.0.1:8787 KB_TOKEN=your-token node agent/cli.js status
# 或
node agent/cli.js status --endpoint http://127.0.0.1:8787 --token your-token
```

所有命令支持 `--json` 输出原始 JSON。

---

## HTTP API

除 `/health` 和 `/ingest` 外，`/api/*` 在配置了 Token 时都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查，公开 |
| `POST` | `/ingest` | 接收 `xtr.capture/1` |
| `GET` | `/api/status` | 统计、队列、LLM、当前周任务 |
| `GET` | `/api/entries` | 列表，支持 `q/category/status/deleted/sort/limit/offset`；`status` 可用逗号分隔 |
| `GET/PATCH` | `/api/entries/:id` | 详情；PATCH 支持移动分类、删除、恢复 |
| `POST` | `/api/entries/:id/process` | `{ "mode": "classify" \| "full" }` |
| `POST` | `/api/entries/:id/retry` | 重试失败条目 |
| `POST` | `/api/entries/:id/notes` | 添加想法 |
| `PATCH/DELETE` | `/api/notes/:id` | 修改/删除想法 |
| `GET/POST` | `/api/categories` | 分类树 / 新建分类 |
| `PATCH/DELETE` | `/api/categories/:key` | 改名 / 归档 |
| `GET` | `/api/summaries` | 分类总结 |
| `POST` | `/api/export/summaries` | 导出分类总结 Markdown |
| `GET` | `/api/weekly` | 周任务列表 |
| `POST` | `/api/weekly/run` | 手动开始 |
| `GET` | `/api/weekly/current` | 当前任务 |
| `GET` | `/api/weekly/:id` | 周报详情 |
| `POST` | `/api/weekly/:id/cancel\|resume\|rollback` | 取消/恢复/回滚 |
| `GET` | `/api/proposals` | 一级分类提案 |
| `POST` | `/api/proposals/:id/approve\|reject` | 批准/拒绝 |

---

## 数据与备份

```text
agent/data/
  kb.sqlite              # 条目、分类、笔记、任务、事件、提案、总结
  captures/<date>/*.json # 原始 capture，先落盘再分析
  library/<一级>/<二级>/*.md
  reports/<week>.md
```

备份时复制整个 `agent/data/` 即可。`kb.sqlite` 使用 WAL，运行中复制建议先停止服务，或同时复制 `-wal` / `-shm` 文件。

原始 JSON 永久保留；删除条目只是软删除，Markdown 会被移除，但 capture JSON 和分析事件仍在数据库中。

---

## 配置

默认读取 `agent/config.json`，也支持环境变量覆盖：

| 环境变量 | 说明 |
| --- | --- |
| `KB_PORT` / `KB_HOST` | 监听地址，默认 `127.0.0.1:8787` |
| `KB_TOKEN` | 访问 Token；设置为空字符串表示关闭认证 |
| `KB_DATA_DIR` | 数据目录 |
| `KB_CONFIG` | 配置文件路径 |
| `KB_LLM_PROVIDER` | `claude-cli` 或 `mock` |
| `KB_LLM_COMMAND` | Claude CLI 命令，默认 `claude` |
| `KB_LLM_MODEL` | 模型，默认 `sonnet` |
| `KB_WEEKLY_ENABLED` | `1/0` 覆盖自动周任务开关 |

`config.json` 里的 `categories` 是首次启动时写入的一级分类种子；之后以数据库为准，修改配置不会覆盖已存在的分类。

---

## 安全

- 默认只监听 `127.0.0.1`；监听非回环地址必须设置 `token`，否则服务拒绝启动。
- 插件内容按不可信数据处理：不执行正文指令、不自动访问正文链接、不把正文当系统提示词。
- 模型通过 Claude CLI 无头模式运行，禁用了 Bash、文件、Web 等工具。
- API 不发送 CORS 头；Web UI 与 API 同源。
- Markdown 渲染会转义 HTML，链接只允许 `http/https`。
- 日志不记录请求正文和 Token。

远程部署建议：反向代理 + HTTPS + 强 Token，并限制来源 IP。

---

## 测试

```bash
# agent 无外部依赖测试（mock LLM）
node --test agent/test/*.test.js

# 插件单元测试
npm test

# 插件端到端测试（需要 Chrome for Testing）
CHROME_PATH="/path/to/Google Chrome for Testing" npm run test:e2e
```

Agent 测试使用临时数据目录和 mock Claude 响应，不会调用真实模型，也不会污染 `agent/data/`。

---

## 常见问题

**`claude --version` 正常，但分析失败？**

检查 `config.json` 的 `llm.model` 是否可用。Agent 显式传 `--model`，避免本机默认模型配置异常。查看服务日志中的 `[worker]` / `[llm]` 信息。

**插件显示 401**

`config.json` 配置了 `token`，插件设置里的 Token 必须一致。Web UI 也需要在「设置」里填写同一个 Token。

**周任务没有自动运行**

确认 `weekly.enabled=true`、服务在周一 09:00 之后运行过、且本周还没有任何周任务。自动任务在同一 ISO 周只跑一次；手动任务不受限制。

**手动改了分类，周任务又改回去了？**

这是当前设计：每周全量分析允许覆盖手动分类，但会在周报的「手动分类被覆盖」中列出。可以在周报里回滚该次分类调整。

**只想保存，不想调用模型？**

在插件设置里把默认处理方式改为「只保存原文」，或点击「存知识库」旁的箭头选择「仅保存原文」。每周整理仍会全量分析这些内容；如果不想自动分析，关闭 `weekly.enabled` 并手动触发。
