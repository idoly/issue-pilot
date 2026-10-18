# 运维

先确认根配置、部署目录、运行进程和真实 state root。不要同时运行两个 API，或用另一 checkout 指向真实状态做实验。启动和重启会迁移、恢复及重建状态，操作前应理解[架构](ARCHITECTURE.md)与[部署方式](DEPLOYMENT.md)。

## 状态分类

工单目录使用规范化的小写 key，路径由 [state.ts](../src/workspace/state.ts) 生成。

| 内容 | 类别 | 处理要求 |
| --- | --- | --- |
| issues.db，以及存在的 WAL/SHM | 持久 | 保留同一时点文件组或一致数据库备份 |
| issues/<key>/agent | 持久 | Pi JSONL、active branch、DB binding 匹配 |
| issues/<key>/attachments | 持久 | 文件与 DB 路径、size/hash、0400 mode 匹配 |
| issues/<key>/outputs | 持久 | 发布成果，不随 runtime 清理 |
| issues/<key>/work | 持久工作文件 | 脚本、中间结果和检查点跨轮次保留 |
| git/repositories | 持久 | objects、本地 branches、worktree metadata |
| workspaces/<key> | 有条件持久 | 活动开发内容，包括 staged/untracked |
| issues/<key>/runtime、git/checkouts、wrapper、control socket | 生成 | 由 owner 校验、准备和回收，异常内容保留调查 |
| backups、quarantine、未知目录 | Operator 证据 | 查清归属与事务阶段，不自动收编或删除 |

基座 `.pi` 独立于 state，需备份资源及依赖。状态、备份和源码快照可能包含凭证、内部代码和业务数据，应使用私有目录，不上传普通测试 artifact。

## 健康与活动检查

```bash
curl -fsS http://127.0.0.1:3000/health
systemctl --user status issue-pilot-api.service issue-pilot-web.service --no-pager
systemctl --user show issue-pilot-api.service issue-pilot-web.service --property=MainPID,ExecStart,WorkingDirectory --no-pager
scripts/playwright.sh status
```

Kubernetes 部署改查实际 namespace 的 deployment、pod、service、探针和日志，不与本地 supervisor 命令混用。健康应返回 `{"ok":true}`，但 active/Running 不能代替数据库、文件、Git 和页面验收。

通过 Issue 列表检查 `agentRunning`，同时考虑 API 配置、生命周期和预约操作。`GET /api/me` 可核对所选活跃身份；`GET /api/workspaces/stats` 包含深检，可能耗时。诊断只记录计数、耗时、稳定错误、Issue key 或 ref/commit，不输出配置 body、认证头和完整敏感结果。

## 备份、发布与重启

1. 记录当前 commit、未提交源码、根配置、依赖版本和 supervisor/镜像信息，确认目标版本的检查通过。
2. 确认 Agent 和预约操作已完成，进入维护窗口并阻止新请求。本地可先停止 Web 入口，再优雅停止 API；保留足够时间 drain，不在退出前复制状态。
3. 确认 API PID 和子进程已退出，在 state root 之外建立 `0700` 一致备份，保留 DB 文件组、issues、Git stores、worktrees、owner/mode 和未知证据。
4. 在独立项目/数据库副本检查 integrity/FK/不变量，使用目标版本演练迁移；比较已应用 migration hash，不修改历史 SQL/journal。
5. 安装或切换到已验证版本，再启动实际服务。不要把旧 backup/worktree 副本直接当可启动工作区，其 Git metadata 可能仍指向原绝对路径。
6. 等待健康，比较数据库、持久文件、Git、权限、SSE 与页面。失败先保留现场，再按恢复流程处理。

本地停止与启动示例，需在上述流程的对应阶段执行：

```bash
systemctl --user stop --no-block issue-pilot-web.service issue-pilot-api.service
systemctl --user is-active issue-pilot-api.service issue-pilot-web.service
# 等待完全退出、完成备份及独立验证后：
systemctl --user start issue-pilot-api.service
# /health 正常后启动开发 Web 服务：
systemctl --user start issue-pilot-web.service
```

状态复制示例仅在无写入进程时执行，目标必须在源目录之外：

```bash
issue_state_root=/var/lib/issue-pilot
issue_backup_root=/srv/issue-pilot-backups/<unique-backup-name>
install -d -m 0700 "$issue_backup_root"
rsync -a --exclude=/control/project-tools.sock -- "$issue_state_root/" "$issue_backup_root/state/"
```

同时保存匹配的代码、根配置及应用 `.pi`。若使用 link-dest 节省空间，仅允许备份之间共享硬链接，不能把可写 live 文件链接成备份；不能对共享 inode 原地覆盖或统一 chmod。复制后检查完整性、模式和可恢复性。

## 数据库核对

