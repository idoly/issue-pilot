# 开发指南

本文说明当前代码 owner、修改配方、测试和 review 标准。开始前阅读[架构说明](ARCHITECTURE.md)；配置合同见[配置说明](CONFIGURATION.md)，生产操作见[运维手册](RUNBOOK.md)。

## 安全开始

Issue Pilot 会操作真实 SQLite、Git、Attachment、Pi JSONL 和 dev worktree。生产入口只从根 `issue-pilot.config.ts` 解析当前 checkout 的 `.issue-pilot`，没有环境变量 override。

每次任务先执行：

```bash
git status --short
```

不要回滚无关修改，不要用真实 `.issue-pilot` 做实验。自动测试使用临时 SQLite、state root、Git remote 和 fake model/tool owner。手工隔离 server 必须使用单独 project copy 和单独 state 配置。

## 本地命令

```bash
npm ci
npm run dev:web
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Vite 监听 `0.0.0.0:4173` 并代理本机 3000 API，只能用于可信开发网络。Production API 应通过 reviewed image 运行，不能用 active state 做临时 server 实验。

## Source map

| Path | Owner |
| --- | --- |
| `issue-pilot.config.ts` | Path、port、default、retention、runtime、budget |
| `src/config.ts` | Project/state/web absolute path resolution |
| `src/domain/contracts.ts` | Shared enum、type、predicate |
| `src/db/schema.ts` | Current Drizzle schema |
| `src/db/bootstrap.ts` | Migration、startup validation/recovery、bootstrap user、Environment sync |
| `src/configuration/agent.ts` | Global model singleton load/validate/save |
| `src/configuration/contracts.ts` | Catalog/config DTO、credential update contract |
| `src/configuration/read.ts` | Catalog 与完整 config snapshot projection |
| `src/configuration/credentials.ts` | Credential projection 和 `preserve|replace|clear` merge |
| `src/http/api.ts` | API assembly、error mapping、startup/close resources |
| `src/http/*-routes.ts` | HTTP boundary 与 route coordination |
| `src/http/service-configuration.ts` | Service request prepare/apply |
| `src/http/attachment-store.ts` | Multipart durable file、quarantine、rollback/finalize、safe GET |
| `src/outputs/store.ts` | production_data durable output、atomic write/append、safe list/download |
| `src/agent/engine.ts` | Run/steer queue、reservation、state、session coordination |
| `src/agent/context.ts` | Minimal context 与 local tool allowlist |
| `src/agent/pi-session.ts` | Private JSONL、Pi SDK、resource loader、tool verification |
| `src/agent/events.ts` | Event bus、current-run replay、buffer |
| `src/pi/models.ts` | Shared offline Pi model runtime/catalog |
| `src/pi/tools.ts` | 统一 service_query metadata、TypeBox parse、direct dispatch |
| `src/capabilities/registry.ts` | Config parser、input schema |
| `src/capabilities/*.ts` | Protocol client、SQL、HTTP、result helper |
| `src/process.ts` | Generic spawn、abort、timeout、output budget |
| `src/tool-runtime.ts` | Authorized process command/environment/HOME cleanup |
| `src/serial.ts` | `SerialQueue`/`KeyedSerialQueue` mechanics |
| `src/workspace/deployment.ts` | Deployment Repository completeness/order |
| `src/workspace/state.ts` | Repository classification、managed path/state cleanup |
| `src/workspace/git.ts` | Bare/fetch/checkout/worktree/batch rollback/Repository lock |
| `src/workspace/project.ts` | Agent/cold-start/reopen project preparation |
| `src/workspace/runtime.ts` | Atomic runtime generation |
| `src/workspace/project-wrappers.ts` | Dev wrapper generation |
| `src/workspace/project-tools.ts` | Unix socket、DB reauthorization、Node/Maven execution |
| `src/workspace/source-browser.ts` | Source authorization、bounded reads、dev file/Git mutation |
| `src/workspace/lifecycle.ts` | Inspection、stats、release、reopen、maintenance |
| `src/workspace/scope-transition.ts` | Scope transition plan/hash、支持矩阵和 apply |
| `src/web/src/data/client.ts` | Web request 与 DTO |
| `src/web/src/app/ApplicationResources.tsx` | Catalog/config/user shared resource 与 latest-wins refresh |
| `src/web/src/app/OverviewView.tsx` | Homepage Issue request、polling、abort、latest-wins state |
| `src/web/src/app/agent-stream.ts` | EventSource state machine |
| `src/web/src/app/conversation.ts` | Pure Agent event projection |
| `src/web/src/app/configuration-model.ts` | Capability/credential serialization |
| `src/web/src/app/ConfigurationView.tsx` | Service/Repository/Deployment/capability editor |
| `src/web/src/app/SettingsView.tsx` | User/model/service mounted tabs |
| `src/web/src/app/CodeBrowser.tsx` | Workbench iframe lifecycle 与 layout bridge |
| `src/web/src/vscode/main.ts` | Workbench services/settings/extension registration |
| `src/web/src/vscode/source-file-system.ts` | Access-aware multi-root filesystem |
| `src/web/src/vscode/source-search.ts` | Native Search provider |
| `src/web/src/vscode/source-control.ts` | SCM Changes/Graph/Diff/blame state |
| `src/web/src/vscode/markdown-preview.ts` | Read-only Markdown editor pane |
| `src/web/vite.config.ts` | Main/Workbench entries 与 static resources |
| `Containerfile` | Application image |
| `deploy/issue-pilot.yaml` | Kubernetes Deployment/Service |
| `scripts/playwright.sh` | Operator browser harness |
| `drizzle/` | Immutable migration history |

## Request flows

```text
Web -> data/client -> route parsing -> reservation/transaction -> owner -> DB/FS/Git
```

```text
Agent route -> AgentEngine -> IssueProjectManager -> AgentSessionContext
            -> PiSessionRuntime(customTools) -> event bus -> SSE -> Web controller
```

```text
Service save -> credential merge -> Registry config parse -> SQLite
Pi customTool -> TypeBox input parse -> typed session-local protocol client
```

```text
Dev wrapper -> Unix socket -> ProjectToolBroker -> SQLite/path authorization
            -> ProcessToolRuntime -> npm/mvn
```

Route、Web 和 AgentEngine 不复制 owner 事实。

## Shared contract 修改

以下内容只定义一次：

- Business enum/predicate 与 Issue work mode 映射：`src/domain/contracts.ts`
- Runtime config/limit：`issue-pilot.config.ts`
- Capability config/input：`src/capabilities/registry.ts`；统一查询 metadata：`src/pi/tools.ts`
- Credential field/update：`src/configuration/contracts.ts`
- Deployment Repository join：`loadDeploymentRepositories()`
- Repository state：`classifyRepositoryState()`

修改 shared enum 或 work mode 映射时检查 schema/default、route parser、state transition、Web option/label、migration 和 domain/HTTP/Web tests。Issue 创建只接收 work mode，普通 metadata edit 不得重新接入 Service/Environment/type。不要在 fixture 或 component 复制 string array。

## Database change

`src/db/schema.ts` 是 current model；`drizzle/*.sql` 与 `meta/_journal.json` 是 published upgrade contract。

1. 修改 schema。
2. 新增下一个连续 migration。
3. Journal 末尾追加 entry。
4. Fresh temporary DB 运行全部 migration。
5. 从 previous schema copy 运行 upgrade test。
6. Real data change 先停 API、创建一致 backup，并在隔离 copy dry-run。
7. 验证 `integrity_check`、`foreign_key_check` 和业务不变量。
8. 更新 schema/route tests 与 owning document。

Published migration 不修改、重排、合并或删除。

## HTTP change

Route 只负责：

1. 在 HTTP 边界解析 `unknown`。
2. 从 `ApiRouteContext` 获取 owner。
3. 验证 current subject 和 Issue scope。
4. 对 code、scope、Attachment、session、lifecycle mutation 使用 reservation。
5. Config snapshot/Service/Issue scope 与关联集合替换使用 scope queue。
6. Multi-table update 使用 transaction；关联集合替换还必须 reservation 目标、旧关联和新关联 Issue，并让新上下文重新入队准备。
7. Scope change 使用 `scope-transition` plan/apply，并在 reservation 内重新计算 hash；成功 mutation 与 append-only audit 必须同事务提交。
8. Cross-media update 使用 prepare/commit/rollback/finalize。
9. 返回 Web 实际需要的 DTO，不暴露 raw row、内部 path 或无关 secret。
10. 同步 `data/client.ts` 与 focused tests。

Config snapshot 使用 libSQL `read` transaction；Drizzle 的默认 transaction 会取得写锁，不能用于这些只读投影，否则与 Agent Workspace 更新并发时会阻塞写入。

Lock order：

```text
config read: scope -> SQLite snapshot transaction
Service/Issue scope write: scope -> reservation
release/reopen: lifecycle -> inspection -> reservation
```

主要 route tests 位于 `tests/http/`。新增 endpoint 时覆盖 parse、authorization scope、success、stable error、repeat、rollback 和 shutdown interaction。

## Attachment change

必须保持：

- Multipart request/file/count/field budget。
- Basename normalization 与 SHA-256。
- Durable file `0400`。
- Create failure 只删除本次文件并 `rmdir` 本次空 root。
- Edit delete 先 quarantine；transaction failure 恢复；commit 后 finalize。
- Cleanup failure 返回 stable error 并保留 evidence。
- GET 验证 direct path、regular file、mode、size、hash。

Attachment write 只属于 Issue create/edit。不要新增独立 POST/DELETE 或 sync route。

## 依赖更新

运行时、数据库客户端和构建工具按 package.json 声明的兼容范围更新，Pi 三件套使用同一 release，应用直接依赖的 ai/coding-agent/codemode 均使用精确版本；undici 的覆盖不能低于 Pi SDK 要求的修复版本。Monaco/VS Code 依赖集中在私有 workspace [packages/workbench/package.json](../packages/workbench/package.json)，根清单不再列这些包。核心包的精确版本是整组唯一基准；两个 npm alias 也必须匹配，Material Icon Theme 同属构建 workspace。`npm run deps:editor -- --check` 检查声明与实际安装，已接入 typecheck/build。升级执行 `npm run deps:editor -- --set <version>`：先核对 registry 中整组版本都存在，再一次更新 manifest；随后根目录 `npm install` 更新唯一 lockfile，并跑全套验证。workspace 只声明 devDependencies，生产 `npm prune --omit=dev` 必须移除这些包。不要将 editor 包重新散放到根清单，或单独提升某个 override/alias。

Monaco/VS Code 所有 override、default extension、editor/extension alias 必须整组兼容，不混用未发布的核心版本。Solid 2 runtime 与 Web 保持相同 RC 版本，配套使用匹配的官方 Vite 插件/编译器；不按 npm latest 标签降回 Solid 1，也不混用 RC 编译产物。以 registry 已发布版本、typecheck、全量测试、build 和真实浏览器结果决定是否可更新。

按当前开发工单的 Java/TS/SQL/样式/配置文件保留 TextMate 与四种语言服务；`standalone-languages` 仅按需导入 Python registration，禁止恢复全语言入口。Workbench factory 已包含 keybindings/titlebar/statusbar，应用不再重复注册或直接声明这三个包（仍由 Workbench 传递依赖提供）。固定 GitHub Dark 主题由本地 extension 提供，不再加载默认主题包。精简后验证 Explorer、Search、SCM、核心语言注册与工作台 ready，不只看 npm 安装是否成功。

Solid 编译链直接使用 `@solidjs/vite-plugin`，当前 Solid/Web 为 `2.0.0-rc.15`、插件为 `3.0.0-next.50`，使用其官方 compiler/Babel plugin，不再覆盖旧版 `babel-preset-solid`。Seroval 与 plugins 同步覆盖到修复版本。

Web UI 由 `src/web/src/ui` 的本地组件提供，不再依赖 Ant Design、ConfigProvider、Layout 或 `.ads-*` 样式。`controls.tsx` 管理按钮、输入、标签和状态；`Modal.tsx` 管理 Portal、嵌套弹窗栈、焦点捕获/恢复和 saving 期间取消；`Select.tsx` 管理受控单选/多选、搜索、键盘、清除和 viewport 内弹层定位；`controls.css` 统一基础样式，业务页只消费这些组件。行为测试在 `ui/controls.test.tsx`，页面既有测试和真实浏览器分别验证完整流程与布局，不能只看类型检查。

## Pi SDK 升级

当前 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 使用相同的精确版本 `1.3.0`，lockfile 中内部 Pi 包也保持同版本。升级先读目标版本 SDK/session/model 文档和 CHANGELOG，再检查 public API，不能从 `session.agent.state.systemPrompt` 读取有效 prompt；使用 `session.systemPrompt`。应用显式传入 tool allowlist，不从旧 JSONL 恢复额外权限；SDK 自带 MCP/codemode 不自动接入 Issue capability。

`agent_settled.aborted` 必须传递，shutdown 对非 idle session（包括 compaction）执行 abort/dispose。JSONL 中 system/context_edit 用于 provider 上下文，不进入可见 SSE transcript；原始历史仍可显示被上下文省略的消息。独立 usage entry 计入总费用，toolResult 的 durationMs 回放至 Web；旧记录缺少耗时才按 start/end 估计。`tests/agent/sdk-upgrade.test.ts` 用无网络 faux provider 覆盖真实 prompt/tool/persist/resume 流程，另有个人模型凭证隔离测试。

## 工单分析沙盒

运行合同见[工单分析沙盒](SANDBOX.md)，选择依据见[消融实验结果](SANDBOX_EXPERIMENT_RESULTS.md)。`sandbox-tool.ts` 拥有 session 内队列、权限和成果传输，`sandbox/runtime.ts` 拥有无宿主挂载的 rootless 容器。每轮 prompt 的 finally 和 session stop 都必须清理；检查启动/关闭竞态、重复轮次、abort、容量、超限和成果原子发布。禁止把模型脚本、文件内容或凭证放进宿主 shell/进程参数。

## 工单沙盒实验

隔离执行与模型能力的对照实验见[工单沙盒消融实验](SANDBOX_EXPERIMENT.md)。它使用生成样例、独立容器与内存 Pi session；通过 `npm run experiment:sandbox` 运行，不接入正式工单或改变其工具权限。

## Agent/Pi change

AgentEngine 拥有 run/steer queue、reservation、state transition、in-memory session 和 background cleanup。IssueProjectManager 拥有 code preparation。

检查：

- Code 先 prepare，context 后生成。
- Prod/test path 只指向 Issue runtime。
- Session file 在首条 visible message 前创建/绑定。
- User message 只在 state commit 或 Pi accept 后写 JSONL。
- Resolved Issue 不可执行。
- Success/failure/abort/close 均 dispose session。
- Prod/test 下一轮重新读取 Deployment。
- Existing dev 保留历史 branch/workspace name。
- Reporter/logger failure 不形成 unhandled rejection。
- Shutdown 拒绝新 activity，并 drain run/reservation。

Pi JSONL 是 transcript 事实源，不新增 message table。重点测试：`tests/agent/`、`tests/pi/`。

## SSE/Web stream change

Contract：

```text
JSONL replay -> current run replay -> snapshot_ready -> buffered/live events
```

Server 在 snapshot 前订阅 live bus。Current-run replay 只包含尚未 durable 的 message/tool 增量和最新 queue；完成或 Issue 结束后释放。连接按 event ID 去重。Writer 必须 ordered，并处理 drain/close/error；当前不通过 pending-byte limit 截断会话数据。

`agent-stream.ts` 只拥有 EventSource、generation、private replay、snapshot commit、stale reconnect 和 compaction refresh。`conversation.ts` 保持 pure projection。测试 stale source、snapshot boundary、Issue switch、stale refresh、compaction 和 dispose。

## Git/runtime/lifecycle change

Filesystem/Git 不受 SQLite 自动 rollback，必须明确每个 failure stage。

Project owner：

- `prepare()`：Agent round。
- `hydrateDevelopmentRuntime()`：dev cold start。
- `hydrateReadOnlyRuntime(s)`：read-only cold start。
- `restoreDevelopmentWorkspace()`：released dev reopen。

Git transaction：

- Repository operation 按 `stateRoot + URL hash` 串行。
- `prepareBatch()` 记录新 worktree，finalize failure 逆序 remove。
- `removeBatch()` 先预检全部 clean，失败逆序从 local ref/commit restore。
- Unknown root、missing repo、mixed state、path mismatch fail closed。

Runtime 用 temporary + previous 原子替换。普通 Issue GET 不做 `du` 或 Git clean；deep inspection 只用于 stats/release/reopen/maintenance。

## 全局能力与自定义 MCP

`configuration/capability-switches.ts` 读取完整全局开关集合，缺行显式失败；Agent context 只保留部署配置和全局开关的交集。`http/capability-routes.ts` 保持 scope queue → affected Issue reservation 顺序。

`http/mcp-routes.ts` 管理可信远程服务与显式 credentialUpdate，禁止认证回显或写入错误日志。`mcp/client.ts` 统一 SSE/Streamable HTTP、同源 HTTPS fetch、发现、schema 校验和结果预算；Pi runtime 根据 canModifyCode 筛选 readonly 注解与当前可执行工具清单。配置变更预约全部 Issues，running 拒绝、idle session 关闭。用假 transport 验证 header、跨源拒绝、两种协议、只读过滤、schema变化、异常/abort关闭，不能对生产服务执行写工具作测试。

## MCP 外部交互

MCP 的最小任务流程是 services_list/users_list → issue_create 或 issues_search → issue_message → issue_get/issue_conversation → output_read。新增写工具复用既有 HTTP owner，通过连接身份执行，不复制事务/队列/角色校验。注解 readOnlyHint=false、idempotentHint=false 必须与操作一致，不能自动重试；/api/endpoints 和 tools/list 共用定义。tests/http/application-mcp-create.test.ts 覆盖实际 MCP SDK 创建、发送、默认字段、身份署名和角色拒绝，fixture 使用临时 state 和 fake engine；不得在真实工单创建测试任务。通用 HTTP 试写仍暂停，记录见 SANDBOX.md。

## Capability change

新增或修改 capability 通常涉及：

1. `CAPABILITY_KEYS` 与 `CapabilityConfiguration`。
2. Registry parser/schema/metadata。
3. `src/pi/tools.ts` dispatch。
4. 独立 protocol client。
5. Root limit/runtime。
6. Explicit Web form 与 serializer。
7. Save round-trip、tool、client tests。
8. [配置说明](CONFIGURATION.md)。

必须明确 exact target、credential lifecycle、allowed action、redirect、timeout、abort、row/item/byte budget 和 sensitive result。除拥有明确无 byte-limit 合同的 DMS 外，超限必须完整失败。

当前协议模块：

```text
nacos.ts
mysql.ts + sql.ts
redis.ts + redis-worker.ts
rabbitmq.ts
elasticsearch.ts
dms.ts + MCP SDK SSE transport
sls.ts + sls-http.ts + sls-worker.ts + read-worker.ts
http-client.ts
```

Native MySQL/DMS 的选择器来自所选 environment/service 配置；DMS 只调用 executeScript 并注入 DatabaseId。listInstances/getDatabase 只属于受信配置解析。Redis/SLS 共用 read-worker.ts 生命周期、并发和取消，Redis 继续使用 RESP/TCP，SLS 用官方 HTTPS SDK。协议授权不能替换成服务描述里的文字。Playwright 不是 capability。

## Web 与 Workbench change

工单详情操作区统一为首行整宽状态操作（确认解决、重新打开或重试/继续），其余操作在下方两列，奇数末项整宽；保持按钮高度、间距和 DOM/视觉顺序一致，不依赖 primary 样式重新排序。

- User role 与 personal credential owner 合同见[配置说明](CONFIGURATION.md#user)。修改角色、active 或个人凭证必须 scope queue → owned Issue reservation；开发创建与 scope 转换的权限在 HTTP 边界强制校验。个人 key 不得进入 DTO、日志或 Agent context，Git helper 和 Pi runtime 必须按 session 隔离并在失败/关闭清理。
- Shared enum 从 domain 导入。
- Request/DTO 集中在 `data/client.ts`。
- Shared resource 保持 abort/generation/latest-wins。
- Homepage Issue state 只由 `OverviewView` 拥有。
- Capability 使用 explicit form，不生成 generic schema form。
- 服务描述按能力标题和字段表呈现，空用户名省略，多值参数分行。开发配置页明文通过独立 developer-only configuration-description 读取，生成器只在该路径接收真实凭证；默认生成、普通 config、Agent 与 MCP 不含密钥。切换服务/身份时丢弃旧响应，卸载取消请求，敏感 Markdown 禁用全局缓存。
- Agent composer 粘贴图片使用 multipart，服务端转换为 Pi `ImageContent`；图片随 visible user event 和 Pi JSONL replay 展示，不写 Attachment store 或新增独立 Attachment route。
- Agent 消息发送前按展开后的粘贴文本校验 `limits.agentMessageChars`，超限保留草稿并提示分段发送；API 对 JSON 和 multipart 的超长文字统一返回 `agent_message_too_long`，空内容或非法格式仍返回 `invalid_agent_message`。
- 配置的三个 panel 保持挂载；切换 Tab 不能丢 draft/modal。
- Deployment 折叠标题在展开前后保持“环境名 + 已启用 capability”同一行；展开区只列未启用 capability，不能重复完整 active 列表。
- 主应用与 Workbench Markdown Preview 使用 `marked + DOMPurify + github-markdown-css`；Workbench 启动不得依赖 optional extension-host render command。
- Workbench dev 可创建、保存、删除、重命名文件并执行 Stage/Unstage/Discard/Commit；其他模式只读。
- Workbench/Agent Git commit 使用当前工单用户姓名和邮箱。
- `production_data` 只能通过专用 `output` tool 写每 Issue 成果区；不得因此开放 Repository mutation tool。MySQL 大结果通过只读 transaction 直接 stream 为 CSV/JSONL，失败或 abort 不发布临时文件。
- 成果列表由 `listIssueOutputs` 按 updatedAt 倒序返回，同时间按 fileName 排序；修改/追加后的文件回到列表最前。
- 成果文件点击文件名打开只读预览，CSV/SQL/JSONL 等以文本展示，JSON 自动排版，Markdown 使用共享的安全渲染器；下载仍返回完整文件。预览按根配置 `web.outputPreviewBytes` 限制为 20 MiB，超限完整失败、不显示截断内容；关闭、切换工单或重试会取消旧请求并忽略过期响应。
- 新 flow 覆盖 loading、empty、success、failure、retry、stale response。
- 服务详情保留服务切换和编辑入口，主体保留仓库/环境分支矩阵，再渲染 ServiceOverview 的一份 Markdown 描述；移除数量横幅和维护说明文字。service-context.ts 从配置生成公开能力参数和开发继承规则，描述不重复仓库分支或共享凭证内部名称。仓库名称读取统一目录。services.description 仅保存手写知识，生成 context 不反写数据库；Token/密码/AccessKey 不进入 context。编辑时仍通过共享 serializer 写各环境配置，dev 只维护分支。
- 统一仓库配置由 `repository-routes.ts` / `RepositoryManagement.tsx` 管理，地址解析与服务选择校验只在对应 HTTP owner 做。Service URL 是引用 catalog 的自然键；不得在服务保存时自动登记 unknown URL，也不得改写历史 Issue Repository URL。改址要 scope queue → affected Issue reservation → session close → transaction；迁移测试核对 binding ID、rowid、branch rows/order 与 FK 完整性。
- 所有 work mode 均可创建、编辑关联；模式切换保留已选关联，scope apply 不删除关系。Dev 关联证据保持在独立 runtime，prompt 使用完整路径；验证 dev prepare/cold-start 与 prod/test，保留自关联、数量和 reservation 校验。
- `output` 的 `spreadsheet` operation 对本工单授权 Attachment ID 做路径/mode/size/SHA-256 校验，解析 `.xlsx/.xls`；也可通过 `outputFiles` 读取同一 Issue 受管成果，拒绝路径穿越与 symlink，JSON/JSONL 提供 `files[i].data`，CSV/TSV/Excel 提供 `files[i].sheets`，可选 `data` 参数直接注入结构化数据。DMS 的 `output.fileName` 将完整 MCP result 原子保存为 JSON，仅返回文件摘要，不把查询行回传模型；只在 canWriteOutputs 的动态 schema 开放，读库仍由唯一 dms tool 执行。随后由 `@earendil-works/pi-codemode` 的 CodemodeSandbox 通过一次已授权 input bridge 传入 `files:[{id,fileName,sheets:[{name,rows}]}]` 与 data；不再自行创建 QuickJS runtime/context、注入全局变量或管理 handle。脚本在 worker 中执行，acquireWorker 在实际线程退出时释放并发名额；覆盖 CPU 计算期间取消、wall timeout、内存超限、并发拒绝和大输入。脚本是 JavaScript function body，返回 `{sheets:[{name,rows}]}`；无 Node/process/filesystem/network，内存与执行时限来自根配置，脚本错误不回传数据。Host 验证结果并编码 `.xlsx`，只有成功后原子发布到成果区；失败/abort 不覆盖旧成果。不启用 bash 或 Repository mutation；Web 成果预览复用 ExcelPreview。
- Excel `.xlsx` / `.xls` 由 `src/documents/excel.ts` 统一解析；Agent `read` 的 `src/agent/document-read-tool.ts` 转为工作表标题加 CSV 文本，并沿用 Pi offset/limit 与输出分页；Web `ExcelPreview.tsx` 按工作表预览，每页 100 行。解析前复制输入，不能修改附件 Buffer；不执行公式、宏或 HTML，读取缓存/格式化单元格值，空工作表显示空状态，损坏/加密文件显式失败。
- 用户个人凭证使用一张卡片，开发、DMS、SLS分行并独立保存。仅开发用户显示开发行，生产配置对全部 active 用户可见；手机端依赖当前 row grid 纵向排列，不复用旧用户表格的 named grid-area。
- 服务工单量图表的服务名列保持 64–96 px，柱条占据剩余宽度；计数与滚动条之间保留 16 px 间距，长服务名使用省略展示。
- 团队动态点击先选择工单 active assignee，再打开详情；未分配或停用用户不伪造身份，仍打开目标。旧 people 请求不能覆盖新选择，异步跳转使用 generation 丢弃旧点击。用户选择仍是 trusted identity selection，不是认证。

## Test commands

Focused backend：

```bash
node --experimental-strip-types --test tests/workspace/git.test.ts
```

Focused Web：

```bash
npx vitest run --config src/web/vite.config.ts --environment jsdom \
  src/web/src/app/App.test.tsx
```

Full：

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

| Change | Minimum coverage |
| --- | --- |
| Shared contract | Domain、DB、HTTP、Web |
| User | Bootstrap、active transaction、API、Web |
| Attachment | Unbounded streaming staging、quarantine、rollback/finalize、GET integrity |
| Agent/Pi | Queue、reservation、state、steer、abort、shutdown |
| SSE | Replay/snapshot/live、backpressure、generation、reconnect |
| Capability | Save parse、scope、schema、client、timeout、oversize、abort |
| Git/lifecycle | Real Git、dirty、missing ref、batch rollback、cold start、reopen |
| Source/Workbench | Path/symlink/binary/budget、dev mutation、readonly refusal、Search/SCM/Preview |
| Project tools | Socket mode/protocol、DB/path auth、serial、timeout |
| Startup | Fresh/migrated DB、interrupted state、unmanaged/changed checkout |
| Deployment | Image tools、single replica、Recreate、hostPath、probes |

## 小范围删减与消融

先为当前问题建立基线，验证删除某个调用路径、文件或样式后的行为变化，再决定保留。不能把“只有测试引用”或“代码很短”单独作为删除依据，也不能为了通过测试移除实际业务断言。配置的部署字段剥离、公开投影和 credential merge 统一位于 credentials.ts；MCP 测试使用生产的 binding → service_query 路径。首次记录见[代码删减消融验证](SIMPLIFICATION_VALIDATION.md)，后续逐问题进行，不扩充为通用审计框架。

## Code conventions

- Backend TypeScript ESM 使用 explicit `.ts` import；Web 遵循 bundler import style。
- 保持 strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- External `unknown` 在边界解析一次；内部 typed call 不重复 shape validation。
- 新 abstraction 只用于稳定 transaction、protocol、process 或 reusable UI boundary。
- Stable error 使用 lowercase code。
- Generated state 原子替换；durable state 不先删再建。
- 不添加 automatic legacy compatibility。
- 不按行数机械拆 owner，不引入万能 service/repository layer。

## Review checklist

- Fact 是否位于 owner 且只有一个 source？
- Prod/test 是否仍只读，dev 是否仍 Issue-isolated？
- Existing dev history 与 released local branch 是否保留？
- Dirty/unmanaged evidence 是否 fail closed？
- Cross-media update 是否有 rollback/finalize test？
- Lock order 是否正确？
- Config GET 是否省略所有 credential 字段，Web 初始密钥是否为空，未修改是否按 preserve 保存，且凭证是否未进入响应、context、prompt、input、argv 或日志？
- Capability result retention 与 budget 是否明确？
- DTO、Web 和 removed route 是否一致？
- Startup、shutdown、retry、abort、repeat 行为是否确定？
- Owning document 是否更新且未复制另一文档的详细合同？
- 验证是否与风险匹配？

个人生产凭证沿用 user_credentials 与 /api/me/credentials，新增字段默认空。applyProductionCredentials 仅覆盖 prod，DMS/SLS 各自完整覆盖，未配置使用部署值，不在失败后更换身份重试。统一我的凭证卡片按开发、DMS、SLS 分行，行保存不能提交或清除其他行草稿。0053/0054 迁移核对原共享密钥与目标逐项一致，旧 resource_connections API/表和客户端接口全部移除。
