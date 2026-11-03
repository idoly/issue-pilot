# 运维手册

[文档导航](README.md) · [部署](DEPLOYMENT.md) · [存储](STORAGE.md)

## 操作边界

先确认源码／安装目录、根配置、state root、supervisor 和活动任务。启动可能迁移数据库、恢复中断状态和刷新只读基线；同一 state 不能启动第二个 API。

提交、推送、重启和真实状态操作分别需要授权。检查和日志保留计数、耗时、工单 key 与错误码，不输出连接密钥、SQL 或敏感响应。未知目录、恢复证据、dirty checkout 和数据库未表示的文件不按名称猜测删除。

## 健康与活动检查

```bash
curl -fsS http://127.0.0.1:3000/health
systemctl --user status issue-pilot-api.service issue-pilot-web.service --no-pager
systemctl --user show issue-pilot-api.service issue-pilot-web.service \
  --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

核对实际身份 `/api/me`、工单列表 agentRunning、相关配置／生命周期预约。排队也是活动。容器核对对应 namespace、deployment、pod、service、挂载和日志。

`{"ok":true}` 不证明动态 executor、Pi 资源、Git、查询或远程目标正常。还须按变更范围检查网页入口、身份 API、SSE 和相关工具。

## 按风险发布与重启

| 变更 | 恢复准备 |
| --- | --- |
| 纯 Web／源码／依赖，未改变持久契约 | 匹配代码、锁文件、依赖、产物与 supervisor，已有完整恢复点可用即可 |
| 小规模配置／数据修复 | 使用 owner／API，保留精确原始行或小型 DB 检查点 |
| schema／布局迁移或高风险不可逆变化 | 停止写入，建立完整一致恢复点，独立副本演练 |

1. 在独立目录验证源码、依赖、补丁、类型、测试、构建与审计，准备可识别的版本及回退产物。
2. 仅 Web 变更可原子切换已验证产物，不必停止 API；不要覆盖它仍在使用的 dist。
3. 后端／依赖变更先排空 Agent 和预约，优雅停止入口与 API，确认进程、子进程退出及租约释放。
4. 完成所需一致备份，切换整组代码／依赖／产物，启动并验证。
5. 对比数据、文件、Git 和未知路径。先按 owner 解释预期变化，发现无法解释的变化保留现场，不继续猜测修复。
6. 验收完成才轮换恢复点，保留最新与上一份完整副本。

运行中的 checkout 不可混装依赖：native-tool-executor／network-exec 是动态源码入口，主进程未重启也会受磁盘变化影响。纯重启不为每轮检查新建大型全量备份。

## 完整恢复点

停止写入后复制 DB 文件组、工单、共享／私有 Git及模式，保留未知证据，并保存匹配源码、根配置、依赖／Web、supervisor 与必要的 Pi／Operator 配置。备份位于 state 外，目录 0700，包含密钥的文件按私有数据保护。

```bash
issue_state_root=/var/lib/issue-pilot
issue_backup_root=/srv/issue-pilot-backups/<unique-name>
install -d -m 0700 "$issue_backup_root"
rsync -a --exclude=/control/project-tools.sock -- \
  "$issue_state_root/" "$issue_backup_root/state/"
```

大状态可先预复制到标记未完成的目录，停写后完成增量与删除同步，核对 WAL／SHM 和持久文件才标记完整。link-dest 仅在备份之间共享，不链接可写 live inode；有共享 inode 时不能原地覆盖或统一 chmod，元数据变化也需先隔离对应文件。

在独立副本验证完整性、FK、业务约束及 migration hash，再演练迁移。迁移 schema 与文件回滚不是一回事。小型日志或 DB 单文件副本不等于完整恢复点。

## 一致性检查

用可信只读连接或备份执行：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

结果分别应为 ok 和空集。还检查：

- 每工单一条 Workspace，有效服务／环境部署，resolved 与 resolved_at 等价。
- 单例全局 Agent 配置，以及受保护的活跃用户、开发者和管理用户。
- 附件为 0400 regular file，大小／SHA-256 与 DB 一致；JSONL／DB 为 0600，state 为 0700。
- 会话绑定存在，未知或不完整 JSONL 保留，不自动截断／改绑。
- Git refs、HEAD、common dir、worktree backpointer、登记分支／路径、staged／untracked／ignored。
- 未登记目录、quarantine、异常临时文件及迁移记录。

```bash
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C <path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C <path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C <path> \
  status --porcelain --untracked-files=all --ignored=matching
