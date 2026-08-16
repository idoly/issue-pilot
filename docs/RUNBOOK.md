# 运维手册

本文面向已经运行中的 Issue Pilot，说明日常健康检查、Workspace 容量、启动/关闭、备份、升级、恢复和故障处理。首次安装见 [部署说明](DEPLOYMENT.md)，状态与所有权见 [架构说明](ARCHITECTURE.md)。

## 先区分 Durable 与 Generated

处理磁盘、启动失败或恢复问题前，先确认数据能否重建：

| 数据 | Durable | 正确处理 |
| --- | --- | --- |
| `issues.db`、WAL/SHM | 是 | 停止 API 后一致备份/恢复 |
| `issues/<key>/attachments` | 是 | 只随 Issue edit事务删除 |
| `issues/<key>/agent` | 是 | 保留 Pi JSONL和 sidecar |
| `git/repositories` | 是 | 保留 objects、本地 Issue branch和 worktree metadata |
| `issues/<key>/runtime` | 否 | 启动/prepare原子重建 |
| `git/checkouts` | 否 | 验证后由启动/prepare重建 |
| `workspaces/<key>` | 有条件 | 只能通过受管 release回收 |
| 遗留`code-server/data` | 历史状态 | 当前版本不读取；可能含编辑历史，确认备份/retention后由Operator处理 |
| `backups` | 是 | Operator管理 |

不要对整个 state root、`workspaces/<key>`、bare repository或未知 Issue目录执行 `rm -rf`。

## 日常健康检查

