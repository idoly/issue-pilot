# 运维手册

本文面向运行中的Issue Pilot，说明健康检查、state核对、Workspace容量、备份、升级、恢复和故障处理。首次安装见[部署说明](DEPLOYMENT.md)，状态原理见[架构说明](ARCHITECTURE.md)。

## State分类

| Data | Durable | 处理 |
| --- | --- | --- |
| `issues.db`、WAL、SHM | 是 | 停API后一致backup/restore |
| `issues/<key>/attachments` | 是 | 只随Issue edit transaction删除 |
| `issues/<key>/agent` | 是 | 保留Pi JSONL和sidecar |
| `git/repositories` | 是 | 保留objects、local branch和worktree metadata |
| `workspaces/<key>` | 有条件 | 只通过受管release回收 |
| `issues/<key>/runtime` | 否 | Startup/prepare重建 |
| `git/checkouts` | 否 | 验证后受管重建 |
| `control/project-tools.sock` | 否 | API lifecycle管理 |
| `backups` | 是 | Operator管理 |
| Legacy `code-server` data | 历史证据 | 当前代码不读；按backup/retention人工处理 |

不要对state root、unknown Issue/workspace、bare store或legacy editor data执行`rm -rf`。

## 日常检查

### Service

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
kubectl -n issue-pilot get deployment,pod,service
scripts/playwright.sh status
stat -c '%F %a %U:%G %n' /var/lib/issue-pilot/control/project-tools.sock
ss -ltnp | rg ':3000'
```

预期：

- Health为`{"ok":true}`。
- Application running/healthy，restart count符合预期。
- Web、`vscode.html`和API同源可达。
- Project socket是owner `0600`。
- Workspace stats完成deep inspection。
- 没有持久application-test container。

ClusterIP Service只能通过可信TLS/auth Ingress访问，不要把Pod或node端口直接暴露到不可信网络。

不要把`/api/config`或Service write body放入monitoring log。

### Logs

关注：

- Startup blocked runtime。
- `unmanaged_issue_state`、`shared_checkout_changed`。
- Agent cleanup/session stop failure。
- Workspace release/restore rollback failure。
- Attachment rollback/finalize failure。
- Capability timeout、invalid response、result too large。
- SSE backpressure/transport failure。

允许记录stable error、Issue key、Deployment ID、Repository hash、commit、bounded count/duration。禁止记录config body、password、AccessKey、Authorization、Cookie、temporary profile、package auth、Source body、Pi JSONL或完整敏感result。

## Database检查

API停止后，或使用可信只读connection：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

预期`ok`和0 rows。业务不变量：

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

-- At least one active user
SELECT count(*) AS active_users FROM subjects WHERE active = 1;
```

前三项0 rows，active users大于0。Migration trigger阻止新异常，但partial restore后仍要检查。

## Issue、Git和runtime

普通`GET /api/issues/:key`是shallow read，不做`du`或Git clean。容量/releasability使用`/api/workspaces/stats`。

| Scenario | DB state | Physical expectation |
| --- | --- | --- |
| Prod/test | `read_only` | 无dev workspace；runtime到detached checkout |
| Active dev | `development_workspace` | `local_path`在Issue root；basename等于workspace name；HEAD等于local branch |
| Released dev | `development_snapshot` | `local_path=NULL`；working branch保留；runtime HEAD等于local branch tip |

只读Git检查：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <path> status --porcelain
GIT_OPTIONAL_LOCKS=0 git -C <path> log -1 --oneline
```

Immutable checkout branch为空正常，HEAD必须等于目录commit。Active dev branch必须等于DB working branch。

`sourceAvailable`应与`runtimeReady`和runtime目录一致。Source repositories返回的每个alias都必须是受管symlink：active dev target等于DB local path；read-only target位于`git/checkouts/<hash>/<commit>`。

Released dev的历史Repository集合可与current Service不同。不要按数量补row、改base branch或重命名workspace。

## Attachment检查

核对每个DB Attachment：

- 位于对应Issue attachment root直属路径。
- Regular file，mode`0400`或至少group/world为0。
- Size与DB一致且不超过20MiB。
- SHA-256一致。
- Runtime没有copy/link。
- 没有未调查的`.deleting`quarantine。

Attachment GET会执行核心检查。独立POST/DELETE应404。

## 启动和关闭

### Stop

```bash
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

等待Pod完全退出。Graceful顺序：

1. 停maintenance并drain lifecycle/inspection。
2. Agent拒绝new activity并drain run/reservation。
3. Stop all Pi sessions。
4. Close model runtime。
5. Close project broker并等待active process。
6. Close SQLite。

多个failure会聚合，但后续cleanup继续尝试。确认socket移除后才能复制DB、移动project或切换release。

### Start

```bash
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=10m
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
```

Startup执行migration、structure/recovery、unmanaged/generated checks、socket、runtime hydration和maintenance。失败时保留现场，不先删除path/ref/row。

