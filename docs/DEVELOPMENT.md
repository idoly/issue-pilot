# 开发指南

本文说明如何基于当前代码修改 Issue Pilot：从哪里读、由哪个模块拥有事实、如何跨层实现、怎样测试，以及如何避免破坏真实 state。先阅读 [架构说明](ARCHITECTURE.md)；配置字段见 [配置说明](CONFIGURATION.md)，宿主环境见 [部署说明](DEPLOYMENT.md)。

## 开始前

Issue Pilot 会操作真实 SQLite、Git repository、Attachment、Pi JSONL 和 dev worktree。主程序只从根目录 `issue-pilot.config.ts` 解析 `.issue-pilot`，没有环境变量 override。

每个任务先执行：

```bash
git status --short
```

区分已有修改和自己的工作。不要回滚无关改动，不要把项目真实 `.issue-pilot` 用作实验数据。

自动测试通过以下方式隔离状态：

- `buildApi({ stateRoot, databaseFile })`
- Manager constructor 注入 temporary root
- 临时 local Git remote
- 临时 SQLite database
- Fake model catalog和 Agent controller

需要手工隔离服务器时使用独立项目副本，而不是临时改变当前 checkout 的真实 state 配置。

## 本地开发

```bash
npm ci
infra/playwright.sh prepare # 仅准备Issue Pilot应用自测浏览器
infra/aliyun-cli.sh prepare
infra/project-tools.sh prepare
npm run db:migrate
npm run server
```

另一个终端：

```bash
npm run dev:web
```

默认API为`127.0.0.1:3000`，Vite为`0.0.0.0:4173`。VS Code Workbench代码浏览器由Vite的`vscode.html`多入口构建提供，不启动独立IDE服务。

## 源码地图

