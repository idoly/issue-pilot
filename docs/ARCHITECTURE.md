# 架构说明

本文定义 Issue Pilot 当前状态模型、事实所有权、Git/runtime 生命周期、Agent执行、并发和安全不变量。配置字段见[配置说明](CONFIGURATION.md)，运行拓扑见[部署说明](DEPLOYMENT.md)，修改方法见[开发指南](DEVELOPMENT.md)，操作恢复见[运维手册](RUNBOOK.md)。

## 术语

| 术语 | 含义 |
| --- | --- |
| Issue | Agent、Pi session、Attachment和代码上下文的隔离单位 |
| Service | 一组带稳定ID、alias和URL的Repository |
| Deployment | Service在一个Environment下的branch、model和capability配置，不是发布进程 |
| Bare store | 按Repository URL共享的Git object/ref store |
| Dev workspace | Active dev Issue的可写worktree集合 |
| Immutable checkout | 按完整commit定址的detached可重建checkout |
| Runtime | `issues/<key>/runtime`中的Repository链接和可选project wrapper |
| AgentSessionContext | model、capability名称、标识和代码写权限的最小session上下文 |
| Capability | Agent可调用的有界外部只读工具；Playwright不属于capability |

## 唯一事实源

| 事实 | 权威来源 |
| --- | --- |
| User、Issue、Service、Deployment、Repository、Workspace、Attachment元数据 | SQLite |
| Path、port、default、retention、runtime和limit | `issue-pilot.config.ts` |
| 业务enum和共享predicate | `src/domain/contracts.ts` |
| Dev最终代码 | Bare store中的本地working branch ref |
| Prod/test代码 | 当前Deployment base branch最新fetched commit |
| Conversation | 每Issue Pi JSONL active branch |
| Attachment内容 | Durable file；DB保存object key、size、SHA-256 |
| Runtime和wrapper | `src/workspace`生成器 |
| Capability save parser、tool schema、metadata | `src/capabilities/registry.ts` |
| Credential字段和update协议 | `src/configuration/contracts.ts` |

Runtime、checkout、页面状态和日志不能反向覆盖这些事实。

## 组件

```text
Browser
  -> TLS/auth proxy
  -> Application container
       Fastify routes + static Solid/Workbench
       SQLite/Drizzle
       AgentEngine -> PiSessionRuntime -> Pi JSONL
       IssueProjectManager -> WorktreeManager -> Git stores
       SourceBrowser -> bounded filesystem/rg/Git reads + dev mutations
       Pi tools -> protocol clients / ProcessToolRuntime
       ProjectToolBroker -> ProcessToolRuntime
```

| Owner | 责任 |
| --- | --- |
| `src/http` | HTTP边界、subject、reservation、transaction、SSE和static Web |
| `src/configuration` | Catalog/config DTO、credential投影/合并、snapshot projection |
| `src/agent` | 每Issue queue、reservation、context、Pi session、event和prompt |
| `src/pi` | Model runtime和Registry-driven tool注册 |
| `src/workspace/project.ts` | Agent/cold-start/reopen项目prepare与runtime hydration |
| `src/workspace/git.ts` | Bare store、fetch、checkout、worktree、batch rollback和Repository锁 |
| `src/workspace/state.ts` | Repository分类、managed path和unmanaged/generated state检查 |
| `src/workspace/runtime.ts` | Runtime原子生成 |
| `src/workspace/source-browser.ts` | Source授权、有界读取和development文件/Git mutation |
| `src/workspace/project-tools.ts` | Unix socket、SQLite重新授权、Node/Maven action |
| `src/workspace/lifecycle.ts` | 深检、stats、release、reopen、maintenance |
| `src/capabilities/registry.ts` | 保存时config parser、Pi input schema和tool metadata |
| 各capability client | 外部target、协议、timeout/abort、response和result budget |
| `src/process.ts` | 共享spawn、abort、timeout和output budget mechanism |
| `src/tool-runtime.ts` | `npm`、`mvn`、限定Aliyun CLI命令的进程allowlist |
| `src/serial.ts` | 通用Promise serial primitive，不拥有业务锁域 |

