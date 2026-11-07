# 运维手册

[文档导航](README.md) · [当前部署](DEPLOYMENT.md) · [存储](STORAGE.md)

## 操作前确认

本机应用和数据分别为 /home/idoly/issue-pilot 与其 data；没有 systemd service。以 idoly 执行：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
curl -fsS http://127.0.0.1:3000/health
```

核对目标、变更范围、实际进程、Agent 活动及相关预约。诊断只保留必要 key、计数、耗时和稳定错误，不原样传播凭证、客户正文、完整 SQL 或日志。仅文档或日常健康检查不创建备份、重启或全量扫描状态。

## 当前备份策略

仅保留数据库级恢复保障，不创建／续存工单文件全量备份。日常检查和纯重启不创建检查点；数据库迁移或高风险修改前创建一致 SQLite 检查点，验 integrity/FK，成功后只保留最新及上一份有效检查点。未知失败材料先检查，不做宽泛轮换删除。

在线 WAL 不能只拷主 DB 当备份。数据库检查点不含附件、会话、工作文件或私有 Git；它们丢失时不能完整恢复工单。没有定时备份入口、自动 down migration 或跨介质自动恢复命令。

### 创建并验证数据库检查点

以下 Bash＋Python 3 示例适用于已授权的数据库迁移或高风险数据修改。先停止请求入口，等待 Agent、预约和维护结束，停止所有写入者并确认租约释放；脚本本身不会停服。将两个绝对路径替换为已核实的数据库文件和 **state 外**的私有检查点父目录。该目录须已存在且为 0700；不要指向工单根或公共临时目录。

```bash
DATABASE_FILE='/absolute/path/to/state/issues.db' \
CHECKPOINT_ROOT='/absolute/path/to/private-db-checkpoints' \
python3 - <<'PY'
import contextlib
import os
import pathlib
import sqlite3
import tempfile

source = pathlib.Path(os.environ['DATABASE_FILE'])
root = pathlib.Path(os.environ['CHECKPOINT_ROOT'])
if not source.is_absolute() or not source.is_file() or source.is_symlink():
    raise SystemExit('database must be an existing regular file at an absolute path')
if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.stat().st_mode & 0o777 != 0o700:
    raise SystemExit('checkpoint root must be an existing private 0700 directory')
checkpoint = pathlib.Path(tempfile.mkdtemp(prefix='db-checkpoint-', dir=root))
partial = checkpoint / 'database.sqlite.partial'
partial.touch(mode=0o600, exist_ok=False)
with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live:
    with contextlib.closing(sqlite3.connect(partial)) as saved:
        live.backup(saved)
        if saved.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise SystemExit('checkpoint integrity check failed; preserve partial for inspection')
        if saved.execute('PRAGMA foreign_key_check').fetchall():
            raise SystemExit('checkpoint foreign key check failed; preserve partial for inspection')
