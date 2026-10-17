# 工单分析沙盒

`sandbox` 是所有工单可用的离线 Node/Shell 分析工具。它由 Pi SDK 注册并使用正常的工具事件、参数校验和取消机制；直接调用执行器，不经过 codemode 或额外 RPC 服务。选择依据见[消融实验结果](SANDBOX_EXPERIMENT_RESULTS.md)。

## 使用方式

小文件直接使用 `read`。需要批量计算、关联、聚合或临时复现时，调用：

```json
{"operation":"run","command":"node -e 'console.log([1,2,3].reduce((a,b)=>a+b,0))'"}
```

命令从 `/work` 运行，Node.js 和镜像中的 Unix 工具可用。`/work`、`/tmp` 可写，在当前 Agent 轮次的多次调用之间保留。没有网络、Python 或在线依赖安装。代码、附件和关联工单路径属于原有宿主工具路径，不挂载到分析容器；可以在命令中创建临时复现文件。`reset` 丢弃当前临时状态，后续调用重新创建容器。

正式数据处理工单具有 `canWriteOutputs` 权限，还可导入已有查询成果并发布新成果：

```json
{"operation":"import_output","fileName":"batch-001.json"}
```

文件由本工单 `IssueOutputStore` 校验并通过 stdin 传入 `/work/batch-001.json`，内容不经模型上下文，也不成为进程参数。可以读取 DMS 的 `{tool,result}` JSON，或 MySQL 的 JSONL/CSV，使用 Node 完成处理后生成 `/work/summary.json`，再调用：

```json
{"operation":"export_output","fileName":"summary.json"}
```

导出只接受 `/work` 直属 regular file，拒绝路径穿越、符号链接、目录、FIFO 和超限文件；通过既有成果存储以 `0600` 原子发布。失败或取消保留旧成果。现有 `output.spreadsheet` 可以继续把 JSON/CSV 成果转换为 XLSX。工具仅返回文件名和大小；最终回复应指出交付文件。

导入要求临时文件尚不存在，防止意外覆盖；需要替换时先显式删除对应临时文件。单文件传输上限见根配置，超限明确失败，需分批处理，不截断。普通调查和开发工单的 schema 只有 `run/reset`，不能通过该工具导入或发布正式成果。外部资源继续由现有 capability 客户端执行权限和只读校验，沙盒不持有这些客户端凭证。

## 生命周期与资源

`src/agent/sandbox-tool.ts` 拥有每个 Pi session 的分析工具和调用队列；`src/sandbox/runtime.ts` 拥有容器进程。容器首次调用时才创建，单个沙盒调用串行，独立工单使用独立容器。每轮 prompt 完成、失败或取消时清理；保留的 Pi session 下一轮创建新的 scratch，JSONL 和已发布成果继续保留。检查点必须在当前轮结束前发布。

容器本身设置最长存活时间并自动移除，限制进程崩溃后的残留时间。timeout、abort 和输出超限会删除整个容器，包括后台子进程；不能只终止 `podman exec` 客户端。关闭和重复关闭幂等；若清理失败，返回稳定错误，不把失败报告为正常完成。

运行参数与所有预算唯一来自 `issue-pilot.config.ts`：

- `runtime.sandbox`：执行文件与预装镜像；禁止运行时自动拉取。
- `limits.sandbox`：并发、CPU、内存、PID、tmpfs、命令执行/容器存活时间、输出、传输与控制操作预算。
- `runtime.agent.codemode`：默认关闭；Operator 可显式开启 SDK 原生 codemode，仍只能调用当前 session 已授权工具。

## 隔离边界

容器为非 root、只读根文件系统、移除全部 capabilities、no-new-privileges、默认 seccomp、独立 PID/网络 namespace。工作与临时目录是独立有界 tmpfs；不挂载任何宿主目录、真实 state、worktree、配置或引擎 socket。关闭 Podman 的默认代理变量转发，避免宿主 HTTP_PROXY 等配置进入容器。

本机制隔离新增分析工具。原有文件读取、开发 bash 和项目 wrapper 仍按既有路径与授权执行；整个 Pi session 不能视为 OS 沙盒。普通容器也不构成对内核逃逸的证明。批处理和文件内容本身属于不可信业务数据，不能在宿主解释执行。

## 部署与诊断

当前执行器要求应用进程直接运行在具有 rootless Podman 的 Linux 用户环境中，且该用户已预装配置镜像。首次使用才检查运行条件；缺少引擎、镜像或可用资源时明确失败，无宿主执行回退。当前 Kubernetes image/manifest 没有提供该执行环境，其他应用功能仍可运行；不能通过挂载引擎 socket 或 privileged 来补齐。

当前本机 systemd 部署可使用已安装的 Podman。检查应用用户权限下的：

```bash
podman image exists docker.io/library/node:26-bookworm-slim
podman ps --filter label=io.issue-pilot.component=analysis-sandbox
```

仅在 Operator 明确要求的维护流程中删除确认属于中断轮次的容器，不按名称猜测其他容器所有权。常见稳定错误：`sandbox_unavailable`、`sandbox_requires_rootless_linux`、`sandbox_capacity_exceeded`、`sandbox_timeout`、`sandbox_output_too_large`、`sandbox_cleanup_failed`。容量不足可等待其他轮次结束后重试；超时/输出超限后的 scratch 已失效，需重新导入检查点。容器到期后可调用 `reset` 再重试。

