# 运维手册

本文面向运行中的 Issue Pilot，说明健康检查、state 核对、Workspace 容量、备份、升级、恢复和故障处理。首次安装见[部署说明](DEPLOYMENT.md)，状态原理见[架构说明](ARCHITECTURE.md)。

## State 分类

| Data | Durable | 处理 |
| --- | --- | --- |
| `issues.db`、WAL、SHM | 是 | 停 API 后一致 backup/restore |
| `issues/<key>/attachments` | 是 | 只随 Issue edit transaction 删除 |
| `issues/<key>/agent` | 是 | 保留 Pi JSONL 与 sidecar |
| `git/repositories` | 是 | 保留 objects、local branches、worktree metadata |
| `workspaces/<key>` | 有条件 | 只通过受管 release 回收 |
| `issues/<key>/runtime` | 否 | Startup/prepare 重建 |
| `git/checkouts` | 否 | 验证后受管重建 |
| `control/project-tools.sock` | 否 | API lifecycle 管理 |
| `backups` | 是 | Operator 管理 |
| Legacy editor data | 历史证据 | 当前代码不读；人工归档/保留 |

不要对 state root、unknown Issue/workspace、bare store 或 legacy evidence 执行递归删除。

## 日常检查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
kubectl -n issue-pilot get deployment,pod,service
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
scripts/playwright.sh status
stat -c '%F %a %U:%G %n' /var/lib/issue-pilot/control/project-tools.sock
ss -ltnp | rg ':3000'
```

预期：

- Health 为 `{"ok":true}`。
- Deployment 1 replica，Pod healthy，restart count 符合预期。
- Web、`vscode.html` 和 API 同源可达。
- Project socket 是 owner-only `0600`。
- Workspace stats 能完成 deep inspection。
- 没有持久 application-test container。

ClusterIP 只能通过可信 TLS/auth Ingress 访问。不要将 `/api/config`、Service write body 或 Source body 放入 monitoring。

### 日志

重点关注：

- Startup blocked runtime。
- `unmanaged_issue_state`、`shared_checkout_changed`。
- Agent cleanup/session stop failure。
- Workspace release/restore rollback failure。
- Attachment rollback/finalize failure。
- Capability timeout、invalid response、result too large。
- SSE transport/backpressure failure。

允许记录 stable error、Issue key、Deployment ID、Repository hash、commit、bounded count/duration。禁止记录 Config response/body、password、AccessKey、Authorization、Cookie、temporary profile、package auth、Source body、Pi JSONL 或完整敏感 result。

## Database 检查

API 停止后，或使用可信只读 connection：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

预期 `ok` 和 0 rows。业务检查：

```sql
-- Missing Workspace
SELECT issues.key
FROM issues
LEFT JOIN issue_workspaces ON issue_workspaces.issue_id = issues.id
WHERE issue_workspaces.issue_id IS NULL;

-- Resolution mismatch
SELECT key, status, resolved_at
FROM issues
WHERE (status = 'resolved') <> (resolved_at IS NOT NULL);

-- Missing Deployment scope
SELECT issues.key
FROM issues
LEFT JOIN service_deployments
  ON service_deployments.service_id = issues.service_id
 AND service_deployments.environment_id = issues.environment_id
WHERE service_deployments.id IS NULL;

-- Global model singleton
SELECT id, provider, model, thinking_level
FROM global_agent_configuration;

-- At least one active user
SELECT count(*) AS active_users
FROM subjects
WHERE active = 1;
```

前三个查询应无异常 rows；global model 应只有 `id=1` 一行；active users 必须大于 0。

## Issue、Git 与 runtime

普通 `GET /api/issues/:key` 是 shallow read，不执行 `du` 或 Git clean。容量和 releasability 使用 `/api/workspaces/stats`。

| Scenario | DB state | Physical expectation |
| --- | --- | --- |
| Prod/test | `read_only` | 无 dev workspace；runtime 指向 detached checkout |
| Active dev | `development_workspace` | `local_path` 位于 Issue workspace；HEAD 等于 local branch |
| Released dev | `development_snapshot` | `local_path=NULL`；working branch 保留；runtime HEAD 等于 local branch tip |

只读 Git 检查：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <path> status --porcelain
GIT_OPTIONAL_LOCKS=0 git -C <path> log -1 --oneline
```