使用可信只读连接或独立备份，避免在线修复：

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
SELECT count(*) AS active_management_developers
FROM subjects WHERE active = 1 AND role = 'developer' AND is_admin = 1;
```

integrity 应为 ok，FK 和前三个异常查询为空，全局基座只有 id=1，活跃用户和可维护管理权限的用户均至少一名。还需核对 schema、迁移记录及对应 owner 的业务约束；这些查询不是自动修复工具。

正常启动可能更新中断恢复标记和生成状态。比较发布前后数据时，区分这些变化与用户、配置、附件、会话和 Git 的持久事实；不要要求所有时间戳绝对不变，也不能因此忽略业务数据变化。

## 文件与 Git 核对

附件必须为 regular file，读取路径直属工单附件目录，size/hash 与 DB 一致，mode 为 0400。DB 和 JSONL 私有，state 目录为 0700，数据库为 0600，project-tool socket 为 0600。work、outputs、agent 和附件文件发布前后逐项检查；`.deleting`、quarantine 和异常临时目录要调查事务阶段。

Git 只读检查示例：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> status --porcelain --untracked-files=all
```

活动开发路径、branch、workspace name 与 DB 的关系不能通过当前服务配置推测。共享 checkout 应 detached、HEAD 匹配 commit、clean，common dir 指向对应 bare store。记录发布前已有的分支偏差和未知目录，发布后确认保留；不通过 checkout、reset、远程 fallback 或改 DB 元数据掩盖偏差。

## Workspace 回收与历史清理

维护策略来自根配置，仅释放 resolved、空闲、非 preparing/running、布局完整且 clean 的开发工单。手动释放使用 `DELETE /api/issues/:key/workspace`，没有 force；重开经状态流程，从本地分支恢复。dirty、untracked 或路径/分支不符时保留并调查。

默认保留最近两份已验证的完整状态恢复点：最新一份和上一份。新快照、匹配代码及重启验收全部成功后，再轮换删除更旧的完整状态快照；失败现场调查完成前不纳入普通轮换。创建前检查现有恢复点，同一已验证状态不重复建立大快照。小型提交、清理和验证记录可单独保留，不把它们误算成完整状态备份。

历史备份按内容、完整性、权限和恢复用途判断。保留范围内，含不同工作文件或 Git 索引的快照需要明确其恢复用途；超出保留上限的旧恢复点按已授权轮换策略删除。空的失败备份可删除；代码/数据库小检查点与完整状态快照要明确区分。

删除临时测试、参考构建和依赖副本前，检查进程 cwd/argv/fd、持久数据引用、符号链接及 Git 归属。保留有效验证结果和删除清单，确认清理不会沿链接进入 live 状态。已发布迁移、运行目录、未知证据及当前资源不能因“没有代码引用”而删除。保留策略由 Operator 决定，备份脚本不顺手清理其他快照。

## 常见故障

| 症状或稳定错误 | 处理 |
| --- | --- |
| unmanaged_issue_state | 保留未知目录、DB 和 Git，调查对应关系，不能自动收编 |
| shared_checkout_changed | 保留 checkout/store，检查 HEAD、common dir 和改动 |
| workspace_branch_does_not_match_issue_policy | 备份 refs、staged/untracked 和 DB，确认历史归属，不猜测修复 |
| workspace_has_changes / workspace_has_untracked_files | 完成处理或单独归档，再走受管释放 |
| rollback / finalize / cleanup failed | 保留新旧文件、quarantine、refs 与 rows，停止重复 mutation |
| invalid_current_subject / developer_role_required / admin_role_required | 检查活跃身份、业务角色、管理标记和网关头映射 |
| last_active_admin | 保留能够通过用户管理接口维护管理权限的活跃开发管理用户 |
| user_model_api_key_required / user_git_ssh_credentials_required | 检查 developer owner 的个人凭证，不能换为共享身份 |
| issue_credential_owner_inactive | 核对 assignee/reporter，使用业务入口调整 |
| model_response_idle_timeout | 检查 provider/网络，保留 JSONL，按工单 retry 继续 |
| 配置 409 | 等待相关 Agent/预约结束，草稿保留后重试，不直接写 DB |
| Source 不可用 | 检查 runtime、仓库布局、权限和静态资源，保留失败证据 |
| 查询不完整、超预算或异常大 | 检查来源、SQL 范围、LIMIT 和成果导出，不返回裁剪后的假完整结果 |

DMS 核对部署或个人 URL/Authorization、同源消息通道及数据库映射；SLS 核对 region/project/logstore 和所选身份。失败不切换凭证重试。SSE 顺序为持久/当前回放 → snapshot_ready → live/heartbeat；检查代理缓冲、超时和 Web generation，重启不会恢复未持久事件。

## 恢复与回退

停止应用，另外保存失败后的完整状态，再恢复匹配的代码、数据库文件组、附件、成果、JSONL、bare store 和 worktree，保持路径、owner/mode。故障后新增的对话、成果或代码必须单独保留，不能被旧快照覆盖。

只回退代码或只替换 DB 都可能造成 schema、binding、文件和 Git ref 不匹配。恢复后重新执行完整健康与一致性核对；遇到 unmanaged/changed state 先调查，不靠删除证据让探针变绿。