## 纯 JavaScript 批处理

`output.spreadsheet` 直接复用 `@earendil-works/pi-codemode` 的 CodemodeSandbox worker/QuickJS，适合已授权的 Excel/JSON/CSV 数据变换；不开放 Node、文件系统或网络，也不要求 Podman。应用继续拥有输入授权、返回 workbook 校验、编码与原子发布。该执行后端与模型可见的 codemode 工具相互独立：`runtime.agent.codemode=false` 不会禁用表格批处理。需要 Node/Shell 时使用本文的容器分析工具。

## Pi 官方机制的适用范围

实现对照了 [Security](https://pi.dev/docs/latest/security)、[Containerization](https://pi.dev/docs/latest/containerization) 和 [MCP](https://pi.dev/docs/latest/mcp)，并核对安装的 SDK 1.3.0 类型与 Gondolin 示例。官方明确指出 cwd/project trust 不是文件访问边界，工具隔离也不会隔离仍在宿主执行的扩展；本工具的隔离声明仅覆盖新增分析执行路径。

官方 Gondolin 示例说明可通过 SDK 的 `ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations` 等接口把原有工具路由到隔离环境。后续若统一代码工具执行位置，应优先复用这些适配接口。示例本身会读写挂载工作目录并传入宿主环境，不能直接当作本项目的凭证隔离实现。

Pi 原生 MCP 可复用发现、重连、工具事件、resources 和 exposure；SDK 需显式加载扩展，并可注入 `loadConfig/createTransport`。当前原生协议不支持 legacy SSE，现有 DMS/SSE 客户端仍需保留；未来接入原生 MCP 时要显式从应用数据库投影配置并保持业务授权，不能自动加载宿主或项目的 mcp.json。

## 通用工具方向与原生 HTTP 验证

本次会话已确认：内置 Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS、SLS 是在基础执行工具之外增加的便捷接入，不应成为工单唯一可用的操作清单。服务与工单描述承载系统背景、接口用法和排查步骤；不应要求每个临时 URL、新接口或 SDK 都新增专用能力和配置实体。

使用当前 xhgj/gpt-6.1-sol 和 Pi SDK 1.3.0 做了实际对照。测试在临时目录启动 HTTP 服务，仅绑定 127.0.0.1 的随机端口，返回事先未告知模型的随机校验值。两组使用独立内存 session，不加载宿主扩展、技能、项目上下文，不访问真实工单或业务系统。

| 配置 | 实际访问 | 校验结果 |
| --- | --- | --- |
| 模型不带工具 | 0 次 | 回答 UNAVAILABLE，未获得响应 |
| 只提供 Pi 原生 bash | 1 次，通过 bash 调用 | 模型返回真实响应，随机值匹配 |

这证明当前模型配合 Pi 原生 bash 已能完成一次真实 HTTP 请求，无需先开发 http_request。未证明模型自身能联网、供应商不存在其他内建网络工具，或隔离环境已经具备网络；该测试也不覆盖公网 TLS、SDK 安装、认证、重定向或生产写入。

后续实现原则：

- 优先复用 Pi 原生工具及其 Operations 适配接口，把执行路由到合适的隔离环境；先验证现有机制，再考虑新工具。
- 基础工具处理临时 HTTP、脚本、文件和依赖使用；专用接入只在特殊协议、凭证、只读约束、完整分页等情况下保留。
- 安全边界由实际文件挂载、网络出口、凭证目标和业务操作权限落实，不能以服务描述或工具名称代替；不能直接给调查工单开放无隔离宿主 bash。
- 沙盒网络与依赖能力尚未接入。下一步先验证原生工具在隔离环境中的请求和依赖使用，再选择最小实现，不预先增加通用代理、能力登记表或 RPC 框架。

通用 HTTP 工具实现继续暂停。本次试写草稿已移出正式源码，保留于 /tmp/issue-pilot-paused-http-request.ts；未接入的 limits.httpRequest 和 undici 直接依赖已清理（SDK 自身的 undici 依赖/版本覆盖保留），不作为已交付功能。测试脚本和结果留在 /tmp/issue-pilot-native-http-test.mjs、/tmp/issue-pilot-native-http-results.json，仅作本机临时证据；持久结论以本文为准。

## 验证

`tests/sandbox/runtime.test.ts` 用真实容器检查宿主/工单隔离、代理变量、权限、二进制传输、symlink/FIFO/超限拒绝和取消后子进程清理；缺少 rootless Podman 或镜像时明确 skip。无需真实工单状态。

`tests/agent/sandbox-tool.test.ts` 检查权限 schema、成果归属、取消保留旧文件、重复轮次和启动/关闭竞态。`tests/agent/sandbox-session.test.ts` 用 Pi faux provider 驱动真实 SDK 和容器，验证查询文件导入、计算、原子交付、JSONL 只保留摘要及下一轮 scratch 重建。通用 stdin 行为由 process tests 覆盖。
