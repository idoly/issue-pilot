# 系统性优化记录（2026-11-04）

> 本文是阶段性工作记录，不是现行行为依据；现行契约以源码与 [文档导航](../README.md) 中的 owner 文档为准。
> 本轮代码改动未提交，保存在分支 `refactor/systematic-optimization` 的工作区；`main` 分支只包含本文档。

## 1. 基本信息

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-04 |
| 代码基线 | `main` @ `de1349f` |
| 工作分支 | `refactor/systematic-optimization`（未提交、未推送） |
| 范围 | 架构与模块边界、业务规则集中、重复逻辑、可靠性、性能、工程治理 |
| 方法 | 先通读架构与核心 owner，再做四个方向的只读分析（领域/配置/能力、HTTP、工作区/Agent、Web），逐项核对后实施最小改动 |

## 2. 起始状态

工作区在本轮开始前已有未提交改动（8 个文件），属于上一轮未完成的工作：

- `credentialOwnerSubject`（凭证属主：处理人，否则报告人）提取到 `domain/contracts.ts`。
- `isStableErrorCode` 提取到 `diagnostics.ts`，替换三处内联正则。
- 工作区统计缓存改为按维护周期复用一次采样，并在生命周期预约时失效。
- `tests/workspace/lifecycle.test.ts` 增加统计缓存测试。

该状态存在一个阻断问题：`src/http/issue-routes.ts` 与 `src/http/workspace-routes.ts` 调用了 `isStableErrorCode` 却未导入，`npm run typecheck` 失败。本轮先补齐导入，保留并延续上述改造。

## 3. 已实施改动

### 3.1 正确性与可靠性

| 位置 | 问题 | 改动 |
| --- | --- | --- |
| `src/workspace/lifecycle.ts` | 自动维护释放空间后只清理字节缓存，统计快照仍可命中，仪表盘最长 15 分钟显示已释放工单 | 新增 `invalidateMeasurements()`，维护与预约路径统一失效统计与字节缓存；补充测试 |
| `src/agent/engine.ts`、`src/workspace/lifecycle.ts` | `lastError` 直接持久化原始错误文本，Git 命令行、绝对路径、SQL 参数可能入库并经 API/页面展示 | 新增 `stableErrorReason`，只保存稳定 snake_case 码，其余回退固定码 |
| `src/capabilities/dms.ts` | DMS 工具发现分页无上限，异常服务可持续分页直到超时 | 套用与通用 MCP 客户端一致的 `limits.mcp.tools` 预算 |
| `src/web/src/app/CodeBrowser.tsx` | 创建/重命名/删除文件或打开 diff 时，挂起的文件加载可能在之后覆盖新状态 | 在路径操作完成回调和 `compare` 开始时递增 `fileRequest`、中止 `fileController` 并清除加载态 |
| `src/web/src/app/CodeBrowser.tsx` | 状态栏固定显示 `Spaces: 2`，实际编辑器 `tabSize` 为 4 | 修正为 `Spaces: 4` |
| `src/http/issue-routes.ts` | 工单详情未设置缓存头，与其余接口不一致 | 补充 `Cache-Control: private, no-store` |
| `src/http/api.ts` | 附件清理与序列化完整性错误码未进入稳定映射，统一落到 `internal_error` | 补充 `attachment_*_cleanup_failed`、`issue_workspace_not_found`、`issue_service_not_found`、`issue_environment_not_found` |

### 3.2 业务规则集中与去重