| 路径 | 当前责任 |
| --- | --- |
| `issue-pilot.config.ts` | State、空库bootstrap用户、端口、默认值、retention、runtime 和上限 |
| `src/config.ts` | 把相对 state 配置解析成绝对路径 |
| `src/domain/contracts.ts` | 前后端共享的 key、enum、type 和共享 predicate |
| `src/configuration/contracts.ts` | 配置中心 catalog、脱敏 editable configuration 和 credential update 共享 DTO |
| `src/configuration/read.ts` | Catalog 和脱敏 editable configuration projection |
| `src/configuration/credentials.ts` | 已存 credential 脱敏及 preserve/replace/clear 合并 |
| `src/configuration/revision.ts` | Service 完整配置内容 revision 和一致性读取 |
| `src/db/schema.ts` | 当前 Drizzle schema |
| `src/db/bootstrap.ts` | Migration、启动状态恢复和 Environment同步 |
| `src/http/api.ts` | API装配、error mapping、启动/关闭资源生命周期和开发入口 |
| `src/http/production.ts` | 主应用镜像的API + static Web显式生产入口 |
| `src/http/*-routes.ts` | User、配置、Issue、Agent、Attachment、Source GET、生产静态Web和Workspace routes |
| `src/http/service-configuration.ts` | Service/Deployment request prepare 和 transaction apply |
| `src/http/attachment-store.ts` | Attachment multipart、write、quarantine、rollback/finalize 和安全读取路径 |
| `src/agent/engine.ts` | Issue Agent queue、reservation、状态转换和 Pi session 协调 |
| `src/agent/pi-session.ts` | Private JSONL、Pi SDK session、resource loader 和 tool核对 |
| `src/agent/events.ts` | Event bus、replay projection 和 replay/live buffer |
| `src/pi/policy.ts` | Frozen IssuePolicy 和 built-in tool allowlist |
| `src/pi/tools.ts` | Registry-driven custom tool creation |
| `src/capabilities/registry.ts` | 配置解析、credential-free scope、schema、metadata |
| `src/capabilities/broker.ts` | Allowlist、input parse 和 keyed handler dispatch |
| `src/capabilities/*.ts` | 独立协议 client和共享 bounded HTTP/process primitives |
| `src/serial.ts` | `SerialQueue`、`KeyedSerialQueue` 和 `idle()` |
| `src/container.ts` | 临时工具容器共同的安全argv、mount和资源限制构建器 |
| `src/container-runtime.ts` | Podman与fail-closed临时容器适配；Capability/项目工具共用的Kubernetes Job runner扩展点 |
| `infra/application-compose.mjs` | 从根配置和绝对宿主路径生成application + tools Compose模型 |
| `src/workspace/project.ts` | Agent/cold-start/reopen 的 Issue project准备 |
| `src/workspace/deployment.ts` | Deployment Repository完整性和顺序解析 |
| `src/workspace/git.ts` | Bare store、checkout、worktree、batch rollback和 Repository锁 |
| `src/workspace/state.ts` | State path、Repository分类、布局、unmanaged/shared checkout检查 |
| `src/workspace/runtime.ts` | Issue runtime Repository link原子生成 |
| `src/workspace/source-browser.ts` | Repository相对路径、tree/file/rg/history/commit/diff只读边界 |
| `src/workspace/project-tools.ts` | Unix socket broker和Node/Maven受限容器执行 |
| `src/workspace/lifecycle.ts` | 深检、stats、release、reopen、maintenance |
| `src/web/src/data/client.ts` | Web request、共享 DTO re-export和 current-user header |
| `src/web/src/app/agent-stream.ts` | EventSource transport state machine |
| `src/web/src/app/conversation.ts` | Agent event纯投影 |
| `src/web/src/app/configuration-model.ts` | Selected capability draft serializer |
| `src/web/src/app/CodeBrowser.tsx` | VS Code Workbench iframe生命周期、Part矩形消息和固定视图工具栏 |
| `src/web/src/app/UserManagement.tsx` | SQLite用户新增、编辑、启停和状态反馈 |
| `src/web/src/vscode/main.ts` | Workbench service组合、固定theme和只读产品设置 |
| `src/web/src/vscode/workers.ts` | Editor、language、TextMate和受控Web Worker extension host工厂 |
| `src/web/src/vscode/source-file-system.ts` | Source API到multi-root VS Code文件系统的只读映射 |
| `src/web/src/vscode/source-search.ts` | 原生Search到预算literal Source API的provider |
| `src/web/src/vscode/source-control.ts` | 原生SCM Changes、提交Graph和按需revision Diff的只读投影 |
| `src/web/vite.config.ts` | 主应用/Workbench多入口以及GitHub、Material、Markdown preview静态contribution构建 |
| `src/web/src/app` | 页面和用户交互 |
| `tests/http/fixture.ts` | 独立 API test fixture |
| `infra` | 主应用、自测Playwright、Aliyun CLI、Node/Maven image准备和根配置读取 |
| `drizzle` | 不可变 migration history |

## 追踪一次请求

普通 Web 请求：

```text
Web component
  -> src/web/src/data/client.ts
  -> src/http/*-routes.ts
  -> boundary parser / reservation / transaction
  -> owning manager or store
  -> SQLite / filesystem / Git
  -> explicit DTO
```

Agent 请求：

```text
agent-routes
  -> AgentEngine
  -> IssueProjectManager
  -> createDeploymentPolicy
  -> PiSessionRuntime
  -> AgentEventBus
  -> SSE replay + snapshot_ready + live
  -> AgentStreamController
  -> conversation projection
```

Capability 请求：

```text
Deployment save
  -> registry parser
  -> credential-free policy scope
  -> registry tool schema
  -> broker
  -> protocol client
```

不要在 route、Web 或 AgentEngine中重写 owning layer 的事实。

## 共享 contract 与配置

以下事实只定义一次：

- Issue/Environment/Workspace状态、priority、type、thinking level、capability key：`src/domain/contracts.ts`
- 可调 path、port、default、timeout、bytes、rows、image：`issue-pilot.config.ts`
- Capability配置字段、scope、input schema和 metadata：`src/capabilities/registry.ts`
- 配置中心 credential 字段、必需性和更新状态：`src/configuration/contracts.ts`
- Deployment Repository完整性：`loadDeploymentRepositories()`
- Repository state：`classifyRepositoryState()`

修改 shared enum 时同步检查：

- Drizzle enum/default。
- API parser和状态转换。
- Web option/label/DTO。
- Domain、DB、HTTP、Agent和 Web tests。
- 已有数据库值是否需要 migration。

不要为编译通过在 route、Web 或 test fixture中复制字符串数组。

