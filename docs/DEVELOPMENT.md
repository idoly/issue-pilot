# 开发指南

本文说明当前代码owner、改动方法、测试和review标准。开始前阅读[架构说明](ARCHITECTURE.md)；配置字段见[配置说明](CONFIGURATION.md)，生产操作见[运维手册](RUNBOOK.md)。

## 开始前

Issue Pilot会操作真实SQLite、Git、Attachment、Pi JSONL和dev worktree。主程序只从`issue-pilot.config.ts`解析当前checkout的`.issue-pilot`，没有environment override。

每次任务先运行：

```bash
git status --short
```

不要回滚无关修改，不要用真实`.issue-pilot`做实验。Tests使用：

- `buildApi({ stateRoot, databaseFile })`
- Manager constructor temporary root
- Temporary local Git remote
- Temporary SQLite
- Fake model catalog/Agent controller/ToolRuntime

手工隔离server必须使用单独project copy和state配置，不能改变active checkout指向的真实state。

## 开发运行

API只从prepared application image启动：

```bash
npm ci
infra/application.sh config
infra/application.sh prepare
npm run server
```

Web迭代：

```bash
npm run dev:web
```

Application API host publish为`0.0.0.0:3000`，Vite为`0.0.0.0:4173`。二者只能在可信网络使用。Workbench由Vite/production的`vscode.html`多入口提供，没有独立IDE service。

## Source map

| Path | Owner |
| --- | --- |
| `issue-pilot.config.ts` | Path、port、default、retention、image、runtime、budget |
| `src/config.ts` | Project/state/web absolute path resolution |
| `src/domain/contracts.ts` | Shared enum、type、predicate |
| `src/db/schema.ts` | Current Drizzle schema |
| `src/db/bootstrap.ts` | Migration、startup structure/recovery、bootstrap user、Environment sync |
| `src/configuration/contracts.ts` | Catalog/config DTO、credential field/update contract |
| `src/configuration/read.ts` | Catalog和redacted config snapshot projection |
| `src/configuration/credentials.ts` | Redaction和`preserve\|replace\|clear` merge |
| `src/http/api.ts` | API assembly、error mapping、startup/close resources |
| `src/http/production.ts` | Production Web+API entry |
| `src/http/*-routes.ts` | User、Config、Issue、Agent、Attachment GET、Source、Workspace、Web |
| `src/http/service-configuration.ts` | Service request prepare/apply |
| `src/http/attachment-store.ts` | Multipart、durable file、quarantine、rollback/finalize、safe GET |
| `src/agent/engine.ts` | Run/steer queue、reservation、state和session coordination |
| `src/agent/context.ts` | Minimal context和local tool allowlist |
| `src/agent/pi-session.ts` | Private JSONL、Pi SDK、resource loader和tool verification |
| `src/agent/events.ts` | Event bus、replay projection/buffer |
| `src/pi/models.ts` | Shared offline Pi model runtime/catalog |
| `src/pi/tools.ts` | TypeBox parse和direct protocol dispatch |
| `src/capabilities/registry.ts` | Config parser、tool schema、metadata |
| `src/capabilities/*.ts` | Protocol clients、SQL、HTTP/process helpers |
| `src/tool-runtime.ts` | Process command allowlist和environment/HOME cleanup |
| `src/serial.ts` | `SerialQueue`/`KeyedSerialQueue` mechanics |
| `src/workspace/deployment.ts` | Deployment Repository completeness/order |
| `src/workspace/state.ts` | Repository classification、managed path/state cleanup |
| `src/workspace/git.ts` | Bare/fetch/checkout/worktree/batch rollback/Repository lock |
| `src/workspace/project.ts` | Agent/cold-start/reopen project preparation |
| `src/workspace/runtime.ts` | Atomic runtime generation |
| `src/workspace/project-wrappers.ts` | Dev wrapper generation |
| `src/workspace/project-tools.ts` | Unix socket、DB reauthorization、Node/Maven execution |
| `src/workspace/source-browser.ts` | Source relative path和bounded read operations |
| `src/workspace/lifecycle.ts` | Inspection、stats、release、reopen、maintenance |
| `src/web/src/data/client.ts` | Web requests和DTO |
| `src/web/src/app/ApplicationResources.tsx` | Catalog/config/user resources和latest-wins refresh |
| `src/web/src/app/agent-stream.ts` | EventSource state machine |
| `src/web/src/app/conversation.ts` | Pure event projection |
| `src/web/src/app/configuration-model.ts` | Selected capability/credential intent serialization |
| `src/web/src/app/CodeBrowser.tsx` | Workbench iframe lifecycle和parent layout bridge |
| `src/web/src/vscode/main.ts` | Workbench services/settings/extension registration |
| `src/web/src/vscode/source-file-system.ts` | Read-only multi-root filesystem |
| `src/web/src/vscode/source-search.ts` | Native Search provider |
| `src/web/src/vscode/source-control.ts` | SCM Changes/Graph/revision Diff |
| `src/web/src/vscode/markdown-preview.ts` | Read-only Markdown editor pane |
| `src/web/vite.config.ts` | Main/Workbench entries和static theme/icon/preview resources |
| `infra` | Image、Compose generation、Operator scripts |
| `deploy/kubernetes/base` | Single-replica Kustomize baseline |
| `drizzle` | Immutable migration history |