```

冷启动会依据当前部署 fetch 并准备 prod/test 只读快照，可能增加 detached shared checkout、更新这些 Issue 的 commit_before／时间戳。必须确认变化限于该 owner 的合法范围，不能因此接受开发分支、历史路径或未提交代码被改动。

## 工作区与空间清理

根默认维护在启动及每 15 分钟运行。已解决满 7 天是普通候选；工单根累计超过 20 GiB 时目标为 16 GiB。实际条件仍要求已解决、空闲、布局／分支匹配且 clean，dirty、untracked、ignored 会阻止释放。

`DELETE /api/issues/:key/workspace` 使用同一 owner，无 force。释放代码保留根目录、附件、会话、普通文件及私有分支；重开只从本地合法 ref 恢复。候选占用不等于可释放量，统计带 sampledAt，见[容量统计](STORAGE.md#容量统计)。

| 资源 | 删除前必须确认 |
| --- | --- |
| 文件／目录 | 静态／动态引用、DB 绑定、符号链接、当前事务和恢复价值 |
| 测试／构建临时根 | 独立夹具归属、进程 cwd／argv／fd、无真实状态引用 |
| Git 工作树 | 实际路径、分支、dirty／ignored、登记与可恢复本地 ref |
| 容器／镜像 | 项目归属、全部容器状态、挂载／volume、当前构建引用 |
| 服务 | unit／启动命令／目录、依赖、端口和使用者 |
| 缓存／安装产物 | 当前进程是否仍依赖，能否按锁文件完整再生成 |

不运行宽泛 prune，不清理共享包缓存、其他项目镜像或系统服务来凑空间。没有容器不代表镜像必定无用；当前 Containerfile 的基础镜像仍可能是有效构建缓存。API 与可选 4173 入口有共同后端，也不意味着其中一个无人使用。

## 常见故障

| 类别 | 处理 |
| --- | --- |
| 身份／角色／管理用户保护 | 核对活跃账号、角色、isAdmin 和网关绑定，不自动切身份 |
| 缺少／失败的模型、SSH、DMS、SLS 凭证 | 核对 owner 和所选组，不回退其他 Key／用户 |
| 配置 409／Agent 活动 | 保留草稿，按版本和预约状态重试 |
| 分支／路径／Git 控制文件异常 | 保留 refs、索引、dirty 与未知文件，不 reset、远端回退或改绑定 |
| JSONL 缺失／不完整 | 保留文件和绑定，在副本中检查，不生成替代会话 |
| 消息结果不明 | 查看会话／文件／交付元信息，不盲目重发 |
| 查询拒绝、限流、不完整 | 核对目标、权限、时间与预算，遵守[查询规则](AGENT.md#原生证据查询) |
| Python／aliyun／SRT 不可用 | 核对真实安装、PATH、namespace 和实际执行，不弱化隔离 |
| rollback／finalize 失败 | 保存现场与原始行，检查事务阶段，停止重复 mutation |

SSH 握手在代理 DNS 返回 `198.18.0.0/15` 时提前关闭，先对照可信 DNS 和既有 known_hosts，检查该主机解析规则；不关闭主机校验、不更换身份或回退旧 ref。WSL 自动 hosts 可在重启后覆盖。

SSE 检查回放、snapshot_ready、live 顺序，以及代理缓冲、超时和 generation。Git 推送远端成功但 upstream 本地写入失败时，先核对远端，不重复产生提交或强推。

## 恢复与回退

停止写入，另存故障后新增对话、文件、代码和未知现场，再恢复匹配的源码、依赖、DB 文件组、工单目录与 Git，保持绝对路径、owner 和 mode。不能只换数据库或只回退代码。

局部修复必须有 owner、明确原始范围与版本／授权检查。恢复后重新验收健康、网页、动态工具、完整性、文件、refs/worktrees 和未登记目录。成功后按最新／上一份策略轮换；未查明失败现场独立保留，不以清理名义覆盖。
