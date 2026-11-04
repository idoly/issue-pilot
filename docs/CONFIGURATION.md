# 配置与协议

[文档导航](README.md) · [使用指南](USAGE.md) · [Agent](AGENT.md)

## 配置来源

| 来源 | 管理内容 | 不承担的职责 |
| --- | --- | --- |
| SQLite | 用户、凭证、仓库、服务部署、MCP、Agent 设置和偏好 | 不从历史 YAML 补齐值 |
| [根配置](../issue-pilot.config.ts) | state 路径、启动默认值、代码上限和运行参数默认值 | 不是每个服务的配置文件 |
| SQLite 运行参数 | admin 在“配置 → 参数”保存的运维参数覆盖值 | 不覆盖进程级设置和代码上限 |
| Operator Pi 目录 | 模型定义、settings、指令、skills、prompts 和 extensions | auth.json／models.json 中的密钥不能成为模型请求身份 |

业务配置通过页面／API 保存，不维护用户或服务 YAML 投影。state root 相对于应用源码位置解析，没有业务 state 路径环境变量覆盖。安装、测试和迁移的不同入口见[部署](DEPLOYMENT.md)、[开发](DEVELOPMENT.md)、[离线迁移](operations/legacy-layout-migration.md)。

## 身份与权限

`X-Issue-Pilot-Subject` 选择一个活跃账号，**不是认证凭证**。可信网关必须认证用户并绑定该头，防止客户端任意冒充。没有显式头时应用选择默认活跃账号；同一请求固定该选择，排队后若账号失活则拒绝，不切换其他人。

源码写入与 Git 操作、状态变更、关联修改和工作区回收同样要求活跃账号。生命周期及 inspection 队列等待后，执行前重新检查当前账号；处理方式转换也重新检查所需角色，授权错误保留原 HTTP 状态。提交作者取预约内重新读取的用户资料。

业务角色固定为 product、test、developer，`isAdmin` 是独立标记：

- product／test 可使用调查方式；开发方式要求 developer。
- 服务、仓库和用户维护等开发管理入口要求 developer；共享凭证／全局模型管理要求 admin。
- 维护管理员身份还需相应管理权限；用户变更保护活跃用户、开发者、管理员，以及至少一名活跃开发管理用户。
- 页面隐藏按钮不代替 API 授权，队列等待后会重新授权。

身份 owner 为 [route-context.ts](../src/http/route-context.ts)，具体操作限制见对应路由与 [user-routes.ts](../src/http/user-routes.ts)。

## 凭证与 owner

工单 owner 为 assignee，否则 reporter，必须活跃。凭证不授予新目标或新服务范围。

| 组 | 选择规则 | 失败行为 |
| --- | --- | --- |
| 模型 | 有个人组时整组使用个人 provider／model／thinking／Codemode／Key，否则使用共享组 | 所选组残缺、缺 Key 或调用失败直接报错，不换身份 |
| Git SSH | developer owner 的个人 SSH 身份 | 不使用其他用户、Operator Key 或匿名回退 |
| DMS | prod/test 使用 owner 的个人 URL／Authorization 组；没有个人组才用共享组 | 个人组不完整或所选组失败不回退 |
| SLS | prod/test 使用 owner 的个人 AccessKey ID／Secret 组；没有个人组才用共享组 | 同上 |

个人模型组对所有角色适用，不局限开发者。共享模型组适用于全部服务／环境，部署没有模型覆盖；Pi runtime 与网络追加项保持全局。Operator `auth.json`、`models.json` 的 apiKey／headers 不进入模型请求。

普通配置 GET 不返回密钥。开发者选定服务的私有编辑／说明接口只暴露约定的 DBHub／MCP 值，native DMS Authorization 和 SLS Key 始终隐藏。连接密钥不进入提示词、工具输入、argv、诊断或普通日志。授权查询中用户明确要求的业务登录 token 可附来源与时间返回，但不能扩大查询权限。

## 个人与共享凭证

“我的凭证”分 API Key、SSH、DMS、SLS。空白保留与显式清除不同：清除必须使用对应操作，不能把空文本误作删除。SSH 仅 developer 可设置。

admin 打开 API Key／DMS／SLS 弹窗时默认勾选共享凭证；取消后编辑个人组。非 admin 不读取共享状态。切换目标清空 Key 草稿，保存期间禁止切换；身份切换或关闭后的旧响应不能覆盖新弹窗。

### 共享 API Key

全局模型与共享 Key 存于 `global_agent_configuration`，个人完整组存于 `user_credentials.model_credentials`。模型候选来自 Pi 全局 `models.json` 中定义的 provider／model，保存仅接受有效组合。

- `PUT /api/config/agent`：`apiKey` 为 `{ mode: "replace", value }` 或 `{ mode: "clear" }`；省略保留。
- `PUT /api/me/credentials`：`model` 为完整 `replace` 组或 `{ mode: "clear" }`。
- 新建组或更换 provider 需要对应 Key；同 provider 可按接口契约保留已有 Key。
- 全局模型修改预约全部工单并关闭旧会话，相关 Agent 活动时拒绝修改；个人修改约束受影响的 owner 工单。