| 位置 | 重复内容 | 集中方式 |
| --- | --- | --- |
| `src/domain/contracts.ts` | 凭证属主规则散落于凭证加载、Agent 事件流、工单创建/更新 | `credentialOwnerSubject(issue)` |
| `src/domain/contracts.ts` | 4 处重复构造 Git 提交身份及邮箱回退 | `personGitIdentity(person)` |
| `src/domain/contracts.ts`、`src/mcp/server.ts` | Issue key 正则在 HTTP、MCP 参数、MCP 资源 URI 各写一份，大小写语义不一致 | 导出 `ISSUE_KEY_PATTERN`；资源 URI 改用 `parseIssueKey` 校验 |
| `src/diagnostics.ts`、`src/http/api.ts`、`src/http/issue-routes.ts` | 3 处重复遍历 `cause`/`AggregateError` 链 | `errorChain`、`errorCode`、`stableErrorReason` |
| `src/http/route-context.ts` | 3 处相同的“拒绝原因 → 409”映射 | `throwRefusal(error)` |
| `src/http/workspace-routes.ts`、`src/http/issue-routes.ts` | 同上 | 改用 `throwRefusal` |
| `src/capabilities/registry.ts`、`src/configuration/credentials.ts` | 两份完全相同的 `fail`/`inputRecord` | 从 registry 导出复用 |
| `src/configuration/credentials.ts` | 能力解析使用二元三元表达式，新增能力会被静默解析为 SLS | 改为穷尽 `switch` |
| `src/agent/engine.ts` | 能力列表硬编码为 `["dms", "sls"]`，与 `CAPABILITY_KEYS` 漂移 | 改为遍历 `CAPABILITY_KEYS` |
| `src/mcp/server.ts` | 错误码透传使用 `[a-z_]+`，与稳定码规则不一致 | 改用 `isStableErrorCode` |
| `src/web/src/app/model.ts` 及 5 个组件 | 环境显示名查找（找不到回退 key）重复 5 次 | `environmentName(environments, key)` |

### 3.3 按反馈收敛的改动

根据“避免过度校验、过多防御性代码”的要求，撤回了本轮曾加入、但收益不足或改变产品语义的两处限制：

- 入站 MCP 请求体上限（原 `requestBytes` 保持 `Number.MAX_SAFE_INTEGER`）。
- Pi MCP 扩展的分页游标缓存上限。

保留的 DMS 工具预算属于与既有 MCP 客户端对齐的一行改动，未新增概念。

## 4. 验证

执行于工作分支，代码改动未提交：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（后端 + Web） | 通过 |
| 后端 `node --test --test-concurrency=2 'tests/**/*.test.ts'` | 687 项：686 通过、1 跳过、0 失败 |
| Web `vitest run --maxWorkers=1` | 31 个文件、319 项全部通过 |
| `npm run build` | 成功 |
| `npm run lint` | 无错误（仅既有的 Biome 配置迁移提示） |
| `npm run format:check` | 通过 |
| `git diff --check` | 干净 |

## 5. 发现但本轮未改

| 事项 | 现状与原因 |
| --- | --- |
| 入站 MCP 请求体无上限 | `requestBytes = Number.MAX_SAFE_INTEGER`，超大 JSON 会在附件校验前整体缓冲；是否设产品级上限需产品与部署决定 |
| 部分变更路由不校验显式身份 | 关联工单、状态修改、工作区释放、代码文件变更等路由未调用 `requireCurrentUser`，而同组其他路由会拒绝未知/停用身份 |
| `Cache-Control` 逐路由重复 | 30 余处相同头；可改为 `/api/*` 全局 `onSend` 钩子，但会牵动大量处理函数签名 |
| 单个测量失败使整轮统计/维护失败 | `du` 超时等会拒绝整轮扫描；保留失败可见性，未做逐项吞错 |
| 开发分支继承正式分支规则三处实现 | `workspace/deployment.ts`、`configuration/read.ts`、`http/service-configuration.ts` 的事务边界不同，合并会引入耦合 |
| 错误码映射重复 | `issue_already_running` → 409 在 8 处重复，守卫风格不一致 |
| Web 错误文案与表单重复 | 同一 HTTP 失败在不同组件呈现不同文案；新建/编辑表单的负责人、抄送、优先级区块近似重复 |
| `createFile` 非原子写入 | 写入中断可能留下截断文件；本次未改 |
| 仅供文件内使用的导出类型 | 多个类型的 `export` 无外部引用，属冗余表面积，未批量清理 |

## 6. 后续建议（按优先级）

1. 决定入站 MCP 请求体预算，明确大附件场景的部署上限。
2. 统一变更路由的身份校验，避免停用用户继续写入。
3. 评估 `/api/*` 统一缓存头钩子，删除逐路由重复。
4. 统计/维护按工单隔离测量失败，同时保留失败诊断。
5. 评估把“开发分支继承正式分支”收口为一处纯函数，前提是不增加跨事务耦合。
6. Web 侧统一 API 错误模型与最近的请求取消，再处理表单控件抽取。