## 修改数据库

`src/db/schema.ts` 是当前模型。`drizzle/*.sql` 和 `_journal.json` 是从历史版本升级的顺序契约。

Schema change步骤：

1. 修改 `src/db/schema.ts`。
2. 新增下一个连续编号 SQL migration。
3. 在 `_journal.json` 末尾追加匹配 entry。
4. 在 fresh temporary database运行 migration。
5. 从上一版本 database copy运行 upgrade test。
6. 涉及真实数据时，在一致备份的隔离副本 dry-run。
7. 验证 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。
8. 更新当前 schema tests。
9. 更新唯一负责该事实的文档。

Published migration不修改、不重排、不删除。Runtime不兼容旧文件布局不等于数据库 migration可以省略。

每张 Issue必须有 Workspace行；`status/resolved_at` 和 Deployment scope有 API guard与 SQLite trigger。迁移前后都要验证这些不变量。

## 新增或修改 HTTP API

Route应完成：

1. 在边界把 `unknown` 解析为明确输入。
2. 使用 `ApiRouteContext`取得 database、engine、events和 managers。
3. 使用 `requireIssue()`、`ensureCurrentSubject()` 等 guard。
4. 影响 Issue code、scope、Attachment、session或 lifecycle时使用 Issue reservation。
5. 配置 snapshot读取、Service配置或 Issue scope变化先进入 scope queue；读取顺序为 `scope -> snapshot transaction`，Service写入顺序为 `scope -> revision check -> reservation`。
6. 多表更新放在一个 transaction。
7. 文件系统事务明确 prepare/commit/rollback/finalize。
8. Service PATCH/DELETE 使用 `/api/config` 返回的 revision 和 `If-Match`；冲突必须在 session close和 transaction之前失败。
9. 返回 Web实际需要的 DTO，不暴露 raw row。
10. 在 `src/web/src/data/client.ts`同步 contract/helper。
11. 在职责对应的 HTTP test文件添加成功和失败场景。

当前 route tests按域拆分：

```text
tests/http/configuration-api.test.ts
tests/http/issue-api.test.ts
tests/http/attachment-api.test.ts
tests/http/runtime-api.test.ts
tests/http/api-startup.test.ts
tests/http/service-configuration.test.ts
tests/http/sse.test.ts
```

`tests/http/fixture.ts` 每个 test创建独立 API、database和 state root。不要恢复一个跨 700+ 行、共享状态的串行 API test。

当前不存在：

- `POST /api/issues/:key/attachments`
- `DELETE /api/issues/:key/attachments`
- `POST /api/issues/:key/sync`

Attachment write必须继续属于 Issue create/edit事务。若重新引入独立 route，必须先重新论证并发、metadata sync和文件事务语义。

## 修改 Attachment

`attachment-store.ts`拥有 durable store helper；`attachment-routes.ts`只拥有只读 GET。

必须保持：

- Multipart总请求、文件数、单文件和 field预算。
- Basename规范化。
- SHA-256在写入前计算。
- Durable file mode `0400`，Issue/attachment directory mode受限。
- Create failure只删除本次文件，并只 `rmdir` 本次空目录。
- Edit delete先 quarantine，transaction rollback恢复，commit后 finalize。
- Rollback/finalize失败返回稳定错误并保留现场。
- GET验证直属 path、普通文件、mode、size和 hash。

相关 tests：

```text
tests/http/attachments.test.ts
tests/http/attachment-api.test.ts
```

## 修改 Agent

AgentEngine拥有：

- 每 Issue run queue。
- Streaming steer queue。
- Issue reservation和 drain。
- Issue/Workspace状态转换。
- In-memory Pi session。
- Background failure cleanup。

`IssueProjectManager`拥有代码准备；不要把 Git prepare重新移回 AgentEngine。

修改时检查：

- Repository先准备，policy后生成。
- Prod/test policy path指向 Issue runtime link，不是 shared checkout物理 path。
- Session file在第一条可见消息前初始化并绑定。
- User message只有状态提交或 Pi accept成功后才写 JSONL。
- Resolved Issue不能执行。
- Success/failure/abort/close都 dispose session。
- Prod/test每轮结束关闭内存 session，下轮刷新 Deployment。
- Dev已有 Repository保留历史 base branch。
- Background reporter/logger failure不能形成 unhandled rejection。
- Shutdown拒绝新 activity并等待 run count和 reservation归零。

