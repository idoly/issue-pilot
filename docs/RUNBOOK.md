# 运维指南

给日常维护人员阅读。[文档导航](README.md) · [部署](DEPLOYMENT.md)

## 先看这三个位置

用 `idoly` 在目标机器执行：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
curl -fsS http://127.0.0.1:3000/health
tail -n 100 /home/idoly/.local/state/issue-pilot-host/application.log
```

日志可能涉及业务信息，只在受信终端查看；向外报告时只保留必要工单编号、错误码和耗时，不原样传播正文、SQL 或密钥。

## 重启慢或失败

| 卡在哪 | 应检查什么 |
| --- | --- |
| 旧进程停止 | 是否仍在处理工单、等待工具或执行失败收尾；最多等待 1800 秒，不强杀。超时后重复执行 stop 只继续等待，不重发信号 |
| 新进程启动 | 查看数据库初始化（Opened application database）耗时；普通重启不扫描历史工单或共享 Git 快照。上一次启动的日志在同目录的 `application.<UTC 时间>.log`（保留 5 份） |
| 等待健康 | 每轮检查，通过即返回；600 秒是上限，不是固定延迟 |
| 超时或发现未知进程 | 保留现场，先查身份和日志，不重复启动、不按端口杀进程 |
| 日志出现 `database_foreign_key_violation` | 迁移后外键检查发现孤立行（信息列出“表#rowid->父表”），服务在监听前停止。不要手工删除这些行或关闭检查；保留数据库和日志，停止写入者核对涉及的行，按[存储参考](ai/STORAGE.md#database-checkpoints)从迁移前检查点恢复后再处理 |

应用由本机脚本管理，没有 systemd service。启动失败不删除租约 socket 或目录来“解锁”。详细身份检查和收尾边界见[启动与关闭](ai/ARCHITECTURE.md#startup-and-shutdown)。

## 从启动到首张工单的定位顺序

| 现象 | 最小排查 |
| --- | --- |
| 网页打不开 | 先查 status、health 和 Web 构建，不先重建数据 |
| 模型不可用 | 核对运行用户的模型目录、应用模型选择和 Key；全局 Pi 登录不替代应用凭证 |
| 没有回复 | 查看排队状态、工单错误与最后一段对话，区分准备失败和模型失败 |
| Git 失败 | 核对工单 owner 的个人 SSH、仓库 URL 和 known_hosts，不换身份试探 |
| 查询失败 | 分别核对目标、所选凭证、权限、超时和结果完整性，不把失败当作空结果 |
| 对话加载慢 | 区分接口等待、传输体积和浏览器渲染；大图片和历史会话会增加负担 |
| 保存冲突 | 保留草稿，重新读取并合并，不取消版本或哈希检查 |
| 目录缺失、路径漂移 | 停止重试和清理，保留文件、数据库及 Git 供维护者检查 |

重启不会逐工单拉取或恢复代码。历史工单打开已保存的版本；新 Agent 轮次按工单配置准备当前代码。若 Agent 准备失败，先检查工单错误再重试。已释放工单按需读取已登记的提交，定时维护不会重建视图。若共享快照校验失败，先保留现场，核对 Git 指针、提交和工作区内容。

工单操作超时或响应不明时，先查是否已经生效。不要自动重建工单、重复发送消息或重新执行查询。

## 对话流返回 200 但没有内容

`agent-stream` 使用 SSE。HTTP 200 只表示响应已建立，不能证明历史回放已完成。页面要等到 `snapshot_ready` 才应用快照；当前前端连续 45 秒没有收到事件就关闭连接，等待 1 秒后重连，时间配置见[根配置](../issue-pilot.config.ts)。

先检查是否收到 `message`、`snapshot_ready` 和后续心跳。如果回放停在中途，服务端 socket 缓冲已清空、socket `needDrain=false`，但 HTTP response `needDrain=true` 且发送器仍等待 `drain`，应检查 SSE 写入完成通知。回放未结束时，快照和心跳都可能尚未发送；仅凭状态码或重连次数不能归因于网络、WebSocket 或历史体积。如果快照已到达但页面仍为空白，应继续检查浏览器异常和当前连接的快照是否应用。

修复 [`fd3d895`](https://github.com/idoly/issue-pilot/commit/fd3d895f8ad09009eca5166d87086e9a2b2d3ede) 在写入完成回调或 `drain` 到来时恢复回放，避免只等待未触发的事件。发送顺序、队列预算、迟到回调隔离和断线清理的约束见 [SSE 技术合同](ai/HTTP.md#async-execution-sse-and-paging)，回归入口为 [sse.test.ts](../tests/http/sse.test.ts)。遇到类似现象应核对停滞阶段，不把所有 45 秒超时都视为同一故障。

## 按风险发布与重启

先按[部署更新](DEPLOYMENT.md#已有应用的部署更新)判断是否需要重启、哪些产物要更新。只有需要重启的发布走下面的停机流程：

1. 停机前准备并核对要切换的源码、依赖、Web 产物和目标根配置。活动检查失败就停止后续操作；获得授权后排空工单及预约，再停止旧进程。
2. 需要恢复材料时按[备份策略](#当前备份策略)准备；常规发布和重启跳过数据库检查点与全量数据扫描。
3. 切换已准备的产物并启动，检查进程身份、健康、首页及受影响行为。迁移、存储／Git 修复或异常恢复才检查相关数据完整性、权限和 refs；有异常证据再扩大范围。

## 当前备份策略

- **只做数据库级检查点**，不新建工单文件全量备份。
- 常规检查和正常重启不创建检查点；数据库迁移或高风险数据库修改前创建一致检查点并验证。
- 成功后只保留最新及上一份有效检查点；未知失败材料先检查，不批量清理。
- 在线 WAL 数据库不能只复制 `issues.db` 主文件。
- 数据库检查点**不包含**附件、对话、工作文件或 Git，不能用它恢复整张工单。

需要执行检查点或恢复时，由维护者按[存储参考](ai/STORAGE.md#database-checkpoints)操作；不会因为有备份就自动获得修改或删除权限。

## 退役密钥离线留证

迁移 0082 会删除 `user_credentials.model_api_keys`、`application_settings.mysql_stdio`、`application_settings.max_concurrent_issues`，以及部署配置中的 `nacos`、`db`、`redis`、`mq`、`es`、`mcpServices`。删除后只能从数据库检查点恢复。

1. 按[数据库检查点](ai/STORAGE.md#database-checkpoints)停止写入、释放租约并制作、验证检查点。
2. 从检查点副本导出，不要连接在线数据库：

   ```bash
   node --experimental-strip-types scripts/export-retired-secrets.ts \
     --database /absolute/path/to/checkpoint/database.sqlite \
     --output /absolute/private/path/retired-secrets.json \
     --checkpoint-copy
   ```

   输出目录必须是当前用户所有的 0700 目录；文件以 0600 新建且不覆盖已有文件。脚本只输出计数，不打印密钥；退役列已删除时会拒绝导出。
3. 确认导出文件可读后，再发布并运行迁移 0082。
4. 导出文件按凭据保管：限制访问，不放进工单目录、日志、普通备份或聊天记录。

## 恢复与回退

工单根缺失时不要 `mkdir` 补空目录，不换会话绑定、不猜测分支或远端恢复。保留现有数据库和残余文件，先确认恢复材料与当前状态匹配。

旧机器已经停止，新机器有新写入后，不能直接启动旧机器充当无损回退。未知目录、有修改的工作区、隔离暂存和失败材料都不能当作缓存删除。

## 工单状态审计

怀疑数据库记录和目录不一致时，停止写入后，在已验证的源码目录执行只读检查，将参数改为目标数据根的绝对路径：

```bash
node --experimental-strip-types scripts/check-issue-state.ts --state-root /absolute/path/to/state
```

检查工单关联的工作区记录、解决状态以及新旧目录的归属。排查共享 Git 时可追加 `--shared-git`，校验全部共享快照的 Git 指针、提交与工作树。单独排查开发仓库绑定时，追加 `--development-git`，核对私有仓、工作树双向指针和镜像分支。只有共享分支、没有私有仓或工作树的记录需要另找历史证据。遇到异常先保留现场；审计不修复、不清理，常规重启也不需要执行它。

## 开发工单 Git 迁移

记录过的开发分支只从工单私有仓读取。对历史共享工作树，核对审计中的工单、仓库哈希、数据库记录的分支以及共享仓该完整引用的提交。已释放工单另需独立证据确认提交，例如发布记录或可核对的旧工单私有仓；只有共享引用不足以迁移。分支不符时保留现场，勿加入清单。

清单是 JSON 数组。每项填写 `issue`、`repository`（审计的 20 位仓库哈希）、`branch`（数据库记录名）及 `sharedCommit`（核对过的 40 位提交）；已释放工单还需 `releasedEvidence`，填写可复核的证据出处，不放凭据。先预演：

```bash
node --experimental-strip-types scripts/migrate-development-git.ts \
  --state-root /absolute/path/to/state --manifest /absolute/path/to/manifest.json
