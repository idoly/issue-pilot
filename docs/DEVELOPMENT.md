# 开发指南

给本机开发和维护人员阅读。[文档导航](README.md) · [AI 维护规则](../AGENTS.md)

## 开始前

1. 执行 `git status --short`，保留已有改动。
2. 在**独立 checkout** 安装完整开发依赖，不在正在服务的目录实验。
3. 核对[本机工具](TOOLS.md)。Python 测试使用 PATH 中的 `python3` 和共享公共库，不依赖项目 `.venv`。
4. 涉及业务行为时，先看 [AI 技术参考](ai/README.md) 中的所属模块。

生产 `data/` 不是测试夹具。后端测试通过临时 state root／databaseFile 隔离；Pi 测试还要使用独立 agentDirectory。不要把开发页面接到真实业务 API 做实验。

## 安装与运行

在独立 checkout：

```bash
npm ci
npm run typecheck
npm run build
```

`npm ci` 必须正常执行 postinstall 补丁校验。`npm run build` 只构建 Web，不生成后端 dist，也不启动服务。

Web 使用 [Solid 2 正式版](https://www.solidjs.com/blog/solid-2-0-the-long-hold)，`solid-js`、`@solidjs/web` 和 `@solidjs/vite-plugin` 按兼容组合更新。Solid 2.0 在 `node_modules/solid-js` 内自带面向 AI 助手的资料：改动前读 `skills/solid-2.0/SKILL.md`，查名字看 `CHEATSHEET.md`（末尾有 1.x 到 2.0 的变化表），出现 `[REACTIVE_WRITE_IN_OWNED_SCOPE]` 这类诊断码时按 `skills/reactivity-diagnostics/SKILL.md` 修复，不要压制。测试库当前使用支持 Solid 2 的 `@solidjs/testing-library` 1.0 RC；升级时核对 peerDependencies 和发布通道，不能仅按 npm 的 latest 标签选择。前端框架更新需通过完整 Web 测试、生产构建和独立浏览器验收。

Linux x64 构建需用 `npm ls @solidjs/compiler-linux-x64-gnu` 核对原生编译器。镜像未同步新版平台包时，npm 可能静默使用 WASM；可在独立 checkout 执行 `npm ci --registry=https://registry.npmjs.org/` 后复核。

`package-lock.json` 的 `resolved` 统一使用 `https://registry.npmjs.org/`。本机 npm 配置了内网镜像时，npm 默认会把这些地址替换到镜像下载，integrity 不变。更新依赖后如果锁文件写入了镜像地址，提交前改回公共源地址。

手工调试需要独立根配置和空数据库，按[部署](DEPLOYMENT.md#首次本地运行)准备后启动：

```bash
node --experimental-strip-types src/http/production.ts
```

可在另一个终端运行 `npm run dev:web`；Vite 使用 4173 并代理 API 到 3000，不提供业务隔离。没有 `npm start` 或后端 watch。修改后端需重启自己的独立实例。

## 验证入口与边界

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

格式化使用 Oxfmt（`.oxfmtrc.json`），Lint 使用 Oxlint（`.oxlintrc.json`），保留 2 空格、200 列和原有排除范围。启用基础、TypeScript、Oxc、Unicorn、Import、Promise、Vitest 的正确性规则，另检查类型导入与 Promise 执行器返回值；警告和失效禁用注释都会阻止通过。类型检查仍由 TypeScript 执行，不以 Lint 代替。

- Promise 执行器只负责调用 resolve/reject，不返回定时器、监听器或赋值结果。
- 测试 mock 使用真实函数或组件回调的类型，夹具遵守实际返回契约；每个参数化分支都应有明确断言，禁止残留聚焦测试。
- Solid 的 JSX `ref` 自动赋值、Vite 的 `?worker` 导出、控制字符过滤、事件监听器快照和保留清理错误等必要例外，在对应行解释，不全局放宽规则。允许 `import()` 类型注解。
- 两项工具默认单线程运行，不格式化业务数据、已发布迁移、文档或构建产物。增加规则先试跑，修正有效告警，并检查框架语义；不可仅因告警多就关闭规则。

资源受限时，以下两条分别替代 `npm test` 的后端和 Web 部分：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

运行时、依赖、安全或工具链变化还需生产依赖审计及适用的部署健康检查：

```bash
npm audit --omit=dev
```

这些检查不证明真实模型、SSH、云服务或浏览器全部可用；按变更补充对应验收。

## 无需真实模型的核心流程验证

```bash
node --experimental-strip-types --test --test-concurrency=2 tests/http/issue-api.test.ts tests/http/application-mcp-create.test.ts
```

夹具使用临时 SQLite／工单根和替代 Agent，不访问真实模型或业务仓库。套接字权限错误应修复测试环境，不要改用生产数据。

## 可重复的真实浏览器验收

`npm run test:browser` 使用临时工单、Git、HTTP/SSE 和生产 Web 构建，需要独立安装的 Playwright。可通过 `ISSUE_PILOT_PLAYWRIGHT_MODULE` 指向其 `index.mjs`，通过 `ISSUE_PILOT_BROWSER_WEB_ROOT` 选择独立构建，`ISSUE_PILOT_BROWSER_ARTIFACTS` 选择临时截图目录。设置 `ISSUE_PILOT_BROWSER_WS` 时连接测试容器内的 Playwright `run-server`；验收需要以 `--unsafe` 启动该服务，以便传入浏览器启动参数。

本机保留 `mcr.microsoft.com/playwright:v1.64.1-noble` 测试镜像。已有只读 smoke 入口：

```bash
python3 /home/idoly/.local/share/issue-pilot-runtime/verify-browser-container.py
```

它只检查运行服务的 health 和 Chromium 页面，不发送消息、挂载生产数据，也不代表完整交互验收已通过。实际工单诊断仅输出耗时、计数和稳定错误；截图、trace 和响应正文可能包含业务秘密，不默认保存。

## 浏览器性能对照

在独立 checkout 完成生产构建后运行：

```bash
npm run test:performance -- --runs=3 --output=/tmp/issue-pilot-performance.json
```

沿用 `ISSUE_PILOT_PLAYWRIGHT_MODULE` 和 `ISSUE_PILOT_BROWSER_WEB_ROOT`。可通过 `ISSUE_PILOT_BROWSER_WS` 连接本机测试容器内的 Playwright `run-server`，测试服务仍在主机运行；容器需能访问主机回环地址。没有服务地址或业务数据目录参数，夹具始终使用临时 SQLite、JSONL 和 Git，退出时清理。输出文件必须不存在，不覆盖已有报告。

场景包含 30 张工单、4 轮短会话和 150 轮长会话，记录列表出现、详情可操作、SSE 快照到达、末条消息可见以及编辑器可操作的时间。每轮使用新的浏览器 context，随后在同一 context 热缓存刷新、切换长会话、返回原工单并打开编辑器。正常网络与 150 ms 延迟、1.6 Mbps 下行、750 Kbps 上行、4 倍 CPU 降速分别测量；`--profile=local` 或 `--profile=slow` 可缩小范围。

先把修改前的 `src/web/dist` 复制到独立临时目录，再构建修改后版本，用 `--compare=/临时目录` 交替测量两套资源；比较使用同一份当前后端代码，适用于 Web 构建和静态传输改动，不代表后端版本对照。报告包含各轮数据、中位数、构建标识和请求时序。资源传输量不含 HTML 和未结束的 SSE，编辑器时间包含脚本操作耗时。服务端为热启动，实验室结果不代表线上用户分布，不设容易受主机负载影响的绝对耗时门槛。测量时不要同时运行构建或测试；临时构建与报告使用后自行清理。

## SSH 与真实 SLS CLI 协议验收

- `npm run test:ssh`：rootless Podman 启动临时 OpenSSH 服务；缺少夹具不能当作通过。
- `npm run test:sls-cli`：真实 aliyun CLI 配临时 HTTPS／CONNECT 服务，需要 OpenSSL，不访问真实云服务。

二者均在 `tests/integration/`，不进入 `npm test`，也不自动探测宿主机 sshd 后跳过验收。前提和清理方式见[测试夹具](../tests/fixtures/README.md)。不构建应用镜像，不使用远端 CI。

## 代码与数据库

- 后端直接执行 TypeScript；避免 strip-types 不支持的语法。
- 路由只协调 owner，业务规则放在对应模块；不要把 Git、协议和授权重写到路由。
- 已发布迁移 SQL／journal 不修改。新增迁移先在临时数据库验证，不能用 `db:migrate` 作为只读诊断。
- 源码、DTO 和 Web 请求同步维护。Solid effect、资源释放、SSE 重连和编辑冲突需行为测试。
- 具体并发顺序、凭证和持久化约束见 [AGENTS.md](../AGENTS.md)。

## 截图与示例

需要截图时使用演示数据，说明对应源码版本和用途，不保存无关业务正文。默认不积累截图档案，也不使用真实工单截图覆盖测试夹具。

## 文档清理与交付

人读指南使用简明中文，AI 参考使用英文；源码入口和失败边界放在 `docs/ai/`。只维护现行文档，不保留旧版跳转，不为每轮修改追加历史报告；迁移复盘作为有界例外保留，不替代当前部署说明。检查链接、标题锚点和 Bash 示例语法，执行 `git diff --check`；纯文档不重启服务。

报告本次改动、实际执行的检查及未覆盖项。提交、推送、发布、重启和真实数据修改需获得用户授权。
