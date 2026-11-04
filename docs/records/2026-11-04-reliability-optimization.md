# 可靠性优化记录（2026-11-04）

## 范围与基线

基线为 `65bbb52` 加任务开始时全部未提交改动。原有改动整体带入分支 `refactor/reliability-cleanup-20261104`，工作目录为 `/tmp/issue-pilot-reliability-20261104`；没有提交、推送、重启或操作生产状态。本文只描述相对任务基线新增的改造，前两轮工作分别见同目录的系统性优化和审查整改记录。

已阅读架构、开发、配置、存储与 Agent 文档，以及根配置、schema、业务契约、工程配置和相关测试。技术栈为 Node strip-types／TypeScript、Fastify、SQLite／Drizzle、Pi、Solid 2、Vite 和 Monaco。

核心调用链是 HTTP／入站 MCP → 业务 owner → SQLite、工作区或 Agent；Agent 再准备身份、凭证、Git／文件与 Pi 会话，事件经 SSE 投影到 Web。审阅范围包括配置与身份、附件事务、工作文件、Git／生命周期、Agent 队列和会话、DMS／SLS／MCP，以及 Web 资源、草稿和源码编辑。此次没有发现需要以大规模重构解决的边界问题，改造集中在有失败证据的错误处理路径。

持久状态包括数据库、JSONL、附件、工作文件与私有 Git；活动 dirty worktree 有条件持久；运行视图和临时凭证配置属于生成状态。测试全部使用临时根，未复制或使用原目录 `.issue-pilot`；worktree 仅链接已有 node_modules 和 Python venv，构建产物生成在 worktree 内。

## 确认并修复的问题

以下均为 P2：常规成功路径不受影响，但合理的运行故障会造成错误状态判断或关键诊断丢失。测试先在未修复实现上失败，再验证修复。

| 位置 | 根因与证据 | 触发与影响 | 最小修复与取舍 |
| --- | --- | --- | --- |
| `src/workspace/state.ts:pathExists` | `access` 的所有拒绝都返回 false；真实 `ENOTDIR` 及注入的 `EACCES`／`EIO` 均被误认为不存在 | 目录损坏、权限或 I/O 故障时，Git store 选择、工作区恢复、会话和源码可用性判断可能走缺失分支；`developmentRepositoryStorePath` 会因此选择共享 store | 复用当前模块的 `isMissing`，仅 `ENOENT` 返回 false，其他错误传播。故障会显式失败，避免默认值掩盖状态；正常存在／缺失不变 |
| `src/capabilities/sls.ts:readSlsLogs` | CLI owner 已聚合查询与临时凭证清理错误，外层却先处理取消／超时并覆盖该错误；两种取消测试均失败 | 调用取消或超时恰逢目录删除失败时，可能残留 AccessKey 配置，却只报告取消／超时 | 将既有 `sls_credential_cleanup_failed` 分支移至取消判断之前；保留原原因和清理错误，不新增重试或凭证回退 |
| `src/capabilities/dms.ts:withDmsSession/queryDms` | 清理 catch 中的 `throwIfAborted` 丢弃关闭失败；查询超时映射再次替换原错误链。查询／导出请求的两种取消及范围解析共五个断言失败 | 查询、范围解析或导出请求被取消，同时协议关闭失败时，无法追踪关闭故障 | 保留一次性 close Promise，显式区分操作失败与成功后关闭，聚合不同错误；超时包装保留 cause。删除失败状态包装对象和两个 unsafe-finally 忽略项；两处内部调用方同步更新，公开工具参数不变 |
| `src/agent/engine.ts:schedule` | 只有 cleanupFailures 非空才调用诊断回调；操作失败、清理与状态保存成功的测试未收到原错误 | 后台模型或准备失败时，工作区只留下稳定失败码，原错误不进入诊断回调 | 总是报告原错误，有次级故障则沿用聚合。保留队列内清理、稳定公开原因和日志回调异常隔离；增加正常故障日志是预期行为 |

## 设计与改动清单

保留现有 owner、SQLite 事实来源、Pi 会话管线、分层队列、预约顺序和跨介质事务边界。路径缺失规则留在存储模块，协议关闭规则留在 DMS，SLS 错误分类留在 SLS，后台失败诊断留在 Engine；路由没有增加第二份实现。

生产代码仅修改上述四个文件。回归测试对应修改 `tests/workspace/state.test.ts`、`tests/capabilities/sls.test.ts`、`tests/capabilities/dms.test.ts`、`tests/agent/engine.test.ts`，新增七项测试并强化三项既有断言。同步更新 `docs/STORAGE.md` 与 `docs/AGENT.md`。

没有新增通用清理层、缓存、依赖、数据表或配置，没有修改已发布迁移；没有依据不足的性能改造。保留协议错误净化、边界校验、幂等关闭与并发保护。收益是错误语义完整、故障可观察、实现更直接；未测量或宣称吞吐、延迟改善。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 修复前回归验证 | 原三处缺陷五项断言失败；DMS 五项断言失败，均符合预期 |
| 最终聚焦测试，四个完整测试文件 | 102 项全部通过 |
| 全量后端，`--test-concurrency=2` | 695 项：694 通过、1 跳过、0 失败；包含临时 API 启动、`/health`、重启及资源隔离测试 |
| 全量 Web，Vitest `--maxWorkers=1`／jsdom | 31 个文件、320 项全部通过 |
| `npm run typecheck` | 后端与 Web 均通过 |
| 已有 Biome format --write | 实际格式化本轮八个 TS 文件，未重排其他文件 |
| `npm run format:check`、`npm run lint` | 通过；仅已有 recommended 配置弃用提示 |
| `npm run build` | 通过；仍有 Monaco 等 chunk 超过 500 kB 的既有提示 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `.venv/bin/python3 -m pip check` | No broken requirements found |
| `git diff --check` 与任务基线对照 | 通过；本轮仅四个生产文件、四个测试文件、两个 owner 文档及本文变化，其余既有改动保留 |

沙箱内 Node 测试子进程未能报告具体测试结果，npm 审计网络请求被 EPERM 拒绝；获得执行授权后在沙箱外以同一 worktree、临时测试状态重跑并通过，未修改项目检查配置。

## 限制与剩余风险

- SSH 端到端测试因本机没有 openssh-server 夹具跳过，不算通过；未运行容器中的对应夹具。
- 未使用真实模型、DMS／SLS 凭证或生产部署验证；Web 验证为 jsdom，没有新增真实浏览器验收。
- 清理失败现已保留错误与恢复证据，但代码不能保证在文件系统拒绝删除后仍删除凭证，或在协议关闭失败后确认远端资源状态；仍需 Operator 按错误处置，不自动修复或切换身份。
- 这是基于当前调用链和测试的局部改造，不代表每个入口、依赖及并发交错均已证明安全。没有待确认的重大接口、架构或数据迁移变更。
