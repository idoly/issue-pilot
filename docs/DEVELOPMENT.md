# 开发指南

先读[系统架构](ARCHITECTURE.md)，按任务查看 [Agent](AGENT.md)、[存储](STORAGE.md)或[配置](CONFIGURATION.md)。设计与审查规则以 [AGENTS.md](../AGENTS.md) 为准，已有状态操作按[运维手册](RUNBOOK.md)。

## 环境

安装步骤统一见[首次本地运行](DEPLOYMENT.md#首次本地运行)。开发与 CI 使用 Node 24.18.0，镜像使用 Node 26。后端直接运行 TypeScript，不使用 strip-types 不支持的语法；前端采用匹配的 Solid 2 runtime/compiler。

Python 库安装在应用根 `.venv`，版本由 `requirements.txt` 固定。原生 Bash 自动加入该环境，无需额外的 Python 路径配置。

## 验证

代码变更运行 focused 行为测试及适用的完整检查：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

若运行中的 API 直接提供本工作区的 `src/web/dist`，验证构建应使用独立输出目录，避免新页面与尚未更新的后端混用。浏览器夹具和镜像产物比较使用该独立目录：

```bash
web_build_root="$(mktemp -d /tmp/issue-pilot-web.XXXXXX)"
npm run build -- --outDir "$web_build_root"
```

资源受限时使用等价入口限制并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

运行时、依赖、协议安全或容器变更补充生产依赖审计、浏览器工具状态和可用部署健康检查：

```bash
npm audit --omit=dev --audit-level=high
.venv/bin/python3 -m pip check
```

| 检查 | 主要验证 |
| --- | --- |
| typecheck | 前后端类型、DTO 使用和未使用局部符号 |
| Node tests | 业务边界、队列、事务、Git、文件及协议夹具 |
| Vitest/jsdom | 页面状态、交互、取消及公共适配 |
| Vite build | 网页、Worker、字体和许可证资源 |
| 容器/部署验收 | 运行时、权限、挂载和恢复流程 |

测试脚本将递归 glob 作为一个带引号的参数交给 Node 发现文件，覆盖 tests 根目录与多层子目录，不依赖 shell 的 globstar 设置。

测试按 agent/http/workspace/capabilities/db 等目录组织。faux provider 可驱动真实工具管线；Python 文件回归使用真实 openpyxl 和临时工单。按风险覆盖失败、重试、取消、重复调用、回滚、最终化和关闭，迁移覆盖 fresh DB 与升级。

文档变更检查链接、锚点、图的解析与渲染，并核对 owner 代码。完成检查后只在新改动、失败或未解决风险需要时扩大验证。

## 修改入口

| 关注点 | Owner |
| --- | --- |
| 默认值、路径、预算、保留 | issue-pilot.config.ts、src/config.ts |
| 角色、处理方式、状态 | src/domain/contracts.ts |
| schema、启动迁移、升级历史 | src/db/schema.ts、bootstrap.ts、drizzle/ |
| 用户、凭证、配置投影 | src/configuration、http/route-context.ts |
| 工单及附件事务 | http/issue-routes.ts、attachment-store.ts |
| Agent 排队、会话、模型、资源 | src/agent、configuration/pi-runtime.ts |
| 工具输入与外部协议 | capabilities/registry.ts、src/capabilities、src/mcp |
| Git、代码集合、生命周期 | src/workspace |
| 成果与发布 | outputs/store.ts、agent/output-tool.ts |
| Web DTO、请求、SSE | web/src/data/client.ts、app/agent-stream.ts |
| 共享配置、当前身份 | ApplicationResources.tsx |
| 代码浏览 | CodeBrowser.tsx、SourceText.tsx、SourceDiff.tsx、monaco.ts、workspace/source-browser.ts；共用 DTO/枚举：workspace/source-contracts.ts |

## 隔离与变更边界

先运行 `git status --short`，保留已有改动，以任务基线检查最终差异。审查默认只读；不顺手修改无关代码、依赖和真实状态。

测试通过 `buildApi({ stateRoot, databaseFile })` 或 manager 注入临时根目录，使用临时 Git remote 和协议/模型夹具，绝不把真实 `.issue-pilot` 当 fixture。手工隔离 API 需要独立项目副本及根配置，没有 state 路径环境变量覆盖。

SQLite 回滚不恢复文件和 Git。异常路径、dirty checkout 和缺失 ref 可能是恢复证据，不能靠删除、reset、目录收编或重写元数据使检查通过。已发布迁移 SQL/journal 不可修改。

unknown 在请求或协议边界解析；路由协调 owner，不复制存储、Git 或授权规则。工具 execute 的再次校验、队列等待后的重新授权，以及[架构中的锁顺序](ARCHITECTURE.md#并发与失败清理)都需要保留。

依赖清理检查动态 import、Worker、CLI、类型、资源 URL 和容器安装。直接使用的包须声明依赖，字体与许可证不能按“没有 TS import”删除。

## Web 与浏览器

Solid 2 使用 `createEffect(compute, callback)`，callback 只返回清理函数或 undefined；组件构造时有意读取初始 reactive value 使用 untrack。配置页保留用户凭证状态、仓库、服务和端点，不提供基座和能力管理入口；切换身份时旧请求不得覆盖新身份状态。

Monaco 使用公开 editor/model API，组件负责释放资源。修改时保留 SHA-256、CRLF、自动保存、撤销、只读与冲突语义。图标与字体配置由 `ui/icons.tsx`、`EditorIcons.tsx` 和 Vite 构建维护。

网页状态与交互由 Vitest/jsdom 验证，文件下载与服务协议由隔离 HTTP fixture 验证。项目不再维护 Playwright 工具链或浏览器 MCP 默认能力。README 截图使用演示数据，不采集真实工单、凭证或私有配置。

交付时报告改动、验证与缺口；未授权不提交、推送、重启或修改线上状态。
