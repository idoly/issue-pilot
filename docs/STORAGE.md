# 数据存储

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [恢复](RUNBOOK.md)

## 事实与保留单位

| 内容 | 权威来源与 owner |
| --- | --- |
| 用户、配置、工单关系、参数、路径和会话绑定 | SQLite，[schema.ts](../src/db/schema.ts) |
| 对话、工具结果与会话分支 | Pi JSONL，[Agent](../src/agent) |
| 附件原件 | 文件＋数据库元数据，[attachment-store.ts](../src/http/attachment-store.ts) |
| 脚本、报告与查询导出 | 普通工作文件，[work-files.ts](../src/workspace/work-files.ts) |
| 代码、对象、refs 与索引 | 共享／工单 Git，[workspace](../src/workspace) |

人工评论与 Pi 对话独立。SQLite rollback 不恢复文件或 Git，GET 脱敏不等于磁盘加密。完整恢复要求各介质匹配，不能只换数据库。

## 数据关系

服务关联仓库目录，Deployment 绑定同一服务／环境的基线和查询目标；MCP 有部署归属。工单恰有一条 Workspace，附件、当前会话、仓库历史、关联、抄送、置顶及范围转换分别登记。

issueId 为内部 UUID，issueKey 为配置时区的 `ISSUE-YYYYMMDD-NNN...`；目录名小写。工单必须对应有效 Deployment，resolved 与非空 resolved_at 等价。类型、约束、索引和触发器以 [contracts](../src/domain/contracts.ts)、[schema](../src/db/schema.ts)、[bootstrap](../src/db/bootstrap.ts) 和不可变 [drizzle](../drizzle) 为准，不修改已发布 SQL／journal。

## 当前目录与权限

根配置 `state.directory=data`，当前唯一根为 `/home/idoly/issue-pilot/data`：

```text
data/
├── issues.db{,-wal,-shm}    # 业务和配置绑定
├── git/                   # 共享对象库与只读展开快照
├── workspaces/<小写工单编号>/
│   ├── <repository>/      # 开发 worktree 或只读代码入口
│   ├── .issue-git/        # 工单私有 Git
│   ├── .session-*.jsonl   # 当前及历史会话
│   ├── .attachment-*      # 附件原件
│   ├── .issue-runtime.json
│   └── 普通文件、脚本、报告及缓存
└── control/               # 单实例与事务控制材料
```

state 为 0700，DB／JSONL 为 0600，附件为精确 0400 regular file。统一 issueRoot 是本地模型操作的持久 cwd；管理文件可列名，不能作为普通文件原始下载。依赖、应用 venv 和 Web 构建位于业务根外，不与工单自己的依赖缓存混用。

原 `.issue-pilot` 已迁移且无兼容目录、链接或挂载。历史会话头／正文和离线证据中的旧路径是历史文字；当前会话执行传入 cwdOverride，不批量改写 JSONL。迁移范围及字节保留证据见[迁移记录](records/2026-11-07-host-migration.md)。

## 工单根缺失与恢复

只有创建工单的 claimIssueRoot 可以独占认领空根。运行视图准备、消息受理和导出要求真实根存在，根或祖先被符号链接重定向时拒绝。缺根为 issue_root_missing，非法根为 invalid_issue_root；权限／I/O 错误保留原含义。

