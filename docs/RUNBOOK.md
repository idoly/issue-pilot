# 运维手册

[文档导航](README.md) · [部署](DEPLOYMENT.md) · [存储](STORAGE.md)

## 操作前确认

确认安装目录、根配置、state root、supervisor、实际依赖和任务活动。提交、推送、服务切换与真实数据操作分别取得授权；不把 health 200 当成所有链路验收。

```bash
curl -fsS http://127.0.0.1:3000/health
systemctl --user show issue-pilot-api.service issue-pilot-web.service \
  --property=ActiveState,MainPID,ExecStart,WorkingDirectory --no-pager
```

通过 /api/me 核对身份，工单 agentRunning 包含排队，另检查 scope／生命周期预约。容器核对 namespace、挂载、实例数、日志和 probes。诊断只输出必要计数、key、耗时和脱敏错误，不输出密钥／SQL／完整敏感结果。

## 按风险发布与重启

| 风险 | 恢复准备 |
| --- | --- |
| 纯 Web／源码／依赖，无持久契约变化 | 匹配代码、依赖、产物、supervisor；已有完整恢复点可用即可 |
| 小型配置／数据修复 | 通过 owner/API，保留精确原始范围或小 DB 检查点 |
| schema／布局迁移、高风险不可逆变更 | 停写后的完整一致恢复点，并在独立副本演练 |

1. 独立安装完成补丁、类型、测试、构建、适用审计和聚焦验收。
2. 纯 Web 原子切换验证过的目录，不需要停止 API，也不在使用中的 dist 原地构建。
3. 后端／依赖更新先排空 Agent 和预约，优雅停止入口与 API，确认子进程退出、租约释放。活动检查失败必须中止后续停服／删除命令，不能继续执行 shell 下一句。
4. 完成所需备份，整体切换匹配代码、依赖和产物，再启动。
5. 检查实际数据、文件、Git 与目录变化；无法解释的变化保留现场，不 reset／改绑定。
6. 验收成功后轮换，保留最新和上一份有效恢复点，未查明失败现场另存。

冷启动会恢复中断状态、准备开发视图、按部署刷新 prod/test 快照及其 commit 基线。它不应改写开发分支／路径；区分合法准备与意外业务修改。

动态 native-tool-executor／network-exec 直接读磁盘源码，即使主进程不重启也受影响，不能在 live checkout 混装依赖。纯重启或例行检查不新建大型全量备份。

## 恢复点范围

完整恢复单位包括 DB 文件组、工单源码／私有 Git／附件／会话／工作文件、共享对象与必要 refs、控制及恢复证据，以及匹配代码、配置、工具／依赖、Web 和 supervisor。保存必要 Operator 配置，按含密钥数据保护。

恢复点放在 state 外，目录 0700、敏感文件 0600。预复制不算完整；停写后完成增量、WAL/SHM 和文件一致核对才标记可恢复。link-dest 只能在备份之间共享，不与 live 可写 inode 共享；元数据变化也需先隔离，不能批量 chmod 共享 inode。

默认排除可再生依赖／构建目录：node_modules、target、.maven-cache、.npm-cache、.venv/venv、__pycache__、.gradle。不能仅按名称判断：本地独有依赖、测试报告或用户成果须检查并记录取舍。

### 排除共享快照

共享展开 checkout 可以不备份，但必须：

1. 核对 detached、HEAD、common dir、干净状态（包括 untracked/ignored）和登记。
2. 确认精确 commit 所需对象完整，并在备份内保留 pin，避免之后 GC。
3. 保存逐路径 manifest、离线重建脚本及说明，实际演练从本地对象重建。
4. 清理对应 worktree 登记，不留下失效指针，不用全局 prune 掩盖未知状态。

不能只留 DB 或只有一个 ref 就称能恢复全部工单；私有 Git 新对象和未提交代码仍需匹配保留。

### 压缩与轮换

两份恢复点可以各存为私有 tar.gz，保留 mode、符号链接、包内硬链接、ACL/xattr 和稀疏信息。压缩先写临时文件，通过 gzip 完整性、tar 内容／元数据比较和 SHA-256 后才删除展开原目录。压缩期间失败保留原件，不把 partial 当完成备份。

恢复先校验再解压到空私有目录，不直接覆盖 live。跨包硬链接未必保留，解压空间不能按压缩体积估计。保存校验值和外部恢复索引；小检查点／历史材料可归入 recovery-notes，不冒充完整恢复点。验收新包成功后才淘汰第三旧包，保留失败证据和必要小元数据。