partial.rename(checkpoint / 'database.sqlite')
print(checkpoint)
PY
```

只有最终 `database.sqlite` 表示本例完成了 DB 复制和两项检查；`.partial` 不能当作已验证检查点。记录对应代码 commit、实际根配置、原 DB 路径、时间和本次变更范围，按敏感数据保管；示例不输出业务行或凭证。检查结果不证明工单文件／Git 匹配，也不证明旧版本代码能够读取新 schema。操作验收后核对清单，只保留最新与上一份有效数据库检查点；失败材料先查明，不用宽泛目录清理代替轮换。

## 按风险发布与重启

1. 独立 checkout 完成匹配锁文件、补丁、类型／行为测试、构建及适用审计。
2. 纯 Web 使用已验证完整目录切换，不在 live dist 原地构建。后端／依赖变更先减少入口、排空 Agent／预约，运行 ./restart.sh stop 并确认进程和租约释放。
3. 按风险准备恢复材料：纯重启不备份；schema／高风险 DB 修改创建小型检查点；跨文件／Git 变更先明确各 owner 的 prepare／rollback／finalize。
4. 整体切换相互匹配的代码、依赖、配置和产物，./restart.sh start，观察 status、health 和启动日志，再验证受影响功能。
5. 仅按影响范围验收。文档检查链接；样式检查页面；普通后端检查相应接口；真实布局／附件／Git 修复才核对相应 mode/hash／绑定／refs／dirty 状态。范围不明或出现异常才扩大扫描。

失败的活动检查必须中止后续停服／清理，不能继续 Shell 下一条。冷启动会恢复中断状态、刷新只读快照并准备运行视图，但不会自动开始所有未完成模型轮次。动态 native executor 直接读磁盘源码，不能以主进程尚未重启为理由混装文件。

本机重启脚本等待关闭最多 1800 秒、健康最多 600 秒，超时不 SIGKILL。Engine 本身排空无独立截止时间；先读日志和状态，避免重叠启动。精确启停行为见[部署](DEPLOYMENT.md#启动停止与重启)。

## 从启动到首张工单的定位顺序

| 现象 | 可执行的定位 |
| --- | --- |
| 目标本机 health 不通 | restart.sh status，读 application.log；区分租约、迁移、模型目录、Git 准备和监听失败，不先删 socket |
| global_agent_model_unavailable | 核对运行进程 HOME／Pi agentDir 和 models.json.providers，执行[离线目录检查](CONFIGURATION.md#operator-模型目录)；全局 pi 登录不代表 DB Key 完整 |
| web_build_file_missing:index.html | 核对部署的是匹配代码的完整 dist，在独立目录构建；不要在 live 现场混用旧产物 |
| 身份／配置拒绝 | 经与客户端相同入口 GET /api/me，核对网关头、active、role、isAdmin；GET 目录可读不代表写授权 |
| 创建后无回复 | 查看工单 workspace.lastError、会话和 agentRunning；包含排队，按 owner 模型组、SSH／基线、SRT 顺序定位 |
| 单一证据能力失败 | 区分无目标、能力关闭、凭证残缺、网络、工具缺失与厂商权限；不换用户猜测 fallback |
| 中文菱形或乱码 | 新登录检查 locale charmap；Hyper-V 基本文本控制台改用中文字体 SSH 终端，不批量转码 |

查看日志只在受信终端进行：

```bash
tail -n 100 /home/idoly/.local/state/issue-pilot-host/application.log
```

DMS 错误按 phase、elapsedMs、sqlDispatchAttempted 和 retryAfterSeconds 定位；发送尝试不等于 SQL 完成，未知结果不自动重放。SLS 的权限、签名、目标不存在、限流和 incomplete 不能包装成空成功，见[Agent](AGENT.md#原生证据查询)。真实验收只覆盖[记录中的目标](records/2026-11-07-host-migration.md)。

## 一致性检查

仅在 schema／批量迁移、实际存储修复或异常恢复涉及范围中执行，不是每次重启的额外步骤。通过只读连接或独立检查点查询：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

预期分别为 ok 和空集，再按变更范围检查唯一 Workspace、有效 Deployment、resolved/resolved_at、附件 0400／size／hash、DB／JSONL 0600、state 0700、会话完整性、Git refs／worktree／指针／dirty 状态与未登记目录。

只读 Git 检查先替换为已确认归属的工作树，不包含修复：

```bash
REPOSITORY_PATH='/absolute/path/to/confirmed/worktree'
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$REPOSITORY_PATH" rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$REPOSITORY_PATH" status --porcelain --untracked-files=all --ignored=matching
```

## 空间与目录清理

先用 df 看文件系统余量，不将首页工单容量当全盘配额。工单／共享 Git 和硬链接去重口径不同，候选字节不等于实际释放；不高频强制刷新全树扫描。

回收由 owner 判断已解决、空闲、干净且绑定一致，包括 ignored；只回收登记代码，保留根、私有分支及其他事实。缓存需确认无活动、无 tracked／独有成果。未知目录、历史 dirty worktree、quarantine、指针漂移都保留检查，不 reset、不全局 prune。

本轮目标原迁移包已在真实查询验收后按精确目录删除；小型 manifest／校验记录留在 ~/.local/share/issue-pilot-runtime/delivery-provenance。它们不是数据备份。源机原归档与原数据没有在本轮删除，目标新增写入不会自动回流。

### 工单删除失败边界

管理员 DELETE /api/issues/:key 永久删除记录及根，不是代码回收，无 force。实际删除须授权指定工单范围；数据库检查点不能恢复被删附件／JSONL／代码。活动或关联引用须先按接口解除，不直接删除目录。

删除先由 Git owner 移除干净 worktree，再暂存根到 control/deletions/<key>-<uuid>，提交 DB 后删除暂存。DB 失败尝试恢复根和 worktree；提交后清理失败不会恢复部分已删内容。500 或连接中断不能推定未删除。

先查 Issue 是否存在、正常根、精确暂存、Git 登记及相关完整性；DB 有工单但缺根时保留暂存待 owner 检查；DB 已无工单但有暂存时可能是部分清理，确认归属和无引用后按授权收尾。rollback 失败保留各介质，不自动改绑。正常成功无本次暂存，其他工单和共享 Git 不在删除范围。

## 启动与清理失败的处理边界

启动回滚尝试维护、Engine、配置队列、模型运行时、DB 和租约的关闭，正常退出沿用顺序；多个原因聚合，不保证文件系统故障后已全部释放。先确认真实进程、残留子进程和租约，不能仅凭端口空闲或日志报错删 socket。

model-runtime、MCP、SLS 或工作文件清理失败时，保留对应错误和精确临时路径的归属证据；不从 /tmp 按前缀批量删未知内容，不将清理失败视作请求未执行。修复宿主 I/O／权限原因后再按 owner 关闭或限定范围处理，必要时停止相关新请求。

## 历史完整恢复点的判定

本节用于判断另行提供的历史材料，不授权创建／继续保留新的全量工单备份。完整恢复至少需要匹配的 DB、原件、JSONL、工作文件、私有／共享 Git 和必要 refs、代码／依赖／构建／配置，以及生成目录的准确重建条件。

归档需有来源、停写一致性、SHA-256、gzip／tar 内容比较和权限／链接保留记录；只压缩成功或只有 DB／一个 ref 不够。排除共享展开 checkout 须确认干净、精确 commit 对象和 pin 可用并演练本地重建。排除依赖也须确认不是 tracked 或独有成果。备份 link-dest 不能与 live 可写 inode 共享，元数据修改可能影响两边。

本次原包只是初始快照，不含停写后的最终增量，不能与迁移检查点混合恢复。迁移清理后的 manifest 仅能说明当时来源，不能恢复已删除的包。

## 恢复与回退

停止新增请求和所有相关写入者，保留当前介质，确认代码／schema／配置与检查点版本相容，再制定精确恢复范围。DB 回退不回退文件、Git 或外部副作用；无匹配介质时只能报告缺失范围，不能承诺整张工单恢复。

缺失工单根不 mkdir、不换 session 绑定、不从远端或共享 ref 猜测恢复。目录仍在但视图失效可由 owner 检查后重建生成材料，持久根丢失则需要匹配历史来源。详细边界见[存储](STORAGE.md#工单根缺失与恢复)。

源机旧服务已停止并禁用自启，原始数据保留。目标已有新写入后，直接启动源实例会分叉；必须先停写、比较增量并重新设计同步／回退，不能直接恢复旧服务。主机重启后需手工启动当前 restart.sh。
