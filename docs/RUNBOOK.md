# 运维手册

先确认根配置、部署目录、进程和真实 state root。状态分类见[数据存储设计](STORAGE.md#一致性与恢复单位)，运行方式见[部署指南](DEPLOYMENT.md)。启动会迁移和恢复状态，不能启动第二个 API 作为只读检查。

## 健康与活动检查

```bash
curl -fsS http://127.0.0.1:3000/health
systemctl --user status issue-pilot-api.service issue-pilot-web.service --no-pager
systemctl --user show issue-pilot-api.service issue-pilot-web.service --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

Kubernetes 部署改查实际 namespace 的 deployment、pod、service、探针和日志，不与本地 supervisor 命令混用。健康应返回 `{"ok":true}`，但 active/Running 不能代替数据库、文件、Git 和页面验收。

通过 Issue 列表检查 `agentRunning`，同时考虑 API 配置、生命周期和预约操作。`GET /api/me` 可核对所选活跃身份；`GET /api/workspaces/stats` 包含深检，可能耗时。诊断只记录计数、耗时、稳定错误、Issue key 或 ref/commit，不输出配置 body、认证头和完整敏感结果。

## 备份、发布与重启

1. 记录当前 commit、未提交源码、根配置、依赖版本和 supervisor/镜像信息，确认目标版本的检查通过。
2. 确认 Agent 和预约操作已完成，进入维护窗口并阻止新请求。本地可先停止 Web 入口，再优雅停止 API；保留足够时间 drain，不在退出前复制状态。
3. 确认 API PID 和子进程已退出，在 state root 之外建立 `0700` 一致备份，保留 DB 文件组、工单根目录、共享和私有 Git stores、worktrees、owner/mode 和未知证据。
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

同时保存匹配的代码、根配置、私有 YAML/MCP 文件和用户全局 Pi 配置。若使用 link-dest 节省空间，仅允许备份之间共享硬链接，不能把可写 live 文件链接成备份；不能对共享 inode 原地覆盖或统一 chmod。复制后检查完整性、模式和可恢复性。

## 减少停服时间

把依赖安装、SDK 补丁验证、前端构建、测试、镜像构建和传输放在独立 checkout 或发布暂存目录中提前完成。在线服务仍从现版本读取代码和依赖；不在运行中的 node_modules 或实际静态网页目录上进行混合版本安装。记录产物与源码、锁文件的匹配关系，停服后再切换。

大状态目录可先在线预复制到本次新建的私有待完成目录，但必须标明“未完成”，不能作为恢复点使用。预复制阶段不要与已验证恢复点建立硬链接，以免最后同步时的权限等属性更新影响旧备份。排空并确认所有状态写入者退出后，再完成最终增量同步、数据库文件组核对和持久文件校验；必须处理预复制后源端已删除的文件，尤其不能残留过期 WAL/SHM。目的目录的删除或替换只限本次明确拥有的待完成副本，不对 live 路径或已有恢复点使用宽泛清理命令。

最终同步及必要校验通过后，激活事先验证的代码和安装产物，再启动服务并验收。文件枚举、数据库和 Git 检查仍可能耗时，不能承诺仅停服几秒。需要进一步缩短窗口时，先单独演练底层快照与路径方案，保留单实例租约和一致性要求。

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

附件必须为 regular file，直属工单根目录，size/hash 与 DB 一致，mode 为 0400；JSONL 为 0600。迁移核对原件、工作副本、会话、普通文件和旧下载映射，不能把生成状态变化当作持久文件损失。DB 和 JSONL 私有，state 目录为 0700，数据库为 0600，project-tool socket 为 0600。`.deleting`、quarantine 和异常临时文件要调查事务阶段。

Git 只读检查示例：

```bash
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> status --porcelain --untracked-files=all
```

活动开发路径、branch、workspace name 与 DB 的关系不能通过当前服务配置推测。共享 checkout 应 detached、HEAD 匹配 commit、clean，common dir 指向共享 bare store；活动开发 worktree 的 common dir 可以指向本工单 `.issue-git/<url-hash>`，必须与自身 store、backpointer 和登记分支相符。私有 store 保留 refs、索引、新对象及发布检查点，不能按临时缓存清空。记录发布前已有的分支偏差和未知目录，发布后确认保留；不通过 checkout、reset、远程 fallback 或改 DB 元数据掩盖偏差。

## Workspace 回收与历史清理

维护策略来自根配置，仅释放 resolved、空闲、非 preparing/running、布局完整且 clean 的开发工单。默认启动时检查一次，随后每 15 分钟检查；已解决满 7 天按保留期回收，超过 20 GiB 时对符合条件的候选提前回收，目标 16 GiB。压力回收不承诺至少保留 7 天。手动释放使用 `DELETE /api/issues/:key/workspace`，没有 force；重开经状态流程，从本地分支恢复。dirty、untracked 或路径/分支不符时保留并调查。

容量统计针对 `workspaces` 工单根目录，包含附件、对话、工作文件、工单内缓存和私有 Git 数据，不包含共享 `git/repositories`、`git/checkouts` 或外部恢复点。释放只移除登记的代码 worktree，随后可能建立只读快照；保留内容仍会占用空间，因此页面候选总容量不等于实际磁盘可释放量。

当前维护实现有已知记账限制：成功释放后会在当轮维护结果和短期容量缓存中扣除释放前整目录大小，而非仅扣实际释放字节；压力回收可能提前判断达到目标。只读和已释放工单的拒绝原因也可能显示为通用安全检查提示。这些行为尚未修复，不能把页面“待自动回收”作为本轮保证释放量；容量验收应独立核对实际目录。不要为纠正统计而删除工作文件、Git 状态或绕过安全检查。

默认保留最近两份已验证的完整状态恢复点：最新一份和上一份。新快照、匹配代码及重启验收全部成功后，再轮换删除更旧的完整状态快照；失败现场调查完成前不纳入普通轮换。创建前检查现有恢复点，同一已验证状态不重复建立大快照。小型提交、清理和验证记录可单独保留，不把它们误算成完整状态备份。

历史备份按内容、完整性、权限和恢复用途判断。保留范围内，含不同工作文件或 Git 索引的快照需要明确其恢复用途；超出保留上限的旧恢复点按已授权轮换策略删除。空的失败备份可删除；代码/数据库小检查点与完整状态快照要明确区分。

删除临时测试、参考构建和依赖副本前，检查进程 cwd/argv/fd、持久数据引用、符号链接及 Git 归属。保留有效验证结果和删除清单，确认清理不会沿链接进入 live 状态。已发布迁移、运行目录、未知证据及当前资源不能因“没有代码引用”而删除。保留策略由 Operator 决定，备份脚本不顺手清理其他快照。

释放存储前用 inode/link count 核算唯一占用；多份备份之间有硬链接时，逐目录 `du` 数字不能直接相加为预计释放量。只清理已核实用途的下载缓存和构建产物；npm 下载缓存与 `_npx` 程序目录、Yarn 下载缓存与直接引用的工具包、Maven 远程依赖与本地 install 制品必须分别检查。保留 Maven 配置和无法确认可重新获得的本地制品。

Podman 镜像、容器写层和 volume 分开处理，空闲不等于没有数据。执行前复核容器、挂载和镜像保留名单；只删除明确授权的对象，不把全局 `system prune --volumes` 作为默认操作。独立浏览器镜像可重新下载，但移除后应记录验证工具恢复方法。

旧恢复点中包含独有历史修复现场时，先独立归档原始文件、必要 Git 基线／索引和恢复说明，逐项校验后再退役大快照。清理记录和小型恢复证据可继续保留，不能把所有带时间戳的目录都当作完整状态恢复点。WSL 内部释放空间不保证 Windows 上 VHDX 文件立即缩小，离线压缩应另安排维护窗口。

## 配置文件准备

用新版本的脚本从当前数据库只读快照生成私有配置草稿。它保留现有服务 key、仓库与分支绑定，导出全部已登记账号各自的凭证与已有文件来源，输出 v2 YAML。共享部署凭证有多个不同组时要求 owner 检查，不猜测选用哪一组。参考文件用于来源声明和 MCP 入口，不覆盖现有业务身份。已退役的 Playwright MCP 不进入草稿。输出目录必须与真实 state root 不同，脚本拒绝覆盖已有文件，生成文件权限为 `0600`：

```bash
node --experimental-strip-types scripts/prepare-configuration.ts \
  --state-root /path/to/application/.issue-pilot \
  --output /path/to/private-config-review \
  --subject user@example.com \
  --reference-service /path/to/reference/config.yaml \
  --reference-mcp /path/to/reference/mcp.json
```

`--subject` 指定旧 `service.yaml.sources.dingtalk` 的迁移归属。脚本默认保留缺失项；用户明确授权复用某个账号的凭证时，可增加 `--fill-missing-from user@example.com`，只补其他账号缺失项，不替换已有完整凭证，也不复制来源或人员筛选。检查暂存文件中每个账号的归属后，再按发布流程安装；运行时失败不会改用另一账号。

审核 `service.yaml`、`user.yaml`、`mcp.json` 的目标、模型和认证归属，不把内容粘贴进日志。按前述维护与一致备份流程停止旧进程后，安装已验证的新代码，将三个文件放入真实 state root；仅在存在旧工作目录布局时执行下面的工作目录迁移，最后重启。文件缺失时数据库仍是配置来源；相应文件存在时页面只读，不能用 API 修改另一份投影。

## 工单工作目录迁移

先验证 SRT 的跨目录写入、宿主 TCP/Unix socket 旁路、取消与 SDK 文件输出，再完成独立完整副本演练，最后执行线上目录切换。执行边界与信任范围见[Agent](AGENT.md#执行边界)。

迁移将旧 `issues/<key>` 中的附件原件、Pi JSONL、成果和运行文件直接归并到现有 `workspaces/<key>`，保留开发仓库路径。先按上文建立匹配的一致恢复点，再在独立副本执行：

```bash
# 只读预检，不升级数据库或移动文件；只输出统计。
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts --state-root /path/to/state
# 停止入口、优雅停止 API，确认进程和子进程退出后应用。
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts --state-root /path/to/state --apply
```

应用先独占 API 使用的实例控制 Socket（沿用 `control/project-tools.sock` 以阻止旧版本并发启动，不处理项目命令），预检完整布局并写 `0600` 计划记录，然后调用数据库 migration owner 执行尚未应用的迁移。0061 增加附件工作副本名，0062 将旧正式数据处理工单及 SQL 处理历史统一转为正式问题调查，并拒绝新写入旧值。此步骤不启动 Agent 或运行应用的中断恢复逻辑。

文件迁移校验 mode/hash、原件与 DB 的关系、会话头和路径、目标重名及旧运行目录结构。编辑过的工作副本保持原样；同内容旧交付复用当前文件，不同内容交付保留摘要后缀文件和下载映射。历史运行普通文件也保留为根目录 `.runtime-legacy-*`，原目录内已识别链接和空目录经 quarantine 后清理。未知目录或非预期文件停止供 owner 检查。

文件移动或绑定事务失败会回移本次文件；回滚失败聚合报告并保留证据。数据库 schema 升级不随文件回滚自动撤销，回退旧版本必须恢复匹配的完整恢复点。`flat_layout_committed_finalize_failed` 表示绑定已提交、最终清理失败，应先按私有计划核对现场。不要只替换 DB，也不要直接重试掩盖失败状态。重复成功应用不重新移动文件，但仍校验已迁移的原件和会话。

恢复服务后验证目录、附件下载、历史成果链接、会话回放、释放与重开，核对 DB integrity/FK、文件哈希和模式、Git refs/worktrees 及未知目录。JSONL 和用户脚本内容不改写；旧脚本中的绝对文件路径由工单 owner 检查。

## 常见故障

先判断应用能否响应，再检查身份、工作区和文件，最后排查模型/协议或 SSE/前端投影。`/health` 不验证每个工单和远程目标。创建或发消息响应不明时先查询确认，不盲目重复提交。

| 症状或稳定错误 | 处理 |
| --- | --- |
| issue_layout_migration_required | 停止服务，备份并执行上文显式迁移；不忽略旧工单内容 |
| unmanaged_issue_state | 保留未知目录、DB 和 Git，调查对应关系，不能自动收编 |
| shared_checkout_changed | 保留 checkout/store，检查 HEAD、common dir 和改动 |
| workspace_branch_does_not_match_issue_policy | 备份 refs、staged/untracked 和 DB，确认历史归属，不猜测修复 |
| workspace_has_changes / workspace_has_untracked_files | 完成处理或单独归档，再走受管释放 |
| host is not on the allow list | 核对当前身份与工单仓库，向私有配置追加精确域名／端口，按流程重启投影；不全局开放网络 |
| SSH host key verification failed | 核对 Operator known_hosts 与当前 owner 的个人身份；不关闭严格主机校验或换用其他账号 |
| workspace_git_binding_invalid / source_git_binding_invalid | 检查自身 store、Git 指针、common dir、backpointer 与分支；保留现场，不自动 repair 外部绑定 |
| workspace_git_configuration_invalid / workspace_git_hooks_require_inspection | 私有 Git 配置或 hooks 超出受信范围，先核对来源，不放开任意 hooks／配置 |
| working_branch_changed_outside_issue | 共享分支不同于已记录发布提交，检查外部变更，不覆盖或强推 |
| rollback / finalize / cleanup failed | 保留新旧文件、quarantine、refs 与 rows，停止重复 mutation |
| invalid_current_subject / developer_role_required / admin_role_required | 检查活跃身份、业务角色、管理标记和网关头映射 |
| last_active_admin | 保留能够通过用户管理接口维护管理权限的活跃开发管理用户 |
| user_model_api_key_required / user_git_ssh_credentials_required | 检查 developer owner 的个人凭证，不能换为共享身份 |
| issue_credential_owner_inactive | 核对 assignee/reporter，使用业务入口调整 |
| model_response_idle_timeout | 检查 provider/网络，保留 JSONL，按工单 retry 继续 |
| 配置 409 | 等待相关 Agent/预约结束，草稿保留后重试，不直接写 DB |
| Source 不可用 | 检查 runtime、仓库布局、权限和静态资源，保留失败证据 |
| `Codemode worker limit reached` / `codemode_queue_timeout` | SDK 的 Worker 限制按进程共享，退出中的 Worker 也占槽位；检查并发脚本与长期未结束的工具调用。应用新版本按资源队列等待，`on` 模式也可直接使用原生工具；不要通过增大 Worker 上限掩盖未退出任务 |
| `ModuleNotFoundError: No module named 'openpyxl'` / `pip: command not found` | 核对实际 Python 路径、应用根 `.venv` 和 API 启动版本；可先使用应用 `.venv/bin/python3` 的绝对路径。旧进程按发布流程更新后加载 Bash PATH 注入 |
| `sls_access_denied` / `sls_invalid_access_key` / `sls_signature_mismatch` | 核对实际 owner 的个人或部署凭证、RAM `log:GetLogStoreLogs` 权限及签名配置；失败不切换其他身份 |
| `sls_request_time_expired` / `sls_project_not_found` / `sls_logstore_not_found` | 分别核对系统时间，或已配置的 region/project/logstore；不猜测或自动更换目标 |
| `sls_rate_limited` / `sls_quota_exceeded` / `sls_http_429` | 查 SLS 服务端请求量、并发和额度；不自动重放查询 |
| sls_cli_not_available | 检查运行用户 PATH 和 aliyun CLI 安装；镜像应包含固定 CLI 版本，不换凭证重试 |
| 查询不完整、超预算或异常大 | 检查来源、SQL 范围、LIMIT 和成果导出，不返回裁剪后的假完整结果 |

如果推送返回的错误发生在本地 upstream 写入阶段，应先用当前工单身份核对远端分支是否已指向目标提交。远端已更新时只处理本地跟踪配置，避免把错误误判为没有执行推送；不自动重复提交或强推。

DMS 核对部署或个人 URL/Authorization、同源消息通道及数据库映射；SLS 核对 region/project/logstore 和所选身份。失败不切换凭证重试。SSE 顺序为持久/当前回放 → snapshot_ready → live/heartbeat；检查代理缓冲、超时和 Web generation，重启不会恢复未持久事件。

## 恢复与回退

停止应用，另外保存失败后的完整状态，再恢复匹配的代码、数据库文件组、附件、成果、JSONL、bare store 和 worktree，保持路径、owner/mode。故障后新增的对话、成果或代码必须单独保留，不能被旧快照覆盖。

只回退代码或只替换 DB 都可能造成 schema、binding、文件和 Git ref 不匹配。恢复后重新执行完整健康与一致性核对；遇到 unmanaged/changed state 先调查，不靠删除证据让探针变绿。