## Request flows

```text
Web -> data/client -> route boundary -> reservation/transaction -> owner -> DB/FS/Git
```

```text
Agent route -> AgentEngine -> IssueProjectManager -> AgentSessionContext
            -> PiSessionRuntime -> event bus -> SSE -> AgentStreamController
```

```text
Service save -> Registry config parse -> SQLite
Pi tool -> TypeBox input parse -> protocol client(typed session config)
```

```text
Dev wrapper -> Unix socket -> ProjectToolBroker -> SQLite/path authorization
            -> ProcessToolRuntime -> npm/mvn
```

Route、Web和AgentEngine不能复制owner事实。

## Shared contracts

只定义一次：

- Business enum/predicate：`src/domain/contracts.ts`
- Runtime config/limit：`issue-pilot.config.ts`
- Capability config/input/metadata：`src/capabilities/registry.ts`
- Credential field/update：`src/configuration/contracts.ts`
- Deployment Repository join：`loadDeploymentRepositories()`
- Repository state：`classifyRepositoryState()`

修改shared enum时检查schema/default、route parser、state transition、Web option/label、DB migration和domain/HTTP/Web tests。不要在fixture或component复制string array。

## Database change

`src/db/schema.ts`是current model；`drizzle/*.sql`和`meta/_journal.json`是published upgrade contract。

1. 修改schema。
2. 新增下一个连续migration。
3. Journal末尾追加entry。
4. Fresh temporary DB运行全部migration。
5. 从previous schema copy运行upgrade test。
6. Real data change先停API并创建一致backup，在隔离copy dry-run。
7. 验证`integrity_check`、`foreign_key_check`和business invariant。
8. 更新schema/route tests和owner doc。

Published migration不修改、重排、合并或删除。

## HTTP change

Route职责：

1. 在HTTP边界解析`unknown`。
2. 从`ApiRouteContext`取得owner。
3. 验证current subject和Issue scope。
4. 影响code、scope、Attachment、session或lifecycle时使用reservation。
5. Config snapshot/Service/Issue scope使用scope queue。
6. Multi-table update放在transaction。
7. Cross-media change使用prepare/commit/rollback/finalize。
8. 返回Web实际需要的DTO，不暴露raw row/secret/path。
9. 同步`data/client.ts`和focused tests。

Lock order：

```text
config read: scope -> snapshot transaction
Service/Issue scope: scope -> reservation
release/reopen: lifecycle -> inspection -> reservation
```