历史 `model_api_keys` 仅保留恢复证据，不再供运行时挑选 provider Key。

### 共享 DMS／SLS 凭据

共享组和独立 revision 位于 `application_settings`。admin 修改时预约工单并关闭旧会话；接口只返回状态及约定的非敏感编辑值。更换 DMS URL 需同时提供 Authorization。根配置不提供 DMS 地址默认值，未配置时由 admin 填写。

服务只维护目标，保存目标不要求凭证已经存在；实际查询时检查。部署 DMS／SLS 输入拒绝 `credentialUpdate`，包括旧 `preserve`。MCP 自身的凭证更新契约与此不同，不能混用。

## 服务和查询目标

仓库目录保存 URL 和显示名，服务关联仓库，prod/test 部署保存分支和查询目标。dev 基线从**同一服务的正式分支**推导，不接受独立开发覆盖。工单已经记录的分支和路径仍属其自身历史。

| 能力 | 目标字段 | 连接身份 |
| --- | --- | --- |
| DBHub | type、host、port、username、password、database | 部署配置生成专属 stdio MCP |
| DMS | alias／schema 解析得到的明确数据库绑定 | owner 个人或应用共享组 |
| SLS | region、project、logstores／targets | owner 个人或应用共享组 |

SLS 的 `*` 表示允许该 Project 下的日志库，调用仍须指定具体 logstore。DMS alias／schema 由服务端用当前操作用户的选定凭证解析，浏览器不能伪造解析结果；保存服务时忽略客户端提供的 instanceId／instanceHost／instancePort／databaseId，查询时按 owner 凭证解析。

工具是否可用依据真实目标，不硬编码某个环境禁用。调查查询保持本环境；开发查询显式选 prod/test，代码 include／remove 保持开发环境。

服务的 `deployments` 必须是数组（可为空）；省略或非数组返回 `invalid_deployments`，不再被当作清空全部部署。

状态携带 revision，保存时提供 `expectedRevision` 可检测并发冲突，`configuration_changed` 不应丢弃草稿。部分 API 接受省略版本，需要保护时必须显式携带。仓库 URL 级联变更推进关联服务版本，显示名变更不等于 URL 变更。

### DBHub

使用固定 `@bytebase/dbhub@1.5.0`，页面支持 PostgreSQL、MySQL、MariaDB、SQL Server 和 Oracle；Oracle 的 database 填服务名。目标保存在 `service_deployments.config.dbhub`，MySQL 使用 `type: "mysql"`，独立 `mysql` 输入返回 `mysql_configuration_retired`。

生成连接属于 Deployment，通用 MCP API 不能改删。DSN URL 编码后只经 `DBHUB_DSN` 环境注入，不进入 argv。[dbhub.toml](../scripts/dbhub.toml) 设置 SQL 只读、行数和连接／查询预算，数据库账号仍须具备真实只读权限。

升级 0068 只转换顶层旧 mysql 数组，不改写 archivedDevelopment。混合新旧字段、无效／重复目标、活动开发目标或部署所属 `mysql-` 历史命令会使迁移回滚，须由 owner 查明，不猜测连接。细则见[迁移 SQL](../drizzle/0068_dbhub_targets.sql)。

### 服务 MCP 与钉钉导入连接

支持 Streamable HTTP、SSE、stdio。Agent 只加载入口／已包含服务在允许来源环境中、属于 Deployment 的连接。全局无 deployment_id 的连接和钉钉导入连接不成为服务 Agent 工具。全局连接保存共享凭证并可能启动本机进程，其创建、导入、读取私有配置、修改、删除和连接测试都仅限管理员。

Pi 管理发现、注册、资源、复用和关闭；应用保留字面私有配置、同源／禁止重定向、预算、取消和发送前校验。`readOnlyHint` 是说明，不是授权。列表与模型说明隐藏 URL 查询部分；标准导入结构见 [mcp.json](../examples/mcp.json)。

连接测试只有发现工具和关闭连接均成功才报告成功。操作与关闭都失败时保留两个原因，即使已经取消也不丢弃清理失败；对页面只返回稳定错误码，不返回协议、目标或认证明文。

## 钉钉导入

输入 `/notable/record` 链接中的 dentryUuid、sheetId、rowId，通过选定全局连接调用 `get_tables` 和按 recordIds 精确查询的 `query_records`。

个人字段偏好逐项覆盖共享映射，支持精确名称或 ID；缺失／重名报错，可选字段可用空值跳过。个人偏好不保存网关密钥，调用参数不能替换映射。默认标题取“序号”原值。

默认指派当前调用者，可指定活跃处理人或 null。重复来源返回原工单，不改派、不重复启动。附件只从允许的 HTTPS 主机下载，不跟随重定向、不转发 MCP 凭证；链接附件保留描述。工单与附件完整保存后返回。

## Agent 基座与资源

