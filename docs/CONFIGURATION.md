# 配置与协议

配置按事实所有者维护。页面是输入与投影，不另存环境、权限或模型的第二套规则。

| 内容 | 所有者 |
| --- | --- |
| 路径、默认值、预算和保留周期 | [根配置](../issue-pilot.config.ts)、[路径解析](../src/config.ts) |
| 角色、处理方式、状态和工具模式 | [业务合同](../src/domain/contracts.ts) |
| 配置 DTO、凭证字段与更新语义 | [配置合同](../src/configuration/contracts.ts)、[凭证处理](../src/configuration/credentials.ts) |
| 能力目标和输入 schema | [registry.ts](../src/capabilities/registry.ts) |
| Pi settings 与资源加载 | [pi-runtime.ts](../src/configuration/pi-runtime.ts) |
| 数据结构和升级顺序 | [schema.ts](../src/db/schema.ts)、[drizzle](../drizzle) |

## 页面与配置归属

设置页默认打开基座，另有用户、能力、仓库、服务和端点面板。设置内面板保持挂载，切换分类不丢表单状态。

- 基座持有全局唯一的 provider、model、thinking level、Codemode 和 `runtime.settings`；部署没有模型覆盖。
- 用户持有角色、管理标记、启用状态和个人凭证。
- 仓库目录持有 URL 与名称，服务引用仓库并保存 alias；各环境部署保存分支和查询能力配置。
- 原生能力按服务/环境配置，全局开关决定是否可用。
- 外部 MCP 独立、全局管理，不需要在服务或环境中绑定；历史绑定不再决定可用性。

根配置相对于应用安装目录解析，默认状态目录为 `.issue-pilot`。不存在 state/database 路径的环境变量覆盖；测试使用注入路径，手工隔离服务需要独立项目副本。

## 身份与权限

身份由可信网关及 `X-Issue-Pilot-Subject` 选择，未提供时使用首个活跃用户。浏览器选择器不是认证机制，不能把任意客户端身份头当作可信登录。

| 操作 | 当前权限要求 |
| --- | --- |
| 创建正式/测试调查 | 活跃用户 |
| 创建开发修复、功能开发、正式数据处理 | developer |
| 维护服务、仓库、内建能力、基座配置 | developer |
| 新增、编辑、启停普通用户 | developer |
| 授予/移除管理标记，维护已有管理用户 | developer 且 isAdmin |
| 新增、导入外部 MCP | isAdmin |
| 读取完整 MCP 编辑配置、修改、测试、删除 MCP | developer |
| 维护个人模型 Key、SSH 私钥 | 当前 developer 本人 |
| 维护个人正式 DMS/SLS 凭证 | 当前活跃用户本人 |

`isAdmin` 是独立管理标记，不增加新的业务角色，也不自动赋予开发凭证或开发工单能力。用户变更保留至少一名活跃用户、一名活跃开发者、一名活跃管理，以及一名同时满足开发和管理要求、能继续维护管理权限的用户。

## 凭证与 owner

工单凭证 owner 为 assignee，未分配时为 reporter，必须活跃。正式数据处理和开发工单要求 owner 为 developer。developer owner 在正式、测试和开发工单中都使用个人模型 Key 与 SSH 环境；缺少必需凭证时失败，不切换到共享身份。其他 owner 使用 Operator 的 Pi 模型运行时。

个人模型 Key 按 provider 保存，个人 Git 只支持 SSH 私钥；临时私钥文件私有，SSH 主机身份必须验证。Git 身份在会话创建或更新时校验，Bash 使用当前已校验环境。

个人正式 DMS 与 SLS 覆盖互相独立、各自完整：缺少某组时使用部署配置，已有组不与部署凭证拼接。只覆盖已配置的能力，不凭个人凭证创造新的服务目标；失败不重试为另一个身份。

普通配置 GET 投影密码、Authorization 和 SLS keys，只返回状态。开发者专用的服务说明可以显示选定原生密码和 MCP 认证，原生 DMS Authorization、SLS keys 仍隐藏。MCP 编辑接口另有明确的完整配置权限，见下文。凭证不能进入 Agent prompt、工具输入、诊断或普通日志；查询业务数据、成果、JSONL 和备份本身也可能敏感。

服务能力更新使用 `credentialUpdate` 的 preserve、replace、clear。preserve 必须匹配原目标，replace 提供所需完整字段，clear 仍受能力必需凭证校验。MySQL 每个数据库独立处理凭证；变更目标不能默默沿用旧身份。开发部署只配置代码分支，旧开发能力数据作为私有归档保留，不投影或执行。

## 内建能力与工具