Current route tests：

```text
tests/http/api-startup.test.ts
tests/http/configuration-api.test.ts
tests/http/service-configuration.test.ts
tests/http/issue-api.test.ts
tests/http/attachment-api.test.ts
tests/http/runtime-api.test.ts
tests/http/sse.test.ts
tests/http/user-api.test.ts
tests/http/web.test.ts
```

## Attachment change

必须保持：

- Multipart request/file/count/field budget。
- Basename normalization和SHA-256。
- Durable file `0400`。
- Create failure只删除本次文件并`rmdir`本次空root。
- Edit delete先quarantine，transaction failure恢复，commit后finalize。
- Cleanup failure返回stable error并保留evidence。
- GET验证direct path、regular file、mode、size和hash。

Attachment write只属于Issue create/edit。不要新增独立POST/DELETE或sync route。

## Agent/Pi change

AgentEngine拥有run/steer queue、reservation、state transition、in-memory session和background cleanup。IssueProjectManager拥有code prepare。

检查：

- Code先prepare，context后生成。
- Prod/test path只指向Issue runtime。
- Session file在首条visible message前创建/绑定。
- User message只在state commit或Pi accept后写JSONL。
- Resolved Issue不可执行。
- Success/failure/abort/close均dispose。
- Prod/test轮次结束关闭session，下轮刷新Deployment。
- Existing dev保留historical base branch/workspace name。
- Reporter/logger failure不形成unhandled rejection。
- Shutdown拒绝new activity并drain run/reservation。

Pi JSONL是transcript事实源，不新增message table。

重点：

```text
tests/agent/context.test.ts
tests/agent/engine.test.ts
tests/agent/events.test.ts
tests/agent/pi-session.test.ts
tests/agent/repository-preparation.test.ts
tests/pi/models.test.ts
tests/pi/tools.test.ts
```

## SSE/Web stream change

Contract：

```text
replay -> snapshot_ready { agent, footer, running, issueStatus } -> live
```

Server在snapshot前subscribe live bus并buffer。Writer必须ordered、bounded并处理drain/close/error。

`agent-stream.ts`只拥有transport：EventSource、generation、private replay、snapshot commit、reconnect、compaction refresh。`conversation.ts`保持pure projection，`AgentPanel.tsx`只负责UI。测试stale source、snapshot边界、Issue switch、stale refresh、compaction和dispose。

## Git/runtime/lifecycle change

Filesystem/Git不受SQLite自动rollback，所有change必须明确失败阶段。

### Project owner

- `prepare()`：Agent round。
- `hydrateDevelopmentRuntime()`：dev cold start。
- `hydrateReadOnlyRuntime(s)`：read-only single/batch cold start。
- `restoreDevelopmentWorkspace()`：released dev reopen。

不要复制prepare sequence到Agent或Lifecycle。

### Git transaction

- Repository operation按`stateRoot + URL hash`串行。
- `prepareBatch()`跟踪新worktree，finalize failure逆序remove。
- `removeBatch()`先预检全部clean，失败逆序从local ref/commit restore。
- Unknown root、missing repo、mixed state和path mismatch fail closed。

### Runtime和Lifecycle

Runtime使用temporary+previous atomic replace。Writable target位于Issue workspace，read-only target位于checkout root。

普通Issue GET不做`du`或Git clean。Deep inspection只用于stats/release/reopen/maintenance。Different Issue可并行inspection，但lifecycle operation由global queue协调。

Release必须拒绝non-resolved/non-dev、busy、dirty/untracked、extra/missing root entry、invalid Repository state、path/name mismatch和local ref异常。

## Capability change

新增/修改通常涉及：

1. `CAPABILITY_KEYS`和`CapabilityConfiguration`。
2. Registry parser/schema/metadata。
3. `pi/tools.ts` dispatch。
4. 独立protocol client。
5. Root limits/runtime。
6. Explicit Web form和serializer。
7. Save round-trip、tool和client tests。
8. [配置说明](CONFIGURATION.md)。