Pi JSONL是 transcript事实源。不要新增消息表或用 Web状态重建历史。

重点 tests：

```text
tests/agent/engine.test.ts
tests/agent/pi-session.test.ts
tests/agent/events.test.ts
tests/agent/repository-preparation.test.ts
tests/pi/policy.test.ts
tests/pi/tools.test.ts
```

## 修改 SSE 或 Agent Web

服务端握手 contract：

```text
replay events
snapshot_ready { agent, footer, running, issueStatus }
live events
```

SSE route必须在 snapshot前订阅 live bus，并缓冲 snapshot期间 event。Writer必须有序、bounded并正确处理 drain/close/error。

Web transport state只放在 `agent-stream.ts`：

- EventSource create/close。
- Generation失效。
- Replay private buffer。
- Atomic snapshot commit。
- Reconnect timer。
- Compaction后主动 reconnect。

`conversation.ts`保持纯 event projection；`AgentPanel.tsx`负责 UI、footer、composer、scroll和 refresh。不要把 transport状态重新散回组件。

测试 stale source、duplicate error、snapshot前后、Issue切换、stale refresh、compaction和 dispose：

```text
src/web/src/app/agent-stream.test.ts
src/web/src/app/AgentPanel.test.ts
```

## 修改 Git、Runtime 或 Lifecycle

这些改动风险高，因为 filesystem和 Git不能由 SQLite transaction自动回滚。

### Project manager边界

- `IssueProjectManager.prepare()`：Agent路径。
- `hydrateDevelopmentRuntime()`：dev cold start。
- `hydrateReadOnlyRuntime()`：prod/test cold start。
- `restoreDevelopmentWorkspace()`：released dev reopen。

新入口应复用这些方法或扩展 owning manager，不要复制 prepare sequence。

### Git事务

- Repository操作按 `stateRoot + URL hash`串行。
- `prepareBatch()`跟踪本次新建 worktree，finalize失败时逆序 remove。
- `removeBatch()`先预检全部 clean，删除失败时逆序从本地 ref/commit restore。
- Unknown root entry、missing repository、mixed state和 path mismatch都 fail closed。

### Runtime

Runtime和 wrapper使用临时目录+previous目录原子替换。Writable link必须位于当前 Issue workspace；read-only target必须位于 shared checkout root。

### Lifecycle与深检

普通 Issue GET不得调用 `inspectIssue()`。深检只属于 stats、release、reopen和 maintenance。

锁顺序：

```text
lifecycle SerialQueue
  -> per-Issue KeyedSerialQueue
  -> Agent Issue reservation
```

Different Issue inspection可以并行。Stop必须等待 lifecycle queue和 inspection queue的 `idle()`。

Release继续拒绝：

- 非 resolved或非 dev。
- Agent/workspace busy。
- Dirty/untracked worktree。
- Root extra/missing entry。
- Empty/mixed/invalid Repository state。
- Path/workspace name mismatch。
- Local branch/ref/rollback异常。

重点 tests：

```text
tests/workspace/git.test.ts
tests/workspace/state.test.ts
tests/workspace/runtime.test.ts
tests/workspace/read-only.test.ts
tests/workspace/lifecycle.test.ts
tests/agent/repository-preparation.test.ts
```

这些 tests使用真实 local Git命令和 temporary remotes。

## 修改串行原语

`SerialQueue`和`KeyedSerialQueue`只提供：

- 保序执行。
- 前一 operation rejection不阻塞后续项。
- Keyed tail清理。
- `idle()` drain。

业务层决定 key和锁顺序。不要用一个 global queue替换 Agent、scope、lifecycle、inspection和 Repository锁域。

修改后运行：

```bash
node --experimental-strip-types --test \
  tests/domain/serial.test.ts \
  tests/workspace/lifecycle.test.ts \
  tests/workspace/git.test.ts \
  tests/agent/engine.test.ts
```

## 新增或修改 Capability

新增能力通常要更新：

