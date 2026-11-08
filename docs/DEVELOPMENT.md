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

`npm run test:browser` 使用临时工单、Git、HTTP/SSE 和生产 Web 构建，需要独立安装的 Playwright。可通过 `ISSUE_PILOT_PLAYWRIGHT_MODULE` 指向其 `index.mjs`，通过 `ISSUE_PILOT_BROWSER_WEB_ROOT` 选择独立构建，`ISSUE_PILOT_BROWSER_ARTIFACTS` 选择临时截图目录。

本机保留 `mcr.microsoft.com/playwright:v1.64.1-noble` 测试镜像。已有只读 smoke 入口：

```bash
python3 /home/idoly/.local/share/issue-pilot-runtime/verify-browser-container.py
```

它只检查运行服务的 health 和 Chromium 页面，不发送消息、挂载生产数据，也不代表完整交互验收已通过。实际工单诊断仅输出耗时、计数和稳定错误；截图、trace 和响应正文可能包含业务秘密，不默认保存。

## SSH 与真实 SLS CLI 协议验收

- `npm run test:ssh`：rootless Podman 启动临时 OpenSSH 服务；缺少夹具不能当作通过。
- `npm run test:sls-cli`：真实 aliyun CLI 配临时 HTTPS／CONNECT 服务，需要 OpenSSL，不访问真实云服务。

二者的前提和清理方式见[测试夹具](../tests/fixtures/README.md)。不构建应用镜像，不使用远端 CI。

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
