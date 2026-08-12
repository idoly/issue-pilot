# 开发指南

本文帮助第一次修改 Issue Pilot 的开发者找到代码入口、选择正确层次、补齐测试并避免破坏持久状态。先阅读 [架构说明](ARCHITECTURE.md)中的术语、Repository 状态和数据所有权；环境安装见 [部署说明](DEPLOYMENT.md)。

## 开始前

Issue Pilot 会操作真实 Git repository、附件、Pi JSONL 和 SQLite。主程序从根目录 `issue-pilot.config.ts` 读取 state 配置，不接受环境变量覆盖；当前目录是项目 `.issue-pilot`。启动 API 前先检查配置指向的位置，它可能包含正在使用的数据。

安装依赖并初始化项目数据库：

```bash
npm ci
npm run db:migrate
```

分别启动 API 和 Web：

```bash
npm run server
```

```bash
npm run dev:web
```

API 为 `http://127.0.0.1:3000`，Vite 本机入口为 `http://127.0.0.1:4173`，并按根配置监听 Web 接口以支持受信任开发网络访问。Playwright 和 code-server 需要固定宿主 runtime，准备方式见 [运行前检查](DEPLOYMENT.md#运行前检查)。

自动测试通过 `buildApi({ stateRoot })` 和 manager constructor 注入 temporary directory，不会使用项目状态。需要隔离的手工服务器时使用独立项目副本；不要为当前 checkout 添加环境变量覆盖或临时修改真实 state 配置。Credential 和数据库不能提交到 Git。

## 从哪里开始读代码

| 目录 | 主要入口 | 责任 |
| --- | --- | --- |
| Project root | `issue-pilot.config.ts` | 路径、server、workspace、runtime 和运行上限 |
| `src/domain` | `contracts.ts` | 后端和 Web 共享的业务常量与类型 |
| `src/db` | `schema.ts`, `bootstrap.ts` | 当前 schema、migration 执行和启动恢复 |
| `src/http` | `api.ts`, `*-routes.ts` | API 装配、输入验证、事务和 SSE |
| `src/agent` | `engine.ts`, `pi-session.ts` | Issue queue、Pi session 和事件 |
| `src/pi` | `policy.ts`, `tools.ts` | 冻结授权、model 和 custom tools |
| `src/capabilities` | `broker.ts`, `contracts.ts` | 外部读取工具的 scope、schema 和 client |
| `src/workspace` | `deployment.ts`, `git.ts`, `state.ts`, `runtime.ts`, `lifecycle.ts` | Deployment 仓库解析、Git、repository state、runtime 和回收 |
| `src/web/src/data` | `client.ts` | Web 使用的 API contract 和 request helpers |
| `src/web/src/app` | `App.tsx` | 页面状态、业务组件和对话投影 |
| `infra` | `playwright.sh`, `code-server.sh` | 固定容器和宿主 runtime 边界 |
| `tests` | 与 `src` 对应的目录 | 后端、Git、HTTP、capability 和启动测试 |
| `drizzle` | 编号 SQL 与 journal | 不可变 schema migration 历史 |

遇到一个业务行为时，先从 route 或 Web client 找到入口，再向 domain、database 和具体 manager 跟踪。不要只根据文件名猜测状态来源；SQLite、Git ref 和生成目录的所有权不同。

## 一次请求如何经过代码

普通 API 请求通常经过：

1. `src/http/*-routes.ts` 解析输入并检查当前 Issue/Service。
2. `src/http/service-configuration.ts` 或对应 manager 执行业务校验。
3. `src/db/schema.ts` 定义的 Drizzle table 在事务中更新。
4. Route 只返回 Web 需要的 DTO，不直接暴露内部 row。
5. `src/web/src/data/client.ts` 声明前端 contract 并调用 route。
6. `src/web/src/app/*` 把 DTO 投影为界面状态。

Agent 请求多经过两条额外路径：

- `agent-routes.ts -> AgentEngine -> repository preparation -> IssuePolicy -> Pi session`
- `Pi official event -> AgentEventBus -> SSE -> conversation projection`

Workspace 操作必须经过 `src/workspace` manager，不能在 route 中直接删除目录或执行零散 Git 命令。执行期 Service/Environment 的 Repository 分支集合统一通过 `loadDeploymentRepositories()` 解析；Agent、冷启动和后续 runtime 入口不要各自重写 join 与完整性判断。

## 共享业务 contract

Issue type、Environment、状态、priority、thinking level、capability key 和共享 workspace 状态条件集中在 `src/domain/contracts.ts`。Web 通过 `src/web/src/data/client.ts` 重新导出这些事实。可调整的默认值、timeout、bytes、rows、items、端口、镜像和 runtime 路径集中在根目录 `issue-pilot.config.ts`；Node/Web 直接导入，Shell 只通过 `infra/config-value.mjs` 读取。协议语法、允许动作、状态转换和路径边界留在拥有该行为的模块。

修改共享枚举时同步检查：

- Domain validation 和映射关系。
- Drizzle enum declaration/default。
- HTTP input validation。
- Agent state transition。
- Web options、label 和状态展示。
- Domain、database、HTTP 和 Web tests。

不要在 Web 或 route 中新增另一份字符串数组。数据库中的旧值需要 migration，不能只改 TypeScript union。

## 修改数据库

### 当前 schema

`src/db/schema.ts` 是新代码使用的当前模型。测试应验证当前业务表、字段、foreign key 和约束，而不是要求历史废弃字段继续存在。

### Migration

数据库升级由 `drizzle/*.sql` 和 `drizzle/meta/_journal.json` 的顺序共同定义。

Schema 变化时：

1. 修改 `src/db/schema.ts`。
2. 添加下一个连续编号的 SQL migration。
3. 在 journal 末尾追加匹配 entry。
4. 在新建临时数据库执行 `npm run db:migrate`。
5. 从上一版本数据库副本执行 upgrade test；涉及真实 Service/Deployment 数据时还要在真实数据库备份副本上验证迁移结果。
6. 验证 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。
7. 更新 `tests/db/sqlite.test.ts` 的当前 schema 断言。

已发布 migration 不修改、不重排、不删除。即使运行时代码不再兼容旧文件布局，数据库仍需要按历史顺序升级到当前 schema。

Migration 中重建 SQLite table 时，要显式复制需要保留的列、恢复 index/foreign key，并检查空值和重复值是否满足新约束。

## 新增或修改 API

遵循现有 route 模式：

1. 在 `src/http/input.ts` 或 route 边界验证未知输入。
2. 通过 `ApiRouteContext` 使用 database、engine、events 和 workspace manager。
3. 使用 `requireIssue()` 等共享 guard。
4. 多表更新放在同一个 transaction。
5. Running Issue 的破坏性修改使用 `assertIssueIdle()`。
6. 预期业务错误使用稳定的小写错误码和适当 HTTP status。
7. 在 `src/web/src/data/client.ts` 增加明确 DTO 和 helper。
8. 添加 HTTP 测试，再添加必要的 Web 交互测试。

不要返回 raw database error、绝对 credential path 或 secret。Fastify error handler 只把已知 conflict 映射为公开错误；未知错误记录服务端并返回 `internal_error`。

## 修改 Agent 行为

AgentEngine 负责每 Issue 串行、状态转换和 session 生命周期。改动时重点检查：

- Repository 必须先准备，policy 才能构造。
- Session binding 必须早于第一个可见事件持久化。
- 成功、失败、abort 和 API close 都要释放对应资源。
- Prod/test 下一轮需要刷新当前 Deployment commit。
- 已有 dev Repository 必须保留 Issue `base_branch` 历史；只有新加入工单的 Repository 使用当前 Deployment 分支。
- Resolved Issue 不能运行 Agent。
- 配置变化要关闭受影响的内存 session。

Pi JSONL 是 transcript 事实源。不要另建聊天消息表或从 Web 状态重建历史。新增 Pi entry 投影时，先确认它属于 active branch 和 replay 语义；内部 metadata 不应伪装成用户可见消息。

相关测试集中在：

```text
tests/agent/engine.test.ts
tests/agent/events.test.ts
tests/agent/pi-session.test.ts
src/web/src/app/AgentPanel.test.ts
src/web/src/app/model.test.ts
```

## 修改 Git 或 workspace

Git/storage 改动的风险高于普通 CRUD，因为错误删除无法靠数据库事务恢复。

### 状态分类

Repository state 必须通过 `classifyRepositoryState()` 判断。不要在 Agent、route 或 lifecycle 中重新拼 `local_path`/`working_branch` 条件。

新增状态前先回答：

- SQLite 如何表示？
- 哪个目录或 ref 是事实源？
- 冷启动如何重建？
- Runtime repository link 应指向 writable worktree 还是 immutable checkout？
- 自动回收是否允许处理？
- 状态不完整时如何失败并保留现场？

### 文件操作

生成 runtime、manifest 和 wrapper 使用临时路径后原子替换。Durable attachment、Pi JSONL 和 bare repository 不使用“先删除再重建”的策略。

Workspace release 必须继续拒绝：

- Dirty 或 untracked Git worktree。
- Issue 尚未 resolved，或 Agent running/busy。
- 数据库外的根目录项，或数据库登记但实际缺失的 Repository 目录。
- 空、mixed 或其他无效 Repository state。
- 路径不符合当前推导规则。
- 非 dev Issue。

只有全部受管 worktree 已删除、但数据库仍是完整 `development_workspace` 的中断窗口可以收敛为 released snapshot；部分目录缺失不能自动修复。

Git tests 使用临时本地 remote 和真实 Git 命令，至少覆盖 success、dirty refusal、missing ref、重复准备和 cold-start reconstruction。`tests/workspace/deployment.test.ts` 单独覆盖 Deployment 仓库顺序、完整性和 Service 归属。

## 新增 capability

Capability 是安全边界，不只是一个 Pi tool。新增能力时通常需要修改：

1. `CAPABILITY_KEYS` 和 `CapabilityConfiguration`。
2. Service save validation 和 Web 配置表单。
3. `capabilityInputSchemas`、固定 action contract，以及根配置中的 size/timeout policy。
4. `IssuePolicy` 中不含 secret 的 scope。
5. `CapabilityBroker` 对冻结 scope 的再次校验。
6. 具体 protocol client。
7. `src/pi/tools.ts` 的 tool registration。
8. Configuration documentation 和 tests。

Client 必须自己验证 scope，不能信任 tool description 或 broker 已经检查过。需要明确：

- 允许哪些 action。
- 目标 host/project/database/index 如何固定。
- Credential 在哪里读取和销毁。
- Timeout、rows、items 和 bytes 上限。
- Redirect、subprocess、temporary files 和 abort 如何处理。
- 超限时是完整失败还是存在可证明安全的分页协议。

默认选择只读、exact target、bounded result 和 fail closed。应用层只读检查不能代替服务端 read-only credential。

## Web 开发

Web 使用 SolidJS 和 `@idoly/ant-design-solid`。主要约定：

- 共享业务枚举从 `src/domain/contracts.ts` 导入，不在组件内复制。
- HTTP 和 DTO 集中在 `src/web/src/data/client.ts`。
- `App.tsx` 负责顶层资源和路由选择，具体页面行为留在对应组件。
- Agent replay/live 合并逻辑集中在 `conversation.ts` 和 model helpers。
- 使用现有 icon library，不手写重复 SVG。
- Desktop 和 mobile 都要验证长标题、错误文本、dialog 和 repository 列表。
- 不在 UI 增加可以绕过后端安全检查的“强制删除”或“忽略错误”入口。

新增用户流程时测试 loading、empty、success、failure 和 retry，不只测试 happy path。

## 测试

### 单个后端测试

```bash
node --experimental-strip-types --test tests/workspace/git.test.ts
```

### 单个 Web 测试

```bash
npx vitest run \
  --config src/web/vite.config.ts \
  --environment jsdom \
  src/web/src/app/App.test.tsx
```

### 完整验证

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

按风险选择测试范围：

| 改动 | 至少覆盖 |
| --- | --- |
| 纯展示 | 对应 Web test、typecheck、build |
| Domain contract | Domain、database、HTTP、Web tests |
| API/transaction | Route test、failure rollback |
| Agent/session | Success、failure、abort、replay |
| Capability | Validation、scope escape、timeout、oversize、abort |
| Git/workspace | Real Git、dirty/untracked、missing ref、重复执行 |
| Startup/state root | Fresh DB、migration、partial failure cleanup、unmanaged state |
| Container script | Shell syntax、argument/env propagation、status test |

测试应使用 temporary directory、temporary database 和 local Git remote。不要依赖开发者真实 `.issue-pilot`、远程 Repository 或长期运行的 code-server。

## 调试方法

### API

优先查看结构化日志中的 Issue key、error code、Repository hash 和 commit。不要临时打印 config body、Authorization、password 或 capability 完整结果。

### SQLite

用 `src/config.ts` 根据根配置解析出的实际 `databaseFile` 进行只读检查。直接修改 SQLite 会绕过业务事务，只能用于已备份后的受控恢复，不用于日常开发。

### Git

分别检查三个层次：

1. Bare repository 的 local branch 和 remote-tracking ref。
2. Worktree/checkout 的 `HEAD` 与 `git status --porcelain`。
3. Runtime link/manifest 和 code-server 容器 mount。

只看 Explorer 中的文件不足以判断 Git 状态正确。

### SSE 和对话

区分 replay snapshot、live buffer 和 live sink。遇到重复或丢失消息时，先检查 Pi JSONL active branch，再检查 SSE 连接边界，最后检查 Web projection；不要先向数据库增加冗余消息记录。

## 代码约定

### 文件归类

- 小型纯函数放回拥有其事实或生命周期的模块，不为单个三五行 helper 新建文件。
- 只有事务边界、安全边界、独立进程、外部协议 client 或稳定可复用组件才单独成文件。
- `workspace/state.ts` 统一拥有 state 路径、文件存在性和 Repository 状态分类；`workspace/deployment.ts` 统一拥有执行期 Deployment Repository 解析与完整性校验；`workspace/runtime.ts` 统一拥有 runtime 生成和批量恢复。
- `agent/pi-session.ts` 统一拥有 Pi session 文件初始化与 SDK session 生命周期；`http/api.ts` 统一拥有 API 装配和进程关闭处理。
- 测试按被测职责归类；只有能独立失败、独立演进的行为才新建测试文件。

### 命名风格

- 优先使用简短领域名词：`issue`, `deployment`, `workspace`, `repository`, `session`。
- 当同一作用域存在多个同类对象时加短后缀说明角色，例如 `issueRow`, `sessionBinding`, `targetStatus`, `workspaceRoot`。
- `input` 用于边界输入，`current`/`next` 用于局部状态转换，`entry` 用于短循环；离开这些上下文后使用更具体名称。
- 避免无上下文的 `data`, `value`, `result`, `row`, `source`，也避免把完整类型描述重复进超长变量名。
- 同一概念全项目使用同一术语，不混用 `repo/repository`、`dir/root/path` 或 `config/configuration` 表示不同对象。

### TypeScript

- TypeScript 使用 ESM 和显式 `.ts` import。
- 保持 strict、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 通过。
- 在边界解析 `unknown`，内部使用明确类型。
- 共享事实只定义一次；调用方复用 domain helper、根配置或 owning manager。能力顺序使用 `CAPABILITY_KEYS`/API catalog，Deployment 仓库使用 `loadDeploymentRepositories()`。
- 新增可调整默认值时写入 `issue-pilot.config.ts`，不要在调用点、Web 和 Shell 各设 fallback。
- 错误码稳定、可测试，不用长自然语言作为程序分支。
- 文件和数据库更新需要说明失败后的状态。
- 只为复杂约束添加注释，不重复代码表面含义。
- 不加入旧路径、旧状态或旧 key 的自动兼容；异常当前状态明确失败并保留证据。

## Review checklist

提交评审前确认：

- 行为变化是否放在拥有该事实的模块，而不是方便调用的位置。
- Prod/test 是否仍严格只读，dev 是否仍按 Issue 隔离。
- Credential 是否没有进入 policy、prompt、event、日志或命令行。
- Dirty、untracked、running 和 unmanaged state 是否仍会阻止删除。
- Attachments、Pi JSONL、本地 Issue branch、dev `base_branch` 历史和 migration history 是否保留。
- 新生成目录是否原子替换且可冷启动重建。
- 数据库多表更新是否有 transaction 和 rollback test。
- 超时、abort、partial failure 和重复调用是否有确定结果。
- 前后端共享枚举、DTO 和错误状态是否一致。
- 相关文档是否更新到唯一负责该主题的文件。
- `npm run typecheck`、`npm test`、`npm run build` 和 `git diff --check` 是否通过。

## 文档职责

| 文档 | 更新时机 |
| --- | --- |
| `README.md` | 产品定位、快速开始或阅读入口改变 |
| `ARCHITECTURE.md` | 状态模型、数据所有权或核心原理改变 |
| `DEVELOPMENT.md` | 代码结构、开发流程、测试或扩展方式改变 |
| `CONFIGURATION.md` | 用户可配置字段、授权或限制改变 |
| `DEPLOYMENT.md` | 项目配置、runtime、代理或部署要求改变 |
| `RUNBOOK.md` | 日常检查、容量策略、恢复或故障处理改变 |

同一事实选择一个主文档完整说明，其他文档只保留读者完成当前任务所需的摘要和链接。
