# 开发指南

先读[系统架构](ARCHITECTURE.md)，按任务查看 [Agent](AGENT.md)、[存储](STORAGE.md)或[配置](CONFIGURATION.md)。设计与审查规则以 [AGENTS.md](../AGENTS.md) 为准，已有状态操作按[运维手册](RUNBOOK.md)。

## 环境

安装步骤统一见[首次本地运行](DEPLOYMENT.md#首次本地运行)。开发与 CI 使用 Node 24.18.0，镜像使用 Node 26。后端直接运行 TypeScript，不使用 strip-types 不支持的语法；前端采用匹配的 Solid 2 runtime/compiler。

Python 库安装在应用根 `.venv`，版本由 `requirements.txt` 固定。原生 Bash 自动加入该环境，无需额外的 Python 路径配置。

| 组件 | 当前版本约定 |
| --- | --- |
| Pi AI / Coding Agent | 1.4.0，安装时应用固定版本输出回调补丁 |
| SRT | 0.0.81，隔离能力缺失时拒绝本地执行 |
| Solid runtime / web | 配套 2.0.0-rc.17，插件和测试库版本由锁文件固定 |
| Monaco | 0.57.0，使用当前导出路径及语言注册入口 |
| 容器 Git / aliyun CLI | 2.56.0 / 3.5.2 |
| Python 库 | openpyxl 3.1.5、et_xmlfile 2.0.0 |

准确依赖及传递依赖以 [package.json](../package.json) 和 [package-lock.json](../package-lock.json) 为准。Pi 与 node-forge 的安装回补见[补丁说明](../patches/README.md)，不能跳过 postinstall 后直接使用未修补 SDK。

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

当前 CI 工作流使用 GitHub 托管 Ubuntu runner，提交到 `main` 或创建 PR 时触发。锁文件中的私有包源地址必须对构建环境可达；SRT、Git 和系统工具也须满足前述条件。不能把本机已有依赖或缓存下的通过结果写成远端 Actions 已通过，调整包源或 runner 环境应单独验证。

运行时、依赖、协议安全或容器变更补充生产依赖审计、浏览器工具状态和可用部署健康检查：

```bash
npm audit --omit=dev --audit-level=high
.venv/bin/python3 -m pip check
```

SRT 0.0.81 的传递依赖 node-forge 1.4.0 尚无 npm 正式修复版。安装时回补上游 RSA 验签修复，并运行恶意 ASN.1 签名回归，详见[依赖补丁](../patches/README.md)。原始生产审计仍会按 1.4.0 版本报告该包及 SRT 的两项高危影响链；这不等于回补后的代码仍接受该攻击，也不是零漏洞结论。不屏蔽审计或退回旧 SRT；正式修复版发布后移除回补。

| 检查 | 主要验证 |
| --- | --- |
| typecheck | 前后端类型、DTO 使用和未使用局部符号 |
| Node tests | 业务边界、队列、事务、Git、文件及协议夹具 |
| Vitest/jsdom | 页面状态、交互、取消及公共适配 |
| Vite build | 网页、Worker、字体和许可证资源 |
| 容器/部署验收 | 运行时、权限、挂载和恢复流程 |

没有独立 lint 脚本，不能把 typecheck 描述成 lint。SSH 传输回归需要 `sshd` 测试夹具；宿主缺失时对应测试会明确 skip，发布验收需在提供 OpenSSH server 的独立环境中补测。不要把该 skip 写成测试通过。

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
| Git、代码集合、生命周期 | workspace/git.ts、issue-git.ts、project.ts、lifecycle.ts |
| 凭据与 SSH 传输 | workspace/git-credentials.ts、agent/network-exec.ts |
| 工作文件与旧下载兼容 | workspace/work-file-store.ts、outputs/store.ts |
| 本地工具执行与隔离 | agent/native-tools.ts、issue-sandbox.ts、native-tool-executor.ts |
| 单实例保护 | workspace/state-lease.ts |
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

Solid 2 使用 `createEffect(compute, callback)`，callback 只返回清理函数或 undefined；组件构造时有意读取初始 reactive value 使用 untrack。配置页保留用户凭证状态、仓库、服务和端点，不提供基座和能力管理入口；切换身份时旧请求不得覆盖新身份状态。工单详情不展示元信息格和评论编辑区；附件紧接详情头部，其余区块保持原顺序。队列仍展示相对更新时间，悬停显示不带前缀的创建时间。“工作目录”直接列出当前目录的文件和文件夹，列表限高并内部滚动，返回上级和刷新位于标题栏。文件夹、代码仓库、普通文件使用不同图标，不展示行下说明，不新增目录请求或定时轮询。支持的工作文件点击名称时复用附件预览，图片、文本和 PDF 按需读取；目录列表不预加载文件内容，超过预览预算或不支持的格式保留下载入口。

关联卡片使用单行细边框，按编号、处理人、状态、服务、环境紧凑排列，标题只通过卡片 `title` 展示。列表超高滚动，字段不会通过 `flex-grow` 在中间撑出空白。真实链接使用 `/?issue=<key>`，点击进入完整工单，浏览器后退／前进保留关联选择；未保存代码的拒绝导航会恢复当前历史位置，不切换当前用户身份。暂无预览弹窗或自动摘要。

工单描述与对话共用带工单上下文的 Markdown 链接解析。Markdown 和原始 HTML 锚点都在最终清洗前解析为授权下载路径，保留 DOMPurify 清洗。覆盖历史路径、当前文件、显式关联文件、未关联工单拒绝、路径遍历拒绝、标题唯一提示及窄屏单行滚动；不能只用截图替代导航和身份行为测试。

Monaco 使用公开 editor/model API，组件负责释放资源。修改时保留 SHA-256、CRLF、自动保存、撤销、只读与冲突语义。图标与字体配置由 `ui/icons.tsx`、`EditorIcons.tsx` 和 Vite 构建维护。

网页状态与交互由 Vitest/jsdom 验证，文件下载与服务协议由隔离 HTTP fixture 验证。项目没有 Playwright 生产依赖或默认浏览器 MCP；需要真实浏览器验证时使用 Operator 提供的外置工具或临时浏览器镜像，并记录工具版本、页面尺寸、请求范围和结果。不要在生产数据上写测试工单；截图使用独立演示数据，不采集真实工单、凭证或私有配置。

交付时报告改动、验证与缺口；未授权不提交、推送、重启或修改线上状态。
