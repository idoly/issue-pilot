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
| `src/pi/tools.ts` | Pi `customTools`、TypeBox parse、direct dispatch |
| `src/capabilities/registry.ts` | Config parser、input schema、metadata |
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
- Capability config/input/metadata：`src/capabilities/registry.ts`
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
sls.ts + aliyun.ts
http-client.ts
```

Native MySQL 的 database input 必须从当前 Deployment 的已配置 URL 路径动态生成 enum，并在服务端映射到该目标独立的 URL/username/password。DMS Agent tool 只能调用 `executeScript`；schema input 必须从当前 Deployment 的已配置 schema 动态生成 enum，并在服务端映射为 DatabaseId。`listInstances/getDatabase` 只属于受信配置解析。Redis Worker 的 heap 隔离不能合回主 event loop。Playwright 不是 capability。

## Web 与 Workbench change

- Shared enum 从 domain 导入。
- Request/DTO 集中在 `data/client.ts`。
- Shared resource 保持 abort/generation/latest-wins。
- Homepage Issue state 只由 `OverviewView` 拥有。
- Capability 使用 explicit form，不生成 generic schema form。
- Config secret 只留在配置页 draft，不写 localStorage、日志或诊断。
- Agent composer 粘贴图片使用 multipart，服务端转换为 Pi `ImageContent`；图片随 visible user event 和 Pi JSONL replay 展示，不写 Attachment store 或新增独立 Attachment route。
- Agent 消息发送前按展开后的粘贴文本校验 `limits.agentMessageChars`，超限保留草稿并提示分段发送；API 对 JSON 和 multipart 的超长文字统一返回 `agent_message_too_long`，空内容或非法格式仍返回 `invalid_agent_message`。
- 配置的三个 panel 保持挂载；切换 Tab 不能丢 draft/modal。
- Deployment 折叠标题在展开前后保持“环境名 + 已启用 capability”同一行；展开区只列未启用 capability，不能重复完整 active 列表。
- 主应用与 Workbench Markdown Preview 使用 `marked + DOMPurify + github-markdown-css`；Workbench 启动不得依赖 optional extension-host render command。
- Workbench dev 可创建、保存、删除、重命名文件并执行 Stage/Unstage/Discard/Commit；其他模式只读。
- Workbench/Agent Git commit 使用当前工单用户姓名和邮箱。
- `production_data` 只能通过专用 `output` tool 写每 Issue 成果区；不得因此开放 Repository mutation tool。MySQL 大结果通过只读 transaction 直接 stream 为 CSV/JSONL，失败或 abort 不发布临时文件。
- 成果文件点击文件名打开只读预览，CSV/SQL/JSONL 等以文本展示，JSON 自动排版，Markdown 使用共享的安全渲染器；下载仍返回完整文件。预览按根配置 `web.outputPreviewBytes` 限制为 20 MiB，超限完整失败、不显示截断内容；关闭、切换工单或重试会取消旧请求并忽略过期响应。
- 新 flow 覆盖 loading、empty、success、failure、retry、stale response。
- 服务工单量图表的服务名列保持 64–96 px，柱条占据剩余宽度；计数与滚动条之间保留 16 px 间距，长服务名使用省略展示。
- Desktop/mobile 验证 long text、dialog、list、composer 和横向 overflow。

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
- Config GET 的 credential 是否仅进入受信 UI，且未进入其他响应、context、prompt、input、argv 或日志？
- Capability result retention 与 budget 是否明确？
- DTO、Web 和 removed route 是否一致？
- Startup、shutdown、retry、abort、repeat 行为是否确定？
- Owning document 是否更新且未复制另一文档的详细合同？
- 验证是否与风险匹配？