Route不实现Git或外部协议。AgentEngine不拼Deployment Repository join。内部typed config/input只在边界解析一次。

## 进程和容器

生产是一个application容器：

- Node 26 build stage构建Web并裁剪dev dependencies。
- Maven 3.9/Temurin 8 stage提供Java工具链。
- Node 26 slim runtime包含Fastify、Pi、Node/npm、Maven/JDK、Aliyun CLI、Git 2.53/SSH、ripgrep和curl；固定Git版本保证relative worktree可读。
- Fastify在容器`0.0.0.0:3000`同源提供Web、Workbench和API。
- Kubernetes把宿主`/var/lib/issue-pilot`挂到image内`/opt/issue-pilot/.issue-pilot`；Pod通过node label固定到state所在节点。
- Container没有Docker/Podman client/socket或ServiceAccount token，不为Agent创建工具Pod。

`ProcessToolRuntime`只允许：

```text
npm ...
mvn ...
aliyun dms-enterprise ...
aliyun sls ...
```

它验证command、cwd、environment，继承有限环境变量，限制timeout/output，并在调用者未指定HOME时创建和清理临时HOME。Project broker先从SQLite重新确认Issue、Repository和真实project path。DMS/SLS用调用级临时`0600`profile指定HOME。

项目脚本与API共享container UID和可读挂载，没有调用级rootfs/cgroup隔离。此模型只适用于可信内部Repository，不是恶意代码sandbox。

## Issue和Workspace状态

### Issue

```text
open -> in_progress -> pending -> resolved
 ^          |            |          |
 +-- fail --+            +-- retry  +-- reopen -> open
```

- Create成功后为`open`并入队。
- Agent开始时为`in_progress`，成功后为`pending`。
- 未resolved的失败轮次回到`open`。
- 用户执行`pending -> resolved`或`resolved -> open`。
- Resolved Issue不能retry或接收Agent message。
- `resolved`与`resolved_at != NULL`必须成对成立。

### Workspace

| 状态 | 含义 |
| --- | --- |
| `not_created` | 未准备代码/session |
| `preparing` | 准备Repository、runtime或session |
| `running` | Pi轮次执行中 |
| `ready` | 当前轮次完成 |
| `stopped` | Dev worktree已release，snapshot可读 |
| `failed` | 准备/执行失败，可按规则retry |

每张Issue恰好有一条`issue_workspaces`。`runtime_ready`只表示受管runtime已生成，不替代物理验证。

## Repository三态

`classifyRepositoryState()`按整组`issue_repositories`判断：

| 状态 | `local_path` | `working_branch` | 场景 |
| --- | --- | --- | --- |
| `read_only` | 全NULL | 全NULL | Prod/test |
| `development_workspace` | 全非NULL | 全非NULL | Active dev |
| `development_snapshot` | 全NULL | 全非NULL | Released dev |
| `invalid` | 空、mixed或其他 | 任意 | Fail closed |

Dev `workspace_name`是稳定历史。Active时必须等于`local_path` basename；release只清空`local_path`，不改working branch或stable name。

## Git布局和生命周期

```text
.issue-pilot/git/
  repositories/<url-hash>/
  checkouts/<url-hash>/<40-char-commit>/
.issue-pilot/workspaces/<issue-key>/<workspace-name>/
```

Repository URL使用20字符SHA-256前缀。Bare store保留remote tracking refs、本地Issue branches、objects和worktree metadata。Immutable checkout可跨Issue复用，但使用前必须验证hash/commit层级、common dir、HEAD和clean status；异常返回`shared_checkout_changed`并保留现场。

### Prod/test

每轮：

