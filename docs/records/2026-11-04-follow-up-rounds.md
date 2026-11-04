# 三轮追加整改（2026-11-04）

## 基线与结论

继续使用 `refactor/reliability-cleanup-20261104` 分支及 `/tmp/issue-pilot-reliability-20261104` worktree。基线为上一轮可靠性改造完成后的全部文件；保留从 main 带入的改动，不提交、推送或操作生产状态。前一轮工作见 [可靠性优化记录](2026-11-04-reliability-optimization.md)。

三轮分别沿 HTTP 身份与生命周期、MCP 连接收尾、Web 草稿资源归属检查调用链。新增 18 项回归场景，均验证旧实现失败、修改后通过；没有为凑轮次引入无证据的重构或性能改造。

## 第一轮：身份与排队后授权

**P1，已复现。** `src/http/issue-routes.ts` 的状态与关联修改、`workspace-routes.ts` 的回收、`source-browser-routes.ts` 的大多数写操作没有检查当前账号活跃状态。测试中未知账号可将工单标记已解决并收到 200，关联修改收到 204；源码提交在预约前取得用户后也未重新读取。失效账号、过期身份头或排队期间被停用的账号均是合理触发。

**P2，已复现。** HTTP 在进入生命周期方法前的授权不能覆盖 lifecycle／inspection 排队等待。转换操作等待期间将调用者由 developer 降为 product，原实现仍进入后续业务检查，以 409 而非权限错误结束；重开可在账号停用后继续成功。默认身份还必须在等待前固定，否则执行时可能换成另一活跃用户。

最小修复：

- 源码写操作统一经过现有 mutate helper，预约前固定身份，预约内重新读取账号和工单；提交作者直接使用该处用户资料。
- 状态、关联与回收入口补齐现有活跃账号检查，排队后重新授权，不新增角色限制。
- Lifecycle 的四种人工变更接受调用者提供的授权回调，在两个队列等待之后执行；HTTP 策略仍留在路由，workspace 模块不依赖 Fastify 或 ApiError。范围转换／迁移同步传递回调，后台维护不需要模拟 HTTP 用户。
- 回调在业务错误转换之外执行，保留 400／403，不把权限失效伪装成可恢复的 409。

修改 `src/http/{issue,source-browser,workspace}-routes.ts`、`src/workspace/{lifecycle,scope-transition}.ts`。新增 `tests/http/mutation-identity.test.ts` 的 11 项测试：未知／停用账号、提交作者更新、显式／默认身份的排队停用、四种生命周期操作保持授权错误、排队期间开发角色撤销。

这些操作可能改变持久 SQLite、Git 与工作区；测试只注入临时数据库和根目录。保留 lifecycle → inspection → Issue reservation 顺序，未引入全局锁。HTTP 请求结构不变，非法身份明确失败是预期行为变化。

## 第二轮：MCP 连接测试与关闭

**P2，已复现。** `src/mcp/client.ts:inspectMcp` 在 finally 中吞掉 close 失败，因此发现工具成功但连接关闭失败仍返回成功；发现或取消失败后的关闭错误也丢失。`connectMcp` 的失败收尾同样忽略关闭错误。

故障注入还复现了 SDK 1.32.2 在初始化失败时 `void this.close()` 导致的未处理 rejection：仅让 transport.close 直接拒绝、随后在应用捕获，并不足以处理 SDK 那个未被等待的 Promise。

修复保留一次性 transport close Promise：SDK 的后台关闭调用等待一个可完成的包装，应用 owner 始终等待原 Promise 并报告失败。连接测试必须列工具和关闭均成功才能返回结果；双失败聚合保留，关闭失败优先于取消分类。只返回 `mcp_connection_cleanup_failed`、`mcp_operation_cleanup_failed`、`mcp_close_failed` 等稳定码，原错误留在 cause；现有 HTTP owner 只记录稳定码。

只修改该 owner 和 `tests/capabilities/mcp.test.ts`，没有改 SDK、升级依赖或新增通用资源框架。四项新增测试覆盖成功后关闭失败、操作双失败、取消双失败、初始化双失败，并验证单次关闭、可重试及无私密错误文本外泄。stdio、SSE、Streamable HTTP 和 HTTP 调用方测试一并执行。