### 服务与网络

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
podman compose version
infra/application.sh config
infra/application.sh status
infra/playwright.sh status
stat -c '%a %n' .issue-pilot/control/project-tools.sock
ss -ltnp | rg ':3000'
```

预期：

- `/health` 返回 `{"ok":true}`。
- Compose发布只监听loopback，主页、Workbench和API同源可达。
- Application image具有匹配当前绝对项目根的label和Healthcheck；容器状态符合部署方式。
- Playwright image ready，且无持久application-test container。
- 项目工具socket存在且mode为`600`。
- Workspace stats能在深检完成后返回。

不要把 `/api/config` 加入普通监控日志；响应虽已脱敏，仍包含内部 Repository、model 和 capability scope。任何 `/api/services/*` 写请求 body 都不得记录，因为 credential replace 会携带新值。

### API 日志

关注：

- Startup runtime blocked warning。
- `unmanaged_issue_state`、`shared_checkout_changed`。
- Agent cleanup aggregate error。
- Workspace release/restore rollback error。
- Attachment rollback/finalize error。
- Capability timeout、invalid response和 result too large。

日志应使用 Issue key、error code、Deployment ID、Repository hash和 commit。禁止记录 config body、password、AccessKey、Authorization、Cookie、临时 credential file或敏感完整 result。

## 数据库检查

在 API 停止后，或使用不会写入的可信连接执行：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

预期：

- `integrity_check` 返回 `ok`。
- `foreign_key_check` 返回 0 行。

还要验证当前业务不变量：

```sql
-- 每张 Issue恰好有一个 Workspace row
SELECT issues.key
FROM issues
LEFT JOIN issue_workspaces ON issue_workspaces.issue_id = issues.id
WHERE issue_workspaces.issue_id IS NULL;

-- Resolved与 resolved_at成对一致
SELECT key, status, resolved_at
FROM issues
WHERE (status = 'resolved') <> (resolved_at IS NOT NULL);

-- Issue Service/Environment存在对应 Deployment
SELECT issues.key
FROM issues
LEFT JOIN service_deployments
  ON service_deployments.service_id = issues.service_id
 AND service_deployments.environment_id = issues.environment_id
WHERE service_deployments.id IS NULL;
```

三项都应返回 0 行。当前 migration trigger会阻止新异常，但恢复旧/部分数据库后仍应显式检查。还要确认至少有一名启用用户：

```sql
SELECT count(*) AS active_users FROM subjects WHERE active = 1;
```

结果必须大于0。用户停用不应删除历史subject行。

## Issue 与代码检查

`GET /api/issues/:key` 是浅详情，不执行 `du` 或 Git clean。需要 Workspace size/releasability时使用 `/api/workspaces/stats`。

对全部 Issue按 Repository state检查：

| 场景 | DB state | 文件/Git预期 |
| --- | --- | --- |
| Prod/test | `read_only` | 无 Issue dev workspace；runtime link到 detached immutable checkout |
| Active dev | `development_workspace` | `local_path`在当前 Issue root，`workspace_name`等于 basename，HEAD等于 local working branch |
| Released dev | `development_snapshot` | `local_path=NULL`，working branch保留，runtime HEAD等于本地 branch tip |

Git健康检查使用：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> status --porcelain
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> log -1 --oneline
```

对 immutable checkout，branch为空是正常的；HEAD必须等于目录 commit。对 active dev，branch和 `issue_repositories.working_branch`必须一致。

`GET /api/issues/:key`的`sourceAvailable`应与Workspace `runtimeReady`和runtime目录存在性一致。`/api/issues/:key/source/repositories`返回的每个alias必须对应runtime中的受管symlink：active dev target等于数据库`local_path`；prod/test/released target位于`git/checkouts/<hash>/<commit>`。

当前Service Repository数量与released dev历史集合不同不一定是损坏。先比较Issue Repository行、创建时间、本地working branch和runtime link；不要按当前数量批量插入历史行或改写base branch。

## Attachment 检查

定期核对：

- 每个数据库 Attachment对象位于对应 `issues/<key>/attachments`。
- Path直属该 attachment root。
- 文件是普通文件。
- Mode为 `0400`，至少 group/world权限为 0。
- 文件 size与数据库一致且不超过 20 MiB。
- SHA-256与数据库一致。
- Runtime中没有 Attachment copy或 link。
- 没有无调查记录的 `.deleting` quarantine文件。

Attachment GET会重复这些核心检查。Attachment只能随 Issue create/edit增删；独立 POST/DELETE attachment route应返回 404。

## 启动与关闭

### 正常关闭

```bash
infra/application.sh stop
```

Compose向application容器发送`SIGTERM`。

关闭流程：

1. 停止 maintenance timer并拒绝新 lifecycle操作。
2. 等待 active lifecycle global queue和 per-Issue inspection queue。
3. Agent拒绝新 activity，等待 run count和 reservation归零。
4. 尝试停止所有 in-memory Pi session。
5. 关闭 SQLite。

即使某个 session stop失败，后续资源仍会尝试关闭。等待容器完全退出后再复制数据库、移动项目或切换release。

### 启动检查

启动会在注册 route前执行：

- Migration和结构预检。
- Interrupted Issue/Workspace状态恢复。
- Environment同步。
- Unmanaged Issue/workspace检查。
- Shared checkout ownership/HEAD/cleanliness检查和受管移除。
- Generated runtime清理与重建。
- 已有 session的 prod/test runtime hydration。
- 一次 Workspace maintenance。

启动失败时不要先删除现场。根据 stable error code处理。

## `unmanaged_issue_state`

含义：SQLite不存在某个 Issue，但 `issues/<key>` 或 `workspaces/<key>`仍存在。

常见原因：

- 恢复了较旧数据库。
- 只复制了 state tree的一部分。
- 数据库、Attachment/JSONL和 Git来自不同时间点。
- Issue create transaction失败后 cleanup也失败。

处理：

1. 保持 API停止。
2. 备份当前数据库、错误目录和 bare repository。
3. 检查 Attachment、Pi JSONL、Git status和 local branch ref。
4. 若数据库本应包含该 Issue，恢复匹配数据库。
5. 若目录确定不属于当前数据库，把它人工归档到 state root外，而不是直接删除。
6. 再次启动并重复完整检查。

启动会在清理 runtime/checkouts前拒绝 unmanaged state。

## `shared_checkout_changed`

含义：本应 disposable且 immutable的 checkout不满足当前模型，例如：

- Hash/commit目录命名异常。
- Checkout不属于同 hash bare store。
- HEAD与目录 commit不同。
- 存在 modified、untracked或 ignored内容。
- Git worktree remove失败。

处理：

1. 停止 API并保留 checkout、bare store和日志。
2. 用只读 Git命令确认 common dir、HEAD和 status。
3. 确认异常内容是否为需要保留的人工证据。
4. Checkout本身可重建，但 bare repository和 local branches不可删除。
5. 只有完成调查后，才由 operator受控归档/修复 checkout metadata。

系统不会 `rm -rf` changed checkout。

## Workspace 容量管理

### 当前 policy

| 字段 | 当前值 |
| --- | ---: |
| Retention | 7天 |
| High-water | 20 GiB |
| Target | 16 GiB |
| Maintenance interval | 15分钟 |

值来自 `issue-pilot.config.ts`。修改后重启 API。Interval为 0只关闭定时 timer，启动时仍运行一次 maintenance。

### 深检与统计

```bash
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
```

响应包含：

- 当前 policy。
- 所有 Workspace的 `du -sk` bytes。
- Issue/Workspace status。
- `releasable`。
- `blockedReason`。

Stats会执行深检，可能比普通 Issue GET慢。每个 Issue深检串行，不同 Issue可并行；stats与 release/reopen/maintenance受 lifecycle global queue协调。

### 自动 release条件

只有 resolved dev Issue成为候选。删除前必须：

- Agent不在运行，也没有 reservation冲突。
- Workspace不是 `preparing/running`。
- Repository state为完整 `development_workspace`。
- Workspace root只含数据库登记的 Repository目录，不多不少。
- `workspace_name`、`local_path`和 Issue root匹配。
- 每个 Git worktree没有 modified/untracked内容。

Retention先释放超过保留时间的 resolved dev。若总量仍高于 high-water，再按 Workspace最近活动时间从旧到新释放直到 target。

Release预检全部 Repository后逐个 remove。中途失败会从本地 working branch的原 commit恢复已删除 worktree。成功后保留 SQLite、Attachment、Pi JSONL、bare store和 local branch，并立即生成只读 snapshot runtime。

### 手工 release

仅用于运维控制：

```bash
curl -fsS -X DELETE \
  http://127.0.0.1:3000/api/issues/ISSUE-20260807-002/workspace
```

它使用与自动 maintenance相同检查，不提供 force选项。Prod/test、未 resolved、dirty或结构异常都会返回 409。

### Reopen

用户把 resolved Issue改回 open时，dev snapshot会：

1. 从每个本地 working branch准备 worktree。
2. 验证精确 layout。
3. 生成writable runtime和wrapper。
4. 事务更新Repository、Workspace和Issue。

失败会清理本次创建的受管 worktree并恢复只读 runtime。`workspace_restore_cleanup_failed` 表示 cleanup不完整，必须停止重复操作并保留现场。

## Workspace 常见拒绝

| Error | 含义 | 操作 |
| --- | --- | --- |
| `issue_not_resolved` | Issue尚未 resolved | 先完成业务状态，不要强制释放 |
| `issue_already_running` | Agent运行或 reservation占用 | 等待完成或正常停止 |
| `workspace_busy` | Workspace为 preparing/running | 查看 API日志和 Agent状态 |
| `workspace_has_changes` | Repository modified/untracked | 检查、提交或人工归档 |
| `workspace_has_untracked_files` | Issue workspace根有额外项 | 核对所有权，保留未知内容 |
| `workspace_repository_missing` | 登记目录缺失或类型不对 | 备份剩余 state和 branch ref，调查部分删除 |
| `development_repository_state_invalid` | 空/mixed/invalid Repository rows | 保留 DB和目录，不自动猜测 |
| `workspace_path_does_not_match_repository` | Stable name、DB path或推导 root不一致 | 不移动目录；恢复匹配版本或 operator修复 |
| `repository_workspace_name_conflict` | Stable workspace name非法或在同一 Issue内冲突 | 保留 Repository rows/worktrees，核对 URL集合和历史名称 |
| `workspace_release_rollback_failed` | Release失败且已删 worktree无法完整恢复 | 停止 maintenance，备份 DB/workspace/bare store |
| `workspace_restore_cleanup_failed` | Reopen失败且本次 worktree/runtime cleanup不完整 | 停止重试，保留所有 evidence |
| `workspace_not_development` | 对 prod/test调用 release | 无需 release |
| `issue_deployment_required` | Issue scope缺少对应 Deployment | 补齐有效配置或恢复匹配数据库，不绕过 trigger |
| `issue_resolution_state_invalid` | Status和 `resolved_at`不一致 | 停止升级/执行，备份后由 operator成对修正 |
| `issue_workspace_missing` | Issue缺少权威 Workspace row | 停止 Agent/lifecycle，调查部分数据库恢复，不自动补默认状态 |

## Agent 故障

Agent失败后的预期收敛：

- 当前 Pi session abort/dispose。
- 未 resolved Issue回到 `open`。
- Workspace变为 `failed`并记录 `last_error`。
- Existing Pi JSONL、worktree、bare store和 Attachment保留。

排查顺序：

1. Issue `last_error` 和 API structured log。
2. Pi model catalog和本地 auth readiness。
3. Issue Service/Environment Deployment是否存在且完整。
4. Repository remote branch、state、path和 Git status。
5. Runtime link、project-tool socket和Source API path验证。
6. Capability frozen scope与当前 Deployment config是否一致。
7. 查询是否超时或超过 result budget。

`capability_result_too_large` 不是部分成功。缩小 SQL、limit、时间范围或 target；不要无限提高预算，也不要把前 N项当成完整证据。

## SSE 与对话故障

正常连接顺序：

```text
JSONL replay
snapshot_ready
live events
heartbeat
```

遇到重复、闪烁或丢消息：

1. 检查该 Issue Pi JSONL active branch。
2. 确认 SSE是否收到 `snapshot_ready`，旧 `ready`不是当前协议。
3. 检查 proxy buffering和 read timeout。
4. 检查 API是否报告 `sse_backpressure_limit_exceeded`或 transport error。
5. 检查浏览器是否在 Issue切换/compaction后创建新 generation并关闭旧 source。
6. 区分 JSONL replay、连接私有 buffer和 live event。

慢客户端只应关闭自己的 SSE，不能影响 Agent。

## Attachment 故障

| Error | 含义 | 操作 |
| --- | --- | --- |
| `attachment_limit_exceeded` | Multipart超过文件/请求/数量/field预算 | 缩小或拆分证据，不提高为无限 |
| `insecure_issue_attachment_file` | Path、类型、mode或 size不匹配 | 停止读取，核对 DB和 durable file |
| `attachment_integrity_check_failed` | SHA-256不匹配 | 保留文件和 DB，调查修改来源 |
| `attachment_rollback_failed` | Edit失败后 quarantine恢复或新文件删除不完整 | 停止重复 edit，备份 attachment root和 DB |
| `attachment_finalize_failed` | DB commit后 `.deleting`文件无法删除 | DB已无记录；保留 quarantine并 operator处理 |
| `issue_state_rollback_failed` | New Issue DB失败后无法清理本次文件/空 root | 核对 DB无 Issue后保留 unknown root |
| `issue_update_rollback_failed` | Atomic edit失败且文件 rollback不完整 | 保留 DB、new files和 `.deleting`证据 |

不要直接把 `.deleting` rename/delete，除非已停止 API、备份并核对对应数据库事务结果。

## 代码浏览器与项目工具排障

| 现象或错误 | 检查 |
| --- | --- |
| 没有浏览代码按钮 | Workspace `runtimeReady`、`last_error`、Repository state和runtime存在性 |
| `source_browser_unavailable` | runtime准备是否成功，不要手工把数据库flag改为true |
| `source_runtime_invalid` | Runtime alias是否symlink、target是否匹配DB `local_path`或受管checkout层级 |
| `source_path_outside_repository` | 文件路径中的symlink是否逃逸Repository；保留现场调查 |
| `source_file_binary` / `source_file_too_large` | 使用原始下载/其他受控工具，不放宽为无限 |
| Search显示无结果但API有匹配 | provider必须通过progress逐个上报`FileMatch`；检查Repository root、literal query、case/word header和浏览器console |
| 搜索失败/超时 | `rg`固定PATH、query范围、5秒和2 MiB预算；regex不受支持 |
| Source Control Changes为空 | `/diff`是否为空、Repository runtime是否仍对应当前HEAD/index/working tree；不要启用本地Git扩展 |
| Source Control Graph无提交或文件无法打开 | 检查`/history`、`/commit`和点击文件后的`/commit-file`是否成功、revision只读provider是否已在Workbench初始化前注册、branch ref和HEAD ancestry；不得回退到宿主Git命令 |
| Agent或工单详情与Workbench错位 | 检查iframe同源、Issue key、Part矩形消息和`ResizeObserver`；桌面应与Bottom Panel/Secondary Side Bar四边完全一致 |
| 提交历史为空/commit 404 | 当前Repository/选中文件、commit是否为当前HEAD ancestor |
| Commit/diff 413 | 变更文件清单、选中文件或Git输出超过预算；缩小到具体文件，不提高为无限 |
| Markdown Preview空白或浅色不可读 | 检查`markdown.api.render`预热、`extensionHostWorkerMain` worker URL、只读Markdown模型、DOMPurify输出和打包的GitHub Dark/highlight样式；Preview应为`issue-pilot.markdownPreview` Editor Pane且不存在`iframe.webview`，不启用本地extension host |
| VS Code Workbench加载失败 | 检查`vscode.html`入口、Workbench/editor/TextMate/language/extension worker、theme静态资源、CSP和浏览器console；页面应显示明确错误而不是空白区域 |
| Wrapper报告broker unavailable | API进程、`control/project-tools.sock` mode/owner和runtime wrapper版本 |
| Node/Maven任务失败 | 先直接检查API所在环境的`node/npm/mvn/java`版本与PATH，再查只读配置挂载、cache权限和broker timeout |

命令：

```bash
infra/application.sh status
stat -c '%F %a %U:%G %n' .issue-pilot/control/project-tools.sock
podman ps -a --filter label=io.issue-pilot.component=application-test
```

不要让wrapper接受可执行文件、配置路径、cache路径或绝对宿主路径。项目命令会以application容器中的API身份执行Repository脚本，只适用于可信代码，失败后应保留worktree输出供检查。Application test容器应在300秒内自动停止；若外层测试异常退出，按`io.issue-pilot.component=application-test`标签调查并清理，不能保留长期浏览器容器。

## DMS/SLS 故障

检查：

- 用`infra/application.sh status`确认application镜像和容器状态。
- Deployment AccessKey仍有效。
- DMS使用 `dms-enterprise ExecuteScript`、安全托管数据库、正确 `DbId/Logic/Tid`和 query permission。
- DMS endpoint固定为 central，数据库 region不是配置字段。
- SLS region/project/logstore与 frozen scope一致。
- 查询符合 read-only/limit/time-range contract。
- Temp profile在调用结束后已删除。

不要运行依赖operator持久Aliyun profile的修复，也不要把AccessKey打印到日志或Issue。DMS SQL/SLS query会短暂出现在API所在环境的进程参数中，这是当前CLI方案的已知边界。

## 一致备份

Database、Attachment、Pi JSONL、bare Git和 backup都可能包含 credential或生产数据。

### Database备份

1. 停止 API并等待进程完全退出。
2. 确认实际 state/database path来自 `issue-pilot.config.ts`。
3. 创建 mode `0700` backup directory。
4. 复制主数据库和同一时刻存在的 `-wal`、`-shm`文件组。
5. 将备份文件限制为 `0600`。
6. 在隔离副本运行 integrity和 foreign-key check。

示例：

```bash
infra/application.sh stop
state_root=.issue-pilot
stamp=$(date +%Y%m%d%H%M%S)
backup="$state_root/backups/$stamp"
install -d -m 0700 "$backup"
cp --preserve=mode "$state_root/issues.db" "$backup/"
for suffix in -wal -shm; do
  [ ! -e "$state_root/issues.db$suffix" ] || cp --preserve=mode "$state_root/issues.db$suffix" "$backup/"
done
chmod 0600 "$backup"/*
```

API已完全停止时通常不会继续写 WAL，但仍按文件组处理，不要只复制主文件后忽略存在的 WAL。

### Full state备份

升级或恢复高风险变更时，还需要匹配时点的：

- `issues/` 中 Attachment和 Pi JSONL。
- `git/repositories/` 中 local branches和 objects。
- Active dev `workspaces/`。
- 根配置和 reviewed code commit。

Generated runtime/checkouts可不作为恢复事实源，但保留它们有助于调查。不要把未加密 backup上传到普通 artifact store。

## 恢复

1. 保持 API停止。
2. 另存当前 database和 state tree供调查。
3. 恢复一致 DB/WAL/SHM组合。
4. 恢复与数据库匹配的 Attachment、JSONL、bare store和必要 worktree。
5. 保持 owner、directory `0700`和 file权限。
6. 启动与该 schema匹配的代码。
7. 如果出现 unmanaged state，不删除较新目录；重新判断备份时点。
8. 运行 DB、Git、Attachment和 runtime完整验收。

只恢复 database而不恢复较旧/较新的 Issue目录很容易触发 unmanaged state或丢失 JSONL/Attachment引用。

## 升级

推荐顺序：

```bash
git fetch --all --prune
git checkout <reviewed-commit>
npm ci
infra/playwright.sh prepare
infra/application.sh config
infra/application.sh prepare
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
infra/application.sh stop
: "创建一致 database和必要 state备份"
: "在备份副本 dry-run migration并检查 integrity/FK"
npm run db:migrate
infra/application.sh remove
infra/application.sh start
infra/application.sh status
```

升级后执行：

- 服务与网络检查。
- Database integrity/foreign keys和业务不变量。
- 全部 Issue Repository state检查。
- Active/released/read-only三类runtime、Source API multi-root/file/search/history/commit/diff检查。
- Attachment mode/size/hash抽检或全检。
- Agent replay和 `snapshot_ready`。
- Capability catalog顺序和必要的只读 smoke query。

Published migration和 journal不修改、不合并、不删除。

## 回滚

Code和 database必须成对回滚。旧代码不能假定能读取已经执行不兼容 migration的新数据库。

可靠回滚：

1. 停止 API。
2. 保留失败升级后的全部 state供调查。
3. Checkout reviewed old commit。
4. 恢复与该 commit匹配的升级前一致 database备份。
5. 保留/恢复匹配时点的 Attachment、Pi JSONL、bare store和 active worktree。
6. 启动并处理 unmanaged state；不要删除较新证据来强行启动。
7. 完整验收。

## 快速故障表

| 现象 | 先检查 | 不要做 |
| --- | --- | --- |
| API启动失败 | Startup code、state root、DB结构、unmanaged/shared checkout | 删除未知目录或 bare store |
| Application container不健康 | `infra/application.sh status/logs`、image root label、内置工具版本、Healthcheck、UID/GID和state mount | 改用`--privileged`、挂Podman socket、改绝对路径或同时启动第二API |
| Agent回到 open | `last_error`、model、Deployment、Git、runtime | 把 credential放进 prompt |
| Issue详情慢 | 是否错误调用 stats/deep inspection | 在 GET详情增加 `du`/Git clean |
| Workspace无法释放 | Issue/Workspace status、root layout、Git status | `rm -rf workspaces/<key>` |
| Released dev无代码 | Local working branch ref、bare store、runtime | 从远程同名 branch兜底 |
| Prod/test路径越界 | Policy path是否位于 Issue runtime | 直接授权 shared checkout物理 root |
| 代码浏览器不可用 | `runtimeReady`、alias symlink、Source API stable error | 改DB flag或暴露绝对路径 |
| 项目命令不可用 | Broker socket、application镜像PATH、内置工具版本、config/cache mode | 让wrapper接受任意命令或绝对宿主路径 |
| Attachment写路由404 | 使用 Issue create/edit multipart | 重新调用历史 POST/DELETE route |
| SSE重连闪烁 | `snapshot_ready`、generation、proxy buffering | 恢复旧 `ready`握手 |
| Capability超限 | 缩小 query/limit/time range | 静默截断或无限放宽 |
| Config保存409 | Running/reserved Issue、引用完整性 | 直接写 SQLite绕过 transaction |
| 用户无法切换 | `/api/users`、subject是否启用、浏览器当前subject | 修改根配置覆盖SQLite用户 |
| 用户无法停用 | 是否为最后一名启用用户 | 删除历史subject或绕过`last_active_user` |

## 日志边界

允许记录：

- Stable error code。
- Issue key。
- Deployment ID。
- Repository URL hash。
- Commit ID。
- Bounded非敏感计数和 duration。

禁止记录：

- `/api/config` request/response body。
- Authorization、Cookie、proxy identity token。
- Password、AccessKey、temporary profile。
- npmrc、Maven settings和package manager认证header。
- 敏感Source/capability完整结果或Pi JSONL内容。