## 一致性检查

使用可信只读连接或独立备份执行：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

应为 ok 和空集，另核对：

- 每工单唯一 Workspace，有效 Deployment，resolved/resolved_at 等价，当前 Issue type 闭集。
- 活跃用户／开发管理用户保护、单例配置、参数版本与有效值。
- 附件 0400 regular file、size/hash 一致；DB/JSONL 0600、state 0700。
- 会话存在且完整，未知或损坏记录保留，不自动截断、改绑或新建。
- Git HEAD、refs、common dir、backpointer、路径／分支及 staged/untracked/ignored。
- 未登记目录、quarantine、异常临时文件和清理阶段记录。

```bash
# 替换为已确认归属的仓库绝对路径；这些命令只检查，不修复 Git 状态。
REPOSITORY_PATH='/absolute/path/to/confirmed/worktree'
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$REPOSITORY_PATH" rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$REPOSITORY_PATH" branch --show-current
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$REPOSITORY_PATH" \
  status --porcelain --untracked-files=all --ignored=matching
```

## 空间与目录清理

先区分磁盘实际占用、du 的硬链接去重口径、候选大小和真正释放量。依赖缓存、共享 checkout、私有 Git、附件与会话分别计量，不将工单根整体当缓存。

工作区回收由 owner 执行：已解决、空闲、布局／分支匹配且干净，含 ignored。保留期、高水位、目标和维护周期来自参数。手工 DELETE workspace 没有 force；只回收登记代码，保留根、私有分支和其他文件。

缓存清理前确认无 Agent／进程使用，不含 tracked 或独有成果。在线旧快照先检查 DB、运行视图、会话与进程引用，只有无引用且干净才删除，保留对象和必要 pin。

服务／容器／镜像按归属、引用、挂载与当前构建检查，不做宽泛 prune，不处理其他项目或系统服务。历史 dirty 工作树、未知目录和恢复证据保留。物理分配可因硬链接导致“删除目录体积”大于实际释放。

### 工单删除失败边界

管理员 `DELETE /api/issues/:key` 会永久移除数据库记录与工单根，不产生工单文件备份。实际删除真实工单必须取得指定范围授权；按当前数据库恢复策略准备必要的小型检查点，但数据库检查点不能恢复被删除的附件、会话、代码或私有 Git。

删除先把根暂存到 `control/deletions/<key>-<uuid>`，再提交 DB 删除，最后清理暂存。失败或连接中断时，先查 Issue 是否仍存在、正常根及精确暂存路径、Git worktree 登记与 integrity/FK；不要盲目重试、全局 prune 或批量删除暂存目录。

- DB 仍有工单且正常根缺失：可能是进程在暂存后中断，保留暂存和 Git 证据，由 owner 检查后恢复，不能凭目录名自动采用。
- DB 已无工单但仍有暂存：可能在 DB 提交后中断或出现 `issue_delete_cleanup_failed`。目录可能只被部分删除；确认精确工单归属、无业务引用和活动后，经授权完成该目录的清理，不把它作为完整备份。
- `issue_delete_rollback_failed`／Git rollback 失败：保留所有介质，分别核对根、分支、worktree 和 DB，不自动 reset 或修复绑定。

正常成功后 `control/deletions` 不保留本次暂存。共享缓存／快照和已发布分支故意保留，不在此 API 中做跨工单清理。工单删除不新增页面入口。

## 从启动到首张工单的定位顺序

先确定是在自己的演示安装还是已授权维护的业务实例。以下 GET 可用于已知实例的只读观察；完整详情和日志也可能含业务数据，不应原样对外粘贴。不要为排障直接运行迁移、清理目录或反复重启。