必须明确exact target、credential生命周期、allowed action、redirect、timeout、abort、row/item/byte budget和sensitive result。超限必须完整失败，除非pagination能证明完整。

Current protocol modules按外部边界拆分：

```text
nacos.ts
mysql.ts + sql.ts
redis.ts + redis-worker.ts
rabbitmq.ts
elasticsearch.ts
dms.ts + aliyun.ts
sls.ts + aliyun.ts
http-client.ts
local-exec.ts
```

Redis Worker隔离node-redis完整RESP materialization和heap；不要合回main event loop。Playwright不是capability。

## Web change

- Shared enum从domain导入。
- Request/DTO集中`data/client.ts`。
- App resource保持latest-wins generation。
- Capability使用explicit forms，不做generic schema form。
- Secret不进入draft；serializer只发update intent。
- Markdown使用`marked + DOMPurify + github-markdown-css`和bounded cache。
- Workbench保持readonly；不启用Terminal、write、Git action或extension gallery。
- 新flow覆盖loading、empty、success、failure、retry和stale response。
- Desktop/mobile验证long text、dialog、list和composer无overlap。

## Test commands

Focused backend：

```bash
node --experimental-strip-types --test tests/workspace/git.test.ts
```

Focused Web：

```bash
npx vitest run --config src/web/vite.config.ts --environment jsdom \
  src/web/src/app/AgentPanel.test.ts
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
| Attachment | Limits、quarantine、rollback/finalize、GET integrity |
| Agent/Pi | Queue、reservation、state、steer、abort、shutdown |
| SSE | Replay/snapshot/live、backpressure、generation、reconnect |
| Capability | Save parse、scope、schema、client、timeout、oversize、abort |
| Git/lifecycle | Real Git、dirty、missing ref、batch rollback、cold start、reopen |
| Source/Workbench | Alias/path/symlink/binary/budget、readonly mutation、Search/SCM/Preview |
| Project tools | Socket protocol/mode、DB/path auth、same-Issue serial、timeout |
| Startup | Fresh/migrated DB、interrupted state、unmanaged/changed checkout |
| Infra | Compose/image labels、Healthcheck、Shell syntax、isolated image smoke |

## Debugging

- API/SQLite：先读stable error、Issue key、Deployment ID、Repository hash和commit。不要打印secret/body/result。
- Git/runtime：依次检查bare refs、worktree HEAD/branch/status、runtime symlink和Source containment。
- Agent/SSE：依次检查Pi active JSONL、server replay/live boundary、Web generation和conversation projection。
- Direct SQLite write会绕过reservation、file transaction和trigger，只能用于停机、备份后的Operator recovery。

## Code conventions

- Backend TypeScript ESM使用explicit `.ts` import；Web遵循现有bundler style。
- 保持strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- External `unknown`在HTTP/Registry/TypeBox/response边界解析一次；内部typed call不重复shape校验。
- 新文件只用于稳定transaction、protocol、process或reusable UI boundary。
- Error使用stable lowercase code。
- Generated state原子替换；durable state不“先删再建”。
- 不添加自动legacy compatibility。
- 不按行数拆owner，不引入万能service/repository layer。

## Review checklist

- Fact是否放在owner且只有一个source？
- Prod/test仍readonly，dev仍Issue-isolated？
- Existing dev history和released local branch是否保留？
- Dirty/unmanaged evidence是否fail closed？
- Cross-media update是否有rollback/finalize test？
- Lock order是否正确？
- Credential是否未进入GET/context/prompt/input/argv/log？
- Capability result retention是否明确？
- DTO/Web/removed route是否一致？
- Startup/shutdown/retry/abort/repeat行为是否确定？
- Owner doc是否更新且未复制详细事实？
- Typecheck/test/build/audit/diff check是否按风险通过？
