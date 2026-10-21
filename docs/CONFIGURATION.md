# 配置与协议

本文维护配置入口、权限和协议格式。工具执行原理见 [Agent 与能力](AGENT.md)，数据关系见[存储设计](STORAGE.md)。

## 配置范围

| 配置 | 所有者 | 影响范围 |
| --- | --- | --- |
| 路径、默认值、预算、保留周期 | [根配置](../issue-pilot.config.ts) | 整个应用；路径相对安装目录解析 |
| 模型、思考、Codemode、runtime settings | 全局基座 | 所有工单，部署无模型覆盖 |
| 仓库 URL/名称、服务 alias | 仓库与服务配置 | 部署引用的代码集合 |
| 分支、原生能力目标与凭证 | 服务/环境 Deployment | 对应来源环境 |
| 原生能力开关、外部 MCP | 全局能力配置 | 所有工单 |
| 个人模型/SSH/正式 DMS/SLS 凭证 | 用户 | 作为工单 owner 时选择使用 |

设置页包含基座、用户、能力、仓库、服务和端点。配置 DTO 和凭证更新定义见 [contracts.ts](../src/configuration/contracts.ts)、[credentials.ts](../src/configuration/credentials.ts)。没有 state/database 路径环境变量覆盖。

## 处理方式

| workMode | 环境 | Issue type | 代码访问 | 创建权限 |
| --- | --- | --- | --- | --- |
| production_analysis | prod | smart_analysis | 只读快照 | 活跃用户 |
| test_analysis | test | smart_analysis | 只读快照 | 活跃用户 |
| production_data | prod | data_processing | 只读快照，额外提供 output | developer |
| development_fix | dev | defect_fix | 独立 worktree | developer |
| development_feature | dev | feature_development | 独立 worktree | developer |

先登记仓库，再配置服务与各环境分支、原生能力；确认全局模型与用户凭证后创建工单。首次引导用户仅在用户表为空时创建。创建请求选择 `serviceKey/workMode`，不直接提交连接凭证或工作分支。

## 身份与权限

可信网关负责认证，`X-Issue-Pilot-Subject` 与页面选择器用于选择用户；未提供时解析首个活跃用户，并在同一请求内固定该 subject；首次并行检查共享同一个未完成的身份解析。后续授权仍重新检查活跃状态和角色；用户失活时拒绝当前请求，不切换到下一默认用户。入站 MCP 将本次请求解析出的 subject 显式传给内部 API。页面解析出用户后固定请求身份，其他标签页的选择不会改变当前页面的请求；localStorage 只记住供新页面初始化的显式选择。失活用户先退出页面上下文，再解析默认用户，卸载后的响应不能覆盖新选择。`isAdmin` 独立于 product/test/developer 角色，不自动授予开发能力。

| 操作 | 要求 |
| --- | --- |
| 维护服务、仓库、原生能力、基座 | developer |
| 新增、编辑、启停普通用户 | developer |
| 修改管理标记、维护已有管理用户 | developer 且 isAdmin |
| 新增、导入外部 MCP | isAdmin |
| 读取完整 MCP 配置、修改、测试、删除 MCP | developer |
| 维护个人模型 Key、SSH 私钥 | 当前 developer 本人 |
| 维护个人正式 DMS/SLS 凭证 | 当前活跃用户本人 |

用户变更须保留活跃用户、developer、管理用户，以及至少一名同时具备开发和管理权限的活跃用户。`PATCH /api/users/:subject` 只更新提供的字段，空更新被拒绝；启停按钮只提交 `active`，避免用旧列表覆盖姓名、邮箱或角色。所有提供的字段在关闭工单会话前完成校验。个人凭证更新也先校验模型、SSH 和生产凭证各组输入，再关闭关联会话并写入；关闭失败不保存凭证，预约释放后可重试。

## 凭证与 owner

工单 owner 为 assignee，未分配时为 reporter，必须活跃；开发和正式数据处理要求 owner 为 developer。

- developer owner 在所有环境都使用个人模型 Key 和 SSH 私钥，缺少或失败时不回退到共享身份；个人模型 runtime 不继承 Operator 的 apiKey 或自定义 headers（provider 与 model 层均移除），避免认证头混用；共享的 endpoint、模型参数继续使用。需要额外路由/认证头的模型接入必须先明确个人身份协议，不能依赖 Operator 私有头。SSH 主机身份必须验证。模型 Key 编辑跟随全局 provider，保存时显式提交界面显示的 provider；切换服务商只清理模型 Key 草稿，保留 SSH 和生产凭证草稿。
- 其他 owner 使用 Operator 模型运行时与宿主 Git 环境。
- 个人正式 DMS/SLS 覆盖独立判断，各自完整替换对应组；没有覆盖组时用部署配置。只覆盖已有目标，不凭个人凭证创建新目标，失败不换身份重试。

