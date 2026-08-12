# 运维手册

本文面向已经运行中的 Issue Pilot：如何确认系统健康、管理 workspace 空间、备份升级和处理异常。首次安装见 [部署说明](DEPLOYMENT.md)，状态为什么这样设计见 [架构说明](ARCHITECTURE.md)。

## 先判断数据类型

处理任何磁盘问题前，先确认目录能否重建：

| 数据 | 是否可重建 | 正确处理方式 |
| --- | --- | --- |
| `issues.db` | 否 | 停止 API 后一致备份/恢复 |
| `issues/*/attachments` | 否 | 只通过附件 API 删除 |
| `issues/*/agent` | 否 | 保留 Pi JSONL 和 sidecar |
| `git/repositories` | 否 | 保留 Git objects 和本地 Issue branches |
| `issues/*/runtime` | 是 | 由冷启动重建 |
| `git/checkouts` | 是 | 由冷启动按 commit 重建 |
| `workspaces/*` | 有条件 | 只能通过受管 release 回收 |

不要对整个 state root 或 `workspaces/<key>` 执行 `rm -rf`。

## 日常检查

### 服务

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
infra/playwright.sh status
infra/code-server.sh status
ss -ltnp | rg ':3000|:18080'
```

预期：

- `/health` 返回 `{"ok":true}`。
- API 和 code-server 只监听 loopback。
- Playwright core/image ready，且没有意外持久 tool container。
- code-server image 和 runtime label 与代码一致。

### 数据库

停止写入或在可信只读连接中执行：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

`integrity_check` 应为 `ok`，`foreign_key_check` 应返回 0 行。

### 工单与代码

对 API 返回的全部 Issue 核对代码状态；工单较多时可以脚本化，但不要只验证最新一张：

| 类型 | 数据库状态 | 文件状态 |
| --- | --- | --- |
| 活动 dev | `development_workspace` | Worktree HEAD 等于本地 working branch |
| Released dev | `development_snapshot` | Runtime HEAD 等于本地 working branch tip |
| Prod/test | `read_only` | Runtime HEAD 等于 `origin/<baseBranch>` |

所有 code-server URL 都应包含 `workspace=`，指向对应 Issue runtime 的 multi-root manifest，并返回 HTTP 200。Manifest 中每个 folder link 都应可解析到登记的 Repository。

Git 验收使用只读命令，并设置 `GIT_OPTIONAL_LOCKS=0`，避免健康检查刷新 worktree index。逐个记录 remote、HEAD、当前 branch、`status --porcelain` 和最近 log；released dev 还要比较 `refs/heads/<workingBranch>` 与 runtime HEAD。

对比当前 Service 配置时分开判断：prod/test 应覆盖当前全部 Repository；活动 dev 会在下一轮补入新增 Repository；released dev 可以合法保留首次准备/释放时的历史集合。若数量不同，先比较 `service_repositories.created_at`、Issue/`issue_repositories.created_at`、本地 working branch 和 runtime manifest。不要只按当前 Service 数量批量插入 `issue_repositories` 或改写历史 `base_branch`。

### 持久文件

建议定期检查：

- Attachment 都位于对应 `issues/<key>/attachments`。
- Attachment mode 为 `0400`，group/world 权限为 0。
- Runtime 中没有 attachment 副本。
- 每个已有 Agent session 的 Issue 都有对应 JSONL。
- `issues` 和 `workspaces` 中没有数据库无法识别的 Issue 目录。

## 启动与关闭

API 启动会执行 migration、恢复中断状态、验证 state tree、重建 runtime/checkouts，再执行一次 workspace maintenance。

正常停止：

```bash
systemctl stop issue-pilot-api
```

`SIGINT`/`SIGTERM` 会停止 maintenance、abort/dispose Pi session、关闭 Fastify 和 SQLite。等待进程完全退出后再复制数据库或移动 release directory。

### `unmanaged_issue_state`

该错误表示数据库没有某个 Issue，但 `issues/<key>` 或 `workspaces/<key>` 仍存在。常见原因：

- 恢复了较旧数据库。
- 只复制了 state root 的一部分。
- 数据库和 Issue 目录来自不同时间点。

启动会在删除任何 runtime/checkouts 前失败，不会自动清理这些目录。

处理步骤：

1. 保持 API 停止。
2. 备份当前数据库和错误中列出的目录。
3. 检查附件、Pi JSONL、`git status` 和本地 branch ref。
4. 如果数据库本应包含该 Issue，恢复匹配的数据库。
5. 如果目录确定不属于当前数据库，人工归档到 state root 外部。
6. 再次启动并检查数据库和 Issue 数量。

不要仅为了启动成功而删除未知目录。

## Workspace 容量策略

### 项目配置

Workspace policy 集中在根目录 `issue-pilot.config.ts`：

| 字段 | 当前值 | 说明 |
| --- | ---: | --- |
| `workspace.retentionMs` | `604800000` | Resolved dev workspace 保留 7 天 |
| `workspace.highWaterBytes` | `21474836480` | Workspace 总量 20 GiB 高水位；`0` 关闭配额回收 |
| `workspace.targetBytes` | `17179869184` | 超限后回收到 16 GiB |
| `workspace.maintenanceIntervalMs` | `900000` | 每 15 分钟维护；`0` 关闭定时任务 |

修改配置后重启 API。非零 target 必须小于 high-water；interval 为 0 只关闭定时任务，启动时仍执行一次 maintenance。

### 自动回收条件

只有 resolved dev Issue 会成为候选。实际删除前还必须满足：

- Agent 没有运行。
- Workspace 状态不是 `preparing` 或 `running`。
- Workspace 根目录只包含数据库登记的 Repository。
- 每个 Git worktree 都没有 modified 或 untracked 文件。

Retention 先处理超过保留时间的工单。总量仍高于 high-water 时，再按 workspace 最近活动时间从旧到新释放，直到 target。

Release 成功后，依赖和构建输出随 worktree 删除；本地工作分支、附件、Pi JSONL 和 session binding 保留，并立即生成只读 branch runtime。

### 查看空间

```bash
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
```

响应包含：

- Workspace 总字节数和当前 policy。
- 每个 Issue 的 bytes。
- 是否可释放。
- 拒绝原因。

Web 统计页展示相同数据，但不提供手动释放按钮。

### 手动释放

只用于运维排障：

```bash
curl -fsS -X DELETE \
  http://127.0.0.1:3000/api/issues/ISSUE-20260807-002/workspace