`service_query` 显式选择 environment、service、capability 和操作。正式/测试工单选择本环境来源，开发工单可调查 prod/test；代码加入/移除仍在工单自己的环境。目标、数据库、schema、logstore 和只读约束在调用时校验。

| 能力 | 主要配置 | 当前操作 |
| --- | --- | --- |
| Nacos | 地址、namespace、group、dataIds、认证 | 读取配置及差异证据 |
| MySQL | 多数据库 URL、用户名、独立密码 | 单条只读 SQL，READ ONLY transaction，CSV/JSONL 导出 |
| Redis | host、port、database、认证 | 受限只读命令 |
| RabbitMQ | 管理地址、port、vhost、认证 | 管理 HTTP 读取，不消费消息 |
| Elasticsearch | URL、认证 | 查询、计数、mapping |
| DMS | HTTPS MCP URL、Bearer、显式数据库集合 | 只读 executeScript、完整 JSON 导出 |
| SLS | region、project、logstores、AK 组 | 官方 HTTPS GetLogsV2 查询 |

MySQL/DMS 保留完整查询结果，不添加隐式行数限制或静默裁剪。大结果应在 SQL 中明确缩小范围，或导出后用脚本处理。其他协议预算与进程/Worker 限额以根配置为准。数据库导出须先完成 rollback/close，才能发布新文件；失败保留旧交付。

所有工单获得 Pi 原生编码工具，cwd 为 `issues/<key>/work`。`workspace` 负责代码集合与服务说明，正式数据处理额外获得 `output` 的 list/publish。普通代码和已安装库负责格式处理，不提供格式专用执行器或可选执行框架。

## 全局外部 MCP

支持 HTTPS Streamable HTTP、HTTPS SSE 和本地 stdio。列表 GET 只返回公开字段及凭证状态；开发者可通过静默日志、no-store 的 `GET /api/mcp-services/:id/configuration` 读取完整 `mcpServers` 编辑配置，包括 command、args、env、cwd 或 HTTP 认证。

新增/导入使用标准 JSON，例如：

```json
{
  "mcpServers": {
    "evidence": {
      "url": "https://mcp.example.invalid/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    },
    "local-tools": {
      "command": "/usr/local/bin/internal-mcp",
      "args": ["--stdio"],
      "env": {},
      "cwd": "."
    }
  }
}
```

导入原子保存，不启动进程；编辑 JSON 只包含一个服务。HTTP 仅支持 Authorization 请求头，默认 HTTP 类型解析为 Streamable HTTP；stdio 的相对 cwd 相对于工单 work。启用/禁用可通过 enabled 或 disabled 表达。

局部更新时，HTTP 省略 headers 可保留原认证，显式空 headers 清除认证；目标/协议变化要明确提供新认证或清除。stdio 省略 command 仅用于保留已有启动配置，不能同时替换 args/env/cwd；替换时提供完整启动信息。编辑页面正常读取并提交完整配置。

每个 Agent 会话通过 Pi 的 `createMcpExtension()` 连接已启用配置。Pi 负责工具命名与注册、连接复用、重连、工具列表变化及关闭，并保留图片、结构化结果和原生 MCP resource 工具；外部工具以 `mcp__<id>__<tool>` 形式独立开放，不再包装成 service_query 的服务/环境分支。Codemode off 时使用 direct 曝光，模型直接调用 MCP；on/only 时使用 codemode 曝光，完整 MCP 工具声明不预先放入模型上下文，脚本通过 searchTools/describeTool 发现并调用工具及 resources。服务仍在会话启动后由 SDK 后台连接，调用时等待所需服务就绪；autoEnableCodemode 保持 false，全局开关不会被 MCP 连接改变。on 仍保留原生与应用直接工具，only 的声明隐藏由 SDK 处理。

MCP 工具返回的业务失败保留 `CallToolResult.isError: true`，错误内容替换为稳定的 `mcp_tool_failed`，原始 content、structuredContent 和 _meta 不进入会话。Codemode 可检查结果的 isError 并继续处理其他成功结果；直接调用仍显示为失败。协议、网络、参数校验和预算错误继续作为异常，不转换为业务成功。

[Pi 接入适配](../src/mcp/pi-extension.ts)只从数据库快照加载配置，不读取宿主或工单 mcp.json，也不开放另一套终端配置管理。HTTP/stdio 使用 Pi 官方传输，SSE 通过 MCP 官方 SDK 的兼容适配接入；保留 HTTPS 同源与禁止重定向、stdio 私有环境及字面配置值的行为；不执行配置中的 `!command` 或展开环境变量。适配层保留启动取消/超时、分页工具数和结果预算、错误稳定化及发送前参数校验，防止扩展钩子修改后绕过 schema。工具变化遵循 MCP 的 list_changed 通知，由 SDK 重新发现并注册，不在每次工具调用前另发一次 tools/list。超过 SDK 文本展示预算的结果附带完整临时文件路径，Codemode 仍接收完整结构，应用的结果字节上限继续生效。连接测试仍使用独立的只发现、不执行工具的协议客户端。

