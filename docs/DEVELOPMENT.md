# 开发

先读[架构](ARCHITECTURE.md)，配置与协议修改同时核对[配置](CONFIGURATION.md)。生产操作按[运维](RUNBOOK.md)，不能用真实 `.issue-pilot` 作为开发夹具。

## 开始与本地验证

先运行 `git status --short`，区分已有工作。测试使用临时 SQLite、Git remote、state root 与 fake protocol/model。手工运行 API 会迁移并整理配置指向的状态；需要隔离时创建单独项目副本并修改其根配置。当前 CI 使用 Node 24.18.0，生产镜像使用 Node 26，以 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 和 [Containerfile](../Containerfile) 为准。

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

资源有限时使用同等测试入口限制并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 tests/**/*.test.ts
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

定向测试示例：

```bash
node --experimental-strip-types --test tests/capabilities/mysql.test.ts
npx vitest run --config src/web/vite.config.ts --environment jsdom src/web/src/app/App.test.tsx --maxWorkers=1
```

依赖、运行时、能力安全或容器修改补充 `npm audit --omit=dev --audit-level=high`、`scripts/playwright.sh status` 和可用部署检查。浏览器脚本使用 `scripts/playwright.sh run <script> <existing-output-directory>`，先拦截 mutation，使用合成数据，不截取真实凭证。

## 修改入口

| 任务 | 入口 |
| --- | --- |
| 枚举、角色、处理方式、权限谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 当前表与约束、初始化和升级 | [db/schema.ts](../src/db/schema.ts)、[bootstrap.ts](../src/db/bootstrap.ts)、[drizzle](../drizzle) |
| 配置快照、凭证投影与合并 | [configuration](../src/configuration) |
| HTTP 身份/角色和协调 | [route-context.ts](../src/http/route-context.ts)、对应 *-routes.ts |
| 服务保存 | [service-configuration.ts](../src/http/service-configuration.ts) |
| 附件事务 | [attachment-store.ts](../src/http/attachment-store.ts) |
| 工单队列、预约、状态和会话 | [agent/engine.ts](../src/agent/engine.ts)、[pi-session.ts](../src/agent/pi-session.ts) |
| 模型目录、service_query | [model-runtime.ts](../src/agent/model-runtime.ts)、[service-query-tool.ts](../src/agent/service-query-tool.ts) |
| 能力保存/schema、协议客户端 | [capabilities](../src/capabilities) |
| 出站 / 入站 MCP | [client.ts](../src/mcp/client.ts) / [server.ts](../src/mcp/server.ts) |
| 工作文件与成果发布 | [state.ts](../src/workspace/state.ts)、[outputs/store.ts](../src/outputs/store.ts)、[output-tool.ts](../src/agent/output-tool.ts) |
| Git/代码准备、跨服务、范围转换和生命周期 | [workspace](../src/workspace) |
| Web DTO、共享状态、事件投影 | [client.ts](../src/web/src/data/client.ts)、[ApplicationResources.tsx](../src/web/src/app/ApplicationResources.tsx)、[conversation.ts](../src/web/src/app/conversation.ts) |
| Web 配置序列化与部署表单 | [configuration-model.ts](../src/web/src/app/configuration-model.ts)、[ConfigurationView.tsx](../src/web/src/app/ConfigurationView.tsx) |
| 代码浏览、文本编辑与 Git | [CodeBrowser.tsx](../src/web/src/app/CodeBrowser.tsx)、[source-browser.ts](../src/workspace/source-browser.ts) |

## 边界与实现约束

外部 unknown 在 HTTP、TypeBox 或协议响应边界解析。内部保持 typed call，不重复 shape 校验。路由只做身份、参数、队列、预约和事务协调；不要新增通用 repository/service 层替代已有 owner。

用户读取/角色校验使用 route-context helper，一次取 active 用户。队列等待后的重新授权必须保留，用户修改在 scope queue 内、预约与关闭会话之前重新检查操作者角色，不能跨请求缓存角色。配置读取使用 scope queue + libSQL read snapshot；写操作遵守架构中的锁顺序。SQLite 不能回滚文件或 Git，相关修改必须明确准备、提交、回滚、最终化及失败证据。

附件用 `lstat` 拒绝符号链接，不能跟随链接后只验证目标属性。附件暂存和成果写入使用 FileHandle.writeFile 完成整段数据；若改用 write，必须处理 bytesWritten 小于输入长度的情况。output publish 只验证文件归属、类型与安全发布，不根据格式执行脚本或编码。

数据库变更修改当前 schema 并新增连续 migration/journal entry，覆盖 fresh DB 与旧版升级；已发布文件不修改、合并或删除。真实状态升级先备份并在独立副本 dry-run，不能把失败守卫改为忽略数据。

能力修改同时检查配置 parser、动态输入 schema、typed dispatch、协议授权、Web serializer 和凭证投影。MySQL 普通读取与导出共用只读连接生命周期；导出 rollback/close 失败不得发布文件。DMS 只暴露 executeScript；SLS/Redis worker 不泄漏上游认证或原始错误。

Pi 使用公开 SessionManager/ModelRuntime/AgentSession API；有效 prompt 从 `session.systemPrompt` 获取。不要操作 agent.state 伪造持久上下文，也不要从旧 JSONL 恢复额外工具权限。工具嵌套、取消和事件遵守安装 SDK 的合同，升级前阅读对应官方文档及声明。

## 前端与依赖

