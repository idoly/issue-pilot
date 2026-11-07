# 开发指南

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [代理规则](../AGENTS.md)

## 环境与入口

后端以 Node strip-types 直接执行 TypeScript，Fastify 协调 HTTP，Drizzle／libSQL 保存业务配置，Pi SDK 提供模型和会话，SRT 隔离本地模型工具。前端使用 Solid、Vite、Monaco，预发布 Solid runtime／web／插件必须按锁文件配套。

目标宿主机的 Node／Git 和工具路径见[部署](DEPLOYMENT.md#系统工具时区与中文)，源码与安装版本以 [package.json](../package.json)、[锁文件](../package-lock.json) 和 [requirements](../requirements.txt) 为准。CI 和 Containerfile 的环境是各自的验证入口，不能当作目标机已经运行的配置。

目标只安装生产依赖。开发、类型检查和构建先在独立 checkout 执行 npm ci，不能往正在服务的 node_modules 或 dist 安装／覆盖。每次改动前确认 Git baseline、owner、契约、配置、Schema 和聚焦测试，区分持久、条件持久和生成状态。

## Pi CLI 与项目 SDK

应用 import 本地锁定的 pi-ai、pi-coding-agent 和 pi-schema，不靠 PATH 中的全局 pi 运行。全局 pi update 不更新应用锁文件、补丁或 SQLite Key。检查本地依赖：

```bash
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-schema
```

SDK 变更需核对[补丁](../patches/README.md)、公开 API、协议兼容和回归，不用升级全局 CLI 代替。

## 本地开发循环

在独立安装按[首次运行](DEPLOYMENT.md#首次本地运行)准备自己的根配置和空数据，启动 API；另一个终端在同一独立仓库根运行 `npm run dev:web`，打开 4173。Vite 代理 /api 和 /mcp 到 3000，health 必须直连 API。

没有后端 watch 或 npm start。改后端后优雅重启；npm run build 只生成 src/web/dist，不启动服务。HMR 不隔离业务 state，不能把独立开发页指向目标业务 API 做试验。当前宿主机直接使用 API 提供构建网页，不需要 Vite 预览进程，见[部署](DEPLOYMENT.md)。

## 代码与数据库约定

业务规则归 domain；路由协调 owner，不重实现 Git、协议、存储或授权。模块 kebab-case，组件／类型 PascalCase；内部 UUID 为 issueId，业务编号为 issueKey。不使用 strip-types 不能处理的 enum、参数属性或装饰器。

Schema 使用公开 Pi Schema builders 和 compile().check()；未知输入在边界解析，可变钩子后仍要 execute 检查。保持队列次序、等待后重授权、取消、事务及 rollback／finalize，不把这些不同时间点的检查当重复。

[schema.ts](../src/db/schema.ts) 描述当前结构，实际升级用不可变 [drizzle](../drizzle)。改 Schema 不自动修改已有数据库；新增迁移及回归，不改已发布 SQL／journal。仓库没有 db:generate、db:push 或自动 down migration。

正常 API 启动执行迁移和 bootstrap；db:migrate 只做自己的迁移职责且取得同一 state 租约，运行 API 时拒绝，不是只读诊断。真实升级先按[运维](RUNBOOK.md#当前备份策略)准备检查点，测试向 migrateStateDatabase 注入临时路径。

## 隔离测试

目标 `data` 及源机历史 `.issue-pilot` 都含真实凭证、会话、原件、dirty worktree 和恢复证据，不作夹具。后端通过 buildApi({ stateRoot, databaseFile }) 或 manager 构造器注入临时根；手工服务用独立项目和根配置，没有 state 环境变量覆盖。

Pi 测试还需独立 agentDirectory，注入假模型不能替代资源隔离。所有连接、会话、文件句柄、服务器和临时根在 finally／onTestFinished 关闭，断言失败也清理。租约需要本地 Unix socket，测试环境应支持它，不能为通过测试关闭租约。

## 无需真实模型的核心流程验证

在已安装完整依赖的独立仓库根执行：

```bash
node --experimental-strip-types --test --test-concurrency=2 tests/http/issue-api.test.ts tests/http/application-mcp-create.test.ts
```

[fixture](../tests/http/fixture.ts) 创建临时 DB／root 并替代 Agent／模型；HTTP 使用 Fastify inject，MCP 用真实 SDK 连接随机本地端口。覆盖创建、冲突、消息受理和状态契约，不调用真实模型或远程 Git，也不证明 SRT／云服务可用。

若 Node 只显示文件级失败，可对相同夹具增加 --test-isolation=none --test-reporter=tap 定位；listen EPERM 表示环境禁止套接字，需修执行环境，不改成真实数据测试。

## 验证入口与边界

独立仓库根的常规代码检查：

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

资源受限时采用有界并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

npm test 后端失败不会继续前端；它不自动运行浏览器、SSH E2E 或 SLS CLI 独立验收。真实模型和网关也不由本地单元测试证明。运行时／依赖／协议安全变更还执行生产依赖 audit、pip check 和可用部署健康检查。

| 变更 | 聚焦覆盖 |
| --- | --- |
| 业务／HTTP | 身份与等待后重检、DTO、预约、错误和事务 |
| Agent／协议 | 输入、范围、只读、预算、取消、重复调用和 shutdown |
| 文件／Git | mode/hash、指针、竞争、refs、dirty 状态、rollback/finalize |
| 迁移 | fresh／已有 DB、失败原子性、重试和历史保留 |
| Web | 身份／导航、草稿、SSE 重连、冲突、图片 URL、editor/model 释放 |
| 文档 | 依据、相对路径、锚点、命令前提和实际执行范围 |

SSH 本地 E2E 用 `npm run test:ssh` 和 rootless Podman 构建临时 sshd fixture；不是厂商仓库集成。缺少 sshd 导致 skip 不记作通过，参见[夹具](../tests/fixtures/README.md#ssh-服务)。

## Web 与浏览器

Solid 2 effect 使用 compute／callback 约定；keyed For 的子项是 accessor，Match render callback 保留参数。会话流式不解析 Markdown，完成后清洗 HTML，并在清洗前保留链接授权策略。升级 marked 不替代 DOMPurify 或路径授权。

Monaco 按需加载，保存处理 SHA-256、换行、自动保存、撤销和导航拦截；关闭释放 editor／model。JSON tokenizer 使用当前 Monaco 公开导出，不开启已禁用的语言服务／Worker；升级需复查导出与浏览器回归。jsdom 不证明实际布局、选区和网络行为。

## 可重复的真实浏览器验收

[acceptance.mjs](../tests/browser/acceptance.mjs) 用临时 SQLite、工单、Git 和真实 HTTP／SSE，配生产 Web 构建和 Playwright 验证编辑、复制、差异、冲突、导航、草稿及滚动等。Agent／模型为替代实现，不调用远程模型。完成后关闭 API／浏览器并删除临时业务数据。

目标已准备 Playwright `mcr.microsoft.com/playwright:v1.64.1-noble`，后续浏览器环境优先使用这个测试容器，不容器化应用或挂载真实 data 作夹具。当前已实际执行的容器 smoke 入口为：

```bash
python3 /home/idoly/.local/share/issue-pilot-runtime/verify-browser-container.py
```

它用无宿主目录挂载的临时容器连接运行中的本机 API，仅检查 health 和 Chromium 打开页面，不发送消息；不是完整 acceptance.mjs。容器退出即删除，浏览器关闭 sandbox 仅发生在此测试容器内，不修改应用 SRT。

完整交互回归仍须在独立 checkout 准备完整依赖、匹配 Web 构建及独立 Playwright 模块。脚本支持 ISSUE_PILOT_PLAYWRIGHT_MODULE 指向已安装的 index.mjs、ISSUE_PILOT_BROWSER_WEB_ROOT 指向独立构建、ISSUE_PILOT_BROWSER_ARTIFACTS 指向临时截图目录。默认读取本仓库 dist；这些变量只影响验收，不覆盖生产 state。不要把容器镜像存在当作完整回归已执行。

## 真实 SLS CLI 协议验收

独立开发环境具备实际 aliyun CLI 和 OpenSSL 后执行：

```bash
npm run test:sls-cli
```

它使用临时凭证、本地 HTTPS 与精确 CONNECT 夹具，覆盖分页、来源、后页失败、预算、证据不完整和取消。不读真实云密钥，不访问 SLS。临时证书只给子进程信任，不关闭全局 TLS；缺工具直接失败。厂商真实查询需另外明确凭证、范围和只读语句。

本轮真实模型／DMS／SLS 验收使用当前 SQLite 选择规则及实际 owner 实现，结果集中在[迁移记录](records/2026-11-07-host-migration.md)。该操作可能计费，不是 npm test 的默认步骤，不应例行重放。

## 页面图维护

[既有演示图](images/README.md) 对应 manifest 中的历史 commit，本轮未重拍。重新捕获须用演示 DB／JSONL、临时 Git 和替代 Agent，不读取真实 data；记录代码、浏览器、视口与 SHA-256。test:browser 是交互回归，不负责重建 README 四张展示图。

## 文档、清理与交付

仓库 Biome [配置](../biome.json) 排除 Markdown 和 docs，未提供专用 Markdown formatter／链接检查脚本。文档遵循现有标题、表格、围栏和 LF 风格，核对全部相对路径、锚点、导航和代码示例，执行 git diff --check；不要为文档安装全量开发依赖或引入新框架。

纯文档不重启服务，不全量扫描真实业务数据。历史记录保存当时事实，当前规则归主指南；真实状态与配置更新按[运维](RUNBOOK.md)。删除前核实动态引用、构建、迁移和独有成果；提交、推送和部署依本次授权执行。
