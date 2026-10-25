# 开发指南

先读[系统架构](ARCHITECTURE.md)，按任务查看 [Agent](AGENT.md)、[存储](STORAGE.md)或[配置](CONFIGURATION.md)。设计与审查规则以 [AGENTS.md](../AGENTS.md) 为准，已有状态操作按[运维手册](RUNBOOK.md)。

## 代码风格

TypeScript 修改参考 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)，页面结构和样式参考 [Google HTML/CSS Style Guide](https://google.github.io/styleguide/htmlcssguide.html)。保持命名清晰、类型边界明确、语义化 HTML 和局部可审查的差异；不为风格一致性批量重排无关代码。

项目运行方式优先于指南中的通用建议：后端使用 Node 原生 strip-types，不引入需要生成运行时代码的 enum、参数属性或装饰器；Solid TSX 保留 JSX 要求的闭合标签。现有文件沿用相邻代码的引号、导入和格式约定，新逻辑避免用类型断言绕过边界校验。

目录和普通模块使用 `kebab-case`，TSX 组件文件与组件使用 `PascalCase`，类型使用 `PascalCase`，函数、参数和局部变量使用 `camelCase`。名称说明当前职责：工作文件统一使用 `workFile`／`workFiles`，原始上传使用 `attachment`，离线转换入口明确包含 `migration`；不保留只做转发的旧业务名称。`issueId` 表示数据库标识，`issueKey` 表示面向用户的工单编号；短名称只在上下文明确的局部使用。已经落盘的文件名、Git refs、迁移记录和外部协议字段按各自契约演进，不为代码风格批量改写。

## Schema 与运行时校验

项目自有的结构化 schema 统一使用 TypeBox，沿用 Pi 的工具参数与 JSON Schema 契约。Agent 工具、入站 MCP 工具和配置结构校验不再新增直接的 Zod 业务 schema。同一规则有模型参数、MCP 描述和执行校验等消费者时，复用其 owner 定义，不各写一份。复用规则不等于共享可变实例；交给 SDK 的工具参数若含共享节点，按工具实例使用 `Value.Clone` 隔离，保留 TypeBox 的可选性和非枚举元信息，避免扩展修改影响后续工单。

结构化外部输入采用 TypeBox 严格检查：低频入口使用 `Value.Check`，重复使用的工具执行热路径使用一次 `Compile(schema)` 后的 `.Check`。不依赖 `Value.Parse` 的全局纠正解析选项进行隐式类型转换、默认值补齐或删除未知字段。默认值、规范化、引用检查和授权仍归对应业务 owner；已有小型语义解析器不为形式统一重写成大 schema，也不新增万能校验包装层。

MCP SDK 的协议 envelope 校验和 SRT 的域名／沙箱规则继续使用 SDK 原有 schema。它们内部的 Zod 是传递依赖，不能通过业务代码改写安全地移除；例如 `NetworkConfigSchema.safeParse` 复用 SRT 的完整域名与端口规则，不另写 TypeBox 正则副本。第三方 Zod 安全回归可以直接使用 Zod API，应用层不维护 TypeBox 与 Zod 两套同义 schema。

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

准确依赖及传递依赖以 [package.json](../package.json) 和 [package-lock.json](../package-lock.json) 为准。Pi、node-forge 与 Zod 的安装回补见[补丁说明](../patches/README.md)，不能跳过 postinstall 后直接使用未修补 SDK。

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

最新审计还报告 Zod 的大集合校验内存耗尽通告 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，生产审计变为 3 个 high 影响包条目（SRT、node-forge、Zod，两条底层通告）。安装与锁文件中的 Zod 均为 3.25.76；SRT 使用 `zod/v3`，MCP SDK 的协议类型使用包内 `zod/v4`，不能仅凭主版本 3 忽略通告。本轮已交付固定版本的集合上限前置回补，覆盖包内 v3／v4 的 ESM、CJS 及 Mini 运行路径；隔离安全与 MCP／SRT 兼容回归通过，详见[依赖补丁](../patches/README.md#zod-集合上限前置检查)。测试只修改复制的包，并核对共享安装文件 hash；正在运行的共享依赖未改动。该回补不为无上限 schema 新增限制，生产审计仍按版本报告。后续安装／部署需按授权流程应用，不能直接采用审计提出的 SRT 降级或屏蔽通告。

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

SSE 连接的保留堆验证可运行：

```bash
node --expose-gc --experimental-strip-types docs/experiments/sse-event-id-memory.mjs 100000
```

该脚本使用临时数据库、合成事件与本地 HTTP 消费者，排空数据并 GC 后比较保留堆；不读取真实工单、不调用模型。它测量 ID 跟踪的连接保留成本，不代表慢客户端背压、总内存峰值或真实模型吞吐。

## 修改入口

| 关注点 | Owner |
| --- | --- |
| 默认值、路径、预算、保留 | issue-pilot.config.ts、src/config.ts |
| 角色、处理方式、状态 | src/domain/contracts.ts |
| schema、启动迁移、升级历史 | src/db/schema.ts、bootstrap.ts、drizzle/ |
| 用户、凭证、配置投影 | src/configuration、http/route-context.ts；离线格式转换：scripts/configuration-conversion.ts |
| 工单及附件事务 | http/issue-routes.ts、attachment-store.ts |
| Agent 排队、会话、模型、资源 | src/agent、configuration/pi-runtime.ts |
| 工具输入与外部协议 | capabilities/registry.ts、src/capabilities、src/mcp |
| Git、代码集合、生命周期 | workspace/git.ts、issue-git.ts、project.ts、lifecycle.ts |
| 凭据与 SSH 传输 | workspace/git-credentials.ts、agent/network-exec.ts |
| 工作文件访问与原子查询导出 | workspace/work-files.ts |
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

Solid 2 使用 `createEffect(compute, callback)`，callback 只返回清理函数或 undefined；组件构造时有意读取初始 reactive value 使用 untrack。配置页按用户／仓库／服务／端点排列，提供人员、个人凭证和仓库维护；服务开发基线只读继承正式环境，查询目标按环境编辑，部署所属 MySQL 连接在服务事务中保存；切换身份时旧请求不得覆盖新身份状态。工单详情不展示元信息格和评论编辑区；附件紧接详情头部，其余区块保持原顺序。队列仍展示相对更新时间，悬停显示不带前缀的创建时间。“工作目录”直接列出当前目录的文件和文件夹，列表限高并内部滚动，返回上级和刷新位于标题栏。文件夹、代码仓库、普通文件使用不同图标，不展示行下说明，不新增目录请求或定时轮询。支持的工作文件点击名称时复用附件预览，图片、文本和 PDF 按需读取；目录列表不预加载文件内容，超过预览预算或不支持的格式保留下载入口。

关联卡片使用单行细边框，按编号、处理人、状态、服务、环境紧凑排列，标题只通过卡片 `title` 展示。列表超高滚动，字段不会通过 `flex-grow` 在中间撑出空白。真实链接使用 `/?issue=<key>`，点击进入完整工单，浏览器后退／前进保留关联选择；未保存代码的拒绝导航会恢复当前历史位置，不切换当前用户身份。暂无预览弹窗或自动摘要。

工单描述与对话共用带工单上下文的 Markdown 链接解析。Markdown 和原始 HTML 锚点都在最终清洗前解析为授权下载路径，保留 DOMPurify 清洗。覆盖历史路径、当前文件、显式关联文件、未关联工单拒绝、路径遍历拒绝、标题唯一提示及窄屏单行滚动；不能只用截图替代导航和身份行为测试。

Monaco 使用公开 editor/model API，组件负责释放资源。修改时保留 SHA-256、CRLF、自动保存、撤销、只读与冲突语义。图标与字体配置由 `ui/icons.tsx`、`EditorIcons.tsx` 和 Vite 构建维护。

网页状态与交互由 Vitest/jsdom 验证，文件下载与服务协议由隔离 HTTP fixture 验证。项目没有 Playwright 生产依赖或默认浏览器 MCP；需要真实浏览器验证时使用 Operator 提供的外置工具或临时浏览器镜像，并记录工具版本、页面尺寸、请求范围和结果。不要在生产数据上写测试工单；截图使用独立演示数据，不采集真实工单、凭证或私有配置。

交付时报告改动、验证与缺口；未授权不提交、推送、重启或修改线上状态。
