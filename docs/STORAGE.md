# 数据存储

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [运维](RUNBOOK.md)

## 事实来源与状态分类

| 分类 | 内容 | 处理原则 |
| --- | --- | --- |
| 持久 | SQLite 文件组、Pi JSONL、附件、工作文件、私有 Git refs／新对象／索引 | 匹配恢复，不能作为缓存删除 |
| 有条件持久 | 活动开发 worktree、未提交／untracked／ignored 文件 | 只有满足 owner 释放条件才移除 |
| 生成 | 运行视图、控制 socket、临时网络配置、受管共享 checkout、缓存 | 先确认归属与状态，异常内容可能是恢复证据 |
| 配置 | 根配置、SQLite 业务设置、Operator Pi／工具配置 | 与运行版本一起保留 |
| 安装产物 | node_modules、venv、构建网页 | 从匹配锁文件、依赖补丁和 requirements 生成 |

SQLite 是业务配置与关系来源，JSONL 是对话来源，Git 是代码来源，普通文件保存原件和成果。Agent 对话不另存 SQL 消息表；人工评论独立保存在 issue_comments。GET 脱敏不等于存储加密，数据库和恢复点均属敏感数据。

共享路径探测只把 `ENOENT` 视为不存在；权限、I/O 和目录结构错误向调用方传播，不能据此选择其他 Git store、重新创建会话或报告状态缺失。

## 数据表关系

当前结构以 [schema.ts](../src/db/schema.ts)、[bootstrap.ts](../src/db/bootstrap.ts) 和不可变 [drizzle](../drizzle) 为准。admin 保存的运行参数位于 `application_settings.parameters`（由 [parameters.ts](../src/configuration/parameters.ts) 校验），`max_concurrent_issues` 已由 0069 迁移复制进该列，仅保留为恢复证据。

| 关系 | 要点 |
| --- | --- |
| subjects → credentials／preferences | 角色、管理标记、活跃状态与个人组分离 |
| services + environments → deployments | 服务／环境组合唯一，部署保存目标和仓库基线 |
| repositories → service_repositories | URL 去重，服务关联保存别名 |
| deployment → mcp_services | 标记工具归属，生成连接随对应目标管理 |
| issues → issue_workspaces | 每张工单恰有一条 Workspace |
| issues → issue_pilot_sessions | 绑定当前 JSONL 和工作根 |
| issues → issue_repositories | 记录 URL、基线／工作分支、路径、workspace name 和 commit |
| issues → attachments | 文件名、物理路径、mediaType、size、SHA-256、上传者 |
| issues → scopes／transitions | 包含服务意图与范围变更快照 |
| issues → comments／cc／relations／pins | 评论、抄送、有向关联和用户置顶 |

内部 issues.id 为 UUID，业务编号为配置时区的 `ISSUE-YYYYMMDD-NNN...`。HTTP 工单 DTO 的 id 使用业务编号，磁盘目录使用小写。工单服务／环境须匹配 Deployment，resolved 与非空 resolved_at 等价。

用户、个人凭证、仓库和服务使用 revision；共享 DMS／SLS 各有独立版本，保存在 application_settings。共享模型组在 global_agent_configuration，个人模型组在 user_credentials.model_credentials。历史私有字段不能用于补齐当前配置。

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
    │   ├── <repository>/
    │   ├── .issue-git/<url-hash>/
    │   ├── .session-<name>.jsonl
    │   ├── .attachment-<uuid>-<原名>
    │   ├── .issue-runtime.json
    │   ├── .related-<key>{,.json,.jsonl}
    │   ├── .npm-cache/、.maven-cache/
    │   └── 普通脚本、日志、报告与检查点
    └── control/
