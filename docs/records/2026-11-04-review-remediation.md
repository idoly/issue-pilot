# 审查整改记录（2026-11-04）

> 本文是阶段性工作记录，不是现行行为依据；现行契约以源码与 [文档导航](../README.md) 中的 owner 文档为准。
> 本轮改动未提交、未推送，与上一轮未完成改动一起保存在 `main` 的工作区；代码改动涉及 28 个修改文件与 1 个新增文件（不含本文档）。

## 1. 基本信息

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-04 |
| 代码基线 | `main` @ `65bbb52` + 上一轮未提交改动 |
| 分支 | `main`（工作区，未提交） |
| 范围 | 依赖这些未提交改动的正确性缺陷、规则一致性与文档同步 |
| 方法 | 逐条核对审查发现 → 阅读 owner 代码与调用点 → 只修复复现或可推理的真实缺陷 → 补充回归测试与验证 |

## 2. 起始状态

工作区已包含上一轮系统性优化（详见 [系统性优化记录](2026-11-04-systematic-optimization.md)），本轮在此基础上审查，不重新引入或回退既有设计。审查给出的候选中，部分经核实不成立，已明确排除（见第 5 节）。

## 3. 已实施改动

### 3.1 正确性

| 位置 | 问题 | 改动 |
| --- | --- | --- |
| `src/web/src/app/CodeBrowser.tsx` | 保存进行中切换到提交差异（`compare()` 自增 `fileRequest`）后，保存结算因序号不匹配跳过 `setSaving(false)`，界面永久停在“保存中…”，自动保存与文件操作全部锁死 | 保存结果按“编辑器是否仍持有同一文件对象”判定是否应用；`saving` 在保存结算时总是释放，只在结果仍属当前文件时刷新变更列表 |
| `src/http/api.ts` | `errorChain()` 遍历 `AggregateError` 成员后，回滚/清理失败包裹的 SQLite `UNIQUE constraint failed` 先命中冲突分支，返回 409 且不写错误日志 | 运维错误（回滚/清理/完整性）先于冲突码判定，恢复 500 + 日志 |
| `src/diagnostics.ts` | `stableErrorReason()` 无条件复用 `errorDiagnostic()`，只要链中存在 Drizzle 错误，外层稳定错误码即被替换为 `database_operation_failed` | 优先采用外层稳定码，仅在消息不可发布时回退到净化后的诊断 |
| `src/web/src/app/IssueWorkspace.tsx` | 新增持久化码 `agent_run_failed` 及 `database_operation_failed`、`workspace_runtime_restore_failed` 无界面文案，用户看到英文原始码 | 补充中文可读说明 |

### 3.2 规则一致性与文档

| 位置 | 问题 | 改动 |
| --- | --- | --- |
| `src/mcp/server.ts` | 同文件内 `api()` 使用 `isStableErrorCode()`，`tools/call` 仍用 `/^[a-z_]+$/`，含数字的稳定码在一层转发、另一层被掩盖 | 统一使用 `isStableErrorCode()` |
| `src/web/src/app/App.tsx` | 深链接自行硬编码 `^ISSUE-\d{8}-\d{3,}$` | 改用 `parseIssueKey` |
| `src/web/src/app/source-editor-settings.ts`（新增）、`monaco.ts`、`CodeBrowser.tsx` | 状态栏硬编码 `Spaces: 4`，与编辑器 `tabSize` 形成第二份事实源（上一轮已手工漂移过一次） | 抽出具名常量供两边共用；该模块不引入编辑器依赖，避免把 Monaco 打进首屏包 |
| `docs/STORAGE.md` | 文档承诺统计快照“最多缓存 60 秒”，上一轮已改为按维护周期复用（默认 15 分钟） | 如实描述缓存周期、失效条件、`sampledAt` 与 `refresh=true` |

### 3.3 测试

| 位置 | 改动 |
| --- | --- |
| `src/web/src/app/CodeBrowser.test.tsx` | 新增“比较抢占在途保存”回归测试；已临时还原旧判定验证该测试确实失败 |
| `tests/capabilities/dms.test.ts` | 新增 DMS 工具预算超限测试（服务端返回 `limits.mcp.tools + 1` 个工具时拒绝） |

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（后端 + Web） | 通过 |
| 后端 `node --test 'tests/**/*.test.ts'` | 688 项：687 通过、1 跳过、0 失败 |
| Web `vitest run` | 31 个文件、320 项全部通过 |
| `npm run build` | 成功 |
| `npm run lint` | 无错误（仅既有的 Biome 配置迁移提示） |
| `biome format` | 无改动 |
| `git diff --check` | 干净 |

## 5. 核实后未采纳的审查发现

| 事项 | 未采纳原因 |
| --- | --- |
| `configuration/credentials.ts` 的能力 `switch` 缺穷尽守卫 | `strict: true` 下新增 `CapabilityName` 会触发 TS2366（缺少返回语句），类型系统已保证 |
| `workspace/project.ts` 启动原因直接使用 `errorDiagnostic` 文本 | 该原因只进入启动日志；改为固定码会丢失 Git/文件系统诊断信息，且不涉及机密 |
| `network-exec.ts`、`mcp-routes.ts`、`pi-extension.ts` 的 `^mcp_[a-z_]+$` | 这是“必须为 `mcp_` 前缀”的不同契约，不是同一规则的重复 |

## 6. 未解决事项与风险

| 事项 | 现状 |
| --- | --- |
| `api.ts` 错误分类缺少 HTTP 级测试 | 构造回滚失败需要故障注入；当前由代码顺序与既有路由测试间接覆盖 |
| 统计快照最多滞后一个维护周期 | Agent 处理与源码编辑不主动失效缓存；已在 `docs/STORAGE.md` 说明，页面提供 `sampledAt` 与强制刷新 |
| Codex 停时审查门已禁用 | 第三方提供方 `https://ai.flower-cli.com` 返回 401 Invalid token；更新 Key 并验证后可用 `/codex:setup --enable-review-gate` 恢复 |

## 7. 后续建议

1. 在附件或 Issue 路由测试中补一条“回滚失败 → 500 + 日志”的端到端用例。
2. 若统计新鲜度成为运维问题，再为 Agent/源码写入路径增加显式失效钩子，避免提前引入跨模块耦合。
3. 更新 Codex 提供方令牌后恢复停时审查门。