Web 使用 Solid 2 的匹配编译链。createEffect 的回调只返回清理函数或 undefined，转发 setter 时用语句块丢弃其返回值。请求和 DTO 集中在 data/client；共享资源和首页请求各有 owner。异步操作保留取消和 generation，覆盖身份/工单切换及过期响应。配置页保持面板挂载、凭证输入初始为空、独立行保存；组件不能提交其他行草稿。

本地 UI 位于 `src/web/src/ui`：Modal 管理嵌套栈和焦点，Select 管理键盘/搜索/定位，Markdown 使用 marked + DOMPurify。Select 的禁用/加载状态同时约束鼠标和键盘修改，控件只声明已实现的参数。附件/成果共用 ExcelPreview；预览不参与 Agent 处理文件。

CodeBrowser 使用原生 textarea 和现有 Source API，保留 SHA-256 冲突校验、草稿保护、原始 CRLF、过期响应取消。Git 状态、暂存、提交、历史由后端系统 Git 实现，diff 库只计算文本差异。

编辑器按旧页面校准：桌面左栏默认 300px、标题 35px、底栏 22px，右侧与 Agent 面板沿用旧版比例；三条分隔线支持拖动、方向键及 Escape 撤销，尺寸保留在页面会话中。布局与样式分别位于 styles.css 和 code-browser.css。文件和目录使用原 Material Icon Theme SVG，操作图标使用旧构建同一份 Codicons 字体（Microsoft / CC BY 4.0，署名与许可随构建发布），没有编辑器运行时依赖；Vite 按版本提供静态资源，不将整套 SVG 作为模块导入。SourceText 负责行号、滚动、查找定位和语法着色，输入、选择、撤销仍由原生 textarea 处理。highlight.js 仅登记实际使用的语言，源码经转义后显示；超过根配置 sourceHighlightCharacters 时保留纯文本显示，不限制文件读取或保存。

Explorer 根目录独立展开，刷新保留状态；单链目录自动展开，Alt+点击递归展开。停止输入 500ms 后通过现有 Source API 自动保存，保留 SHA-256 冲突检查；保存期间的新输入保留并继续保存，失败保留草稿并停止自动重试。Changes 与 Graph 同屏，前台每 2s 及重新聚焦时检查 Git 变更；历史失败不屏蔽变更，Git 放弃操作同步更新打开的文件。状态使用 M/A/D/R/C/U 字母及对应颜色，空暂存组不显示。

搜索由服务端 rg 执行，分批查询当前工单仓库，遵循忽略规则。后端流式解析结果，达到匹配数或输出预算后停止进程并明确返回 truncated；客户端断开会取消运行中的搜索。前端限制总量并按需增加可见匹配，避免短词生成过多 DOM；大小写、全字、分组和定位保留。API 将 rg 的 UTF-8 字节列转换为 UTF-16 列。匹配行可移出结果；可写仓库可将匹配替换为空，仍经读取校验及自动保存，过期匹配不修改文件。

Graph 在每个提交下展开文件，点击文件打开单份差异，收起保留正在查看的内容。历史按首次读取的提交固定分页，加载更早提交时保留已展开节点，新增提交不会使后续页重复或漏项。HistoryGraph 只保留父提交、轨道和 SVG 的原绘制规则，展开文件时延续合并连线。鼠标/键盘改变光标行后自动查询归属并常驻底栏；未保存时显示草稿状态，提交浮层支持选中及 HTTP 复制。面包屑与操作栏使用同一布局行，长路径省略并保留完整提示，按钮不覆盖路径。预算及防抖位于根配置。目录行标为“代码目录”，沿用原页路径；Agent 实际 cwd 仍为 Issue work。修改需验证只读、草稿、CRLF、标记不执行、真 Git、复制、宽高调节、目录展开、短词大量命中、取消、历史分页及页面几何尺寸。

依赖由根 package.json 与唯一 lockfile 管理，不再维护 Workbench workspace、编辑器版本脚本或语言 worker。Pi ai/coding-agent 使用匹配的精确版本；Solid runtime、Web 与官方 Vite/compiler 版本同步。版本以 manifest/lockfile 为准。

## 验证重点

| 修改范围 | 关键检查 |
| --- | --- |
| 用户/配置 | 角色、active、独立凭证保存、投影、排队期间权限变化 |
| 工单/附件 | root claim、事务失败、quarantine、rollback/finalize、重复调用 |
| Agent/Pi/SSE | run/steer、预约、取消、关闭、JSONL 回放、snapshot_ready 与过期连接 |
| Git/runtime | 真 Git、dirty/untracked、缺失 ref、批量回滚、冷启动、释放/重开 |
| 代码浏览器 | 相对路径、symlink、hash 冲突、草稿、只读拒绝、搜索、Git 与布局 |
| 能力/成果 | 精确目标、只读、预算、取消、原始字节与原子发布 |
| 镜像/部署 | 工具、用户、挂载、单副本、Recreate、探针 |

源码删减先确认生产入口、动态入口和构建资源，不能单凭“仅测试引用”删除，也不能为测试通过撤掉业务断言。不要按大文件行数机械拆分或建立新的审计框架。

Agent 在单应用容器内使用原生工具，工作目录只做组织，不提供隔离。测试必须在临时目录验证真实 Node 执行、库使用和任意文件发布，不向真实工单发送验证消息。旧消融原始 JSON 位于 [docs/experiments](experiments)，属于历史数据，独立运行入口已移除。

交付前检查最新需求、完整 diff、生成物/状态/密钥，运行适用验证，更新一个 owning 文档，并报告未验证项。没有用户指令时不提交、不推送、不操作线上状态。
