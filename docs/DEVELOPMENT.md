# 开发指南

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [代理规则](../AGENTS.md)

## 环境与入口

后端直接用 Node strip-types 执行 TypeScript，版本以 [CI](../.github/workflows/ci.yml) 为准；容器 Node 与系统工具以 [Containerfile](../Containerfile) 为准。前端使用 Solid、Vite 与 Monaco，后端为 Fastify、Drizzle／libSQL，Agent 使用本地 Pi SDK 和 SRT。Solid runtime／web／Vite 插件需按锁文件配套，不把预发布版本当稳定兼容承诺。

准确版本见 [package.json](../package.json)、[package-lock.json](../package-lock.json)、[requirements.txt](../requirements.txt)。安装须执行 postinstall 校验[依赖补丁](../patches/README.md)，不默许被策略阻止的脚本。工具环境见[部署](DEPLOYMENT.md#首次本地运行)。

修改前运行 git status，固定基线，读取 owner、契约、配置、schema 与聚焦测试；区分持久、有条件持久和生成状态。路由协调 owner，不重实现协议／Git／附件授权，不为风格重写合理设计。

## Pi CLI 与项目 SDK

项目直接依赖 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-schema`，由 `package-lock.json` 固定实际安装；运行入口通过 import 调用 SDK，不要求先全局安装 `pi`。`pi --version` 查看 PATH 中的 CLI，不能代表应用版本。

在仓库根查看本地依赖：

```bash
npm ls --depth=0
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-schema
```

全局 `pi update` 不更新项目锁文件或本地 SDK，也不替应用写入 SQLite 模型凭证。SDK 升级属于依赖变更，需配套检查[补丁](../patches/README.md)、调用 API、聚焦回归与完整验证，不能用全局 CLI 升级替代。

## 本地开发循环

先完成[首次运行准备](DEPLOYMENT.md#首次本地运行)，在自己的独立安装目录启动 API；另一个终端在同一仓库根执行 `npm run dev:web`。浏览器打开 `http://127.0.0.1:4173` 使用前端 HMR；`/api`、`/mcp` 代理到 3000 API，`/health` 不在 Vite 代理范围，检查健康请直连 API。

后端没有 `dev`／watch 脚本，也没有后端编译步骤；修改后端按需要优雅重启 API。`npm run build` 只生成 `src/web/dist`，不是启动服务。开发 Web 仍操作同一个 API 的真实 state，HMR 不提供数据隔离，不能将它指向生产 API 做试验。

## 代码约定

模块 kebab-case，组件／类型 PascalCase，局部符号 camelCase，遵循相邻 TS／TSX 风格。内部 UUID 称 issueId，业务编号称 issueKey；后端不用 strip-types 不支持的 enum、参数属性或装饰器。

业务规则集中在 domain，参数及凭证有各自 owner。应用 schema 用公开 Pi Schema builders 和 compile().check()；HTTP／入站 MCP／execute 严格，不隐式 coercion。公开 schema 与执行快照隔离，外部格式使用官方 formats，重复验证器只编译一次。SDK 内部传递依赖不代表应用仍直接依赖 TypeBox。

不同时间点的重授权、可变钩子后的校验和跨介质收尾不是冗余。抽象、缓存和依赖须有具体维护收益；微小性能差异不构成改写理由。

## 隔离测试

真实 .issue-pilot 含凭证、附件、JSONL、分支和恢复证据，不作夹具。后端通过 buildApi({ stateRoot, databaseFile }) 或 manager 注入临时根；手工服务器使用独立项目与根配置，没有 state 环境变量覆盖。

Pi 会话显式使用临时 agentDirectory，注入模型不能替代资源隔离。所有会话、连接、句柄和临时根在 finally／onTestFinished 关闭，断言失败也清理。不要在运行中的 checkout 安装依赖或覆盖 dist；动态 executor 会读取磁盘源码，health 200 不代表其可用。

## 无需真实模型的核心流程验证

在已安装依赖的仓库根执行以下现存测试，走工单创建、重复／冲突处理、消息受理和状态转换：

```bash
node --experimental-strip-types --test --test-concurrency=2 tests/http/issue-api.test.ts tests/http/application-mcp-create.test.ts
```

[HTTP fixture](../tests/http/fixture.ts) 通过 `buildApi({ stateRoot, databaseFile, engine, modelCatalog })` 创建临时数据库和根目录，注入替代 Agent／模型目录，使用 Fastify `inject` 调用真实路由，最后关闭并清理。它验证 HTTP／MCP 与存储契约，不监听真实部署端口，也不调用真实模型或远程 Git；不能据此声称模型、SSH、SRT 或网关集成通过。实际 Engine 的排队、输入持久化和失败恢复另见 `tests/agent/engine.test.ts`、`message-admission.test.ts`、`message-recovery.test.ts`。

新增行为测试沿用临时根注入模式，避免把上述替代 controller 的成功误当成 Agent 执行成功。手工验证真实能力则按[首张工单路径](DEPLOYMENT.md#首次本地运行)在独立安装中进行。

## 验证入口与边界

以下命令均在仓库根运行。普通检查与独立验收的前置条件不同，不能将 `npm test` 的通过推及所有入口；精确命令以 [package.json](../package.json) 为准。

| 入口 | 前置条件与作用 | 不代表什么／副作用 |
| --- | --- | --- |
| `npm run typecheck` | 已安装项目依赖；检查后端与 Web TypeScript | 不执行业务或生成 Web 产物 |
| `npm test` | Node、项目依赖与所测能力需要的本地工具；后端测试后再运行 jsdom 测试 | 后端失败时不会继续前端；不自动运行 browser／SLS CLI 验收；SSH 缺默认 sshd 可 skip |
| `npm run build` | 项目依赖；生成 `src/web/dist` | 不启动 API，不验证真实模型；不要在 live dist 原地构建 |
| `npm run test:ssh` | Linux、rootless Podman、Git／SSH 与 SRT 依赖 | 构建固定名的本地夹具镜像并启动临时容器，不是生产 SSH 验收；镜像会留作缓存 |
| `npm run test:browser` | 先生成生产 Web 构建，再准备独立 Playwright、Chromium 和系统库 | 真实 HTTP／SSE 和浏览器，但替代 Agent／模型；不会更新文档展示图 |
| `npm run test:sls-cli` | 实际 aliyun CLI 与 OpenSSL；本地 HTTPS／CONNECT 夹具 | 不读取真实云凭证、不访问真实 SLS，不替代厂商授权验收 |

CI 声明了上述独立验收步骤，具体工具安装见 [ci.yml](../.github/workflows/ci.yml)；必须看对应 Actions 的实际结果，不能因步骤存在就断言已通过。工具不存在、浏览器未安装或 rootless namespace 不可用时，先补齐环境并重新验证，不将跳过或启动失败记作通过。

### 常规检查

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

资源受限可用等价有界并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

| 变更 | 必要覆盖 |
| --- | --- |
| 业务／HTTP | 身份与等待后重检、DTO、预约、事务、错误含义 |
| Agent／协议 | 可变钩子后输入、范围、只读、取消、预算、重试与 shutdown |
| 文件／Git | mode/hash、符号链接、竞争、rollback/finalize、refs 与 dirty 状态 |
| 迁移 | fresh／已有 DB、失败原子性、纠正重试、历史保留 |
| Web | 导航、身份切换、草稿、重连、冲突、图片 URL 和 editor/model 释放 |
| 文档／截图 | 当前代码依据、相对链接与锚点、图片 hash、浏览器可见内容与演示隔离 |

运行时、依赖、协议安全、容器变化还执行生产 npm audit、pip check 和可用部署健康验证。SSH E2E 缺 sshd fixture 明确 skip，不当作通过；`npm run test:ssh` 使用 rootless Podman 提供独立 OpenSSH 服务并要求实际执行。显式指定 `ISSUE_PILOT_TEST_SSHD` 但程序不存在时直接失败。夹具范围见 [tests/fixtures](../tests/fixtures/README.md#ssh-服务)；远程模型／数据库／认证与完整容器需要对应环境。本机结果不代表远程 CI 成功。

纯文档可以按文档范围验证，不必为了文档运行用户工单的依赖安装或完整构建。应用自身检查与工单 Agent 的“默认不构建”策略是不同职责。

仓库 `npm run format`／`format:check` 使用 Biome，但 [biome.json](../biome.json) 明确排除 Markdown 和 docs；执行成功也不等于格式化了文档。目前没有专用 Markdown formatter 或链接检查脚本。文档变更保持现有标题、表格、代码围栏风格，逐项检查相对路径、锚点、导航及命令，并运行 `git diff --check`；不要为一次文档改动引入新框架或修改全仓库格式配置。

## Web 与浏览器

Solid 2 使用 compute／callback 形式的 createEffect；callback 只返回清理或 undefined。函数 keyed For 的子项是 accessor，避免捕获过时原始对象；Match render callback 保留参数，零参数函数可能被当 accessor 重建 DOM。

会话验证帧批处理、最终覆盖、完成消息选区、原生 details 键盘操作、快照去重和身份隔离。jsdom 不替代真实浏览器布局、选区和网络验收。

Markdown 在链接授权解析后清洗 HTML；文件预览同时检查声明和实际字节。Monaco 保存需处理 SHA-256、换行、撤销、自动保存及导航拦截，关闭释放 editor/model。CodeBrowser 动态加载，大型上游 chunk 提醒不通过抬阈值或随意拆分掩盖。

Markdown 解析使用锁文件中的 marked；升级时保留混合围栏、转义链接、未闭合强调符、页面解析、链接授权及清洗回归，见 [Markdown.test.tsx](../src/web/src/ui/Markdown.test.tsx) 和[浏览器验收](../tests/browser/acceptance.mjs)。上游解析器修复不替代应用的 DOMPurify 和链接策略。

CodeBrowser／Monaco 按需加载。图标使用主题的明确字段，JSON 使用固定 Monaco 版本提供的 tokenizer，并通过公开 languages API 注册高亮和括号配置；不引入已禁用的 JSON 语言服务及 Worker。升级 Monaco 时复查该 tokenizer 导出及浏览器验收。

## 可重复的真实浏览器验收

`tests/browser/acceptance.mjs` 启动临时 SQLite、Issue 根、Git worktree 和真实 HTTP/SSE 服务，再用生产构建与 Chromium 检查高亮、查找、粘贴、保存、CRLF、撤销／重做、差异、冲突、导航、Agent 草稿及选区。会话场景还覆盖 40 条实时历史、浏览历史时的未读提示和滚动位置、长草稿、键盘展开思考内容、点击发送及焦点恢复。Agent 执行器和模型目录使用测试实现，不发起远程模型请求。脚本最后关闭浏览器／API 并删除其临时状态；输出浏览器版本、源码基线／diff 哈希、视口、场景及加载资源。

Playwright 是独立验收工具，不加入应用依赖。以下 Bash 示例只在**自己的独立开发 checkout**执行：脚本固定读取仓库的 `src/web/dist`，不要对正在提供服务的目录执行构建。Linux 先准备浏览器系统库和中文字体（如 `fonts-noto-cjk`）；`install --only-shell` 只下载浏览器，不会安装这些系统包，CI 的安装方式见 [ci.yml](../.github/workflows/ci.yml)。工具安装需要网络，既不修改应用依赖，也不修改全局 Pi 配置。

逐步执行，任一步失败先停止，不继续使用缺失或旧构建做验收：

```bash
verification_root=$(mktemp -d)
npm install --prefix "$verification_root/tools" --ignore-scripts --no-audit --no-fund playwright@1.64.1
PLAYWRIGHT_BROWSERS_PATH="$verification_root/browsers" "$verification_root/tools/node_modules/.bin/playwright" install chromium --only-shell
npm run build
PLAYWRIGHT_BROWSERS_PATH="$verification_root/browsers" \
ISSUE_PILOT_PLAYWRIGHT_MODULE="$verification_root/tools/node_modules/playwright/index.mjs" \
ISSUE_PILOT_BROWSER_ARTIFACTS="$verification_root/artifacts" \
npm run test:browser
```

截图输出可选：设置 `ISSUE_PILOT_BROWSER_ARTIFACTS` 时输出 `application.png`、`code-1280.png`，失败时尝试保存 `failure.png`；它们仅包含本次夹具，不是 README 展示图。浏览器模块变量指向已安装工具的 `index.mjs`，浏览器路径须与下载时一致；不设置模块变量则尝试普通 `playwright` 包解析。

成功日志含浏览器版本、源码 commit、受检源文件 diff 哈希、视口、场景和资源，不应仅凭生成图片判断通过。验收脚本始终尝试关闭浏览器／API 并删除临时业务 state，但不会删除外部工具与截图目录；检查完日志和图片后，在同一 Shell 确认 `verification_root` 是本次 `mktemp` 的路径，再执行：

```bash
rm -rf -- "$verification_root"
```

这些环境变量只配置验收工具，不能覆盖应用的生产状态路径。

本地协议夹具不能替代实际厂商验收。模型、DMS/SLS、钉钉及外部 MCP 需要明确的独立测试目标、受控凭证位置、允许的只读查询与预期结果；不得自行选择生产连接，也不得用协议模拟结果声称外部系统已通过。

## 真实 SLS CLI 协议验收

安装与 [Containerfile](../Containerfile) 一致的 aliyun CLI 和 OpenSSL 后执行 `npm run test:sls-cli`。测试使用真实 CLI、临时 0600 凭证配置和本地 HTTPS 服务，覆盖分页、来源、后续页拒绝、证据不完整、输出预算与进程取消；不读取真实云凭证或访问云端。临时自签名证书仅由该子进程信任，精确目标的 CONNECT 代理将 SLS 的 project 子域名映射到回环地址，不修改 DNS 或关闭 TLS 校验。服务、套接字、配置和证书在测试结束时清理。

普通 `npm test` 不要求外部 CLI；此验收独立运行，缺少工具直接失败。CI 从 Containerfile 读取 CLI 版本并执行该入口。它验证应用调用真实 CLI 的协议形态，真实厂商权限、数据及网络仍需独立测试目标验收。诊断输出包含本次 CLI 实际版本；`test:sls-cli` 本身不强制安装版本，因此与生产一致性还需核对 Containerfile，不能只看测试通过。

## 页面图维护

[页面图](images/README.md) 是按 manifest 标明源码版本留存的展示材料，不随文本指南同步而自动更新。重新捕获时使用当前源码的独立应用、演示 SQLite／JSONL、临时本地 Git 和替代 Agent controller，不读真实业务、不调用模型或外部查询。记录 sourceCommit、Web tree、浏览器版本、视口和 SHA-256；只有实际重拍并校验后才更新图片与 manifest，不把旧图说成当前验收。

仓库没有四张展示图的独立生成脚本；`test:browser` 是固定场景的交互验收，不负责生成运营首页、工单、代码浏览器和参数页的完整展示组。若仅更新文字，保留原图和捕获记录，明确引用版本。

可在临时工具目录安装 Playwright，不增加应用依赖、不修改全局 Pi 设置。中文字体在临时 fontconfig 中引用，不能分发系统字体。检查截图文本、状态、加载完成、无页面异常和横向溢出，结束关闭浏览器／服务器并删除临时安装。

原始图片读取夹具在 [tests/fixtures](../tests/fixtures/README.md)，不是产品截图；不要因替换页面图而改变该夹具。

## 文档、清理与交付

现行指南描述当前契约，历史审查留在 records，不追加成变更流水账。静态／动态 import、Worker、CLI、构建复制、资源 URL 和测试引用都确认后才删除文件；迁移 SQL／journal 不变。

真实操作遵循[运维](RUNBOOK.md)，未知状态和独有证据保留。完成时报告改动、检查与缺口；提交、推送、部署和状态 mutation 依授权分别执行。