已启用 MCP 的全部工具向所有工单开放，不按工单环境或 readOnlyHint/destructiveHint 过滤；只读标记只展示服务声明。外部 MCP 与内建只读证据查询是不同合同，配置者应理解其工具行为。

## Agent 基座与资源

基座编辑停止 500ms 后自动保存，连续修改合并，同一时刻只提交一项请求。初次加载和相同值不写配置。草稿、保存队列和失败信息由应用资源持有，切页后保留；失败可重试，切换身份取消未提交的旧身份修改。存在运行中工单时，后端拒绝基座变更；成功关闭空闲会话，下一轮读取新配置。

页面提供模型、思考级别、Codemode、自动压缩、自动重试、最大重试次数和缓存预热，保存常用项时保留其他 runtime 参数。高级 JSON 编辑和资源文件编辑不在页面提供。

Codemode 的 off/on/only 由独立字段持有，默认 on。on 保留直接工具并允许脚本编排；only 隐藏其他模型工具声明，但仍可通过 SDK 嵌套管线调用。应用显式注册扩展并关闭 codemode 的 models 能力，不提供额外模型选择器。`service_query`、`workspace`、`output` 同时提供文本和结构化结果，脚本应只返回必要字段；独立读取可并行，依赖执行结果或发布同一文件的操作顺序等待。

`runtime.settings` 支持 compaction、retry、branchSummary、steeringMode、followUpMode、thinkingBudgets、transport、httpIdleTimeoutMs、websocketConnectTimeoutMs、cacheWarming、images、shellPath、shellCommandPrefix，以及 codemode.inlineBudget。校验来自当前 SDK 发布的 schema，拒绝未知、已弃用和负数预算字段；压缩、重试、排队等默认值由 SDK 提供。模型、工具选择、凭证和会话路径不归这个对象覆盖。

资源由根配置指向的应用 `.pi` 管理：

| 路径 | 用途 |
| --- | --- |
| skills/<name>/SKILL.md | SDK Skill |
| prompts/<name>.md | Prompt 模板 |
| extensions/<name>.ts | 受信扩展 |
| APPEND_SYSTEM.md | 追加到工单策略的通用指令 |

应用只显式加载这些资源，不自动继承宿主/Issue 的提示词、扩展和 settings，也不自动安装包。`/skill:名称` 和模板命令由 SDK 解析，应用保留隐藏的工单上下文。扩展不能覆盖原生/application 工具名，须遵守 SDK 的曝光和关闭合同。

新会话重新加载资源。需要重载已有空闲会话时，可通过配置 API 重新提交当前基座；`GET /api/config/agent/resources` 为开发者提供元数据和诊断，不执行扩展代码。资源及其依赖应随部署保留。

## 入站工单 MCP

外部客户端访问同源 `POST /mcp` 的无状态 Streamable HTTP；GET/DELETE 返回 405。连接身份沿用 HTTP 身份选择，认证仍由网关承担。

端点页按当前访问入口和所选用户生成接入配置，支持 Pi/Cursor/Claude Code 的 `mcpServers` JSON、VS Code 的 `servers` JSON，以及 Codex TOML；可一键复制包含地址与身份头的完整配置。配置中的 `X-Issue-Pilot-Subject` 选择用户，不能代替入口认证；为其他用户分享配置前先切换身份，从客户端可访问的应用地址打开此页。工具列表提供名称及说明，写操作的受理与后续查询语义保持一致。

| 工具 | 作用 |
| --- | --- |
| services_list | 发现服务和环境 |
| users_list | 当前身份及可分配用户 |
| issues_search | 搜索和分页核对已有工单 |
| issue_get | 详情、运行状态、附件和成果 |
| issue_create | 创建工单并异步入队 |
| issue_message | 发送补充消息或继续处理 |
| issue_conversation | 分页读取对话和当前进展 |
| attachment_read | 校验后读取文本/Excel，或返回下载路径 |
| output_read | 读取成果文本/Excel，或返回下载路径 |

写工具成功仅表示受理。创建和发消息不是幂等操作，超时先搜索或核对对话，不能盲目重发。工具输入 schema、分页及请求/响应预算以 [server.ts](../src/mcp/server.ts) 为准；创建、队列、角色与附件读取复用 HTTP owner。