Immutable checkout 的 branch 为空是正常情况，HEAD 必须等于目录 commit。Active dev branch 必须等于 DB working branch。

Source repositories 返回的 alias 必须映射到受管 runtime symlink：active dev target 等于 DB local path；read-only target 位于 `git/checkouts/<hash>/<commit>`。Released dev 的历史 Repository 集合可与 current Service 不同，不要自动补 rows、改 base branch 或 rename workspace。

## Attachment 检查

每个 Attachment 必须：

- 位于对应 Issue attachment root 的直属路径。
- 是 regular file。
- Mode 为 `0400`，或至少 group/world 权限为 0。
- Size、SHA-256 与 DB 一致；Attachment 不设应用层大小上限。
- Runtime 中无 copy/link。
- 没有未调查的 `.deleting` quarantine。

Attachment GET 会执行核心完整性检查。独立 POST/DELETE 应为 404。

## 启动与关闭

### Stop

```bash
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

等待 Pod 完全退出。Graceful 顺序：

1. 停止 maintenance 并 drain lifecycle/inspection。
2. Agent 拒绝新 activity 并 drain run/reservation。
3. Stop all Pi sessions。
4. Close model runtime。
5. Close project broker 并等待 active process。
6. Close SQLite。

确认 Pod 与 socket 消失后，才能复制 database、移动 project 或切换 release。

### Start

```bash
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=10m
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
```

Startup 执行 migration、结构/recovery、unmanaged/generated checks、socket、runtime hydration、global model initialization 和 maintenance。失败时保留 path/ref/row，不先删除现场。

### Pod replacement

```bash
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

Deployment 使用 `Recreate`，旧 Pod 完全停止后才创建新 Pod。hostPath state 不随 Pod 删除。

## Unmanaged 与 changed generated state

### `unmanaged_issue_state`

DB 没有 Issue，但 `issues/<key>` 或 `workspaces/<key>` 存在：

1. 保持 API 停止。
2. 备份 DB、unknown directory 和 bare store。
3. 检查 Attachment、Pi JSONL、Git status 和 local branch。
4. 若 DB 应包含 Issue，恢复 matching DB/state。
5. 若目录确属外部遗留，人工归档到 state root 外。
6. 重新启动并完整验收。

Startup 在清理 runtime/checkouts 前拒绝 unmanaged state。

### `shared_checkout_changed`

Immutable checkout 的 hash/commit 层级、common dir、HEAD 或 clean status 不匹配：

1. 停 API，保留 checkout、bare store 和 log。
2. 只读检查 common dir、HEAD、modified/untracked/ignored。
3. 判断异常内容是否为证据。
4. 不删除 bare store 或 local branch。
5. 调查后由 Operator 归档或修复 generated checkout metadata。

系统不会强制删除 changed checkout。

## Workspace 容量与 release

当前策略由根配置定义：retention 7 天、high-water 20 GiB、target 16 GiB、interval 15 分钟、concurrency 4。

```bash
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
```

Stats 执行 `du -sk`、layout 和 Git clean 检查，可能较慢。Per-Issue inspection 串行，不同 Issue 可并行；stats/release/reopen/maintenance 由 lifecycle global queue 协调。

自动 release 只选择 resolved dev，并要求：

- 无 Agent activity/reservation。
- Workspace 非 preparing/running。
- Repository 组是 `development_workspace`。
- Root 只有登记的 Repository 目录。
- Workspace name、local path、root 一致。
- 所有 worktree clean。

Retention 先释放过期项；如果仍超过 high-water，再按最近活动由旧到新释放到 target。中途 remove 失败会从 local branch 原 commit 恢复。

Manual release：

```bash
curl -fsS -X DELETE \
  http://127.0.0.1:3000/api/issues/ISSUE-YYYYMMDD-NNN/workspace
```

不存在 force。Prod/test、non-resolved、dirty、busy 或 invalid 状态会拒绝。

常见拒绝：

| Error | Action |
| --- | --- |
| `issue_not_resolved` | 完成业务状态，不 force |
| `issue_already_running` / `workspace_busy` | 等待或正常停止 Agent |
| `workspace_has_changes` | 检查、提交或人工归档，不删除 |
| `workspace_has_untracked_files` | 核对 unknown entry 所有权 |
| `workspace_repository_missing` | 备份剩余 state/ref，调查 partial deletion |
| `development_repository_state_invalid` | 保留 DB/path，不猜测 mixed state |
| `workspace_path_does_not_match_repository` | 不移动目录；恢复 matching version |
| `repository_workspace_name_conflict` | 核对 URL 集合与历史 workspace name |
| `workspace_release_rollback_failed` | 停 maintenance，备份 DB/workspace/bare |
| `workspace_restore_cleanup_failed` | 停止 retry，保留 evidence |

