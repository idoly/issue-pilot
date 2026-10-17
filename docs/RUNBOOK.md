# 运维

所有操作先确认根配置、实际部署目录和运行进程。应用使用一个 state root；不要同时启动第二个 API、把真实状态当实验夹具，或直接删除看起来可重建的异常目录。首次安装见[部署](DEPLOYMENT.md)，状态原理见[架构](ARCHITECTURE.md)。

## 哪些数据必须保留

目录中的工单 key 使用小写；路径由 [state.ts](../src/workspace/state.ts) 生成。

| 路径/内容 | 类别 | 恢复要求 |
| --- | --- | --- |
| issues.db 及存在的 -wal/-shm | 持久 | 同一时点文件组或一致数据库备份 |
| issues/<key>/attachments | 持久 | 内容、DB object key、size/hash 和 mode 匹配 |
| issues/<key>/outputs | 持久 | 正式处理成果，不随 runtime 删除 |
| issues/<key>/work | 工作文件 | 脚本、处理中间文件和检查点，跨轮次保留 |
| issues/<key>/agent | 持久 | Pi JSONL、active branch 与 DB binding 匹配 |
| git/repositories | 持久 | objects、本地 branches、worktree metadata |
| workspaces/<key> | 有条件持久 | 活动开发代码，包括 staged/untracked |
| issues/<key>/runtime、git/checkouts | 生成 | 验证后受管重建，异常内容仍先保留 |
| control/project-tools.sock | 生成 | 由 API 管理 |
| backups、旧数据和未知目录 | Operator 证据 | 人工确认，不能自动清理 |

备份同时包含凭证、内部源码和业务数据，限制访问，不上传普通测试 artifact。

## 健康检查

```bash
curl -fsS http://127.0.0.1:3000/health
kubectl -n issue-pilot get deployment,pod,service
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
scripts/playwright.sh status
```

健康响应为 `{"ok":true}`。核对镜像、单副本、restart count、挂载/UID 和探针。启动会迁移并重建 Git/runtime，进程 active 或 Pod Running 不等于就绪。非 Kubernetes 部署用实际 supervisor 检查，不在另一 checkout 启动 API 探测。

`GET /api/me` 可核对所选活跃身份，`GET /api/workspaces/stats` 做容量与深检，可能耗时。不要把完整 config、源码、JSONL、查询结果或下载内容放进监控/日志。允许记录稳定错误、Issue key、ref/commit、计数和耗时。

## 一致备份与升级

1. 检查 Agent 和预约活动，安排停机窗口；阻止新请求。
2. 停 API 并等待完整退出。Kubernetes 可 scale 至 0，再等待旧 Pod 消失；本机使用实际 supervisor。停止过程中不能复制状态或切换代码。
3. 在 state root **之外**创建 `0700` 备份目录，完整保留 SQLite/WAL/SHM、issues、Git stores、活动 worktrees 及权限。另存根配置、镜像 digest、代码 commit 和部署清单。
4. 在独立项目/状态副本检查 integrity/FK/业务不变量，并用目标版本 dry-run 迁移。Git worktree metadata 含路径信息，文件副本不能直接假定可在另一绝对路径作为完整运行实例；按 owner 验证或在匹配布局的隔离环境恢复。
5. 发布匹配的新代码/镜像。迁移由启动执行；journal 和已发布 SQL 不修改。
6. 等待 /health，再核对数据库、Git、附件、会话和页面。失败保留现场，按下述恢复流程操作。

Kubernetes 停止示例：

```bash
kubectl -n issue-pilot scale deployment/issue-pilot --replicas=0
kubectl -n issue-pilot wait --for=delete pod -l app.kubernetes.io/name=issue-pilot --timeout=35m
```

确认无进程写入后，完整备份示例（路径由 Operator 选择，目标必须在源目录之外）：

```bash
issue_state_root=/var/lib/issue-pilot
issue_backup_root=/srv/issue-pilot-backups/<unique-backup-name>
install -d -m 0700 "$issue_backup_root"
cp -a -- "$issue_state_root/." "$issue_backup_root/"
```

不要对全部文件统一 chmod：附件、JSONL、DB、SSH 和目录有不同 mode。复制完成后检查实际文件和一致性。历史备份目录可能很大，保留/归档策略由 Operator 决定，不能在备份脚本中顺手清理。

发布前的代码检查和镜像构建见[开发](DEVELOPMENT.md)、[部署](DEPLOYMENT.md)。这些说明不授权代理操作线上状态。

## 数据库与文件核对

使用隔离备份或可信只读连接执行，避免在线修复：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;

SELECT i.key FROM issues i
LEFT JOIN issue_workspaces w ON w.issue_id = i.id
WHERE w.issue_id IS NULL;

SELECT key FROM issues
WHERE (status = 'resolved') <> (resolved_at IS NOT NULL);

SELECT i.key FROM issues i
LEFT JOIN service_deployments d
  ON d.service_id = i.service_id AND d.environment_id = i.environment_id