```

正式执行前停止应用和所有 Git 写入者，确认清单，再追加 `--apply`。工具拒绝已有租约套接字，整份清单通过校验才写入；迁移逐条生效，失败即停，已完成项会输出 `migrated`。复核失败项和残留的 `.preparing-*`、私有仓及工作树指针后再重试，勿清理未知路径。迁移后重新运行 `--development-git` 审计并复查迁移的 refs、工作树和未提交变更，再启动服务。

## 工单删除失败边界

管理员 API 删除是永久删除，不是代码回收；页面没有删除入口。即使返回 500 或断线，也可能已经部分生效。不要反复删除、手动清空目录或重建记录；按[存储参考](ai/STORAGE.md#deletion-and-cross-medium-failure)检查准确的暂存位置和事务阶段。

## 首次开发准备中断

首次准备开发代码时，如果进程在 `git worktree add` 之后、数据库保存仓库记录之前退出，重试会返回 `workspace_path_already_exists`。系统不会自动接管这个目录，需要停止写入后人工确认：

1. 只读查询数据库，确认该工单该仓库没有 `issue_repositories.local_path` 记录。
2. `workspaces/<key>/<仓库名>` 是 `workspaces/<key>/.issue-git/<仓库哈希>` 私有仓登记的工作树，当前分支是该工单的 `hotfix-`/`feature-` 分支，没有超出基线的提交，`git status --porcelain --ignored` 输出为空。

全部符合时，只移除这个工作树登记：`git -C <私有仓> worktree remove <工作区>`。保留私有仓和分支，再重新准备，系统会沿用已有的私有分支。任一项不符（有改动、多出提交、分支或指针不一致）时保留现场，不要删除目录、重置分支或改数据库。

## 空间清理

先看磁盘余量和带采样时间的资源统计。自动回收只释放已解决、空闲、干净且绑定正确的开发代码，不删工单根、附件、会话、工作文件或私有分支。

开发工单释放后登记原提交，浏览历史代码不要求展开新快照；需要文件目录时才按原提交展开。已有共享代码快照的自动回收默认关闭。只有确认本地 Git 对象足以恢复原文件、验证历史浏览及正在执行的会话后，才调整根配置的共享快照高水位。磁盘告警先处理可重建的下载缓存；数据库检查点不能替代 Git、附件和会话的备份。

回退到不支持按需快照的版本前，先停写并用支持按需快照的 Git 管理逻辑展开仍被工单引用的原提交。无法确认提交或目录归属时保留现场。

不要对 `data/`、共享 Git、未知临时文件或容器存储执行宽泛删除／prune。清理必须先确认具体 owner、用途及当前是否使用；历史材料的判断见[存储参考](ai/STORAGE.md#retention-and-cleanup)。

## 对话文件不完整或末行未写完

发送消息、查看历史或 SSE 返回 `agent_session_file_incomplete`，或历史列表把某会话标为“文件不完整”，通常是 ENOSPC/OOM/SIGKILL 中断了 Pi 对工单根下 `.session-*.jsonl` 的追加，最后一行没有写完。不要自动重建空会话、改写 JSONL 或改会话绑定。

1. 停止应用和所有写入者，保留当前绑定与文件。
2. 只读确认范围：文件非空、首行是合法 session 头、只有末尾一行缺换行或 JSON 不完整；记录大小和 SHA-256，并把原文件复制到状态根之外受控位置留证（不在 `data/` 内新增备份）。
3. 只有确认是“单条末尾残行”时才可截断到最后一个完整换行；截断前先留证并核对偏移。空文件、头部损坏、多行损坏或中间非法 JSON 一律保留现场，不截断、不重建。
4. 恢复通过产品执行：开发人员在该工单编辑对话中重置会话（需空闲、未解决且 `expectedSessionId` 匹配）。当前版本重置只校验旧文件头部身份，可对残缺尾行直接重置；旧文件字节保持不变，新会话文件在绑定提交前已落盘。
5. 重置后旧会话继续保留并标记不完整。显式查询该旧消息回执会报错而不是返回 unknown，表示它可能已执行，不要重发；新消息进入新会话。

## 发布或重开后工单卡住

### 发布：移除工作树之后、写入释放标记之前中断

1. 停止写入者，确认工单已解决且无活动轮次。
2. 只读核对数据库：`issue_workspaces.released_at` 为空、`issue_repositories.local_path` 仍指向原工作区，而这些目录已不存在。
3. 对每个记录的仓库核对证据：私有仓 `workspaces/<key>/.issue-git/<20位哈希>` 的 `refs/heads/<working_branch>`，与共享仓 `git/repositories/<同一哈希>` 的 `refs/heads/<working_branch>` 及 `refs/issue-pilot/snapshots/<提交>` 完全相同；`git -C <私有仓> worktree list` 不再包含该工作区。任一项不符时保留现场，不补引用、不删除私有仓。
4. 全部符合且确认数据库事务未提交后，停止写入、按存储合同做数据库检查点，再在一个 SQLite 事务内补完与 `markReleased` 相同的状态（时间为 epoch 秒）：

   ```sql
   UPDATE issue_repositories SET local_path = NULL, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE issue_id = '<工单UUID>';
   UPDATE issue_workspaces SET status='stopped', runtime_ready=0, released_at=CAST(strftime('%s','now') AS INTEGER), last_error=NULL, updated_at=CAST(strftime('%s','now') AS INTEGER) WHERE issue_id = '<工单UUID>';
   ```

5. 重启后再次执行发布，应返回 `alreadyReleased: true`；运行 `--development-git` 审计核对 refs 与工作树。只有部分工作区已移除或提交不一致时不要补状态，保留现场人工确认。

### 重开/转开发：创建工作树之后、数据库提交之前中断

1. 停止写入者，先判断事务是否已提交：若 `issue_workspaces.released_at` 已清空、`issue_repositories.local_path` 已写入、`issues.status` 为 open（转开发则已有开发仓库记录），说明已提交，刷新页面即可，不重复操作。
2. 未提交时数据库仍是旧状态（重开：resolved、released_at 非空、local_path 为空；转开发：read_only 记录），但工作区目录已存在。重试会报 `workspace_path_already_exists`，系统不会自动接管。
3. 只读核对：`git -C <私有仓> worktree list` 包含该路径；工作树 HEAD 等于记录的 `working_branch`（重开时该分支必须等于发布保留的提交，可用 `refs/issue-pilot/snapshots/` 与共享仓分支核对）；`git -C <工作区> status --porcelain --ignored` 为空且没有多出提交。
4. 全部符合时只移除工作树登记：`git -C <私有仓> worktree remove <工作区>`；保留私有仓、分支和保留引用，再重试重开/转换。不要手工插入 `local_path`。
5. 任一项不符（有改动、多出提交、分支或指针不一致）时保留现场，不删除目录、不重置分支、不改数据库；转换中旧只读运行链接已移除时，先按存储合同的转换回滚要求核对恢复，无法确认则保留现场。

## 模型响应空闲超时

日志出现 `model_response_idle_timeout`（level 50）表示当前 Agent 轮次在配置的 `modelResponseIdleMs`（默认 5 分钟）内既没有收到助手流式增量，也没有正在执行的工具；看门狗会中止该会话，本轮以该错误失败。

- 先看同一工单前后的模型请求、工具执行和错误码，区分模型端长时间无输出、网络中断或调用方等待；工具执行期间不计时。
- 这不是进程崩溃或重启：服务保持健康，已完成的工具副作用不回退。不要自动重发消息、重建工单或重启服务；用户确认后再发送。
- 连续复现时按工单和提供方归类，保留时间、错误码和耗时，不复制对话正文、SQL 或密钥。
- 管理员可在“配置 → 参数”调整 `modelResponseIdleMs`；已建立的会话在下次计时时读取新值，无需重启。

## 发布与监控

协调发布使用仓库脚本，预检、检查点、Web 轮换和回退规则见[部署指南](DEPLOYMENT.md#协调发布后端与-web)；不要在运行目录原地构建。

```bash
cd /home/idoly/issue-pilot
scripts/host/release.sh \
  --build /absolute/path/to/release-checkout/src/web/dist \
  --revision "$(git rev-parse HEAD)" \
  --previous-revision <上一运行版本> \
  --checkpoint /home/idoly/.local/state/issue-pilot-host/checkpoints
```

健康探针用于 cron 巡检，不替代发布后的手工检查。它读取 `/health`、数据盘余量、可用内存、最近 24 小时的日志轮转数和当前日志大小；正常只输出一行并以 0 退出，任一越界以 1 退出。它只读状态，不启动、停止或清理任何进程与文件。

```bash
cd /home/idoly/issue-pilot
scripts/host/health-probe.sh
# 可调阈值：--min-free-mb 2048 --min-available-mb 128 --max-restarts-24h 8 --max-log-mb 256
```

用 `crontab -e` 为运行用户安装（每 5 分钟一次；cron 的非零退出按 `MAILTO` 发信）：

```cron
*/5 * * * * cd /home/idoly/issue-pilot && scripts/host/health-probe.sh >> /home/idoly/.local/state/issue-pilot-host/health-probe.log 2>&1
```

`restarts_24h` 统计轮转日志数，发布重启也会计入，告警时先查应用日志和进程身份。探针日志按需人工截断，不要删除仍用于判断重启次数或故障现场的文件。