### Pod replacement

修改manifest中的image tag/digest后执行：

```bash
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

Deployment使用`Recreate`，旧Pod完全停止后才创建新Pod。hostPath state不随Pod删除。

## Unmanaged/changed generated state

### `unmanaged_issue_state`

DB没有Issue，但`issues/<key>`或`workspaces/<key>`存在。

1. 保持API停止。
2. 备份DB、unknown directory和bare store。
3. 检查Attachment、Pi JSONL、Git status和local branch。
4. 若DB应包含Issue，恢复matching DB/state。
5. 若目录确属外部遗留，人工归档到state root外，不直接删除。
6. 再启动并完整验收。

Startup在清理runtime/checkouts前拒绝unmanaged state。

### `shared_checkout_changed`

Immutable checkout的hash/commit层级、common dir、HEAD或clean status不匹配。

1. 停API并保留checkout/bare/log。
2. 用只读Git检查common dir、HEAD、modified/untracked/ignored。
3. 判断异常内容是否是证据。
4. Bare store/local branches不可删除。
5. 调查后由Operator归档或修复generated checkout metadata。

系统不会强删changed checkout。

## Workspace容量

当前：retention 7天、high-water 20GiB、target 16GiB、interval 15分钟、concurrency 4。值来自根配置，修改后重启。Interval 0只禁timer，startup仍maintenance一次。

```bash
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
```

Stats执行`du -sk`、layout和Git clean检查，可能较慢。Per-Issue inspection串行，不同Issue并行；stats/release/reopen/maintenance受lifecycle global queue协调。

自动release只选择resolved dev，并要求：

- 无Agent activity/reservation。
- Workspace非preparing/running。
- Repository组为`development_workspace`。
- Root只有登记Repository目录。
- Workspace name/local path/root一致。
- 全部worktree clean。

Retention先释放过期项；若仍超过high-water，按最近活动从旧到新释放到target。中途remove失败会从local branch原commit恢复。

Manual release：

```bash
curl -fsS -X DELETE \
  http://127.0.0.1:3000/api/issues/ISSUE-YYYYMMDD-NNN/workspace