1. **进程未监听／health 不通**：查看前台启动错误或已有 supervisor 日志，区分监听失败、数据库迁移、state 租约和代码准备。`application_already_running` 说明另一个 API 持有租约，先找实际进程／挂载；不要直接删除 `control/project-tools.sock`。冷启动可能在监听前访问仓库，不应一看到超时就连续重启。
2. **`global_agent_model_unavailable`**：确认启动进程实际 HOME／Pi agentDir，核对该用户 `models.json.providers` 和模型定义；只在自己 shell 里执行全局 `pi --version` 或 `/login` 不能证明应用模型目录完整。空库首次需要至少一项候选；已有全局选择后模型不可用还可能到保存／执行阶段才暴露。
3. **网页构建缺失／入口异常**：生产入口要求 `src/web/dist/index.html`，缺失会以 `web_build_file_missing:index.html` 拒绝启动，核对是否在独立安装完成 `npm run build`。health 正常而页面不可用时再检查是否用了不带 webRoot 的自定义 API 入口、静态资产发布或代理；若用 4173，核对 Vite 进程、实际端口和 3000 API，Vite 不代理 `/health`。不要在 live dist 现场重建来掩盖发布不完整。
4. **身份或配置拒绝**：使用与客户端同一网关路径读取 `/api/me`；核对 header 绑定、活跃角色和 isAdmin。浏览器账号选择不是登录。GET 目录可读不证明写入身份有效，详见 [HTTP 边界](HTTP.md#身份与访问边界)。
5. **创建后没有回复**：读取对应工单详情和会话。`agentRunning=true` 含等待名额；`workspace.status=failed` 时记录 `lastError`。先检查 owner 模型组、共享 Key、所选仓库／分支／SSH，再检查本地工具与 SRT。确认原因解决后再显式 retry／发送消息，避免重复工单；API 重启不会自动接续模型执行。
6. **能回复但某能力失败**：区分没有部署目标、全局开关关闭、凭证组不完整、网络／工具缺失与外部授权拒绝；DMS／SLS／DBHub／其他 MCP 不是同一执行路径。只针对所选服务和来源环境检查，不能通过切换身份或扩大网络白名单猜测修复。

本地演示的只读查询示例（Bash，替换两处示例值；已有业务实例要用实际受保护网关地址）：

```bash
BASE_URL='http://127.0.0.1:3000'
SUBJECT='demo-developer@example.invalid'
ISSUE_KEY='ISSUE-20260101-001'
curl --fail-with-body -sS -H "X-Issue-Pilot-Subject: $SUBJECT" "$BASE_URL/api/me"
curl --fail-with-body -sS -H "X-Issue-Pilot-Subject: $SUBJECT" "$BASE_URL/api/issues/$ISSUE_KEY"
# 仅在确有此 user unit 的安装中查看，输出按敏感业务日志处理：
journalctl --user -u issue-pilot-api.service -n 100 --no-pager
```

静态检查通过只能证明对应文件／配置可见；health、路由测试、真实模型／SSH／sandbox／外部查询分别验证并分别记录。启动、关闭和错误映射依据为 [api.ts](../src/http/api.ts)，租约依据为 [state-lease.ts](../src/workspace/state-lease.ts)，模型目录依据为 [model-runtime.ts](../src/agent/model-runtime.ts)。

## 启动与清理失败的处理边界

以下是内部诊断／日志中的阶段码，不是每项都原样出现在 HTTP body。启动失败时尚无可用 API，先保存完整的脱敏原因链，再判断是否已经释放资源；不要只根据最外层错误或一次 health 失败做恢复决定。

| 阶段／诊断 | 已确认行为与下一步 |
| --- | --- |
| `workspace_runtime_state_failed` | 运行视图准备失败且 readiness 写回也失败；等待同批准备全部结束后令启动失败。检查 SQLite 可写性、空间／权限和原始准备原因，不直接将 `runtimeReady` 改回 true |
| `api_startup_cleanup_failed` | 组装失败同时清理失败；各已初始化 owner 都会尝试关闭。核对进程／子进程、DB 和租约现场，不能认定失败返回即已安全释放 |
| `api_listen_cleanup_failed` | 监听失败后关闭也失败；同时检查端口占用和清理原因，信号处理器会移除，不自动换端口或启动第二实例 |
| `pi_model_runtime_cleanup_failed` | 模型运行时初始化及私有临时目录清理同时失败；目录所有权保留给后续 close 尝试。检查临时文件系统，不尝试切换 Key、重发模型请求或宽泛清理 `/tmp` |
| `dingtalk_attachment_cleanup_failed` | 下载响应或暂存清理未完成，可能同时发生取消／超时；服务端按失败记录，不把它当作安全取消。先核对导入结果、暂存路径与日志，不循环导入或删除未知目录 |

启动／监听回滚与正常退出共用清理顺序，细节与代码证据见[架构](ARCHITECTURE.md#启动与关闭)。模型临时目录属于凭证敏感状态，钉钉下载可能携带私密业务文件；检查与恢复不应把目录内容、签名 URL 或完整上游错误复制到公开日志。单元／本地协议回归入口见[开发指南](DEVELOPMENT.md#验证入口与边界)，不能替代故障实例的一致性检查。

## 常见故障

| 类别 | 处理 |
| --- | --- |
| 身份／权限 | 核对活跃用户、角色、isAdmin 和网关，不换身份兜底 |
| 模型／SSH／DMS／SLS 凭证 | 核对 owner 和所选完整组，失败不切 Key |
| 工单网站访问失败 | 先核对 `networkMode`；白名单模式检查目标域名、端口及跳转目标，再检查运行主机的 DNS、路由、代理、TLS 和网站登录状态，见[网络模式](CONFIGURATION.md#工单网络访问) |
| personal_git_fetch_failed | 先区分 DNS、TCP、SSH 主机校验、Key、仓库权限和分支；统一错误码不证明 Key 错误 |
| personal_git_ssh_url_required | developer owner 的远程地址必须使用 SSH；HTTPS 即使公开可读也不被该路径接受，核对服务登记的 URL |
| user_git_ssh_credentials_required | owner 缺个人 SSH 私钥；由该用户配置，不改用宿主或其他人的 Key |
| 配置冲突 | 保留草稿，重新读取 revision 或等待活动结束 |
| 源码冲突／Git 漂移 | 保留 refs、索引及未提交内容，不 reset、远端回退或猜测改绑定 |
| 开发工单根缺失 | 拒绝回收／重开，从匹配备份或明确恢复计划处理，不把共享分支当完整历史 |
| 会话缺失／不完整 | 保存原文件和绑定，在副本中检查 |
| 受理结果不明 | 看对话／交付记录／文件，不自动重发 |
| 查询限流／不完整 | 遵守来源、只读和预算，已发送 SQL 不自动重放 |
| rollback/finalize 失败 | 保存现场与所有原因，停止重复 mutation |

代理 DNS 返回 198.18.0.0/15 不等于必然失败；以真实 SSH 握手和严格 known_hosts 校验判断，不能关闭主机验证。远端推送成功但本地 upstream 写入失败先查远端，不重复推送。

SSE 频繁重连时先检查浏览器的 `agent_event_connection_failed`／`agent_event_protocol_error`、代理缓冲与超时，以及 replay → snapshot_ready → live 的顺序。协议错误会触发整轮回放，旧连接迟到帧应被 generation 拒绝；不能通过忽略坏帧或累加旧 footer 来“修复”页面。浏览历史时不自动跟随新内容是正常交互，使用「回到最新」或新消息按钮；刷新页面不取消服务端任务。依据见 [HTTP SSE 约定](HTTP.md#异步执行sse-与分页)及 [AgentPanel](../src/web/src/app/AgentPanel.tsx)。

### 排队、慢页面与旧采样

1. 先看 `runState`：`queued` 尚未取得名额，`running` 还包括准备和收尾。`maxConcurrentIssues` 不是队列容量；增加它之前先区分仓库、模型和工具耗时，不把所有慢请求归因于名额不足。
2. 模型持续有输出时，`modelResponseIdleMs` 不构成总时长截止；工具执行也暂停这个计时器。DMS／SLS／MCP 各用自己的预算，`capabilityConnectionMs` 当前仅作用于 SLS CLI 建连，详见[参数作用范围](CONFIGURATION.md#运行参数)。
3. 首页工单摘要按周期拉取，资源统计另有缓存。核对 `sampledAt`，需要新采样再调用一次 `GET /api/workspaces/stats?refresh=true`；不要连续强制刷新，因为每次可能排入新的磁盘扫描。缓存和计量口径见[容量统计](STORAGE.md#容量统计)。
4. 工单侧栏只展示当前处理人的队列；没显示不等于数据被删除。源码变更列表更新不代表打开的文本已重读；保存失败后的处理见[使用指南](USAGE.md#检查文件与代码)。

本项目没有从这些检查推导出的吞吐量或最大工单数保证。若持续变慢，在独立数据副本中分别测量列表查询／传输、SSE 回放、磁盘采样和仓库准备；保留输入规模及测量条件，不在业务实例上无界压测。

## 恢复与回退

停止所有写入者，保存故障后新增数据和未知现场；校验、解压恢复点，恢复匹配代码／依赖／DB 文件组／工单／Git，保持绝对路径、owner 和 mode；若排除共享 checkout，按包内 manifest 从 pin 重建。

再核对完整性、文件、会话、refs/worktrees、未登记路径和当前有效参数，启动后验收网页、身份、SSE、动态工具及受影响能力。只回退代码或 DB 都不足以恢复跨媒体一致性；需要修复时通过 owner、原始范围和重新授权执行。