```

该 API 只接受 dev Issue。它与自动回收使用完全相同的预检，不会强制删除 dirty workspace。

### 常见拒绝原因

| 原因 | 含义 | 处理 |
| --- | --- | --- |
| `issue_already_running` | Agent 仍在执行 | 等待完成或正常停止 Agent |
| `workspace_busy` | Workspace 状态 busy | 检查 API 日志和 Issue 状态 |
| `workspace_has_changes` | Git modified/untracked | 检查、提交或人工归档 |
| `workspace_has_untracked_files` | Issue workspace 根目录有未知项 | 核对目录所有权 |
| `workspace_path_does_not_match_repository` | DB path 不符合当前命名 | 保留现场，释放后按当前名称重建 |
| `workspace_not_development` | 对 prod/test 调用了 release | 不需要释放；它们没有 dev workspace |

## Git 与 runtime 排障

### Released dev 无法打开

按顺序检查：

1. `issue_repositories.working_branch` 是否全部非空。
2. Bare repository 是否存在。
3. `refs/heads/<workingBranch>` 是否存在。
4. Branch tip object 是否完整。
5. Runtime manifest 和 Repository links 是否已生成。
6. code-server 是否挂载了同一个 state root。

系统不会从远程同名 Issue 分支恢复。远程分支存在也不能代替缺失的本地 ref。

### Dev 无法重建 worktree

除了本地 working branch，还需要检查该 Issue Repository 保存的 `base_branch` 是否能 fetch。已有 dev Repository 使用这个历史基线恢复，不会因当前 Deployment 改分支而自动改写；新加入工单的 Repository 才读取当前 Deployment `baseBranch`。Base branch 用于确认基线；Issue branch 用于恢复工单代码，两者用途不同。

如果 `local_path` 与当前 Repository 名称不一致，系统不会自动移动目录。先检查 worktree 是否 dirty；clean workspace 可以通过受管 release 后重新创建，dirty workspace 应先人工处理修改。

### Shared checkout changed

`shared_checkout_changed` 表示本应 immutable 的 checkout 出现不同 HEAD 或修改。保留现场确认原因后，停止 API；checkout 本身可重建，但 bare repository 和 Issue data 不可删除。

## code-server 排障

| 现象 | 检查 |
| --- | --- |
| 页面没有 code-server 按钮 | `code_server_ready`、workspace `last_error`、repository state |
| Explorer 有根目录但无法展开 released dev 文件 | 容器内检查 runtime link target；若宿主 checkout 存在而容器挂载为空，重启 code-server 以刷新旧 bind mount |
| Explorer 没有文件 | Runtime links、state root mount、checkout 是否存在 |
| 有文件但 Git 为 0 repositories | URL 是否为 `workspace=`、manifest 是否列出 Repository |
| Git Graph 无历史 | 容器内 `git -C <repo> log`、host Git mounts、worktree metadata |
| 文件显示只读或无法修改 | prod/test 和 released snapshot 应由 workspace setting 与只读 mount 双重保护；dev 工单重新打开后应从本地 working branch 恢复 active worktree |
| Container 启动失败 | 固定 host runtime、Podman image、`container.env` 权限 |

命令：

```bash
infra/code-server.sh status
podman logs --tail 200 code-server
podman exec code-server git --version
```

不要为解决 Git discovery 给每个 Issue 复制 `.git` 或完整 Repository。Multi-root manifest 是当前设计。

## 数据库备份

数据库和 backup 包含真实 Deployment credential。

### 一致备份

1. 停止 API 并等待进程退出。
2. 确定实际数据库路径。
3. 检查同目录的 `-wal` 和 `-shm`。
4. 复制一致的数据库文件组。
5. 保持 backup 目录 `0700`、文件 `0600`。

默认路径示例：

```bash
systemctl stop issue-pilot-api
state_root=.issue-pilot
install -d -m 0700 "$state_root/backups"
cp --preserve=mode "$state_root/issues.db" \
  "$state_root/backups/issues.db.before-$(date +%Y%m%d%H%M%S)"
