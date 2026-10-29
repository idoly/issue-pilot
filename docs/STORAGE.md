# 数据存储设计

[文档导航](README.md) · [系统架构](ARCHITECTURE.md) · [运维手册](RUNBOOK.md)

SQLite 保存业务关系，Pi JSONL 保存对话，普通文件保存附件与工作结果，Git 保存代码状态。它们共同构成工单事实，恢复时必须匹配。

## 数据分别放在哪里

| 内容 | 存储与 owner |
| --- | --- |
| 用户、配置、工单和绑定 | SQLite，[schema.ts](../src/db/schema.ts) |
| 消息、工具结果、会话分支 | Pi JSONL，[pi-session.ts](../src/agent/pi-session.ts) |
| 附件原件与元数据 | 工单文件加 DB，[attachment-store.ts](../src/http/attachment-store.ts) |
| 普通工作文件与查询导出 | 工单根目录，[work-files.ts](../src/workspace/work-files.ts) |
| 代码、对象、refs 与索引 | 共享／工单 Git store，[git.ts](../src/workspace/git.ts)、[issue-git.ts](../src/workspace/issue-git.ts) |

Agent 对话不另建 SQL 消息表。人工评论属于 `issue_comments`，与 Pi 对话分开。

## 数据表关系

| 关系 | 约束 |
| --- | --- |
| repositories → service_repositories | 仓库 URL 去重，服务关联保存 alias |
| services + environments → service_deployments | 每个服务／环境组合唯一，config 保存查询目标 |
| deployment + service_repository → service_deployment_repositories | 保存部署基线分支 |
| deployment → mcp_services | 标记服务工具归属，生成连接随部署级联删除 |
| issues → issue_workspaces | 每张工单恰有一条 Workspace |
| issues → issue_pilot_sessions | 绑定 Pi JSONL 与工作根 |
| issues → issue_repositories | 保存 URL、基线／工作分支、路径、workspace name、commit |
| issues → issue_attachments | 保存文件名、物理名、mediaType、size、SHA-256 和上传者 |
| issues → scope／transition | 保存 include／remove 意图及范围变更计划快照 |
| issues → comments／cc／relations／pins | 人工评论、抄送、有向关联与用户置顶 |

`issues.id` 是内部 UUID；业务编号为 `ISSUE-YYYYMMDD-NNN...`，按配置时区生成，HTTP 工单 DTO 的 id 使用业务编号，磁盘目录用小写编号。工单范围必须匹配有效 Deployment，resolved 与非空 resolved_at 等价。字段与触发器以 schema 和 migration SQL 为准。

用户、个人凭证、仓库和服务带 revision；共享 SLS 凭据及独立版本保存在 application_settings，部署仅保存 SLS 查询范围。配置关系在 owner 事务中更新，服务仓库绑定变化保留其 ID 与创建时间；全局 Agent、开关和偏好分别保存在对应业务表。

## 目录布局

```text
应用目录/
├── issue-pilot.config.ts
├── node_modules/
├── .venv/
└── .issue-pilot/
    ├── issues.db{,-wal,-shm}
    ├── git/
    │   ├── repositories/<url-hash>/
    │   └── checkouts/<url-hash>/<commit>/
    ├── workspaces/<issue-key>/
    │   ├── <repo>/
    │   ├── .issue-git/<url-hash>/
    │   ├── .session-<name>.jsonl
    │   ├── .attachment-<id>.<ext>
    │   ├── .issue-runtime.json
    │   ├── .related-<key>{,.json,.jsonl}
    │   ├── .npm-cache/、.maven-cache/
    │   └── 脚本、检查点、日志、报告等普通文件
    └── control/
```

`issueRoot(stateRoot, issueKey)` 是统一工单根，也是 Agent cwd。state 目录为 0700，数据库与 JSONL 为 0600，附件为 0400。模型与资源配置位于 Operator 的 Pi 全局目录，默认 `~/.pi/agent`；安装产物和完整恢复点位于工单目录之外。

仓库目录在活动开发时是 worktree，在调查或已释放状态下是受控只读视图。关联链接指向源工单真实目录，json 元信息和 jsonl 引用在准备时生成。管理文件仅列名称，不提供普通原始下载；越界链接、Git 控制文件和特殊文件由 API 拒绝。

## 文件写入与发布

附件先暂存并计算 size／hash，再由工单事务协调文件与 DB。原始文件名保存在元数据及下载响应；物理名包含 UUID，按 UTF-8 字节预算裁剪描述并保留可容纳的扩展名。

读取原件检查直属路径、regular file、精确 0400、DB 大小与 SHA-256。下载用固定缓冲先完整校验，再从同一描述符流式发送，取消时关闭；因此可能读文件两次，但内存有界且校验失败不会发送内容。Agent 准备使用同样校验，随后关闭描述符交原生工具读取；这不是持续监控。删除先 quarantine，事务失败恢复，提交后 finalize；收尾失败和原失败一起报告。