1. `CAPABILITY_KEYS` 和 `CapabilityConfiguration`。
2. `registry.ts` definition：parse、scope、schema、metadata。
3. `broker.ts` keyed handler。
4. 独立 protocol client。
5. Root config limits/runtime。
6. Web显式表单。
7. `configuration-model.ts` serializer。
8. Configuration API round-trip和 registry/client tests。
9. [配置说明](CONFIGURATION.md)。

必须回答：

- Exact target如何冻结？
- Credential在哪里读取、传递和销毁，配置 GET 是否仍保持脱敏？
- 新 credential 字段是否加入共享 `CAPABILITY_CREDENTIALS`，并覆盖 preserve/replace/clear 测试？
- 哪些 action明确允许？
- Redirect、subprocess和 temp file如何处理？
- Timeout、rows/items/bytes预算是什么？
- Abort如何终止活动连接或进程？
- 超限是完整失败还是可证明完整的 pagination？
- Result是否可能包含敏感数据并进入 Pi JSONL？

Registry不替代 client校验。Tool description不是安全边界。应用只读解析也不替代外部系统最小权限账号。

协议 client当前按职责拆分：

```text
nacos.ts
redis.ts + redis-worker.ts
rabbitmq.ts
elasticsearch.ts
mysql.ts + sql.ts
dms.ts + aliyun.ts
sls.ts + aliyun.ts
http-client.ts
local-exec.ts
```

协议模块必须直接导入 owning client；不保留聚合兼容 barrel。Playwright不属于Agent capability；`infra/playwright.sh run`只运行operator提供的Issue Pilot应用自测脚本，不经过registry、policy、Pi tools或broker。

## Web 开发

Web使用 SolidJS和 `@idoly/ant-design-solid`。

规则：

- Shared enum从 `src/domain/contracts.ts`导入。
- API DTO/request集中在 `src/web/src/data/client.ts`。
- `App.tsx`负责顶层资源、当前用户和页面选择；用户CRUD只属于`UserManagement.tsx`。
- 页面组件负责具体 interaction，不复制 transport或 serializer。
- Capability页面保留每种能力的显式 UI，不构建万能 schema form。
- `configuration-model.ts`只序列化 selected capability 和 credential update 意图；已存 secret 不能进入 draft 或请求 payload。
- `ApplicationResources` 的 catalog/config refresh 使用 latest-wins generation；必须测试旧 success、旧 failure、首次失败和原地 retry。
- Markdown使用 `marked + DOMPurify + github-markdown-css`和 bounded LRU cache。
- Desktop/mobile都验证长文本、dialog、Repository list和 Agent composer。
- 不提供绕过后端检查的 force delete/ignore error按钮。

新增流程至少覆盖 loading、empty、success、failure、retry和 stale async response。

## 测试命令

### 单个后端测试

```bash
node --experimental-strip-types --test tests/workspace/git.test.ts
```

### 多个后端测试

```bash
node --experimental-strip-types --test \
  tests/domain/serial.test.ts \
  tests/workspace/lifecycle.test.ts
```

### 单个 Web 测试

```bash
npx vitest run \
  --config src/web/vite.config.ts \
  --environment jsdom \
  src/web/src/app/AgentPanel.test.ts
```

### 完整验证

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

按风险选择范围：

| 改动 | 至少覆盖 |
| --- | --- |
| 纯 Web展示 | 对应 Vitest、Web typecheck、build |
| Shared contract | Domain、DB、HTTP和 Web |
| User管理 | Bootstrap、active migration、API事务、当前用户刷新和管理页面 |
| API transaction | 独立 fixture、success、conflict、rollback |
| Attachment | Multipart limits、quarantine、rollback/finalize、GET integrity |
| Agent/session | Queue、reservation、success、failure、steer、abort、shutdown |
| SSE/Web stream | Replay、snapshot、live、backpressure、stale generation、reconnect |
| Capability | Save parse、scope escape、schema、client、timeout、oversize、abort |
| Git/project/lifecycle | Real Git、dirty、missing ref、batch rollback、cold start、reopen |
| Source browser | Multi-root alias授权、path traversal、symlink escape、binary/size、rg JSON、HEAD ancestry、commit/diff API预算、只读文件系统mutation失败、Explorer/Editor Groups/Tabs、Search逐文件progress、SCM Changes/Graph/提交文件、Markdown Preview按钮/Web Worker、Bottom Panel与Secondary Side Bar矩形对齐、窄屏详情抽屉、无Terminal/本地扩展host和水平溢出 |
| Project tools | Socket mode/protocol、DB path授权、容器argv/mount/limits、same-Issue串行 |
| Startup/state | Fresh DB、migration、interrupted state、unmanaged/changed checkout |
| Infra/dependency | Application multi-stage build/同源静态smoke、绝对路径label、Healthcheck、Shell status、build、audit和runtime status |