1. 读取当前Service/Environment Deployment。
2. 验证每个Service Repository恰有一个base branch。
3. Fetch各`origin/<baseBranch>`。
4. 创建/复用commit checkout。
5. 原子写`read_only` Repository rows和current commit。
6. 生成只读runtime。

下一轮重新读取当前Deployment，因此配置和branch更新会生效。Agent只看到Issue runtime link，不看到shared checkout物理root。

### Active dev

- `defect_fix`使用`hotfix-<issue-key>`。
- `feature_development`使用`feature-<issue-key>`。
- 首次Repository从当前Deployment branch创建本地branch和专属worktree。
- Existing Repository保留Issue row中的历史`base_branch`。
- Service新增Repository在下一次prepare加入；待删除worktree必须clean。
- 完整目标集合先prepare，再finalize filesystem和DB；失败按batch rollback恢复。

Prod `smart_analysis`可在`pending/ready/read_only`时通过专用动作转为dev `defect_fix`。转换保留Attachment、Comment和Pi JSONL，准备hotfix worktree/runtime后在一个transaction切换scope和Repository rows；失败恢复只读runtime。

### Released dev

只有resolved、idle、布局完整且clean的dev workspace可release：

1. 深检DB、root和Git状态。
2. 预检全部Repository。
3. 受管remove各worktree。
4. 中途失败时从本地branch原commit恢复已删除worktree。
5. 全成功后清空`local_path`，Workspace变`stopped`。
6. 从本地working branch tip生成immutable checkout和只读runtime。

Reopen从全部本地working branch准备worktree/runtime，再transaction更新Repository、Workspace和Issue。系统不从远程Issue branch fallback。

## Runtime、Source和项目工具

```text
issues/<issue-key>/runtime/
  <workspace-name> -> active worktree or immutable checkout
  bin/              # only writable dev
    node-project
    maven-project
```

Runtime通过临时目录和previous目录原子替换，不包含Attachment。Wrapper使用versioned Unix socket request，仅发送Issue key、workspace name、relative project、action和args。Broker验证：

- Issue是dev且Repository组为`development_workspace`。
- DB `local_path`等于预期Issue workspace path。
- Project realpath位于Repository。
- npmrc/Maven settings为owner-only file，cache不可group/world写。

Node允许npm `install|test|build|typecheck`，拒绝其他package manager、长期server action和`--watch*`；Maven允许`test|verify|package`。同Issue串行，不同Issue可并行。

Source Browser重新读取SQLite关系并验证runtime symlink：

- 只接受Repository alias和relative path。
- 拒绝absolute、`..`、symlink escape、`.git` tree项、binary和超限文件。
- `/search`使用literal `rg --json`。
- History/commit必须位于current HEAD ancestry；blame一次只读取一个合法文件行。
- Diff读取Git index/working tree；development workspace额外允许Stage、Unstage、Discard和Commit，所有写操作经过Issue reservation。
- Development workspace可创建、保存、删除和重命名普通文件/目录；保存既有文件携带读取时SHA-256并原子替换。Prod/test和released snapshot保持只读。

Workbench filesystem根据Repository access声明权限：dev允许文件创建、保存、删除和重命名，prod/test及released snapshot保持Readonly。固定LocalProcess extension提供Explorer/Search/SCM Graph和受限Git action；Web Worker Markdown extension只用于render。Terminal、Node extension host、gallery和任意宿主命令不可用。

## Agent和Pi

一次轮次：

1. Workspace设`preparing`。
2. 读取Issue、Service、Environment和Deployment。
3. 关闭旧in-memory session。
4. `IssueProjectManager`准备代码和runtime。
5. 从实际access和typed Deployment config生成`AgentSessionContext`。
6. 打开Pi JSONL或原子创建`0600`session file。
7. 创建SDK session并核对ID、model、thinking level和tools。
8. 持久化session binding。
9. Transaction设置Issue `in_progress`、Workspace `running`。
10. 记录可见user message并执行prompt。
11. 成功转`pending/ready`；失败abort/dispose并转`open/failed`。