```

无force。Prod/test、non-resolved、dirty、busy或invalid返回conflict。

Reopen从local working branches准备全部worktree/runtime后transaction更新。`workspace_restore_cleanup_failed`表示cleanup不完整，应停止重试并保留evidence。

### 常见错误

| Error | Action |
| --- | --- |
| `issue_not_resolved` | 完成业务状态，不force |
| `issue_already_running` / `workspace_busy` | 等待或正常停止Agent |
| `workspace_has_changes` | 检查并提交/人工归档，不删除 |
| `workspace_has_untracked_files` | 核对root unknown entry所有权 |
| `workspace_repository_missing` | 备份remaining state/ref，调查partial deletion |
| `development_repository_state_invalid` | 保留DB/path，不猜测mixed state |
| `workspace_path_does_not_match_repository` | 不移动目录；恢复matching version或人工修复 |
| `repository_workspace_name_conflict` | 核对URL集合和历史stable name |
| `workspace_release_rollback_failed` | 停maintenance，备份DB/workspace/bare |
| `workspace_restore_cleanup_failed` | 停止retry，保留全部evidence |
| `issue_deployment_required` | 恢复/补齐合法Deployment，不绕trigger |
| `issue_workspace_missing` | 调查partial DB restore，不自动补row |

## Agent和SSE

Agent失败预期：session abort/dispose；未resolved Issue回`open`；Workspace`failed`并记录`last_error`；JSONL/worktree/bare/Attachment保留。

排查：

1. `last_error`和structured log。
2. Pi model/auth readiness。
3. Deployment完整性。
4. Repository remote branch/state/path/Git status。
5. Runtime/socket/Source path。
6. Capability target/config。
7. Timeout/result budget。

SSE正常顺序：

```text
JSONL replay -> snapshot_ready -> live -> heartbeat
```

重复/闪烁/丢消息时检查active JSONL、proxy buffering/read timeout、server backpressure、Web generation和compaction reconnect。旧`ready`不是当前握手。慢client只关闭自身。

## Attachment故障

| Error | Action |
| --- | --- |
| `attachment_limit_exceeded` | 缩小request，不改为unbounded |
| `insecure_issue_attachment_file` | 停读，核对DB/path/type/mode/size |
| `attachment_integrity_check_failed` | 保留file/DB，调查修改来源 |
| `attachment_rollback_failed` | 停止edit，备份attachment root/DB |
| `attachment_finalize_failed` | DB已commit，保留quarantine供Operator处理 |
| `issue_state_rollback_failed` | 核对DB无Issue，保留unknown root |
| `issue_update_rollback_failed` | 保留DB/new/quarantine evidence |

不要在线手工rename/delete`.deleting`。

## Source和project tools

| Problem | Check |
| --- | --- |
| No code button | `runtimeReady`、last error、Repository state/runtime |
| `source_runtime_invalid` | Alias symlink和target是否匹配DB/checkout root |
| Path escape | Symlink containment，保留现场 |
| Binary/too large | 使用其他受控工具，不放宽无限 |
| Search mismatch | Literal query、case/word headers、progress、rg budget |
| SCM empty | `/diff`、HEAD/index/worktree、runtime target |
| Dev file/Git mutation fails | Environment access、Issue reservation、relative path、Source stable error和Git status |
| Graph/file fail | `/history`、`/commit`、`/commit-file`、`/blame`、HEAD ancestry |
| Preview fail | Markdown worker、render API、DOMPurify、fixed styles |
| Workbench fail | `vscode.html`、workers、theme/static resources、browser console |
| Broker unavailable | API、socket mode/owner、wrapper version |
| Node/Maven fail | Image tool versions、project manifest、config/cache mode、timeout |

```bash
kubectl -n issue-pilot get pod
stat -c '%F %a %U:%G %n' /var/lib/issue-pilot/control/project-tools.sock
podman ps -a --filter label=io.issue-pilot.component=application-test
```

Project failure output保留在worktree。不要让wrapper接受executable、config path、cache path或absolute host path。

## DMS/SLS故障

检查：

- Application image和Aliyun CLI可用。
- Deployment AccessKey有效且最小权限。
- DMS使用`dms-enterprise ExecuteScript`、正确DbId/Logic/Tid、安全托管和query permission。
- DMS endpoint固定central；database region不是field。
- SLS region/project/logstore exact匹配。
- Query符合read-only/limit/time-range。
- Temporary profile在调用后删除。

不要依赖Operator持久`~/.aliyun`，不要打印AccessKey。SQL/SLS query会短暂出现在application process argv。

## 一致备份

### Database

1. Stop API并等待container完全退出。
2. 从根配置确认state/database path。
3. 创建`0700`backup directory。
4. 复制同一时点的DB、WAL、SHM文件组。
5. 文件设`0600`。
6. 在隔离copy运行integrity/FK/business checks。

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

即使API停止后WAL通常checkpoint，也按现存文件组复制。

### Full state

High-risk upgrade/recovery还要保存matching：

- `issues/` Attachment和Pi JSONL。
- `git/repositories/` objects/local branches/worktree metadata。
- Active dev `workspaces/`。
- Root config和reviewed code commit。

Runtime/checkouts可重建，但保留有助调查。Backup包含secret/production data，不上传普通artifact store。

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
podman build --pull=always -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
: "create consistent DB and required full-state backup"
: "dry-run migrations on isolated copy and verify integrity/FK"
: "update deploy/issue-pilot.yaml image"
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
```

不要在active API上运行migration或复制DB。使用不可变image tag或digest，确保manifest和备份记录能定位同一版本。

升级后验证：

- Service/network和container restart count。
- DB integrity/FK/business invariant/file mode。
- 全部Issue三种Repository state和runtime。
- Attachment mode/size/hash。
- SSE replay/`snapshot_ready`。
- Source multi-root/tree/file/search/history/commit/diff，以及隔离dev workspace中的file/Git mutation。
- Capability catalog order和必要read-only smoke。

Published migration/journal不可修改。

## Restore和rollback

Restore：

1. 保持API停止。
2. 另存current failed state供调查。
3. 恢复matching DB/WAL/SHM。
4. 恢复matching Attachment、JSONL、bare store和active worktree。
5. 保持owner、directory`0700`、file mode。
6. 启动matching code/schema。
7. 遇到unmanaged state时重新判断backup时点，不删newer evidence。
8. 完整验收。

Rollback必须code和database/state成对。旧代码不能假定可读new schema。只恢复DB而不恢复matching filesystem会造成unmanaged state、missing Attachment/JSONL或Git ref mismatch。

## 快速决策

| Symptom | First check | Never do |
| --- | --- | --- |
| Startup fail | Error、DB structure、unmanaged/checkout | 删除unknown/bare store |
| Pod unhealthy | Logs、image、UID/mount/tool version | Privileged、container socket、second API |
| Agent back to open | last error、model、Deployment、Git/runtime | 把credential放prompt |
| Issue detail slow | 是否误做deep inspection | 在GET加入du/Git clean |
| Release blocked | Status/layout/Git clean | `rm -rf workspaces` |
| Released code missing | Local branch ref/bare/runtime | Remote branch fallback |
| Source unavailable | runtimeReady/symlink/stable error | 改DB flag/暴露host path |
| Attachment write 404 | Use Issue multipart edit | 恢复独立write route |
| Capability too large | Narrow query/range/limit | Silent truncation/unbounded limit |
| Config 409 | Running/reserved Issue和references | Direct DB bypass |
| User cannot deactivate | Last active user | Delete historical subject |