## Agent 与 SSE

Agent 失败后的预期状态：session abort/dispose；未 resolved Issue 回 `open`；Workspace 为 `failed` 并保存 `last_error`；JSONL（包括已接受的粘贴图片）、worktree、bare store、Attachment 保留。

排查顺序：

1. Stable `last_error` 和 structured log。
2. 全局 provider/model/thinking level 与 Pi auth/model catalog。
3. Deployment/Repository completeness。
4. Remote branch、Git state、path、runtime。
5. Project broker/socket。
6. Capability target/config。
7. Timeout/result budget。

`model_response_idle_timeout` 表示模型在配置窗口内没有 assistant event；确认 provider/network 后用 Issue retry 续跑。

SSE 正常顺序：

```text
JSONL replay -> current run replay -> snapshot_ready -> live -> heartbeat
```

刷新后缺当前 thinking/text/tool 时检查进程内 current-run replay；完成内容由 JSONL 接管，API 重启不会恢复未 durable 增量。页面停留 Working 时检查具名 heartbeat、proxy buffering/read timeout、Web stale watchdog、event ID 去重和 generation。

## Source、Workbench 与 project tools

| Problem | Check |
| --- | --- |
| 无代码按钮 | `runtimeReady`、last error、Repository state/runtime |
| `source_runtime_invalid` | Alias symlink 与 target 是否匹配 DB/checkout |
| Path escape | Symlink containment，保留现场 |
| Binary/too large | 使用其他受控工具，不改为 unbounded |
| Search mismatch | Literal query、case/word header、rg budget |
| SCM empty | `/diff`、HEAD/index/worktree、runtime target |
| Dev mutation fails | Access、Issue reservation、relative path、Git status |
| Graph/file fail | `/history`、`/commit`、`/commit-file`、`/blame`、HEAD ancestry |
| Preview fail | Markdown model、`marked`、DOMPurify、preview stylesheet |
| Workbench loading/error | `vscode.html`、worker/static resources、显式 ready/error 消息、console |
| Broker unavailable | API、socket mode/owner、wrapper version |
| Node/Maven fail | Image versions、manifest、config/cache mode、timeout |

```bash
stat -c '%F %a %U:%G %n' /var/lib/issue-pilot/control/project-tools.sock
scripts/playwright.sh status
```

Project failure output 留在 worktree。不要允许 wrapper 接受 executable、absolute path、config path 或 cache path。

## DMS MCP 与 SLS

### DMS

检查：

- Deployment URL 是可达的 HTTPS SSE endpoint。
- Authorization 是未过期的 `Bearer <token>`。
- SSE GET 与同源 message POST 都携带 Authorization，redirect 被拒绝。
- 每个 alias/schema 已解析到预期 InstanceId、DatabaseId、host:port。
- SchemaName 和 DatabaseId 在 Deployment 内均唯一。
- `listInstances` 与 `getDatabase` 只在受信配置解析中使用。
- Agent 的 schema input 只能取当前 Deployment 动态 enum，并只调用唯一、schema-compatible 的 `executeScript`。
- 服务端把 schema 映射为 DatabaseId 并注入，SQL 是单条只读 statement。
- 首次 SSE handshake 的 12 秒计时器在连接完成后清除，仅 handshake 超时允许重建连接一次；不能让 handshake deadline 中断已建立的 SSE 或后续 tool 请求。
- 连接/list/call/close 位于 30 秒 operation timeout 内。

旧 AccessKey/dbId/tid 配置不受支持，必须通过当前配置页重新保存。不要记录 Authorization、MCP request header 或完整 result。

### SLS

检查：

- Image 中 Aliyun CLI 可执行。
- Deployment AccessKey 有效且最小权限。
- Region/project/logstore exact 匹配。
- Query/time range 符合合同。
- Temporary HOME/profile 在调用后删除。

SLS AccessKey 不进入 argv；query、project、logstore 与时间可能短暂出现在 application process list。

## Attachment 故障