Resource loader禁用extension、skill、prompt template、theme、context file和宿主prompt自动发现。Issue Pilot显式提供system prompt、model和tools。

Pi session在等待模型输出时应用`runtime.agent.modelResponseIdleMs`空闲watchdog；assistant增量会重置计时，tool执行期间暂停，最后一个tool结束后重新开始。超时调用SDK abort并以`model_response_idle_timeout`进入现有`open/failed`可重试恢复，不让Issue永久停在`in_progress/running`。

`AgentSessionContext`只包含：

- `issueKey`、`serviceKey`、`environmentKey`
- provider、model ID、thinking level
- capability names
- `canModifyCode`

它不包含credential、Deployment ID/config、Repository path或commit。Writable context获得`read/bash/edit/write/grep/find/ls`；其他只获得`read/grep/find/ls`。

Capability调用链：

```text
Service save -> Registry parse -> typed Deployment config -> SQLite
Pi tool -> TypeBox input parse -> protocol client(typed session config, typed input)
```

完整Deployment config只存在API session-local tool closure。Protocol client不重复解析内部shape，但必须限制外部target、协议、redirect、timeout、abort、response和result size。SLS按服务端page size读取完整查询，不设置record count上限，但每页检查统一result byte budget。Tool result会进入Pi JSONL。

## Attachment事务

唯一durable文件：

```text
issues/<issue-key>/attachments/<uuid>-<basename>
```

Create：应用multipart budget、计算SHA-256、独占创建空Issue root、以`0400`写文件，再transaction写Issue/Workspace/CC/Attachment；失败只删除本次文件并用`rmdir`回收本次空目录。

Edit：待删除文件先rename到`.deleting` quarantine，新文件写入后transaction更新metadata/CC/Attachment；rollback恢复quarantine并删除新文件，commit后finalize删除quarantine。Cleanup失败返回稳定错误并保留证据。

GET验证直属path、普通文件、权限、size和SHA-256。不存在独立Attachment POST/DELETE。

## SSE

SSE先订阅live bus，再读取JSONL snapshot：

```text
Pi JSONL replay -> current non-durable run replay -> snapshot_ready -> buffered/live events -> heartbeat
```

Event bus只在当前Agent运行期间保留尚未写入JSONL的assistant增量、运行中tool状态、queue和`agent_start`。同一assistant内容块的token delta合并为一个replay event，保留完整文本且减少SSE协议元数据。完成的message/tool立即由JSONL接管，Issue结束或API重启即清空；它不是第二份durable conversation。页面snapshot重放Pi active branch中的完整可见transcript，不能使用仅供模型推理的compaction context替代；内部runtime user prompt仍不投影。Snapshot期间的live event进入连接私有buffer，并按event ID去重。Writer不限制pending bytes，并有序处理backpressure和transport close/error。Heartbeat使用具名SSE event；Web在静默窗口内未收到open、heartbeat、snapshot或message时主动重连，以恢复被代理隐藏的断流。Capability结果完整保留在Pi JSONL并提供给Agent；Web只对过大的tool result做首尾有界展示，避免长会话把浏览器主线程耗尽。

Web controller用generation失效旧EventSource/timer，握手前保存private replay，收到`snapshot_ready`后原子提交；compaction成功后重连读取新active branch。Event transport与conversation projection分离。Assistant流式块按Pi `contentIndex`标识和排序，不能把可能包含tool-call间隔的索引直接作为稀疏数组下标。

## 并发

| Lock domain | 粒度 |
| --- | --- |
| Agent run/steer | Issue ID |
| Issue reservation | Issue set |
| Scope queue | API instance |
| Lifecycle queue | API instance |
| Inspection queue | Issue ID |
| Repository queue | state root + URL hash |

顺序：

```text
config read: scope -> SQLite snapshot
Service/Issue scope write: scope -> reservation
release/reopen: lifecycle -> inspection -> reservation
```