Pi ResourceLoader 使用 `getAgentDir()` 解析的运行用户全局目录，默认 `~/.pi/agent`。应用不维护自己的 skills／extensions 副本，不加载工单目录扩展；Operator 扩展不能覆盖应用保护工具。

Pi settings 为基线，SQLite `runtime.settings` 显式覆盖，省略的覆盖恢复基线。可配置项由 [contracts.ts](../src/domain/contracts.ts) 和 [pi-runtime.ts](../src/configuration/pi-runtime.ts) 限定，不接受任意 Pi 内部设置。资源检查只发现资源，不执行扩展；实际会话才加载。

`runtime.networkAllowedDomains` 在个人组内追加精确域名／端口，省略回到运行参数的基础白名单，不覆盖宿主控制地址拒绝或业务范围。它与运行参数使用同一套校验：单项语法、去重、最多 100 项。

## 运行参数

以下参数由 admin 在“配置 → 参数”修改，保存后立即生效，不需要重启应用，也不预约工单或关闭会话。未保存过的项使用根配置 `issue-pilot.config.ts` 的 `parameters` 默认值；已保存的值存于 `application_settings.parameters`，带 `parameters_revision` 做并发冲突检测。

| 参数 | 生效时机 |
| --- | --- |
| `maxConcurrentIssues` | 立即。调高放行排队轮次；调低不中断运行中的轮次，只在释放名额时收紧。排队算活动但不占执行名额 |
| `modelResponseIdleMs` | 下一次重新计时，包含已打开会话 |
| `workspaceRetentionMs`、`workspaceHighWaterBytes`、`workspaceTargetBytes` | 下一次维护或统计采样 |
| `workspaceMaintenanceIntervalMs` | 保存后重新计时；0 表示不自动维护 |
| `capabilityConnectionMs`、`mcpExecutionMs`、`dmsExecutionMs`、`slsExecutionMs` | 下一次调用 |
| `dingtalkAttachmentHosts` | 下一次导入 |
| `networkAllowedDomains` | 下一次获取沙箱；在用的沙箱由 `SandboxManager.updateConfig` 同步 |

`GET /api/config/parameters` 返回 `revision`、保存的 `overrides`、生效的 `values`、根配置 `defaults` 和 `bounds`。`PUT /api/config/parameters` 接受 `{ expectedRevision, overrides }`：`overrides` 是完整快照，省略的项回到默认值；数值必须为范围内的整数，`workspaceTargetBytes` 必须小于非零的 `workspaceHighWaterBytes`，非零维护周期不小于一分钟，列表去重且逐项校验。非法值返回 `400 invalid_application_parameter:<key>`，版本不符返回 `409 configuration_changed`。并发参数之外的入站额度、协议字段长度、缩进以及端口、state 路径、时区等进程级设置仍在根配置中，修改需要重启。

SSE 使用 idle／queued／running，并保留包含排队的 running 布尔语义。`http.sseRecentEventIds` 限制临时 ID 去重窗口；`http.sseQueuedBytes` 分别限制待发送帧和回放期间的实时缓冲，不限制整份历史总大小或已直接交给 socket 的单帧。

## 入站工单 MCP

`/mcp` 为无状态 Streamable HTTP POST，复用 HTTP 身份；GET／DELETE 返回 405。从“配置 → 端点”复制当前用户配置，不能把 subject 头当作网关认证替代品。

| 工具 | 用途 |
| --- | --- |
| services_list／users_list | 发现服务、用户并核对当前身份 |
| issues_search／issue_get | 搜索与读取状态、范围、附件 |
| issue_create | 创建、保存附件后自动入队；省略处理人即未分配 |
| dingtalk_import | 单条导入；默认 p2、不启动、指派当前用户 |
| issue_message／issue_conversation | 异步发送与分页读取进展 |
| attachment_read | 校验并读取原件，二进制返回下载路径 |
| work_files／work_file_read | 读取授权工作目录，管理文件只列名称 |

附件结构为 fileName、可选 mediaType 和标准 Base64 contentBase64，不带 data 前缀。HTTP 上传不设置附件业务总大小／数量上限，部署必须控制传输与内存。响应和分页预算见根配置。入站 MCP 的 Base64 附件在内存中解码，单个不超过 `mcpServer.attachmentBytes`（默认 20 MiB）、数量不超过 `mcpServer.attachments`（默认 20），超限在解码前拒绝；HTTP 上传仍流式落盘，不受此限。文本附件或工作文件在 `mcpServer.readBytes` 以内时按 offset／limit 分页读取，每页受 `mcpServer.responseBytes` 约束；超过 `readBytes` 时返回 `inline: false`、`size`、`reason: "read_budget_exceeded"` 与下载路径，不整份读取；二进制同样只返回元数据与下载路径。

只读资源为 `issue-pilot://catalog/services`、`issue-pilot://catalog/users` 和 `issue-pilot://issues/{key}`。工具 schema、默认值与错误边界以 [server.ts](../src/mcp/server.ts) 为准，创建或发送响应不明时先查询，不盲目重试。
