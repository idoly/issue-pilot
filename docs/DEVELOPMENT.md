# 开发指南

[文档导航](README.md) · [系统架构](ARCHITECTURE.md) · [Agent](AGENT.md) · [存储](STORAGE.md)

开发从所属模块和业务契约开始，设计与授权约束见 [AGENTS.md](../AGENTS.md)。测试使用独立状态，发布操作按[运维手册](RUNBOOK.md)。

## 环境

安装命令见[首次本地运行](DEPLOYMENT.md#首次本地运行)。开发／CI 使用 Node 24.18.0，容器使用 Node 26；后端直接 strip-types 运行 TypeScript，前端使用配套 Solid runtime／compiler。

| 组件 | 版本来源 |
| --- | --- |
| Pi AI／Coding Agent | 1.4.0，postinstall 校验固定版本补丁 |
| SRT | 0.0.81，依赖 Linux 隔离能力 |
| Solid | runtime／web 2.0.0-rc.17，编译与测试包按锁文件 |
| Monaco | 0.57.0，使用公开 editor／model API |
| Python | 应用 `.venv`，openpyxl 3.1.5、et_xmlfile 2.0.0 |
| 容器 Git／aliyun CLI | 2.56.0／3.5.2 |

DBHub 使用固定版本 stdio 工具，静态只读配置位于 `scripts/dbhub.toml`，服务目标与生成连接归 `configuration/dbhub.ts` 管理。

准确 npm 版本以 [package.json](../package.json) 和 [package-lock.json](../package-lock.json) 为准，Python 以 [requirements.txt](../requirements.txt) 为准。Pi、node-forge 和 Zod 回补由[依赖补丁](../patches/README.md)统一说明，不能跳过 postinstall。

## 修改入口

| 关注点 | Owner |
| --- | --- |
| 角色、状态、处理方式 | `src/domain/contracts.ts` |
| 路径、预算和保留 | `issue-pilot.config.ts`、`src/config.ts` |
| schema、启动与升级 | `src/db/`、`drizzle/` |
| 业务配置和身份 | `src/configuration/`、`src/http/route-context.ts` |
| HTTP 协调与附件 | `src/http/*-routes.ts`、`attachment-store.ts` |
| Agent 队列和会话 | `src/agent/engine.ts`、`pi-session.ts`、`model-runtime.ts` |
| 原生工具与隔离 | `native-tools.ts`、`native-tool-executor.ts`、`issue-sandbox.ts` |
| 工具和外部协议 | `src/capabilities/`、`src/mcp/` |
| Git、生命周期和文件 | `src/workspace/` |
| Web 请求、SSE、共享状态 | `src/web/src/data/client.ts`、`agent-stream.ts`、`ApplicationResources.tsx` |
| 代码浏览器 | `CodeBrowser.tsx`、`SourceText.tsx`、`SourceDiff.tsx`、`monaco.ts`、`source-browser.ts` |

## 代码风格

TypeScript 参考 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)，页面参考 [Google HTML/CSS Style Guide](https://google.github.io/styleguide/htmlcssguide.html)，沿用相邻代码格式。模块使用 kebab-case，TSX 组件和类型使用 PascalCase，函数及局部变量使用 camelCase。

后端不使用 strip-types 不支持的 enum、参数属性或装饰器。`issueId` 表示数据库 ID，`issueKey` 表示业务编号，工作文件用 workFile／workFiles，原始上传用 attachment。持久名称、Git refs 和协议字段按契约维护。

项目结构化 schema 使用 TypeBox。输入边界做严格检查，低频 Value.Check，重复执行热路径可一次 Compile 后复用。默认值、规范化和授权由 owner 处理，不借 Value.Parse 隐式纠正输入。交给可变 SDK 管线的共享 schema 用 Value.Clone 隔离；保留执行时再校验和等待后重新授权。

第三方 MCP／SRT 自有 schema 沿用官方 SDK，包括其 Zod 与域名规则。路由协调 owner，SQLite、Git、附件和命令授权各自维护；并发顺序见[系统架构](ARCHITECTURE.md#并发与失败清理)。

## 验证

代码变更先运行所属行为测试，再完成适用的检查：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

| 检查 | 覆盖 |
| --- | --- |
| typecheck | 前后端类型、DTO 与未使用局部符号 |
| Node tests | 身份、配置、队列、事务、Git、文件和协议 |
| Vitest／jsdom | 页面状态、交互、请求取消和适配 |
| Vite build | 页面、Worker、字体及许可证资源 |
| 浏览器／部署 | 真实尺寸、导航、运行环境和挂载 |

没有独立 lint 脚本。递归 glob 作为一个带引号的参数传给 Node；资源受限时限制并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

运行中的 API 若直接提供本 checkout 的 dist，验证构建使用独立目录：

```bash
web_build_root="$(mktemp -d /tmp/issue-pilot-web.XXXXXX)"
npm run build -- --outDir "$web_build_root"
```

运行时、依赖、协议安全和容器变更还验证生产依赖审计、Python 依赖、浏览器环境和可用健康检查：

```bash
npm audit --omit=dev --audit-level=high
.venv/bin/python3 -m pip check
```

node-forge／Zod 固定版本回补的效果需结合安装 hash、攻击回归与协议兼容判断；审计按版本报告，不能屏蔽通告或用降级掩盖。SSH E2E 需要 sshd fixture，缺失时测试明确 skip，验收在具备服务端的独立环境完成。

CI 在 main 提交和 PR 触发，使用 GitHub Ubuntu runner。私有包源、系统依赖和 SRT 必须对 runner 可用，本机结果不代表远程 Actions 结果。

## 隔离与变更边界

开始前检查 git status 并固定任务基线，保留已有改动。测试通过 `buildApi({ stateRoot, databaseFile })` 或 manager 注入临时根，使用临时 Git remote、faux 模型和协议 fixture。手工运行也使用独立项目及根配置，真实 `.issue-pilot` 不能作为测试夹具。

按风险覆盖失败、重试、取消、重复调用、rollback／finalize 和 shutdown；schema 升级覆盖 fresh DB 和已有 schema。SQLite 回滚不能撤销文件／Git，未知目录、dirty worktree、缺失 ref 和错误现场不能靠删除、reset 或改绑定使检查通过。已发布迁移与 journal 不可修改。

依赖／资源清理检查动态 import、Worker、CLI、类型、资源 URL、镜像和实际使用者。运行服务的依赖和网页产物通过发布步骤切换，提交、推送和真实状态操作须有授权。

## Web 与浏览器

Solid 2 使用 `createEffect(compute, callback)`，回调只返回清理函数或 undefined；有意仅读取初始值时用 untrack。ApplicationResources 持有共享资源与草稿，切换身份取消旧身份工作，迟到响应不能覆盖当前身份。Markdown 与 HTML 链接先解析到授权文件路径，再 DOMPurify 清洗。

Monaco 组件负责释放 editor／model，保留 SHA-256 冲突、CRLF、自动保存、撤销、只读和导航语义。链接使用真实工单 URL，浏览器前进／后退及未保存代码拦截由行为测试验证。文件列表按需预览，加载失败可重试，超预算或不支持格式保留下载。

图标使用 Phosphor SVG，编辑器 Codicon 按需加载，文件图标沿用 Material Icon Theme。Geist 字体、来源与许可证在 ui/assets 维护；更新同步 provenance 和许可证，保留焦点、减少动效及手机触控尺寸。

真实浏览器采用 Operator 工具或临时镜像，记录工具版本、尺寸和结果；使用独立演示数据。弹窗不因点击遮罩关闭，通过关闭、取消或 Esc 退出；保存期间保留关闭限制。截图位于 [images](images/README.md)，源码树、文件 hash 和验证来源写入 manifest。workspace.jpg 还供图片读取测试使用，替换时运行 `tests/agent/codemode.test.ts`。

文档检查链接、锚点、页面阅读效果与代码契约；流程使用简短文字步骤。纯文档变更按此范围验证，完成后清理临时页面、服务和构建，只保留有用结果。