WHERE d.id IS NULL;

SELECT id FROM global_agent_configuration;
SELECT count(*) AS active_users FROM subjects WHERE active = 1;
```

integrity 应为 ok、FK 与前三个异常查询无结果、全局模型仅 id=1、活跃用户至少一名。还有 schema、migration guard 和 owner 的其他不变量；这些查询不构成完整修复工具。

附件必须为直属 regular file，权限私有、期望写入 mode `0400`，size/SHA-256 与 DB 一致，runtime 中没有副本/链接。数据库与 Pi JSONL 为私有文件，project-tool socket 为 `0600`。`.deleting` 文件需调查事务阶段，不能在线手工 rename/delete。

Git 只读核对：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> status --porcelain --untracked-files=all
```

活动开发路径、branch、workspace name 与 DB 匹配；released dev local_path 为空而本地 branch 保留。Immutable checkout 应 detached、HEAD 等于目录 commit、clean，common dir 指向对应 bare store。服务当前配置可以不同于历史开发工单，不能据此重写旧分支。

## Workspace 回收

维护策略来自根配置，只释放 resolved、空闲、非 preparing/running、布局完整且 clean 的开发工单。先按 retention，再在超过高水位时按策略释放至目标。`GET /api/workspaces/stats` 返回占用及拒绝理由。

人工释放使用 `DELETE /api/issues/:key/workspace`，不存在 force。重开使用工单状态流程并从本地 branch 恢复。dirty、untracked、branch/path 不符或运行中都必须先调查，不能删除 workspaces、改 DB flag 或 reset 来绕过。

## 故障处理

| 错误/症状 | 处理 |
| --- | --- |
| unmanaged_issue_state | 保持停止，备份 DB、未知目录和 bare store；恢复匹配 DB/state，或确认归属后人工归档到 root 外 |
| shared_checkout_changed | 保留 checkout/store，核对层级、common dir、HEAD 和改动；不要强制清理 |
| workspace_branch_does_not_match_issue_policy | 备份 DB、refs、staged/untracked，隔离确定归属与恢复方案；不直接 checkout/reset 或改记录 |
| workspace_has_changes / workspace_has_untracked_files | 检查代码和未知条目，完成业务处理或归档后走受管释放 |
| rollback / finalize / cleanup failed | 保留新旧文件与 quarantine、refs、rows，停止重复 mutation，先调查失败阶段 |
| invalid_current_subject / developer_role_required | 核对活跃身份、角色和网关头映射；身份选择不是认证 |
| user_model_api_key_required / user_git_ssh_credentials_required | 工单 owner 为 developer 时检查其个人凭证，不切换共享身份 |
| issue_credential_owner_inactive | 核对 assignee 或 reporter，使用受支持业务操作调整 |
| model_response_idle_timeout | 检查 provider/网络，保留 JSONL 后按工单 retry 续跑 |
| 配置 409 | 检查正在执行/预约工单和引用，空闲后保存，不直接写 DB |
| 代码浏览器不可用 | 核对 runtime、路径/权限、Source API、静态资源和 console |
| 查询不完整或超预算 | 缩小范围/SQL LIMIT，使用受支持成果导出，不静默截断 |
| 原生脚本失败 | 核对当前工单 work 目录、Node/工具/库、退出码和工作文件；按文件处理，不恢复专用格式工具 |

DMS 检查部署或个人生产 URL/Authorization、同源 SSE/message、schema 对应 DatabaseId；只读 smoke 不返回完整敏感结果。SLS 检查 region/project/logstore、当前选定身份和官方 HTTPS SDK，SQL 分析不做 offset 自动分页。失败不自动更换凭证。

SSE 顺序为 JSONL/current-run replay → snapshot_ready → live/heartbeat。缺增量检查代理缓冲、连接超时和 Web generation；进程重启不恢复未持久事件。Agent 失败保留 JSONL、附件、成果、bare store 和开发改动。

Agent 在应用容器内可信执行，没有额外容器清理流程。work 目录不随 runtime 重建删除，outputs 为已发布成果，两者都随 issues 目录备份。代码浏览器的只读模式仍由 Source API 校验；原生 Shell 的权限属于应用用户，不提供工单级 OS 隔离。项目工具故障核对 socket 权限、wrapper、配置/缓存路径和工具版本。

## 恢复与回退

停止应用，另存失败后的完整状态，再恢复**匹配版本**的代码、DB 文件组、附件、成果、JSONL、bare store 和活动 worktree，并保持路径布局与 owner/mode。若故障后已有新对话、成果或代码，将其作为证据单独保留，不能被旧备份无声覆盖。

只回退镜像或只恢复数据库都可能造成 schema、文件、binding 和 Git ref 不匹配。启动遇到 unmanaged/changed state 时先调查备份时点，不靠删除证据让健康检查变绿。恢复后重新执行健康、数据库、Git、文件完整性和只读页面验收。
