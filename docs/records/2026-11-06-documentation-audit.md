# 2026-11-06 文档核查与可靠性修复

[文档导航](../README.md)

代码基线为 `07285a86172f96183e5d5713d8666099f0735011`，工作分支为 `docs/current-implementation-guide`，独立 worktree 为 `/tmp/issue-pilot-docs-current-implementation`。先完成文档核查，再按后续授权实施局部代码修复；当前指南包含这些修复，不能只检出原基线就假定具有相同行为。未操作真实 state、重启业务服务、提交或发布。

## 分轮范围与设计结论

| 方向 | 核对内容 | 结果 |
| --- | --- | --- |
| 入口与契约 | 根配置、锁文件、启动／迁移、模型目录、角色、Schema、HTTP／MCP | 补齐离线模型目录示例、developer 远程仓库 SSH 必需条件、响应编号和范围转换边界；修正 MCP 测试“不监听端口”的误述 |
| 页面展示与交互 | 个人队列、首页身份切换、Agent 草稿、源码保存、DTO、SSE、Markdown | 明确队列筛选、内存草稿、500ms 自动保存及失败后重新读取；修正参数页面的作用范围说明 |
| 性能与并发 | Engine 名额／排空、统计缓存、SSE 背压、超时参数、MCP 生命周期 | 修正缓存 60 秒的错误，区分队列长度与执行名额、连续空闲与总时长；修复 MCP 预算更新缺口 |
| 身份与容量 | 等待后重授权、用户停用、服务范围、入站 MCP 解码、网关／容器 | 修复发送者停用竞态；在 JSON 解析前限制 MCP 请求、解码前限制附件总量；补充 hostPath 节点限制 |
| 存储与资源 | 工作文件原子替换、附件原件验证、失败清理、取消和句柄关闭 | 保留跨介质事务及完整性校验；补齐主错误与清理错误的联合诊断 |
| 文档整合 | 版本、导航、主说明位置、命令、链接、代码围栏、JSON 示例 | 更新既有指南；新增本记录和模型目录示例，未引入文档框架、合并、删除或重命名文件 |

现有 owner 分工、分层队列、prepare／rollback／finalize、SSE generation 和源码哈希冲突检查有明确用途，继续保留。目录读取的 `allSettled` 等待全部 metadata 查询后才关闭描述符，工作文件队列包含失败清理，附件全量 hash 核对保障原件完整性；不能为减少代码或 I/O 删除这些边界。本轮没有证据支持全局锁、通用执行框架、存储重写或新增抽象层。

当前规模边界仍包括全量工单列表、内存草稿、无持久执行调度器和无内置登录／逐工单 ACL。没有负载测量支持宣称吞吐或延迟提升，也没有确认可直接删除的大块闲置实现；不为凑重构范围删除动态加载、迁移或恢复代码。

## 确认问题及修复

以下复现描述的是修复前基线；当前行为以对应 owner 和回归测试为准。

### P2：消息等待期间停用发送者仍被受理

- **根因与触发**：[消息路由](../../src/http/agent-routes.ts) 只在 `engine.send` 前检查用户，[Engine](../../src/agent/engine.ts) 的 admission／steering 等待后未复核发送者。[用户变更](../../src/http/user-routes.ts) 只预约 reporter／assignee 的工单，因此非 owner 发送者可在等待期间被停用。
- **修复前证据**：临时 SQLite、真实消息／用户路由及 Engine，用门闩暂停 `sessionQueue`，只替换模型执行。停用返回 200，随后消息仍返回 202、写入 `issue_user` 并安排一次执行。新增显式／默认身份、queued／steering 四个初始回归也均因 `202 !== 400` 失败。
- **影响**：停用未阻止尚未持久受理的在途消息，不代表失活用户能新发任意请求。
- **修复**：路由把固定请求身份的重授权回调交给 Engine，在 `sessionQueue`／`steerQueue` 等待后、修改 Git 作者和持久输入前检查。steering 转普通排队时再次检查；授权失败保留原 HTTP 错误，不进入会话故障清理。
- **取舍与验证**：内部 `send` 多一个可选回调，Engine 无需依赖 HTTP 用户模型；已受理消息不追溯撤销。[mutation-identity.test.ts](../../tests/http/mutation-identity.test.ts) 新增六种路径，检查拒绝时无记录、无作者改变、无 Pi 输入，以及下一有效请求不会重放拒绝输入。默认身份在同一请求中固定，不改用其他活跃用户。