| Error | Action |
| --- | --- |
| `insecure_issue_attachment_file` | 停止读取，核对 DB/path/type/mode/size |
| `attachment_integrity_check_failed` | 保留 file/DB，调查修改来源 |
| `attachment_rollback_failed` | 停止 edit，备份 attachment root/DB |
| `attachment_finalize_failed` | DB 已 commit，保留 quarantine |
| `issue_state_rollback_failed` | 核对 DB 无 Issue，保留 unknown root |
| `issue_update_rollback_failed` | 保留 DB/new/quarantine evidence |

不要在线手工 rename/delete `.deleting`。

## 一致备份

### Database

1. Stop API，等待 Pod 完全退出。
2. 从根配置确认 state/database path。
3. 创建 `0700` backup directory。
4. 复制同一时点 DB、WAL、SHM 文件组。
5. 文件 mode 设为 `0600`。
6. 在隔离 copy 运行 integrity/FK/business checks。

```bash
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
state_root=/var/lib/issue-pilot
stamp=$(date +%Y%m%d%H%M%S)
backup="$state_root/backups/$stamp"
install -d -m 0700 "$backup"
cp --preserve=mode "$state_root/issues.db" "$backup/"
for suffix in -wal -shm; do
  [ ! -e "$state_root/issues.db$suffix" ] || \
    cp --preserve=mode "$state_root/issues.db$suffix" "$backup/"
done
chmod 0600 "$backup"/*
```

### Full state

高风险升级/恢复还需保存 matching：

- `issues/` 中的 Attachment 和 Pi JSONL。
- `git/repositories/` 的 objects、local branches、worktree metadata。
- Active dev `workspaces/`。
- Root config、manifest、image digest 和 reviewed code commit。

Runtime/checkouts 可重建，但保留副本有助调查。Backup 包含 credential、源码和 production data，不能上传普通 artifact store。

## Upgrade

```bash
git fetch --all --prune
git checkout <reviewed-commit>
npm ci
scripts/playwright.sh prepare
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
podman build --pull=always -f Containerfile \
  -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
: "create consistent DB and full-state backup"
: "dry-run migrations on an isolated copy"
: "update deploy/issue-pilot.yaml image"
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

升级后验证：

- Service/network、Pod restart count、probe。
- DB integrity/FK/business invariant/file mode。
- 全局模型 singleton 与 catalog。
- 全部 Issue Repository state 和 runtime。
- Attachment mode/size/hash。
- SSE replay/`snapshot_ready`/heartbeat。
- Source tree/file/search/history/commit/diff。
- 隔离 dev workspace 的 file/Git mutation 和 project wrapper。
- 必要 capability 的最小只读 smoke。

Published migration/journal 不可修改。

## Restore 与 rollback

1. 保持 API 停止。
2. 另存 current failed state 供调查。
3. 恢复 matching DB/WAL/SHM。
4. 恢复 matching Attachment、JSONL、bare store、active worktree。
5. 保持 owner、directory `0700`、file mode。
6. 启动 matching code/schema。
7. 遇到 unmanaged state 时重新判断 backup 时点，不删除 newer evidence。
8. 完整验收。

Rollback 必须 code 与 database/state 成对。只恢复 DB 而不恢复 matching filesystem 会产生 unmanaged state、missing Attachment/JSONL 或 Git ref mismatch。

## 快速决策

| Symptom | First check | Never do |
| --- | --- | --- |
| Startup fail | Error、DB structure、unmanaged/checkout | 删除 unknown/bare store |
| Pod unhealthy | Logs、image、UID/mount/tool version | Privileged、socket、second API |
| Agent 回到 open | Last error、model、Deployment、Git/runtime | 把 credential 放 prompt |
| Issue detail 慢 | 是否误做 deep inspection | 在 GET 加 `du`/Git clean |
| Release blocked | Status、layout、Git clean | `rm -rf workspaces` |
| Released code missing | Local branch ref、bare/runtime | Remote branch fallback |
| Source unavailable | runtimeReady、symlink、stable error | 改 DB flag、暴露 host path |
| Attachment write 404 | 使用 Issue multipart edit | 恢复独立 write route |
| Capability too large | 缩小 query/range/limit | Silent truncation |
| Config 409 | Running/reserved Issue、references | Direct DB bypass |
| User 无法停用 | 是否最后一个 active user | 删除历史 subject |
