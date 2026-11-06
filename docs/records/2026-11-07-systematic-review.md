# 2026-11-07 代码审查与局部整改

[文档导航](../README.md) · [开发验证](../DEVELOPMENT.md#验证入口与边界)

## 范围与结论

本轮以 `22479503fb515356c90bf757694892ea9cb88271` 为基线，在独立 worktree 安装锁定依赖。第一轮沿业务 owner 与测试查证，第二轮故障注入、交叉复核并补齐调用方，第三轮执行整体检查与隔离验收。覆盖 HTTP／配置／DB、文件与 Git 生命周期、Agent／协议／进程、Web 共享状态与编辑交互、构建和依赖入口；这不是每行代码、所有并发交错或所有厂商服务均已验证的承诺。

确认并修复以下五项问题。未修改公共数据结构、迁移、业务身份规则或依赖版本，未新增框架。持久状态仍由原 owner 管理；没有证据支持全局锁、通用资源管理器、全面重写或因依赖体积替换成熟 SDK。

## 确认问题

| 级别／位置 | 证据、触发与影响 | 最小修复、取舍与验证 |
| --- | --- | --- |
| P2：[参数页](../../src/web/src/app/ApplicationParameters.tsx) | API 允许整数毫秒／字节，页面换算后取整并重建全部 overrides。只改并发也会把 `1501ms` 写成 `2000ms`、`1B` 写成 `0B`，意外改变超时或回收策略。旧实现已复现 | 未编辑字段保留原始整数，编辑值局部按十进制精确换算，不放过亚毫秒／亚字节或超安全整数。显示单位可能是循环小数，不能用显示值反推未编辑字段。[回归](../../src/web/src/app/ApplicationParameters.test.tsx)覆盖合法小数、最大安全整数、无关字段保存及非法精度 |
| P2：[SourceBrowser.createFile](../../src/workspace/source-browser.ts) | 直接写目标，部分写入后 ENOSPC／EIO 会返回失败但留下半文件，后续同名重试报已存在。临时真实 Git 夹具故障注入已复现 | 独占同目录临时文件，关闭后无覆盖发布；清理只处理自己拥有的文件并聚合错误。[回归](../../tests/workspace/source-pagination.test.ts)覆盖失败重试、句柄、目标竞争及临时文件碰撞。发布后清理失败仍可能留下完整目标，恢复边界见[存储](../STORAGE.md#普通工作文件)；HTTP 映射为 500 |
| P2：[DMS 连接](../../src/capabilities/dms.ts) | SDK 初始化失败会后台关闭；应用另行关闭并吞掉错误。模拟上游失败和关闭失败后复现 unhandled rejection，429 路径也会在清理失败后重连 | SDK 和 owner 共用关闭 Promise，owner 等待并保留原错误／清理错误；失败清理阻止新握手，正常关闭可重复观察同一失败。[真实 SDK＋模拟 SSE 回归](../../tests/capabilities/dms.test.ts)覆盖初始化、429、成功连接关闭，既有取消／退避／不重放 SQL 回归继续通过。未增加自动重试或切换凭证 |
| P2：[个人工单队列](../../src/web/src/app/IssueQueue.tsx) | 列表先显示，置顶 POST 成功后迟到的初始 pins GET 返回旧快照，会回退已保存的 UI。延迟 GET／即时 POST 已复现 | 偏好读取期间暂不可置顶，读取结束或失败后恢复；旧身份响应不能释放新身份控件。取舍是首次加载时短暂不可操作，不增加请求。[回归](../../src/web/src/app/IssueQueue.test.tsx)及 [App 集成测试](../../src/web/src/app/App.test.tsx)验证恢复与排序 |
| P3：[会话用量投影](../../src/web/src/app/AgentPanel.tsx) | error／aborted／零用量的 message_end 会把原 `10%` 上下文覆盖成 `0.5%` 或 `0%`，与服务端有效用量规则不一致。三个旧实现回归均失败 | 无效上下文保留上次估计，累计用量／费用和最近缓存命中率沿原口径更新；下一条有效回复仍更新占用。[回归](../../src/web/src/app/AgentPanel.test.ts)覆盖三种输入及后续恢复 |

## 保留的设计与排除项

- 保留 scope queue、Issue reservation、lifecycle、inspection、repository queue 的独立职责和固定顺序。等待后重授权、可变 Pi 钩子后的校验、跨介质 prepare／rollback／finalize 有不同语义，不作为重复逻辑删除。
- 保留目录描述符固定、SHA-256 保存冲突、原件只读、SDK／SRT 边界，以及 Web generation／AbortController、草稿归属和 Monaco 释放机制。
- 截断显示的 `boundedText` 已扣除固定标记长度，当前标记没有省略字符数量；未发现所怀疑的计数错误。Pi MCP 客户端已有分页数量和重复 cursor 保护，不重复实现。
- 直接依赖核对了运行 import、DBHub 动态解析、构建图标／Worker、补丁与工具入口。DBHub 的数据库驱动、Pi 的协议依赖仍有实际用途；没有证据支持删除。本轮未做容量压测，未据局部计时引入性能缓存或拆分模块。

## 验证结果与边界

- `npm ci` 成功，既有 Pi／zod／Monaco 补丁校验通过；未修改锁文件。`npm audit --omit=dev` 报告 0 项漏洞，`pip check` 通过，这些结果不构成安全保证。
- 后端／Web TypeScript、Biome format／lint、`git diff --check` 通过；Markdown 不在 Biome 范围，另核对本轮文档的相对链接与代码依据。
- 有界并发后端测试 **793 项通过、0 跳过**；Web 单 worker 测试 **364 项通过**。首次后端检查因独立 checkout 尚无 `.venv` 失败，补齐固定 requirements 后全量重跑通过；首次 Web 全量发现旧 App 测试在置顶控件加载完成前点击，改为等待可操作后全量通过。
- 生产 Web 构建及 Chromium 真实浏览器验收通过，覆盖 HTTP／SSE、代码读写／差异／冲突、会话与配置交互；Agent／模型使用替代实现，临时 SQLite、文件和 Git 与真实安装隔离。
- SSH/SRT 的本地 OpenSSH 容器验收通过；真实 aliyun CLI 的本地 HTTPS／代理验收 **6 项通过**，覆盖分页、后页错误、证据不完整、预算和取消。主机缺 OpenSSL，使用验证目录内匹配的工具与库完成，不改变主机安装；未查询真实云数据。
- 发布前只读检查通过 integrity／FK、附件 mode／size／hash、会话 JSONL、Git refs／worktrees 和未登记目录核对。已有脏工作树保留；运行实例的检查结果与隔离测试分别记录。

## 尚未确认的事项

- 缺失工单根的策略已在下述后续整改中统一，不再作为未确认项。
- 真实模型、DMS／SLS 云权限、钉钉及各 DBHub 驱动未做厂商集成验收；本地协议通过不代表远端权限或数据正确。
- 安装策略阻止了 DBHub／Pi 传递依赖的五个安装脚本；未放宽全局策略或宣称所有原生驱动可用。现有 Biome 配置弃用提示和 Monaco 大 chunk 提示保留，不以升级依赖或提高告警阈值掩盖。


## 后续整改：持久工单根（基线 `85ee1ee`）

P2：[工作文件准备](../../src/workspace/work-files.ts)、[Engine](../../src/agent/engine.ts) 和[运行视图](../../src/workspace/runtime.ts) 曾递归创建缺失根。已登记根被外移或丢失后，准备／导出可能成功创建空目录，掩盖持久文件缺失；缓存中的流式会话还可能绕过目录准备。旧实现的四项回归已复现失败。

统一由 [state.assertIssueRoot](../../src/workspace/state.ts) 检查，只有创建工单认领根；缺失／非法根拒绝，底层权限与 I/O 错误保留。项目准备在 Git 操作前检查；Engine 在消息受理、缓存 manager 返回及排队输入开始前检查。会话绑定和剩余文件不变，恢复精确原目录后可继续，根存在时生成 manifest 仍可重建。HTTP 对新增稳定码返回 500，页面保留文字和粘贴图片并显示恢复提示。未引入新持久结构或迁移；开发生命周期的既有 `workspace_missing` 拒绝契约保留。主要恢复说明在[存储](../STORAGE.md#工单根缺失与恢复)。

取舍：不再以空目录让受阻工单看似可用；需要维护者确认并恢复持久根。检查发生在应用操作边界，不承诺持续监控或消除外部文件系统变更的所有竞争。旧夹具补齐显式认领，生命周期缺根测试改为保留并恢复原根，不以重建空根模拟数据恢复。新增覆盖见[根校验](../../tests/workspace/state.test.ts)、[项目准备](../../tests/workspace/read-only.test.ts)、[导出](../../tests/workspace/work-files.test.ts)、[会话受理](../../tests/agent/message-admission.test.ts)、[HTTP](../../tests/http/issue-api.test.ts)及[页面](../../src/web/src/app/AgentPanel.test.ts)。

本次后续验证：后端串行全量 **802 项通过、0 跳过**，Web 单 worker **366 项通过**；TypeScript、生产构建、Biome format／lint、`git diff --check` 通过，生产依赖审计为 0 项漏洞，`pip check` 通过。首轮全量的四项旧夹具缺根失败已补齐前置条件，随后全量重跑通过。Markdown 不在 Biome 范围，另检查改动文档的相对链接、锚点与代码围栏。本轮未重跑真实浏览器、SSH 容器或 SLS CLI 独立验收；这些前轮结果不计为本轮通过。已有 Biome 弃用提示和 Monaco 大 chunk 提示保留。

真实厂商验收仍未执行：当前 mall/test 未配置 DMS、SLS 或数据库查询目标；其他服务有测试目标，但尚未明确本轮服务／环境、身份与查询范围。未自行选择生产连接、读取历史密钥或将本地协议验证记作云端通过。
