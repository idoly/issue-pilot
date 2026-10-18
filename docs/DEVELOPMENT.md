# 开发

先读[架构](ARCHITECTURE.md)和当前 owner；配置、协议、身份或资源变更同时核对[配置](CONFIGURATION.md)。操作已有服务与状态按[运维](RUNBOOK.md)。设计和审查标准见 [AGENTS.md](../AGENTS.md)。

## 工作与验证

开始先运行 `git status --short`，保留已有改动，按本轮基线核对最终 diff。检查源代码、合同和 focused tests 后再修改；审查请求本身不授权改代码，获得修改授权后优先解决正确性和一致性问题。

开发与 CI 使用 Node 24.18.0，应用镜像使用 Node 26。后端直接运行 TypeScript，不能使用 Node strip-types 不支持的参数属性等语法；前端由 Vite 编译，使用匹配的 Solid 2 runtime/compiler。

代码改动执行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

资源有限时使用等价的测试入口限制并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 tests/**/*.test.ts
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

定向验证示例：

```bash
node --experimental-strip-types --test tests/agent/engine.test.ts tests/http/management-role.test.ts
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1 src/web/src/app/App.test.tsx
```

运行时、依赖、协议安全或容器变更补充：

```bash
npm audit --omit=dev --audit-level=high
scripts/playwright.sh status
```

检查通过后，只有新改动、失败或未解决风险才需要扩大或重复验证。报告范围、结果和缺口，不把测试通过当作所有代码安全的证明。

## 隔离与数据

测试通过 `buildApi({ stateRoot, databaseFile })` 或 manager constructor 注入临时目录，使用临时 Git remote、数据库和协议/模型夹具。不得把真实 `.issue-pilot` 当测试数据。

手工启动 API 会迁移并整理状态。需要隔离服务时建立独立项目副本及其根配置，再显式传入临时路径；没有 state root 环境变量覆盖，也不能从另一 checkout 指向真实状态启动第二个 API。

错误、回滚或异常目录可能是恢复证据。不要通过重写 DB、reset、目录收编或删除未知路径，让测试或启动表面成功。真实状态、schema 与发布检查按 Runbook 执行。

## 修改入口

| 关注点 | 当前 owner |
| --- | --- |
| 默认值、路径、预算与保留 | 根配置、src/config.ts |
| 业务枚举与处理方式 | src/domain/contracts.ts |
| schema、启动迁移与历史 | src/db/schema.ts、bootstrap.ts、drizzle |
| 用户、凭证和配置投影 | src/configuration；HTTP 授权见 route-context.ts |
| Issue 创建/编辑、附件事务 | issue-routes.ts、attachment-store.ts |
| Agent 排队、预约、失败恢复 | src/agent/engine.ts |
| Pi 会话、模型、应用资源 | pi-session.ts、model-runtime.ts、configuration/pi-runtime.ts |
| 工具输入、分派和协议 | service-query-tool.ts、capabilities/registry.ts、各 capability 与 MCP client |
| 入站 MCP | src/mcp/server.ts |
| Git、代码集合、runtime 与生命周期 | src/workspace |
| 成果与发布 | src/outputs/store.ts、agent/output-tool.ts |
| Web 请求和 DTO | src/web/src/data/client.ts |
| 共享配置/身份、基座编辑状态 | ApplicationResources.tsx、agent-configuration.ts |
| 会话连接与消息投影 | agent-stream.ts、conversation.ts、AgentPanel.tsx |
| 代码浏览与编辑 | CodeBrowser.tsx、SourceText.tsx、SourceDiff.tsx、monaco.ts |
| 浏览器验证 | scripts/playwright.sh |

## 设计与边界

优先用语言、标准库、框架和官方协议客户端。增加抽象要证明维护收益，允许语义不同的少量重复，不为文件长度拆模块。对闭合内部类型保留枚举，对真实变化点使用明确的数据或映射；不预建通用权限、执行或插件框架。

