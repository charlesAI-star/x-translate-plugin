# X 翻译 — 推文自动翻译

一个只作用于 **X（Twitter）** 的 Chrome 扩展：时间线里出现外语推文时，自动在原文下方显示中文译文；也可以切换成其他目标语言。默认优先使用 **Chrome 内置的本地翻译**，不需要 API Key；需要更高质量时可以接入 **DeepSeek / OpenAI 兼容大模型**。

> 如果你只是想要一个成熟的通用翻译工具，可以直接安装 [Kiss Translator](https://github.com/fishjar/kiss-translator)（开源，扩展 + 油猴脚本）或 [沉浸式翻译](https://immersivetranslate.com/)。本项目是为「只翻译 X、零配置、代码可审计」做的一个精简实现。

---

## 功能

- **只作用于 X**：仅在 `x.com`、`twitter.com`、`mobile.twitter.com` 运行，不碰其他网站。
- **自动翻译外语推文**：普通时间线滚动到推文时按需翻译；博主主页会提前翻译前 12 条（仅大模型模式，可在设置中关闭），滚动时更少等待。
- **批量与并发**：大模型请求按 4–8 条分组并行发送，先返回的推文先显示译文，不会等整批完成。
- **双语对照**：译文显示在原推文下方，保留原文，方便核对。
- **随时看原文**：鼠标移到译文上可「隐藏」；隐藏后出现「显示译文」小按钮，点一下即可恢复。
- **一键复制**：鼠标移到推文上会出现「复制」按钮；文章标题旁有「复制全文」。自动把被截断的链接还原成完整 URL，保留换行、段落和列表。
- **多种目标语言**：简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Español、Русский 等 20+ 种。
- **手动模式**：关闭「自动翻译」后，每条推文下方会出现「翻译」按钮，按需翻译。
- **引用推文**：引用内容也会翻译（可关闭）。
- **多个翻译服务**：
  - Chrome 内置翻译（免费、本地、无需 Key）
  - Google 翻译免费接口（无需 Key）
  - 大模型（OpenAI 兼容：DeepSeek、OpenAI、硅基流动、Moonshot、智谱、OpenRouter、Ollama、LM Studio、Magpie、自定义）
  - 本地路由自动检测：扫描 Magpie / Ollama / LM Studio / LiteLLM / One API 等常见端口，并从 `/v1/models` 读取模型列表
  - Microsoft Translator（Azure，需要 Key，有免费额度）
  - MyMemory（无需 Key 的备用接口）
- **自动降级**：「自动」模式下，Chrome 本地翻译不支持某个语言对、模型还没下载或准备失败时，会自动改用 Google。
- **本地模型一次点击**：Chrome 要求扩展下载翻译模型必须由用户手势触发。第一次遇到需要下载的语言对时，页面下方会提示「启用本地翻译」，点一次即可；不点则继续用 Google，不影响阅读。
- **缓存与限流**：相同文本不会重复请求；免费接口自动重试、限速，避免一开页面就触发 429。
- **无遥测**：没有统计、没有远程代码，API Key 只保存在本机。

---

## 安装（本地加载）

1. 打开 Chrome，进入 `chrome://extensions`。
2. 打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目目录（包含 `manifest.json` 的那一层）。
4. 安装后会自动打开设置页。默认配置即可使用：
   - 翻译服务：**自动（本地优先）**
   - 目标语言：**简体中文**
   - 自动翻译：**开**
5. 打开或刷新 `https://x.com`。**已经打开的 X 页面需要刷新一次**，因为内容脚本只在页面加载时注入。

> 本项目没有上架 Chrome 应用商店，所以用「加载已解压」的方式安装。更新代码后，在 `chrome://extensions` 点击扩展卡片上的刷新按钮，然后刷新 X 页面。

---

## 使用

### 自动模式（默认）

向下滚动时间线，遇到与目标语言不同的推文时，原文下方会出现译文：

```
This is a tweet about AI.
────────────────────────
这是一条关于人工智能的推文。
本地 · 隐藏
```

- 译文左侧的蓝色竖线表示这是翻译内容。
- 鼠标移到译文上，底部会出现「本地 / Google / AI」来源和「隐藏」按钮。
- 点击「隐藏」后，译文收起，原文下方出现「显示译文」小胶囊；再点一次恢复。
- 想临时停用整个扩展：点击工具栏图标，关闭右上角总开关。

### 手动模式

在弹窗或设置里关闭「自动翻译」后，每条推文下方会出现「翻译」小按钮，只有点击才会翻译。

### 换目标语言

弹窗里可以直接切换；设置页里也可以改。切换后，当前页面已有的译文会被清除并按新语言重新翻译。

### 只翻译某一条 / 不翻译某一条

- 自动模式下：点击译文上的「隐藏」，这条推文就只看原文。
- 手动模式下：不点「翻译」即可。
- 想彻底跳过已经是中文的推文：保持「跳过已经是目标语言的推文」开启（默认）。

### 一键复制

- **推文**：鼠标移到推文上，操作栏会出现「复制」按钮，点击即可复制正文纯文本。
- **文章**：标题旁的「复制全文」会复制标题和正文，包括段落、小标题、列表、引用和图片说明。
- 复制的是**原文**，不包含译文、评论或引用推文；被 X 截断的链接会展开成完整 URL，换行和列表会保留。
- 中文推文同样可用，复制按钮不依赖是否触发翻译。
- 复制只在点击时写入本机剪贴板，不会发送到任何服务。

---

## 翻译服务怎么选

### 1. 自动（推荐，零配置）

优先使用 **Chrome 内置翻译**：

- 免费、在本机运行，文本不会离开电脑。
- 首次翻译某个「源语言 → 目标语言」组合时，Chrome 会下载对应模型（通常几 MB 到几十 MB），需要等几秒到几十秒；之后很快。
- **Chrome 要求模型下载由用户手势触发**。第一次遇到某个语言对时，扩展会在页面底部提示「启用本地翻译」，点一下才会开始下载；不点则自动用 Google，翻译不会中断。也可以在设置页点「测试当前配置」预先下载（会用一段英文测试，下载英语 → 目标语言的模型）。
- 需要 **Chrome 138 或更高版本**。旧版 Chrome 会自动改用 Google。
- 不是所有语言对都支持；不支持时自动降级到 Google。

如果 Chrome 本地翻译不可用，自动模式会请求 Google 的免费网页接口。这个接口不需要 Key，但可能被限流（HTTP 429），速度也取决于网络/代理。

### 2. 大模型（质量最好）

适合网络用语、反讽、长推文，译文比传统机器翻译自然。支持任何 **OpenAI 兼容** 的 `/chat/completions` 接口。

**DeepSeek（推荐，便宜且中文好）**

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建 API Key。
2. 设置页 → 翻译服务 → 大模型 → 预设选「DeepSeek」。
3. 填写 API Key；地址和模型会自动填好：
   - Base URL：`https://api.deepseek.com/v1`
   - 模型：`deepseek-chat`
4. 点击「保存设置」，Chrome 会询问是否允许访问 `https://api.deepseek.com/*`，选择允许。
5. 点「测试当前配置」确认能返回译文。

其他预设：

| 预设 | Base URL | 模型示例 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini`（可改成你账号可用的模型） |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:7b` |
| LM Studio（本地） | `http://localhost:1234/v1` | 本地模型名 |
| Magpie（本地路由） | `http://127.0.0.1:3425/v1` | 从 Magpie 的模型/路由组选择，例如 `auto/glm-5.3-flash` |

**本机 Magpie 路由**

如果你已经装了 [Magpie](https://github.com/yetone/magpie)（菜单栏里的本地 AI 网关），可以直接把它的 OpenAI 兼容接口接进来：

1. 确认 Magpie 已经启动（菜单栏图标在运行）。默认网关是 `http://127.0.0.1:3425/v1`，默认 Key 是 `magpie`。
2. 设置页 → 翻译服务 → **大模型（OpenAI 兼容）**。
3. 预设选 **Magpie（本地路由）**；或者点 **自动检测本地服务**，在扫描结果里点 Magpie。
4. 点 **获取模型**，从返回的列表里选一个 `provider/model` 或 `group/...` 路由组。
5. 保存设置，并在 Chrome 询问时允许访问 `127.0.0.1`。

「自动检测」会扫描 `127.0.0.1` 上的常见端口：Magpie（3425）、Ollama（11434）、LM Studio（1234）、LiteLLM（4000）、One API / New API（3000）、vLLM（8000）等。检测只负责填入 Base URL 和模型列表，**不会自动切换你的翻译服务**；默认仍然是「自动（本地/Google）」，只有你在设置里选了「大模型」并保存后才会使用 Magpie。

- 本地 Ollama / LM Studio / Magpie 可以留空 API Key（Magpie 默认填 `magpie`）。
- 文本是否离开本机取决于 Magpie 背后的路由：转到本地模型就在本机处理，转到云端 provider 就会发给对应的云端服务。
- 大模型模式会按 4–8 条分组发送（每个请求最多 8 条），多个分组并行请求；超长推文会分段翻译后拼接。先完成的译文会先显示。
- 在博主主页会提前翻译前 12 条推文（默认开启，可在「高级」里关闭）；这会略微增加模型调用，但滚动体验会明显更顺畅。
- 速度主要取决于模型：带 `flash` / `mini` / `fast` 的模型通常快很多；带 `pro` / `max` / `thinking` 的推理模型会慢一些。Magpie 的 `auto/...` 是路由组，可能比直接的 `provider/model` 多一层路由，建议两种都试一下。
- API Key 只保存在本机 `chrome.storage.local`，不会同步到云端，也不会进入 X 页面。
- 费用由你选择的模型决定；普通时间线浏览通常很便宜。

**翻译速度参考（本机 Magpie，12 条主页推文）**

| 模型 | 首屏 4 条 | 全部 12 条 | 备注 |
| --- | --- | --- | --- |
| `auto/glm-5.3-flash` | 约 1.5–2.6 秒 | 约 3–3.7 秒 | 推荐日常使用 |
| `auto/deepseek-v4.1-flash` | 约 4.5–5.7 秒 | 约 4.6–10.7 秒 | 质量好，但波动较大 |
| `opencode-go/deepseek-v4.1-flash` | 约 5–10 秒 | 更慢 | 直连 provider，不一定比路由组快 |

实际速度受 Magpie 路由、云端负载和网络影响。若觉得慢，优先换 `flash` 类模型；仍然慢时，可以关闭「个人主页提前翻译」减少调用量，或改用本地 Ollama / LM Studio。

### 3. Google 翻译（免费接口）

- 无需 Key，使用 `translate.googleapis.com` 的免费接口。
- 可能被 Google 限流；如果频繁出现「请求过于频繁」，换成本地翻译或大模型。
- 这是非官方接口，Google 随时可能调整；扩展会重试并提示错误。

### 4. Microsoft Translator（Azure）

1. 在 Azure 门户创建 **Translator** 资源。
2. 从「密钥和终结点」获取 Key 和区域（例如 `eastasia`）。
3. 设置页选择 Microsoft Translator，填写 Key 和区域。
4. 免费层每月约 200 万字符，适合中等使用量。

### 5. MyMemory

- 无需 Key，但每日额度较小，长推文会按 480 字节分段。
- 质量一般，只建议作为备用。
- 可选填邮箱提高额度。

---

## 设置说明

| 设置 | 说明 |
| --- | --- |
| 启用翻译 | 总开关。关闭后不翻译、不显示译文。 |
| 自动翻译可见推文 | 滚动到推文时自动翻译。关闭后改为每条推文下方的「翻译」按钮。 |
| 目标语言 | 只翻译与目标语言不同的推文。 |
| 跳过已经是目标语言的推文 | 例如目标为中文时跳过中文推文。关闭后可以用于「繁体 → 简体」等场景。 |
| 翻译引用推文 | 推文里嵌套的引用内容也翻译。 |
| 翻译个人简介 | 在个人主页翻译用户简介，默认关闭。 |
| 个人主页提前翻译 | 在博主主页提前翻译前 12 条推文（仅大模型模式），滚动时更少等待；会增加少量模型调用。 |
| 显示翻译服务标签 | 在译文下方显示「本地 / Google / AI」等来源。 |
| 最短翻译长度 | 小于该长度的内容跳过，避免翻译 `lol`、`+1` 等。 |
| 调试日志 | 在 X 页面控制台输出扫描和请求日志。 |

---

## 隐私

- 扩展只匹配 `x.com`、`twitter.com`、`mobile.twitter.com`，只读取推文文本节点。
- 不会读取你的密码、私信或其他网站内容。
- **Chrome 内置翻译**：文本在本机处理，不上传。
- **Google / MyMemory / Microsoft / 大模型**：只发送需要翻译的推文文本和语言参数到你选择的服务。请求由扩展的后台 Service Worker 发出，API Key 不会进入页面上下文。
- **个人主页提前翻译**：开启时，扩展会把博主主页上当前已加载的前 12 条推文一并送去翻译（包括还没滚动到的推文）；可在「高级」里关闭。
- **本地路由（Magpie / Ollama / LM Studio）**：扩展只直接连接你填写的 `127.0.0.1` / `localhost` 地址；文本之后是否继续发往云端，取决于该路由自己的配置。访问本机地址需要你在设置页点击检测或保存时授权一次。
- 没有分析、统计、远程配置或远程代码。
- API Key 保存在本机 `chrome.storage.local`，不参与 Chrome 同步。

---

## 已知限制

- **X 的 DOM 会变**。本项目使用 X 当前的内容选择器（`[data-testid="tweetText"]` 等）；如果 X 改版，可能需要更新 `content.js` 顶部的选择器。
- **安装/更新后需要刷新 X 页面**，内容脚本才会注入。
- **X 是单页应用**。扩展用 `MutationObserver` 监听新推文，正常情况下滚动加载没问题；极端情况下如果某条推文没被翻译，向下滚一下或刷新页面。
- **X 长文（Articles）**：支持翻译文章标题和正文段落、标题、列表、引用，兼容 X 当前版式和旧版 Draft.js 阅读器；图片说明、代码块等复杂内容可能不完整。
- **一键复制只复制文字**：图片、视频、投票不会复制；极长文章或 Draft.js 内容如果尚未渲染完，只能复制当前已加载的部分。
- **Chrome 本地模型按语言对下载**：遇到很多种语言时会占用一些磁盘空间；可以在 Chrome 设置里清理翻译模型。首次下载需要点一次「启用本地翻译」，这是 Chrome 的权限要求，无法完全静默。
- **免费接口不稳定**：Google 免费接口可能 429，MyMemory 有每日额度；长期稳定使用建议配置大模型或 Azure。
- **译文仅供参考**：机器翻译可能出错，重要内容请对照原文。

---

## 开发与测试

### 目录结构

```
manifest.json          MV3 清单
background.js          Service Worker：翻译请求、缓存、限流、测试
content.js             内容脚本：扫描推文、语言判断、渲染译文、本地翻译
content.css            译文与弹窗样式
popup.html/css/js      工具栏弹窗
options.html/css/js    设置页
lib/shared.js          语言表、默认设置、设置合并
lib/core.js            语言启发式、文本分段、响应解析（可在 Node 中测试）
lib/providers.js       Google / MyMemory / LLM / Azure 客户端
icons/                 图标
test/                  Node 单元测试 + 浏览器端到端测试
```

### 单元测试

无需安装依赖：

```bash
node --test test/*.test.js
```

或：

```bash
npm install
npm test
```

### 端到端测试（可选）

端到端测试会在本机启动一个 **Chrome for Testing**，加载扩展，打开一个模拟 X 时间线的本地页面，并把翻译服务指向本地模拟的大模型接口，验证：

- 外语推文出现译文
- 中文推文被跳过
- 引用推文翻译
- 隐藏/显示译文
- 新推文插入后自动翻译
- 个人主页提前翻译屏外推文
- 手动模式点击后翻译
- 设置页和弹窗正常渲染
- 从 `/v1/models` 读取模型列表，以及 Magpie 预设填入本地网关

Chrome 品牌版从 137 起默认禁用了 `--load-extension`，所以端到端测试需要用 Chrome for Testing：

```bash
npx @puppeteer/browsers install chrome@stable --path .cache/chrome
npm install
CHROME_PATH="$PWD/.cache/chrome/chrome/mac_arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm run test:e2e
```

如果路径不同，把 `CHROME_PATH` 换成实际的 Chrome for Testing 可执行文件即可。测试只会访问本地 `127.0.0.1` 和模拟的翻译接口，不会登录或操作真实 X 账号。

### 调试

- 设置页勾选「调试日志」，打开 X 页面开发者工具，筛选 `[X 翻译]`。
- 在 `chrome://extensions` 点击扩展的「Service Worker」链接，可以查看后台日志和缓存。
- 修改代码后：刷新扩展卡片 → 刷新 X 页面。

---

## 与现成项目的关系

调研过同类项目后，最接近需求的是：

- **[Kiss Translator / 简约翻译](https://github.com/fishjar/kiss-translator)**：GPL-3.0，浏览器扩展 + 油猴脚本，支持 X，Google/Microsoft/DeepL/OpenAI/DeepSeek 等，双语对照、规则订阅、术语库，功能非常完整。**如果你不想自己维护代码，直接用它是更省事的选择。**
- **[沉浸式翻译](https://immersivetranslate.com/)**：闭源但非常成熟，支持 X、PDF、字幕等，免费版可用 Google/Microsoft 等。

本项目没有直接 fork 上述项目，原因是：

1. 它们都是通用整页翻译工具，代码量和权限范围远大于「只翻译 X 推文」这个需求；
2. Kiss Translator 是 GPL-3.0，直接改造后分发需要遵循 GPL；
3. 本项目想做的是：**X-only、默认零配置、本地优先、代码短到可以自己审计和改**。

X 页面的选择器思路参考了 [kiss-rules](https://github.com/fishjar/kiss-rules)（`tweetText`、`twitterArticle`、`UserDescription`），但代码是独立实现的，没有复制其源码。

---

## 版本与分支

- `main` 始终保持可安装、单元测试通过；功能开发从 `main` 拉 `feature/<name>`，通过 Pull Request 合并。
- 发布时同步更新 `manifest.json` 和 `package.json` 的版本号，提交后打 `vX.Y.Z` tag。
- `dist/`、`*.zip`、`node_modules/`、`.env`、密钥和本地缓存不会提交到 Git；发布包作为 GitHub Release 附件上传。
- API Key 只保存在本机 `chrome.storage.local`，不要写进源码、README、Issue 或提交记录。

## License

MIT。见 [LICENSE](LICENSE)。

本项目与 X Corp. 无关。