### P2：服务 MCP 会话保留旧调用超时

- **根因与触发**：[应用扩展](../../src/mcp/pi-extension.ts) 在配置加载时保存固定 timeout，Pi 注册工具又捕获固定 `timeoutMs`；管理员修改参数后，已有会话的新请求仍用旧值。
- **修复前证据**：临时 Pi 目录、真实 Pi MCP 扩展和[stdio 慢工具](../../tests/helpers/mcp-stdio-server.mjs)，从 1,000ms 改成 5,000ms 后仍在约 1,001ms 报 `MCP request timed out after 1000ms`。这是旧值捕获的复现，不是性能基准。
- **影响**：已有会话无法及时使用调高预算，也不能按调低预算收紧后续请求。
- **修复**：应用配置提供动态 `timeout`，既有 Pi 补丁将工具的 `timeoutMs` 改为 getter；每次请求开始时取值，在途请求保持开始时的预算。资源读取使用 SDK 原有动态路径；不重建会话、不增加执行层、不重放失败请求。
- **取舍与验证**：新增一个受版本校验的 SDK hunk，升级时需复核，见[补丁说明](../../patches/README.md#服务-mcp-调用预算)。[mcp-extension.test.ts](../../tests/agent/mcp-extension.test.ts) 通过真实 PiSessionRuntime／SRT／本地 stdio 覆盖直接工具和 Codemode、调高调低、资源读取、在途预算、连接复用、重连及不重放；模型使用替身。

### P2：入站 MCP 缺少有效请求和附件总量边界

- **根因与影响**：基线 [server.ts](../../src/mcp/server.ts) 的 JSON 请求字节上限为 `Number.MAX_SAFE_INTEGER`，JSON 解析后才校验单附件大小；多个合法附件会叠加 Base64 解码、Blob 和 multipart 内存。该分配路径构成可预测的容量风险；未做内存耗尽实验，不能称为已复现的拒绝服务攻击。
- **修复**：[根配置](../../issue-pilot.config.ts) 将 MCP JSON 请求限制为 32 MiB，在解析前由 Fastify 拒绝；附件解码前先检查整组，单件和合计上限均为 20 MiB，数量仍为 20。超限分别返回 HTTP `413 payload_too_large` 或工具错误 `mcp_attachments_too_large`；既有单件／编码校验继续有效。
- **取舍**：MCP 创建工单不再接受合计超过 20 MiB 的附件。HTTP 流式上传规则不变。此限制是每请求预算，不能当作整个进程的内存／并发容量；可信入口仍需按部署负载控制速率和并发。
- **验证**：[application-mcp-budget.test.ts](../../tests/http/application-mcp-budget.test.ts) 两项在修复前失败；修复后验证声明长度／流式超限在 dispatch 前拒绝、小请求可重试、附件超限没有 Base64 解码或工单创建，以及合计恰好 20 MiB 创建一次。未运行破坏性压力测试。

### P3：参数页说明比实际作用范围更宽

[ApplicationParameters.tsx](../../src/web/src/app/ApplicationParameters.tsx) 曾把 `capabilityConnectionMs` 标为“外部连接超时”，但生产消费点只有 [SLS CLI](../../src/capabilities/sls-cli.ts) 的 `--connect-timeout`；网络列表写“个人组可追加”，实际追加项属于全局 Agent runtime。

已改成“SLS 连接超时／SLS CLI 建连，下次查询生效”和“全局 Agent 配置可追加”。没有改变运行时预算、单位或凭证模型，也没有为文字变化增加镜像实现的测试。

### P2：读取与清理同时失败时丢失诊断

[工作文件 owner](../../src/workspace/work-files.ts) 的目录关闭和失败后文件关闭可能覆盖原始读取／路径错误；[附件下载路由](../../src/http/attachment-routes.ts) 在取消时无条件忽略异常，也会吞掉附件 owner 聚合的 `attachment_read_cleanup_failed`。这会妨碍故障定位，不能据此推导正常读取的数据损坏。

工作文件读取与关闭双失败现在聚合为 `work_file_read_cleanup_failed`，只关闭失败时保留原错误。附件路由仅静默处理原始取消原因；其他取消期间错误仍记录稳定 reason 和 errno，再结束已断开的响应，不记录路径或原始错误链。没有新的清理框架或接口变化；实际关闭失败仍需排查文件系统，不能承诺资源已释放。

[工作文件回归](../../tests/workspace/work-files.test.ts) 与[附件路由回归](../../tests/http/attachment-api.test.ts) 新增五项故障注入／对照测试，修复前三项失败、两项对照通过。覆盖双失败、单独关闭失败、取消后的正常／异常关闭、日志脱敏和下一次读取。相关四个套件共 48 项通过。

### P2：参数保存期间切换身份会卡住表单

[参数页](../../src/web/src/app/ApplicationParameters.tsx) 原先只按 subject 变化重新加载，未重置 `saving`。管理员 A 保存期间切换到管理员 B，A 的 `finally` 因 generation 已失效不再清状态，B 的保存入口及按钮一直被阻止；同 subject 的 `isAdmin` 变化也不会重新加载。

已按 subject／isAdmin 一起维护请求代际，切换时重置保存、错误及冲突状态，卸载时失效旧响应，提交前再次检查管理权限及加载状态。没有取消已经交给后端的保存，也不把迟到结果应用给新身份。三个初始回归在旧代码失败，修复后覆盖旧请求成功／失败、再保存、提权／失权及迟到响应隔离，见 [ApplicationParameters.test.tsx](../../src/web/src/app/ApplicationParameters.test.tsx)。

## 工单通用网络能力

后续按用户确定的范围增加全局 `networkMode: "open" | "allowlist"`，默认 `open`。本地工具及 stdio MCP 仍使用同一个 SRT 边界，通过公开网络回调放行外部连接，不按网站 API／HTTP 方法增加读写限制。模式保存在现有参数 JSON，无 SQL 迁移、依赖升级、浏览器执行层或网站凭证系统。

SRT 先执行既有明确拒绝／允许名单，再调用应用回调；回调每次读取当前参数，切换不重建会话，也不中断已接受的隧道。当前 SRT 的 DNS 地址检查不覆盖 IP literal，因此自动放行路径使用 Node `BlockList` 保留回环、本机、链路本地及元数据边界；正常业务内网地址可达。明确配置的 allow/deny 优先级不变，没有把临时开放变成网站操作授权系统。实际语义、旧安装采用新默认的影响及上游代理边界集中在[配置说明](../CONFIGURATION.md#工单网络访问)。

页面提供模式选择，开放模式隐藏但保留名单，保存省略与根默认相同的模式。回归覆盖保存／重启加载／非法模式、模式切换时保留名单、版本冲突重新加载；本地上游代理夹具用于验证 SRT HTTP／SOCKS、POST、内网目标、宿主拒绝及热切换，不能据此宣称真实网站账号可用。

另在临时工单根通过真实 `issueNativeTools → SRT → curl` 对 `https://gitlab.xhgjdev.com/users/sign_in` 发起无凭证 GET，只保留状态码，响应正文丢弃：`open` 为 `http=200;connect=200`，空名单的 `allowlist` 为 `http=000;connect=403`。未使用账号、Cookie 或 Token，未登录或执行网站写操作；该结果只证明本次主机网络条件下的 HTTPS 连通及模式切换。

## 实际文件范围

- 指南：根 `README.md`；docs 下 `README.md`、`USAGE.md`、`ARCHITECTURE.md`、`HTTP.md`、`CONFIGURATION.md`、`DEVELOPMENT.md`、`DEPLOYMENT.md`、`RUNBOOK.md`、`STORAGE.md`、`AGENT.md`。
- 代码：`issue-pilot.config.ts`、`src/agent/engine.ts`、`src/http/agent-routes.ts`、`src/http/attachment-routes.ts`、`src/mcp/pi-extension.ts`、`src/mcp/server.ts`、`src/web/src/app/ApplicationParameters.tsx`、`src/workspace/work-files.ts`。
- 后续网络参数：`src/agent/issue-sandbox.ts`、`src/configuration/contracts.ts`、`src/configuration/parameters.ts`；参数页面复用上述组件。
- 补丁：`patches/@earendil-works+pi-coding-agent+1.5.0.patch`、`patches/README.md`。没有依赖升级、Schema 或迁移变更。
- 回归：`tests/agent/mcp-extension.test.ts`、`tests/helpers/mcp-stdio-server.mjs`、`tests/http/attachment-api.test.ts`、`tests/http/fixture.ts`、`tests/http/mutation-identity.test.ts`、`tests/workspace/work-files.test.ts`；新增 `tests/http/application-mcp-budget.test.ts`。
- 后续回归：`src/web/src/app/ApplicationParameters.test.tsx`、`tests/http/application-parameters.test.ts`、`tests/db/application-parameters-migration.test.ts`、`tests/browser/acceptance.mjs`；新增 `tests/agent/sandbox-network.test.ts`。历史迁移 SQL／journal 未修改。
- 新文档／示例：本记录、无密钥的 [models.json](../../examples/models.json)。没有删除、合并或重命名文件。

## 验证记录与边界

检查使用独立 worktree、隔离依赖安装和临时业务根。`PI_CODING_AGENT_DIR` 指向临时模型示例目录，不使用真实 Operator 配置。初期受限环境的 `listen EPERM` 不计为通过，允许本地 socket 后才记录实际结果。

文档阶段的核心路径执行真实 HTTP 路由／存储和回环 HTTP 的 MCP SDK，Agent／模型为测试替身；34 项与 28 项聚焦集合有重叠，不合并为独立覆盖数。Engine／SSE／Codemode 和统计缓存聚焦检查退出 0。Web 文档核对覆盖 85 项 jsdom 测试。模型目录示例经真实 `PiAgentModelCatalog` 离线加载，未发模型请求。

代码阶段使用[开发指南](../DEVELOPMENT.md#验证入口与边界)的有界并发等价命令运行 `npm test` 两部分：后端 `--test-concurrency=2`，Web `--maxWorkers=1`。以下为本次实际结果；聚焦集合与全量有重叠。

| 检查 | 结果 |
| --- | --- |
| 消息身份、Engine admission／recovery | 57 项通过；包含六个新竞态回归 |
| Pi MCP、协议／stdio | 37 项通过；已有取消／关闭覆盖继续通过 |
| 入站 MCP 创建与容量 | 14 项通过 |
| 工作文件与附件 | 48 项通过，含五项故障／对照回归 |
| 后端全量 Node test | 最后一轮 759 项通过、无失败或跳过；包含网络模式及本地 SRT／SSH 夹具，不代表真实 Git 托管服务账号已验收 |
| Web 全量 Vitest／jsdom | 最后一轮 32 文件、340 项通过 |
| TypeScript／格式／Lint | `npm run typecheck`、`format:check`、`lint` 及 `git diff --check` 通过；实际对改动的 TS／TSX／MJS 执行 Biome 格式化 |
| 生产 Web 构建 | 通过；仍有既有 Monaco 大 chunk 提醒 |
| Chromium 浏览器验收 | Chromium 156.0.8078.4，通过生产 Web、真实回环 HTTP／SSE、临时 Git 和替代 Agent 的现有交互场景；含网络模式真实 HTTP 保存、名单保留与 `/health` 检查，不代表真实模型或生产部署 |
| 生产依赖审计、Python 依赖 | `npm audit --omit=dev --audit-level=high` 为 0 漏洞；`pip check` 无依赖冲突 |
| SDK 补丁 | postinstall 校验通过；独立副本反向还原、正向应用／反向检查及字节比较通过 |
| 文档与示例 | 相对链接、锚点、代码围栏、表格、Bash 语法及 JSON 静态检查通过；示例经 Biome stdin 格式检查 |

后续网络改造的聚焦后端集合共 13 项通过，覆盖真实 SRT 代理、原有文件／进程边界、参数存取及旧库默认。子代理执行时曾出现 Node `InternalCallbackScope` 原生断言，主代理重跑未复现，未为此改动运行时代码。新网络夹具最初错误假定上游代理会转发 loopback；SRT 实际绕过上游直连，已删除该错误假设，显式 loopback 授权仍由已有随机端口夹具验证。新增参数控件曾使浏览器的默认布局验收失败，改为开放模式隐藏名单后重新验证；没有降低原有布局断言或修改全局样式。新夹具的 `finally` 抛错被 Lint 检出，改为清理后统一报告主错误和清理错误。

Biome 排除 Markdown／docs／examples，未引入格式化工具；这些文档保持现有风格，另检查相对路径／锚点、围栏、表格、JSON 与 Bash 块。JSON 示例使用 Biome stdin 检查。全仓格式检查仍会提示既有 `recommended` 配置弃用，不为此修改规则。

未验证真实模型、GitLab 登录、DMS／SLS／钉钉厂商授权或生产部署，没有性能与负载压测结论。网络模式对所有工单生效，未实现浏览器登录、网站凭证或按单张工单授予网络权限的系统。外部链接没有逐一联网验证，页面图没有重新拍摄。这些结果不证明所有代码安全，也不表示已经发现全部闲置代码或缺陷。