`SerialQueue`/`KeyedSerialQueue`只复用mechanics，不能把不同业务锁域合并为global mutex。

## 启动和关闭

启动：

1. 创建/打开`0600`SQLite，设置WAL/busy timeout并执行migration。
2. 验证Issue Workspace和resolution结构。
3. 首次插入bootstrap user；同步Environment。
4. 收敛中断的Issue/Workspace状态。
5. 拒绝unmanaged Issue/workspace。
6. 验证和受管清理generated checkout/runtime。
7. 启动`0600`project-tool socket。
8. 重建active/released dev runtime。
9. 为已有session的prod/test重建当前read-only runtime。
10. 执行一次maintenance，注册route并启动timer。

关闭：停止maintenance并drain lifecycle/inspection，拒绝新Agent activity并drain reservation，停止Pi sessions，关闭model runtime，关闭project broker并等待活动进程，最后关闭SQLite。每个cleanup都会尝试，多个失败聚合为`api_close_failed`。

Broker启动探测existing socket：活动socket阻止第二API；只有`ECONNREFUSED/ENOENT` stale socket可移除。关闭仅按记录的device/inode删除自己的socket。

## 数据所有权

| 数据 | Durable | 自动处理 |
| --- | --- | --- |
| SQLite/WAL/SHM | 是 | 不自动删除 |
| Attachment | 是 | 只随Issue edit transaction删除 |
| Pi JSONL | 是 | 不随workspace删除 |
| Bare store/local branch | 是 | 不作为cache清理 |
| Active dev worktree | 有条件 | 仅受管release |
| Runtime/socket | 否 | 启动/prepare重建 |
| Immutable checkout | 否 | 验证后受管重建 |
| Backup/legacy editor data | 是/历史证据 | Operator管理 |

DB不存在但`issues/<key>`或`workspaces/<key>`存在时是`unmanaged_issue_state`；启动在清理生成物前失败。

## 安全边界

- API无内置认证；所有入口需外部TLS/auth/authorization。
- ClusterIP Service只允许通过可信TLS/auth Ingress访问。
- Workbench和Source API返回内部代码；development write还会直接修改Issue workspace，均属于敏感接口。
- Config GET包含Repository、model、scope和完整Deployment credential，只允许在受信应用网络内使用且不得记录响应。
- Credential update仍使用`preserve|replace|clear`；配置页可直接回填GET返回的credential，保存时通常发送`replace`。
- Credential不进入context、prompt、tool input、argv或日志。
- DMS/SLS临时profile包含AccessKey；query仍出现在process argv。
- Pi built-in tools和project scripts不是OS sandbox。
- Playwright只属于Operator测试harness，不进入Service、Deployment、Agent或Pi tools。

## 必须保持的不变量

1. Issue key为`ISSUE-YYYYMMDD-NNN...`。
2. 每Issue恰有Workspace row，`resolved/resolved_at`成对。
3. Issue scope有对应Deployment。
4. Prod/test、active dev、released dev分别为三种合法Repository状态。
5. Released dev只从本地working branch恢复。
6. Existing dev `base_branch`和`workspace_name`是历史。
7. Dirty、untracked、running、invalid-layout、changed-checkout和unmanaged state不自动删除。
8. Attachment只有一个`0400`durable副本，写操作只属于Issue create/edit。
9. Runtime和checkout不成为durable事实源。
10. Repository集合变化先prepare filesystem，再commit DB，失败可rollback。
11. Credential只在SQLite、受信Config GET/保存请求和session-local protocol client中出现，不进入Agent context、prompt、tool input、process argv、日志、监控或诊断附件。
12. Pi tool只解析一次input并直接调用protocol client。
13. API、migration、Git、runtime、Source和project broker使用同一state root。
14. Published migration/journal不修改、重排或删除。
15. SQLite User是唯一事实源，且至少保留一名active user。