普通 GET 隐藏密码、Authorization 和 SLS keys，返回配置状态。开发者专用服务说明可展示选定原生密码和 MCP 认证，原生 DMS Authorization、SLS keys 仍隐藏。完整 MCP 编辑配置有独立权限。

服务能力使用 `credentialUpdate`：`preserve` 保留已有凭证，`replace` 提供完整 `values`，`clear` 清除可选凭证。DMS URL、MySQL 数据库 URL 等目标匹配规则仍需通过；MySQL 每个数据库独立更新。空输入不代表清除，必需凭证不能 clear。Nacos、MySQL、Redis、RabbitMQ 和 Elasticsearch 密码通过校验后按原字符串保存与执行，保留首尾有效空白；旧版本已裁剪并保存的密码无法自动还原，需要重新填写。个人 DMS/SLS 保存响应只清理仍与提交内容相同的输入，等待期间的新草稿保留并提示未保存。初始状态加载不覆盖已输入的 DMS 地址，同一用户资料刷新不清空凭证草稿。

凭证不能进入 Agent prompt、原生能力工具输入或普通诊断日志。数据库异常日志移除 SQL 和参数，仅保留稳定诊断与 SQLite 错误码。查询结果、JSONL 和备份也可能敏感。开发部署只配置代码，旧开发能力配置作为私有归档保留，不投影或执行。

## 内建能力与工具