根存在时可恢复生成的运行清单／只读代码链接；根缺失时不补空目录、不换会话绑定，不用共享分支冒充历史。保留 DB、残余目录和 Git，按[恢复流程](RUNBOOK.md#恢复与回退)检查匹配材料。数据库检查点不能补回文件。依据：[state.ts](../src/workspace/state.ts)、[project.ts](../src/workspace/project.ts)、[根测试](../tests/workspace/state.test.ts)、[消息受理测试](../tests/agent/message-admission.test.ts)。

## 原始附件

先暂存、计算 size／SHA-256，配合工单事务公开文件与元数据。编辑上传不能重建缺失根或更改异常根权限；新原件在关闭旧会话及预约后写入。

读取核对直属工单根、regular file、0400、大小和 hash；打开后经 `/proc/self/fd` 验证真实位置，从同一描述符发送，避免检查与重新打开之间的路径竞争。取消仍释放句柄，清理失败记录脱敏诊断，不把普通取消当故障。

删除先 quarantine，rollback 恢复，commit 后 finalize；失败不掩盖原错误。Agent 只读原件，不自动生成可编辑副本；消息粘贴图片留在 JSONL。依据：[附件 owner](../src/http/attachment-store.ts)、[附件事务测试](../tests/http/attachment-api.test.ts)。

## 普通工作文件

查询导出生成同目录临时文件，内容与协议收尾均成功后原子替换；提交前失败保留旧文件，不自动重查 SQL。同名路径串行，等待可取消。没有第二套发布输出快照或旧下载路由。

文件和 Source 操作使用目录／文件描述符、打开后路径复核、管理名和 Git 控制路径拒绝；不接受任意宿主路径。清理只处理本次拥有的临时文件，操作和清理错误聚合，不能因为返回 500 就推定目标不存在。

源码新建通过独占临时文件和硬链接发布，避免覆盖竞争创建的目标。发布后临时链接清理失败为 source_create_cleanup_failed，完整目标可能存在，先重读再决定。保存使用读取时 SHA-256，冲突拒绝覆盖。实现和回归见 [source-browser.ts](../src/workspace/source-browser.ts)、[source-pagination.test.ts](../tests/workspace/source-pagination.test.ts)、[work-files.test.ts](../tests/workspace/work-files.test.ts)。

预览、源码、diff、MCP 文本各有预算，不限制普通下载为相同长度。outputs／work／attachments 若存在就是普通真实目录，不剥除旧别名；旧绝对路径和迁移索引不是在线下载兼容层。

## Git 与工作区

共享 bare store 保存基线对象和 refs，共享 checkout 是 detached 展开。开发工单持有私有分支、对象、索引和 worktree，只读复用共享对象，不跨工单共享可写硬链接。

| 仓库集合 | local_path | working_branch |
| --- | --- | --- |
| read_only | 全 NULL | 全 NULL |
| development_workspace | 全非空 | 全非空 |
| development_snapshot | 全 NULL | 全非空 |
| invalid | 空集合、混合或其他组合 | 拒绝并保留检查 |

共享基线按完整 ref 解析。恢复检查 HEAD、common dir、指针和分支，开发只从合法本地分支恢复，不 reset、不远端 fallback、不猜测改绑。

代码释放要求已解决、空闲、路径／分支匹配且干净，包括 staged、untracked 和 ignored；只移除登记代码，保留根、会话、工作文件和私有分支。缺根不能释放／重开。发布使用 compare-and-swap，外部 ref 变化拒绝覆盖。依据：[Git owner](../src/workspace/git.ts)、[lifecycle](../src/workspace/lifecycle.ts)。

## 容量统计

工单 totalBytes 含原件、JSONL、工作文件、缓存和私有 Git；sharedGitBytes 另计。它不是整盘容量或原子快照。

并发读取共享在途扫描；结果和测量缓存一个维护周期，默认 15 分钟，维护周期 0 时缓存为 5 秒。`GET /api/workspaces/stats?refresh=true` 会排入新采样，不能高频轮询替代磁盘诊断。sampledAt 是批次完成时刻，候选字节不等于实际释放量。

高水位按工单根合计触发，只释放满足条件的开发代码，不删除原件／会话／工作文件／私有 Git，且不含共享 Git；不是全盘配额。参数集中在[配置](CONFIGURATION.md#运行参数)，缓存回归见 [lifecycle.test.ts](../tests/workspace/lifecycle.test.ts)。

## 保留与清理

持久事实不能当缓存删除；dirty、untracked、ignored 的开发代码在安全释放前属于有条件持久数据。依赖缓存、共享快照及运行清单可再生，但名称不能证明可删；未知目录、quarantine 和异常临时文件先查 owner。

当前只保留最新及上一份有效数据库检查点，不新建工单文件全量备份。数据库检查点不包含其他介质；创建时机和恢复限制集中在[备份策略](RUNBOOK.md#当前备份策略)。已有历史归档另按[完整恢复点判定](RUNBOOK.md#历史完整恢复点的判定)评估。