systemctl start issue-pilot-api
```

如果在 `issue-pilot.config.ts` 修改了 `state.directory` 或 `state.databaseFile`，使用 `src/config.ts` 解析后的实际路径。存在 WAL/SHM 时不能只复制主数据库后假设备份完整。

不要把未加密 backup 上传到普通 artifact store。

### 恢复

1. 停止 API。
2. 另存当前数据库和 state tree 供调查。
3. 恢复一致的 DB/WAL/SHM 组合。
4. 保持 owner 和权限。
5. 启动与 backup schema 兼容的代码。
6. 处理 `unmanaged_issue_state`，不要删除较新 Issue 数据。
7. 检查 integrity、foreign keys、Service、Deployment、Issue 和 session binding。

## 升级与回滚

推荐顺序：

```bash
git fetch --all --prune
git checkout <reviewed-commit>
npm ci
infra/playwright.sh prepare
npm run typecheck
npm test
npm run build
systemctl stop issue-pilot-api
# 在这里创建一致数据库备份
npm run db:migrate
systemctl start issue-pilot-api
infra/code-server.sh ensure
```

升级后执行 [日常检查](#日常检查)，并验证三类 Repository state 和 code-server Git Graph。

回滚必须成对考虑代码和数据库。旧代码不能直接读取已经执行不兼容 migration 的新数据库。可靠回滚是在同一个持久项目目录 checkout 已验证的旧 commit，并恢复与该 commit 匹配的升级前 database backup；项目 `.issue-pilot` 中的附件、Pi JSONL 和 Git store 不能替换为无关副本。

Drizzle migration 是顺序 schema 契约。已经发布的 migration 和 journal 不修改、不重排、不删除。

## Agent 与 capability 故障

Agent 失败后：

- 当前 Pi session 会 abort/dispose。
- Workspace 状态变为 `failed`。
- 未解决 Issue 回到 `open`。
- JSONL、Git cache 和现有 dev worktree 保留。

排查顺序：

1. 查看 Issue `last_error` 和 API structured log。
2. 检查 model catalog 和 credential readiness。
3. 检查 Service/Environment/Deployment 是否匹配。
4. 检查 Repository state、remote base branch 和 Git status。
5. 检查 capability scope 是否在配置更新后变化。
6. 缩小 SQL、query、时间范围或目标集合后重试。

`capability_result_too_large` 不是部分成功。不要提高为无限上限，也不要接受前 N 条作为完整证据。

## 快速故障表

| 现象 | 首先检查 | 不要做 |
| --- | --- | --- |
| API 启动失败 | Startup error、state root、DB integrity | 删除未知 Issue 目录 |
| Agent 回到 open | `last_error`、model、Deployment、Git | 把 credential 放进 prompt |
| Workspace 无法释放 | Git status、Agent、根目录布局 | 直接删除 workspace |
| Released dev 无代码 | 本地 branch ref、历史 Repository 集合、bare repository | 按当前 Service 数量直接回填 |
| code-server 无 Git 历史 | Manifest、`workspace=`、host Git | 复制 `.git` |
| Capability 超限 | 缩小查询 | 静默截断或无限放宽 |
| 配置保存 409 | Running Issue、引用完整性 | 直接改 SQLite 绕过事务 |

## 日志边界

排障日志应使用错误代码、Issue key、Deployment ID、Repository URL hash 和 commit。禁止记录：

- `/api/config` body/response
- Authorization 和 Cookie
- Password、AccessKey
- Playwright credential file
- code-server `container.env`
- 敏感 capability 完整结果