`service_query` 显式选择 environment、service、capability 和操作，凭证与连接目标由服务端注入。来源范围、校验与执行机制见 [Agent 与能力](AGENT.md#原生证据查询)。

| 能力 | 配置目标 | 操作 |
| --- | --- | --- |
| Nacos | 地址、namespace、group、dataIds | 读取配置 |
| MySQL | 多数据库 URL 和独立凭证 | 单条只读 SQL、READ ONLY transaction、CSV/JSONL 导出；结果列名须唯一，连接查询使用 AS 别名 |
| Redis | host、port、database | 受限只读命令 |
| RabbitMQ | 管理地址、managementPort、vhost | 管理 HTTP 读取，不消费消息 |
| Elasticsearch | URL | search/count/mapping |
| DMS | HTTPS MCP URL、显式数据库集合 | 只读 executeScript、完整 JSON 导出 |
| SLS | region、project、logstores | 官方 SDK GetLogsV2，检查完整性 |

RabbitMQ 旧 AMQP `port` 字段被忽略，不再展示或保存。按 vhost/queue 查询时拒绝值为 `.` 或 `..` 的对应路径段，避免 URL 标准化改变查询目标；此类名称暂不支持，其他队列名称按字面保留，包括首尾空格和纯空格名称，并分别编码，避免查询另一个队列。Nacos 在 HTTP 地址未指定端口时使用 8848；显式端口（包括 `:80`）保持不变，HTTPS 默认 443。目标和输入 schema 见 [registry.ts](../src/capabilities/registry.ts)，预算见根配置。

DMS 握手保留安全的上游 HTTP 状态，例如 `dms_mcp_http_429`；不把响应正文、URL 或认证信息拼进连接错误。每次操作最多尝试两次握手，首次握手超时或 HTTP 429 可重试一次；429 优先遵守 `Retry-After`（秒数或 HTTP 日期），再加随机退避。缺少有效提示时等待 1–2 秒；等待上限默认 5 秒，服务端要求更久时直接报告限流。等待和连接均受原有取消与总预算约束，401/403 等错误不重试，已发送的 SQL 不自动重放。参数由根配置的 `limits.capability.dms` 维护。

DMS 查询失败通过 `service_query` 的错误 JSON 返回稳定 `error` 和脱敏 `diagnostics`：`phase`（connect/discovery/execute/publish/close）、总 `elapsedMs`、各阶段 `phaseElapsedMs`、`sqlDispatchAttempted`，以及有有效上游提示时的 `retryAfterSeconds`。各阶段计时包含其内部等待，publish 可能包含 close，不能把这些时间直接求和。`sqlDispatchAttempted` 只表示已调用 SQL 发送入口，不证明服务端接收或执行；输出不存在也不证明 SQL 未执行。原始 SDK 错误、认证头、目标 URL 和 SQL 不进入该错误 JSON。调用方取消保留原取消语义。连接、发现、查询和发布仍共用 120 秒预算，不增加 SQL 自动重试。

批量 DMS 任务使用串行、有间隔的查询，根据耗时与失败调整批量和间隔；固定间隔不是已确认的上游配额。Agent 提示要求保留检查点和成功结果，优先遵守 `retryAfterSeconds`，缺少提示时有限退避；核对结果后才能主动重查只读批次，同一批次重查一次仍失败则拆分或暂停。连续两次恢复探测失败，或单轮累计五次 DMS 调用失败即保存断点并停止，探测成功不清零累计失败数。这些是 Agent 执行指引，不是服务端限流器。未完成值须与成功查询确认的零值或无记录区分，验证新文件后再发布。

SLS 错误只保留 SDK 结构化字段中可验证的诊断，不透出原始 message、请求正文、认证头或密钥；未知异常保持 `sls_query_failed`。例如 `sls_access_denied`、`sls_signature_mismatch`、`sls_invalid_access_key`、`sls_request_time_expired` 分别提示权限、签名、AccessKey 或请求时间问题；`sls_project_not_found`、`sls_logstore_not_found`、`sls_index_unavailable` 提示目标或索引不可用；`sls_rate_limited`、`sls_quota_exceeded`、`sls_http_429` 保留限流/额度线索。其他安全 HTTP 状态使用 `sls_http_NNN`，DNS、连接和证书错误分别使用 `sls_dns_failed`、`sls_network_failed`、`sls_tls_failed`。Worker 模块缺失或无法初始化使用 `capability_worker_initialization_failed`，与远程查询失败区分。查询失败不自动重放；分页中途失败也不返回前面已读页作为完整结果。

## 全局外部 MCP

支持 HTTPS Streamable HTTP、HTTPS SSE 和本地 stdio，按标准 `mcpServers` JSON 导入：

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

导入原子保存，不启动进程；编辑 JSON 只含一个服务。HTTP 默认按 Streamable HTTP 解析，只支持 Authorization 配置头；SSE 需选择对应传输。enabled/disabled 控制启用状态，stdio 相对 cwd 相对于工单 work。

局部更新中，省略 headers 可保留 HTTP 认证，空 headers 清除；目标或协议变化要明确提供新认证或清除。stdio 省略 command 仅保留原启动信息，替换时提交完整 command/args/env/cwd。配置按字面使用，不执行 `!command` 或展开变量，不读取宿主/工单 mcp.json。

列表只返回公开字段；开发者通过静默日志、no-store 的 `GET /api/mcp-services/:id/configuration` 读取完整编辑配置。已启用的全部工具向所有工单开放，readOnlyHint/destructiveHint 仅为说明。

应用保留 HTTPS 同源、禁止重定向、stdio 私有环境、启动取消/超时、分页工具数、参数和结果预算。工具变化按 list_changed 重新发现。业务失败保留 `isError: true` 并净化为 `mcp_tool_failed`，协议/网络/预算错误仍作为异常。单次取消不关闭其他操作借用的连接。连接测试只发现工具，不执行工具。

## Agent 基座与资源

基座停止编辑 500ms 后自动保存，串行并合并后续修改；草稿、失败和重试跨页面保留，切换身份取消未提交旧工作。运行中工单会阻止基座变更，成功后关闭空闲会话，下一轮读取新配置。

页面提供模型、思考、Codemode、自动压缩/重试及缓存预热。`runtime.settings` 按当前 SDK schema 校验，支持 compaction、retry、branchSummary、steeringMode、followUpMode、thinkingBudgets、transport、HTTP/WebSocket 超时、cacheWarming、images、shellPath、shellCommandPrefix 和 codemode.inlineBudget。拒绝未知、弃用字段及负数预算，其他默认值由 SDK 提供。

资源来自应用根配置指向的 `.pi`：

| 路径 | 用途 |
| --- | --- |
| skills/<name>/SKILL.md | Skill 指引 |
| prompts/<name>.md | Prompt 模板 |
| extensions/<name>.ts | 受信扩展 |
| APPEND_SYSTEM.md | 追加指令 |

资源在新会话显式加载，不自动继承宿主/Issue settings、提示词和扩展，不自动安装包。扩展不能覆盖原生/应用工具名。开发者可用 `GET /api/config/agent/resources` 读取元数据和诊断；高级 JSON 和资源文件不在页面编辑。

## 入站工单 MCP

同源 `POST /mcp` 提供无状态 Streamable HTTP，GET/DELETE 返回 405。身份沿用 HTTP；端点页按所选用户生成 Pi/Cursor/Claude Code、VS Code JSON 或 Codex TOML 接入配置。

| 工具 | 用途 |
| --- | --- |
| services_list / users_list | 服务环境、当前身份与可分配用户 |
| issues_search / issue_get | 搜索、详情、运行状态与文件列表 |
| issue_create / issue_message | 创建工单、补充消息，异步受理 |
| issue_conversation | 分页读取对话与当前进展 |
| attachment_read / output_read | 读取文本，Excel 等二进制返回下载路径 |

二进制成果的 `output_read` 使用已校验的成果元数据返回下载信息，不把文件内容读入 MCP 响应；附件读取仍保留完整性校验。

创建和发消息不幂等，超时先查询确认再决定是否重试。输入 schema、分页和响应预算以 [server.ts](../src/mcp/server.ts) 为准。
