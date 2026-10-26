# 运维手册

[文档导航](README.md) · [部署](DEPLOYMENT.md) · [存储](STORAGE.md)

操作前确认安装目录、根配置、state root 和 supervisor。同一 state 只运行一个 API，启动可能升级 schema 或恢复运行状态。日志保留计数、耗时、工单 key 和错误码，隐藏密钥与敏感响应。

## 健康与活动检查

```bash
curl -fsS http://127.0.0.1:3000/health
systemctl --user status issue-pilot-api.service issue-pilot-web.service --no-pager
systemctl --user show issue-pilot-api.service issue-pilot-web.service --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

容器检查对应 namespace 的 deployment、pod、service 与日志。健康返回 `{"ok":true}` 仅表示应用可响应；远程目标、工具和业务状态按变更范围验收。

Issue 列表的 agentRunning 与配置／生命周期预约共同用于判断活动；`GET /api/me` 核对身份。容量统计带 sampledAt，`?refresh=true` 进行完整采样。

## 按风险发布与重启

| 变更 | 保留范围 |
| --- | --- |
| 网页／代码／依赖，无持久契约变化 | 匹配源码、锁文件、依赖、产物及 supervisor；已有完整恢复点可用即可 |
| 小规模配置／数据修复 | 业务 owner/API 操作，保留精确原始行或小型 SQLite 检查点 |
| schema／数据／文件或 Git 布局迁移、高风险不可逆操作 | 停止写入，建立完整一致恢复点，在独立副本演练 |

1. 在独立目录完成检查与构建，确认变更类型和回退产物。
2. 仅网页原子切换已验证产物，保持 API 运行。
3. 后端／依赖变更先排空 Agent 和预约，优雅停止相关服务并确认退出，再切换、启动。
4. 验收健康、页面及相关不变量；发现非预期数据变化时保留现场，按状态恢复处理。

纯重启不新建全量快照，运行中的依赖与静态目录不能混合覆盖。无持久变化可回退匹配代码／产物；数据库、文件或 Git 变化不能仅靠代码回退。

## 完整恢复点

1. 排空并停止所有写入者，在 state 外创建 0700 私有副本。
2. 保存 DB 文件组、工单、共享／私有 Git、模式及未知证据，匹配源码、根配置、Pi 与 Operator 配置。
3. 独立副本验证 integrity／FK、业务约束和 migration hash，演练操作。
4. 操作与验收成功后轮换，保留最新和上一份完整恢复点；未查明失败现场单独保留。

无写入进程时复制，目标独立于源：

```bash
issue_state_root=/var/lib/issue-pilot
issue_backup_root=/srv/issue-pilot-backups/<unique-name>
install -d -m 0700 "$issue_backup_root"
rsync -a --exclude=/control/project-tools.sock -- "$issue_state_root/" "$issue_backup_root/state/"
```

link-dest 只在备份之间共享，不链接可写 live inode，不原地覆盖或统一 chmod 共享 inode。大状态预复制到独立待完成目录，停止写入后完成增量与删除同步，核对 WAL／SHM 和持久文件才标记可恢复。小型记录不算完整恢复点。

## 一致性检查

使用可信只读连接或独立备份：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

结果应分别为 ok 和空集。按[存储约束](STORAGE.md#数据表关系)核对每工单唯一 Workspace、有效部署、resolved／resolved_at 等价；全局 Agent 仅 id=1，活跃用户和开发管理用户至少各一名。区分启动产生的生成状态变化与业务事实。

附件为工单根内 0400 regular file，size／SHA-256 匹配 DB；JSONL、DB 与控制 socket 为 0600，state 为 0700。quarantine、`.deleting` 和异常临时文件按事务阶段检查。

```bash
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> branch --show-current
GIT_OPTIONAL_LOCKS=0 git -C <repository-path> status --porcelain --untracked-files=all
```

共享 checkout 应 detached、HEAD 匹配且 clean，common dir 指向共享 store。开发 worktree 核对私有 store、backpointer、index、HEAD、登记路径与分支，检查 untracked／ignored 内容。异常绑定按匹配证据恢复。

## Workspace 回收与空间清理

| 策略 | 默认值 |
| --- | --- |
| 维护 | 启动一次，之后每 15 分钟 |
| 正常保留 | 已解决满 7 天 |
| 压力回收 | 工单根累计超过 20 GiB，目标 16 GiB，可早于 7 天 |
| 条件 | resolved、空闲、非 preparing／running、布局与分支匹配、clean |

手动 `DELETE /api/issues/:key/workspace` 使用同样检查，无 force。dirty、untracked 和 ignored 阻止释放；重开使用本地分支。代码释放后视图恢复失败由维护重新检查处理。

统计包含工单文件与私有 Git，共享 Git 单独计算。候选占用不是可释放量，保留文件可能使全部代码回收后仍高于目标。计量与缓存规则见[容量统计](STORAGE.md#容量统计)。

清理前核对进程 cwd／argv／fd、持久引用、符号链接及 Git 归属。已确认无用且授权的生成副本可删除，独有恢复数据才保留必要原件；完整备份按策略轮换。按 inode／link count 计算唯一占用，分别检查下载缓存、被引用工具、本地制品及容器 volume，避免宽泛 prune。

## 常见故障

创建／发送结果不明先核对工单与对话。排障先查应用，再查身份、文件与 Git，最后检查模型、协议和页面。

| 类别 | 处理 |
| --- | --- |
| 身份／角色／last_active_admin | 核对活跃账号、管理标记及网关映射，保留开发管理用户 |
| 缺少个人凭证／owner 失活 | 核对 assignee／reporter，通过业务入口调整实际 owner |
| 配置 409 | 区分版本与任务冲突，保留草稿后重载／等待 |
| unmanaged／绑定／分支／Git config／hooks 异常 | 保留目录、原 index、HEAD、refs 及 staged／untracked／ignored，按证据核查 |
| workspace 有改动 | 处理实际文件后再受管释放 |
| runtime 未就绪／恢复失败 | 核对本地 ref 和运行清单，按 owner 重试恢复 |
| source_file_changed／cleanup 失败 | 重载冲突内容，保留临时文件及原操作、清理错误 |
| JSONL 缺失／不完整 | 保留文件与绑定，查磁盘、I/O 和写入者，在独立副本核查 |
| message scope／state／outcome_unknown | 核对范围、交付记录及实际结果，按[投递规则](AGENT.md#消息接收与中断)继续 |
| 模型超时／Codemode 队列满 | 查 provider、网络及未退出脚本／工具，保留对话 |
| 网络允许列表／SSH 拒绝 | 核对精确域名端口、known_hosts 与个人身份 |
| Python／aliyun CLI 缺失 | 核对 venv、PATH 和实际启动产物 |
| DMS／SLS 拒绝、限流、不完整 | 核对所选凭证、目标、时间、权限和预算，遵守[工具重试语义](AGENT.md#原生证据查询) |
| 钉钉 DataNotReady | 核对失败工具和计算／关联字段；读取与外部指派是不同路径 |
| rollback／finalize 失败 | 保留文件、quarantine、refs 与原始行，停止重复 mutation |

Git 推送若远端成功而本地 upstream 写入失败，先核对远端提交。SSE 检查回放、snapshot_ready、live 顺序及代理缓冲、超时和页面 generation。

## 恢复与回退

完整恢复先停止写入，另存失败现场和故障后的对话、文件与代码，再恢复匹配源码、依赖、DB 文件组、工单目录和 Git，保持绝对路径、owner 与模式。仅换 DB 或源码不能恢复跨媒体一致性。

局部修复按 owner 和已记录的原始范围回退，重新授权及检查版本。恢复后验收健康、数据、文件、Git 和页面；不能用 reset、远程 clone、空索引或改绑定掩盖异常。