unknown 在 HTTP、TypeBox 或协议响应边界解析，内部维持 typed call。路由协调 owner，不复制 Git、文件存储、协议或命令授权。错误使用稳定语义，不能伪造成功或丢弃必要恢复失败。

身份、业务角色和管理标记分开处理。用户写入在 scope queue 后重新授权；涉及 Issue 的变更通过 reservation，管理变更同时保护最后一个具备实际维护权限的用户。锁域与顺序见架构，不能合并成全局锁。

配置读快照使用原生 libSQL read transaction：当前 Drizzle adapter 忽略事务模式参数，适配器负责避免读占写锁。验证应使用独立 libSQL writer 与持有中的快照重叠，不能只测未并发的请求。

Pi 在可修改参数的扩展钩子之前验证输入。service_query、workspace、output 因此保留 execute 入口同 schema 的编译校验，避免钩子引入非法输入后到达副作用。模型、会话、Codemode、工具嵌套与资源尽量使用公开 SDK API，不直接操作 agent.state 或从历史恢复额外工具权限。

Agent 失败清理属于同一工单的串行任务；复现要覆盖下一条工作、会话关闭、失败状态回写和排队消息恢复。模型超时区分 assistant 与 user/toolResult/custom，工具执行期间暂停。

附件处理覆盖 open/write/close 和暂存清理，持久文件用 lstat 拒绝链接并校验 size/hash。文件批次、数据库事务和 Git 操作需要各自准备、回滚、提交与 finalize。成果复制完成且协议收尾成功后才发布，失败保留旧文件和工作源文件。

MySQL query/export 共用只读连接生命周期，Node promisify 保留 callback close 错误；普通查询完整性合同不能用截断结果替代。MCP/DMS 等待处理已经触发的取消并释放 abort listener；单次操作取消不关闭其他操作借用的共享会话。HTTP 读取按实际字节限制，流退出释放锁和剩余数据。

## Web 与浏览器

Solid 2 使用 `createEffect(compute, callback)`，callback 仅返回清理函数或 undefined；调用 setter 用语句块丢弃返回值。组件构造时有意读取初始 reactive value 使用 untrack，避免未跟踪读取警告。

基座编辑状态归应用资源持有，页面销毁不能丢弃失败草稿。网络写入串行，合并后续输入；身份变化取消未提交旧身份工作，旧响应不得覆盖当前编辑。其他配置行只提交自身草稿，敏感编辑内容在身份变化或关闭时按 owner 清理。

Monaco 仅使用公开 editor/model API。语言、贡献和单一 worker 在 monaco.ts 注册；组件负责 model 生命周期、内容同步、定位和保存命令。保持 SHA-256、CRLF、自动保存、撤销、只读、旧响应取消和面板布局；Material Icon Theme、Codicons 及许可证属于构建资源，不能按“没有 TS import”删除。

jsdom 使用公开调用替身验证应用适配，真实编辑和可见布局需要浏览器。运行：

```bash
scripts/playwright.sh status
scripts/playwright.sh run <script> <existing-output-directory>
```

浏览器默认拦截 API mutation，使用合成数据和净化结果；需要写入验证时仅放行独立夹具。不得向真实工单发送测试消息或把页面凭证保存到普通 artifact。

## 完成标准

检查失败、重试、取消、重复调用、事务回滚、最终化和关闭；保持 Web DTO 与 HTTP 一致，更新对应 owning 文档。检查 diff 中的无关改动、真实状态、生成物及秘密。发布迁移不可编辑或合并；新增迁移应覆盖 fresh DB 与升级。

依赖清理同时检查动态 import、Worker、资源 URL、CLI、类型、测试和容器安装；直接使用的包须声明依赖。协议和 SDK 固定版本变更按官方文档与现有测试验证，不能靠传递依赖或宽泛类型绕过问题。

未明确要求时不提交、不推送、不重启或改线上状态。获得发布授权后，先完成可审查的改动和验证，再按 Runbook 备份、发布与验收。