## Debugging

### API/SQLite

优先查看 stable error code、Issue key、Deployment ID、Repository hash和 commit。不要打印 config body、Authorization、password、AccessKey或完整敏感 capability result。

SQLite只读检查使用 `src/config.ts`解析的实际 database path。直接写 SQLite会绕过 reservation、file transaction和 trigger guard，只能用于停机、备份后的 operator-controlled recovery。

### Git/runtime

分三层检查：

1. Bare repository的 remote-tracking和 local working branch ref。
2. Worktree/checkout的 HEAD、common dir和 `git status --porcelain`。
3. Runtime symlink、Source API realpath containment和project wrapper socket。

只看 Explorer文件不足以证明 Git state正确。

### Agent/SSE

先检查 Pi JSONL active branch，再检查 server replay/live boundary，再检查 AgentStreamController generation和 conversation projection。不要先创建冗余数据库消息记录。

## Code conventions

- TypeScript ESM使用显式 `.ts` import；Web按现有 bundler style保持一致。
- 保持 strict、`noUncheckedIndexedAccess`和 `exactOptionalPropertyTypes`通过。
- 在边界解析 `unknown`，内部使用明确类型。
- 只为稳定事务、安全、进程、协议或复用边界创建新文件。
- 错误码使用稳定小写标识，不用自然语言做程序分支。
- Generated directory原子替换；durable state不使用“先删再建”。
- 复杂失败路径明确 prepare/commit/rollback/finalize。
- 不添加旧路径、旧状态或旧 key的自动 compatibility。
- 不按文件长度机械拆分，也不引入通用 repository/service万能层。

## Review checklist

- 改动是否放在拥有该事实的模块？
- 是否保留唯一事实源，没有新建重复 enum/default/schema/branch join？
- Prod/test是否仍只读，dev是否按 Issue隔离？
- Read-only policy path是否仍位于 Issue runtime？
- Existing dev base branch、working branch和 workspace name是否保持历史？
- Dirty、untracked、running、invalid和 unmanaged state是否仍阻止删除？
- Attachment、Pi JSONL、本地 Issue branch和 migration history是否保留？
- File/database跨介质更新是否有 rollback/finalize test？
- 锁顺序是否保持，没有 global mutex或反向 acquisition？
- 已存 Credential 是否未进入配置 GET、未轮换的 PATCH、policy、prompt、tool input、日志或不必要 argv？
- Capability result的敏感留存是否明确？
- DTO、Web interaction和 removed route是否一致？
- Service 配置读取是否来自同一 SQLite snapshot，写入是否拒绝缺失或陈旧 revision？
- Startup、shutdown、retry、abort和 repeated call是否有确定行为？
- 文档是否更新到唯一 owning文档？
- Typecheck、tests、build、audit和 diff check是否按风险通过？

## 文档职责

| 文档 | 负责事实 |
| --- | --- |
| `README.md` | 产品入口、快速开始和文档导航 |
| `ARCHITECTURE.md` | 状态、所有权、生命周期、并发和安全不变量 |
| `CONFIGURATION.md` | 可配置字段、capability contract和 credential数据流 |
| `DEPLOYMENT.md` | 宿主依赖、进程、容器、代理和首次验收 |
| `KUBERNETES.md` | StatefulSet、PVC、Job runner、RBAC和迁移门槛 |
| `DEVELOPMENT.md` | 模块边界、改动方法、测试和 review |
| `RUNBOOK.md` | 日常检查、容量、备份、升级、恢复和故障 |
| `AGENTS.md` | Coding Agent执行规则 |

同一详细事实只在一个主文档完整说明，其他文档保留完成当前任务所需的摘要和链接。