```

[issueRoot](../src/workspace/state.ts) 是统一工作根和 Agent cwd。state 为 0700，数据库／JSONL 为 0600，附件为 0400。资源来自 Operator 全局 Pi 目录，完整恢复点必须在 state 之外。

工作目录 API 可列管理文件名称，但不提供普通原始下载。源码和工作文件使用校验后的固定目录／文件描述符，拒绝越界、Git 控制文件、特殊文件和非法链接。写操作固定父目录后执行临时写入、回滚与清理，不能仅在写后检查路径。

## 文件写入与发布

### 附件

[attachment-store.ts](../src/http/attachment-store.ts) 暂存原件、计算大小／哈希，再与工单事务协调：原件在 SQLite 写事务之前复制进工单根，事务内只插入记录，回滚时删除本次独占创建的文件，避免大文件复制占用写锁。物理名包含 UUID，并遵守文件名 UTF-8 字节预算；原名留在元数据与下载响应。

读取要求直属工单根、regular file、精确 0400、DB 大小与 SHA-256 匹配。下载先有界完整校验，再从同一描述符发送，避免校验后重新打开可变路径；取消关闭句柄。Agent 准备也验证原件，但不声称持续监控之后的外部修改。

删除先 quarantine，事务失败恢复，提交后 finalize；事务失败时原失败和收尾失败都保留。提交后的 finalize 失败只记录日志并保留 `.deleting` 文件供 Operator 清理，不把已提交的编辑报告为失败。准备 Agent 不自动复制可编辑附件，粘贴图片属于 Pi 消息。

### 工作文件与导出

[work-files.ts](../src/workspace/work-files.ts) 负责普通工作文件。导出先校验目标，再独占临时文件、完成内容与协议收尾、复查取消，最后原子 rename 替换。提交前失败保留旧文件，清理失败不掩盖原错误；已经提交的 rename 不因后续诊断自动回滚。

同一路径导出串行，等待取消不启动生产者。下载文件名使用标准 Content-Disposition；不存在或非目录祖先返回 404，链接循环返回 400，不暴露内部路径。预览有预算，普通下载不因此截断。

对话链接解析当前 workspace、普通相对路径和授权相关工单。`outputs/`、`work/`、`attachments/` 是真实相对目录，不剥除为旧别名；旧 issues 绝对路径不自动转换，历史 JSONL 和离线索引不改写。

### 源码保存

Source API 使用读取时 SHA-256 检测冲突，`source_file_changed` 不可盲目覆盖。临时文件独占创建，只清理本次拥有且未发布的路径；原写入和清理失败聚合报告。目录并发变化可使读取失败，不能把写入重定向到外部链接目标。

## Git 与工作区

共享 bare store 提供基线对象及 detached 只读快照。开发工单持有私有 store、分支、新对象、worktree 和索引，只读复用基线对象，不跨工单共享可写硬链接。

| 仓库集合状态 | local_path | working_branch |
| --- | --- | --- |
| read_only | 全 NULL | 全 NULL |
| development_workspace | 全非空 | 全非空 |
| development_snapshot | 全 NULL | 全非空 |
| invalid | 空集合、混合或其他组合 | 拒绝并检查 |

只读基线按完整远端 ref 解析；冷启动可准备新共享快照并刷新对应 commit 基线，不修改历史分支／路径。已有开发分支只从本地 store／ref 恢复，缺失或损坏时报错，不 reset、远程回退或猜测修复。工单根缺失的开发工单（私有 store 随之丢失）回收和重开都以 `workspace_missing` 拒绝，不标记为已回收，也不从较旧的共享 ref 重建。

复用 checkout 检查 HEAD、common dir 和 tracked／untracked／ignored；config、hooks、alternates、指针和 link count 也由 owner 检查。模型不可改 Git 配置，推送可显式指定分支；远端成功而本地 upstream 更新失败时先核对远端，不自动重复推送。

释放要求已解决、空闲、布局与分支匹配且 clean，包括 staged、untracked、ignored。只移除登记的代码 worktree，保留工单根、文件、会话和持久分支。发布使用 compare-and-swap，外部 ref 变化拒绝覆盖；跨媒体失败按 owner 恢复，不能用 SQL rollback 代替。

服务 scope 先保存意图，再准备资源；相同 URL 的分支冲突拒绝。失败保留事实供重试，释放后视图恢复失败记录 runtimeReady／lastError，维护在预约内重新检查。

### 容量统计

`totalBytes` 统计工单根分配空间，含缓存和私有 Git，`sharedGitBytes` 单独计量。结果不是主机全盘占用或原子磁盘快照。

并发读取共享同一次扫描，完成的快照在下一个维护周期内复用（默认 15 分钟；维护间隔为 0 时 5 秒）。释放、重开、转换和自动维护使缓存失效；Agent 处理与源码编辑等其它变更在下一次采样后反映，页面显示 `sampledAt`，`GET /api/workspaces/stats?refresh=true` 强制重新采样。真实释放重新检查；候选占用不等于可释放量，释放量以实际减少为准。

## 升级与恢复

数据库使用 WAL 和 FK，配置读取使用 read snapshot。已发布 SQL／journal 不改写，升级增加新迁移并验证 fresh DB、已有 schema、失败回滚和重试。

正常启动不自动解析旧目录或采用未知路径。离线迁移工具独立处理确认过的旧状态，见[旧目录迁移](operations/legacy-layout-migration.md)。迁移索引仅是恢复证据，正常运行读取当前工作文件。

未知目录、quarantine、异常临时文件或变化的 checkout 先查所属阶段，不当作垃圾删除。备份、发布检查与恢复顺序统一见[运维手册](RUNBOOK.md)。