## 第三轮：Web 旧响应与图片资源

**P2，已复现。** `AgentPanel.submit` 把发送失败恢复到捕获的草稿对象，却不检查对象是否已被身份切换移除。旧图片恢复到不可达记录后没有 owner 释放 URL；旧 `resolved_issue_cannot_run_agent` 响应还会禁用同工单的新身份输入框。

**P3，已复现。** `ApplicationResourcesProvider` 销毁时只移除 beforeunload 监听，没有释放草稿持有的图片 URL。

修复在现有 `AgentDraftStore` 增加基于 Map 对象身份的 `isCurrent`，发送结果按具体记录归属生效，替代把全局通知 revision 当作归属证明。被移除记录的失败响应只释放提交图片；不会恢复草稿、设置错误或修改新身份状态。导航后仍保留的记录继续恢复失败并通知重挂载面板。应用资源销毁时清空其草稿，释放未发送图片。

修改 `AgentPanel.tsx`、`agent-drafts.ts`、`ApplicationResources.tsx` 和对应两个测试文件。两项迟到响应测试及一项资源销毁测试均先失败再通过；保留既有跨导航草稿及发送恢复测试。影响仅为浏览器内存状态和 Blob URL，不迁移持久数据。

## 设计与验证

继续保留现有 owner、类型、SDK、SQLite 事实来源与分层并发设计。授权回调隔离 HTTP 规则与生命周期队列；草稿记录身份代替通知次数判断；连接结果与清理结果由原协议 owner 负责。没有新增生产模块、依赖、缓存、兼容层或通用框架，没有修改迁移或部署配置。本轮没有测量或声称性能提升。

同步更新 `docs/CONFIGURATION.md` 与 `docs/AGENT.md`。相对本轮基线仅九个生产文件、四个测试文件、两个 owner 文档及本文发生变化。

| 验证 | 结果 |
| --- | --- |
| 旧实现回归验证 | 身份 11 项、MCP 4 项、Web 3 项均按预期失败；身份夹具修正后在独立基线副本复验 |
| 身份最终聚焦测试 | 11 项通过 |
| 工单、关联与生命周期相关测试 | 49 项通过（此时身份测试为最初九项；新增两项另行通过） |
| MCP／stdio／HTTP／身份相关测试 | 28 项通过（此时身份测试为十项；新增转换用例另行通过） |
| Web 两个完整聚焦文件 | 52 项通过 |
| 全量后端，`--test-concurrency=2` | 710 项：709 通过、1 跳过、0 失败；包含隔离 API 启动／健康、Git、协议与资源清理测试 |
| 全量 Web，`--maxWorkers=1` | 31 个文件、323 项通过 |
| `npm run typecheck` | 后端与 Web 通过 |
| Biome format --write | 实际格式化全部 13 个改动 TS／TSX 文件 |
| `npm run format:check`、`npm run lint` | 通过，仅已有配置弃用提示 |
| `npm run build` | 通过，有 Monaco 等大 chunk 与插件耗时提示 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `.venv/bin/python3 -m pip check` | No broken requirements found |
| `git diff --check`、任务基线比较 | 通过，无前轮改动丢失，无运行数据或生成产物混入补丁 |

## 限制与风险

- Subject 头仍是身份选择，可信网关必须负责认证和绑定；本轮不替代网关认证设计。
- 已发送并可能被服务端受理的消息不能靠清除浏览器草稿撤销。本轮隔离迟到响应，不提供跨请求幂等或外部副作用恰好一次保证。
- 网络或文件系统清理失败现已报告，但仍可能需要 Operator 处置；没有自动切换身份、删除未知状态或重放操作。
- 没有连接真实外部模型、DMS／SLS 或验证生产部署；Web 使用 jsdom，没有真实浏览器验收。现有 SSH 端到端测试因缺少 openssh-server 夹具而跳过，未执行容器夹具验证。
- 本轮不涉及需确认的重大架构、公共请求结构或数据迁移变更，验证也不等于所有调用路径和并发交错均已证明安全。