Agent 粘贴图片保存在 Pi 消息中。工作目录中的脚本、表格和报告是普通文件，附件要编辑时显式另存。文件预览按类型及预算按需读取，下载通过授权工作文件 API。

1. 校验文件名、路径、目标类型和取消信号。
2. 独占创建临时文件，完成内容写入和协议收尾。
3. 关闭文件并再次检查取消，用原子 rename 替换目标。
4. 返回下载路径；提交前失败保留原文件，收尾错误独立报告。

查询导出同名目标按实际路径跨实例串行，排队取消不启动生产者；拒绝管理名、路径和非普通目标。DMS 收尾成功后才替换文件，提交的 rename 不自动回滚，清理失败保留原始错误。

Source 保存先核对读取时 SHA-256，冲突返回 `source_file_changed`。临时文件独占创建，只清理本次拥有且尚未发布的临时路径；原失败和清理失败聚合为 `source_save_cleanup_failed`。

## Git 与工作区

共享 bare store 提供基线对象和只读 checkout。开发工单建立私有 Git store，复用只读基线对象，持有自己的分支、新对象、worktree 和索引。满足释放条件后移除代码目录，保留本地分支及其他工单文件；重开从本地分支恢复。

| 仓库集合状态 | local_path | working_branch |
| --- | --- | --- |
| read_only | 全 NULL | 全 NULL |
| development_workspace | 全非空 | 全非空 |
| development_snapshot | 全 NULL | 全非空 |
| invalid | 空集合、混合或其他组合 | 拒绝并检查 |

工单 `.issue-git` 是持久数据，保存 refs、索引、新对象和发布检查点；基线通过只读 alternates 复用，不跨工单共享可写硬链接。Git config、hooks、alternates 和绑定指针由应用维护，可信操作前检查真实路径、类型和 link count。

共享基线按完整 `refs/remotes/origin/<branch>` 解析，checkout 复用时核对 HEAD、common dir、tracked／untracked／ignored。已有工作分支的准备与重开只用本地 store/ref，缺失时失败。`show-ref --exists` 仅返回码 2 代表不存在，损坏 ref 或缺对象继续报告。

释放要求已解决、空闲、布局和分支匹配、工作树 clean，包括 staged、untracked 和 ignored 检查；只移除登记的 worktree，保留根目录其他文件。应用导入工单对象并以发布提交作 compare-and-swap，ref 外部变化时拒绝覆盖。批量失败按原 ref／commit 恢复，不能 reset 或猜测修复绑定。

私有 origin 使用标准 fetch 映射，安全的自身分支跟踪配置可保留。模型工具不能写 Git 配置，推送可显式指定 `git push origin <branch>`；需要改跟踪设置时由受信操作者在空闲状态维护。远端更新而本地 upstream 写入失败时，先核对远端再处理本地。

`issue_service_scopes` 先保存服务意图，再准备资源；同 URL 分支冲突拒绝，失败保留事实供重试。代码释放后视图恢复失败记录 runtimeReady 和 lastError，下一轮维护在预约内重新检查并恢复。单候选失败记录后继续其他候选，整体 DB／容量测量失败正常上报。

### 容量统计

`totalBytes` 累计工单根目录，包含附件、会话、工作文件、缓存和私有 Git；`sharedGitBytes` 单独计算共享 git 目录。采样是按目录分配空间，不是主机全盘占用或同一时点快照。

完成快照最多缓存 60 秒，并发请求共享扫描；`GET /api/workspaces/stats?refresh=true` 重新采样，结果带 sampledAt。回收／重开／范围变更前后失效缓存，真实释放重新检查。每个工单独立 du，释放结果是根目录的实际减少量，候选占用不等于可释放量。

## 一致性与恢复单位

| 分类 | 内容与要求 |
| --- | --- |
| 持久 | DB 文件组、JSONL、附件、工作文件、本地 Git；恢复时保持匹配 |
| 有条件持久 | 活动 worktree；满足释放条件前保留未提交及 ignored 内容 |
| 生成 | runtime、临时网络配置、控制 socket、受管 checkout、缓存；由 owner 确认状态后处理 |
| 配置 | 根运行配置、SQLite、Pi 与 Operator 工具配置；随匹配版本保留 |
| 安装产物 | node_modules、venv、构建网页；从匹配锁文件和补丁生成 |

SQLite 使用本地 libSQL，启用 WAL 和 FK，时间戳以秒保存。配置读取通过原生 read transaction 获取快照；已发布 migration SQL／journal 不可修改，新增升级要覆盖 fresh DB 与已有 schema。

SQLite 回滚不恢复文件和 Git。未知目录、变化的 checkout、quarantine 和异常临时文件可能是证据，先检查所属事务阶段。凭证 GET 脱敏不等于存储加密，数据库、会话、文件及备份均按敏感数据管理。保留与恢复步骤统一见[运维手册](RUNBOOK.md)。
