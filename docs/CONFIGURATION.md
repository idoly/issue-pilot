# 配置与协议

应用业务状态保存在安装项目下的 `.issue-pilot/`。SQLite 是人员、凭证、仓库、服务、查询目标及业务偏好的唯一来源；配置页和对应 HTTP owner 直接读写数据库。程序、依赖和 Python 环境位于应用目录，工单文件与 Git 布局见[存储设计](STORAGE.md)，备份与恢复见[运维手册](RUNBOOK.md)。

## 配置来源

| 来源 | 内容 |
| --- | --- |
| SQLite subjects／user_credentials | 人员角色、管理权限、启停及四组个人凭证 |
| SQLite repositories／services／service_repositories | 仓库登记、服务及关联关系 |
| SQLite service_deployments／service_deployment_repositories | 正式／测试分支与 MySQL、DMS、SLS 目标；开发基线继承正式 |
| SQLite global_agent_configuration／application_settings | 全局 Agent 与运行偏好、并发上限、已有 MySQL stdio 模板 |
| SQLite mcp_services | MCP 连接；服务工具按 deployment_id 归属，钉钉连接仅供导入 |
| SQLite user_preferences／application_settings | 个人钉钉来源／字段偏好和共享字段映射 |
| Pi 全局目录 | models.json、Operator 认证、settings、Skills、Prompts、Extensions、全局指令 |
| issue-pilot.config.ts | 应用路径、启动默认值、预算和维护策略 |

不再支持 `user.yaml`、`service.yaml` 或 state root 中 `mcp.json` 的业务配置加载、导入、导出和旧格式转换。相关脚本及示例已移除。旧文件若仍存在，只是历史恢复材料，不会覆盖数据库或补齐缺失凭证；应用不自动删除这些未知文件。MCP 的标准 mcpServers JSON 导入／编辑 API 仍保留，见 [mcp.json 示例](../examples/mcp.json)，它不是另一份文件权威源。Pi 自身的文件和格式由 Pi SDK 管理。

根配置中的 http.sseRecentEventIds 默认 4096，必须为正整数，控制单条 SSE 连接近期临时事件 ID 窗口。持久条目仍按连接生命周期去重；这个预算不限制消息内容或网络背压队列，修改随重启生效。

## 服务和查询目标

仓库登记一次地址和显示名，服务选择仓库，正式／测试环境配置分支。开发基线只读继承同服务正式分支，不接受独立覆盖；缺少正式部署时拒绝保存。新工单使用当前基线，既有工单分支、commit 和路径保持历史事实，不通过服务配置重置。移动已有 Git worktree 根路径仍须独立迁移和演练。

MySQL 目标按环境维护 host、port、username、password、database。DMS 使用 alias／schema，首次查询前按当前连接严格解析，目标未变时复用已解析绑定。SLS 使用 region、project、logstores，多个命名目标保留各自 name，查询显式选择目标和 logstore。开发工单查询仍明确选择 prod/test 证据，不因此改变开发代码环境。

个人 DMS 的 URL／Authorization、SLS 的两个 Key 分别构成完整组；更新和清除由个人凭证接口处理，空白输入保留现有配置。服务 DMS／SLS 的密钥继续经 credentialUpdate preserve／replace 明确处理，不在普通 GET 回显。没有按文件跨账号补齐凭证的入口。

全局 Agent runtime.networkAllowedDomains 为本地工具和 stdio MCP 追加域名或 host:port；SSH 22 和 HTTPS 443 分别声明，仓库 URL 不自动放通网络。规则不能覆盖宿主地址和应用控制端口的拒绝策略，也不改变 DMS／SLS 的业务目标授权。

application_settings.maxConcurrentIssues 限制并发工单轮次；排队仍计入活动，工单串行和失败清理规则不变。当前页面只提供已有的人员、仓库、服务和凭证编辑能力；本次移除文件链路不新增通用配置编辑器。

## 钉钉导入

顶部“钉钉”弹窗接受 `/notable/record?dentryUuid=BASE&rowId=RECORD&sheetId=TABLE` 单条记录链接。选择入口服务、处理方式和优先级后导入，不预览、不扫表、不分页，不按人员或状态筛选。工单归当前应用用户，使用选定的全局 MCP 连接；没有个人钉钉凭证覆盖或失败回退。默认链接及字段偏好从数据库读取，未声明默认链接时在弹窗填写。

字段映射不允许临时调用参数覆盖；个人 user_preferences.dingtalk.fields 按项覆盖 application_settings.dingtalk_fields。支持精确字段名或 ID，缺失或重名时报错，可用空字符串跳过可选字段。默认标题使用“序号”原值。assignee 筛选和 intervalMinutes 轮询声明不属于当前配置契约；历史 JSON 中的同名数据不执行、不自动清理，也不启动轮询。

只调用 get_tables 和按 recordIds 精确读取的 query_records。重复来源返回已有工单，手工工单按完整标题或编号精确核对，不自动补历史来源绑定。附件下载、校验和工单保存成功后才返回；失败清理暂存文件并回滚。附件仅允许配置的 HTTPS 存储主机，禁止重定向，不转发 MCP 凭证，原件权限 0400。

页面导入成功后启动 Agent；重复导入不重复启动，弹窗保留并清空链接。MCP 的 dingtalk_import 与页面共用接口，参数 url、serviceKey、workMode，可选 priority（默认 p2）、startAgent（默认 false），返回 status 和 issueKey。关闭或切换身份会取消未完成请求，已经提交的工单不会撤回。

## 凭证与 owner

工单 owner 为 assignee，未分配时为 reporter，必须活跃。开发要求 owner 为 developer。developer owner 使用个人模型和 Git 身份，缺失或失败不回退到其他身份。个人正式 DMS/SLS 配置各自完整覆盖部署组，没有该组则使用部署配置，不能创建不存在的目标。普通配置 GET 隐藏凭证；选定 MCP 编辑配置的开发者接口可以展示其文档约定的私有值。配置密钥不会注入 Agent 提示词或工具输入；本地工具经 SRT 限制持久文件写入范围，执行与远程服务的信任边界见 [Agent](AGENT.md#执行边界)。

用户明确请求的业务登录 token、session token 和业务 Authorization 可以作为 SLS/DMS 查询结果返回，并注明来源与时间，不需要重复确认。该规则针对授权查询返回的业务证据；用于连接 SLS、DMS、MCP、模型和 Git 的应用配置密钥仍隐藏。查询结果不授予额外服务或环境权限。

## 内建能力与工具

DMS／SLS 按实际部署配置展示和查询，没有针对测试／正式名称的额外禁用规则。没有目标就不展示该能力。MySQL 在编辑器中与 DMS／SLS 一样由“添加能力”选择，未选中不显示目标编辑器；执行仍由 MCP 负责。

配置页顺序为用户、仓库、服务、端点。分类首次访问时才挂载和读取；已访问分类保留实例和筛选，默认用户页不预加载服务配置、仓库、端点或私有服务说明。用户页提供四组个人凭证和人员管理；凭证弹窗直接填写，留空保留，清除显式执行，不回显秘密。仓库页登记／编辑地址与显示名、查看使用服务并可跳转；未使用仓库可删除。服务保留顶部 Tab、代码分支矩阵和描述，开发基线只读继承正式分支；MySQL、DMS、SLS 仍按环境维护。MySQL 密码只在开发者选定服务的私有详情／编辑读取，普通配置 GET 只返回 passwordConfigured。服务、仓库和个人凭证状态响应始终携带整数 revision，前端类型不再接受缺失版本的旧响应。页面编辑使用对应版本，过期返回 configuration_changed，保留输入并在编辑弹窗提供重新加载。仓库 URL 的级联变更同时推进所有关联服务的 revision，避免旧服务草稿恢复旧地址；仅修改仓库显示名不推进服务版本，也不扩大工单预约。API 仍允许省略 expectedRevision 的现有调用；需要冲突保护的客户端应始终携带它。

原生 `service_query` 只提供 DMS 和 SLS，显式选择 service/environment。Nacos、Redis、RabbitMQ、Elasticsearch 和原生 MySQL 已移除。旧部署 JSON 仅作为私有恢复证据保留，不投影、不执行；新增迁移移除旧开关，历史迁移保持不变。

### MySQL MCP

MySQL 目标保存在 service_deployments.config.mysql，保存与关联 MCP 条目同一事务完成。默认启动模板固定 `@benborla29/mcp-server-mysql@2.0.9`；数据库 application_settings 中已有的私有 stdio 模板继续按其字面配置使用。应用按部署、host、port、database 标识连接，注入 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASS`、`MYSQL_DB`；固定关闭 INSERT/UPDATE/DELETE 开关。密码保留有效空白，不进入 argv。示例固定 `@benborla29/mcp-server-mysql@2.0.9`。模板本身不作为无参数服务器启动。生成条目带 deployment_id，不允许经通用 MCP 接口修改或删除；服务移除目标时按归属删除。连接加载按入口／包含服务的部署范围选择。现有连接变更仍沿用保守的全部工单预约，以关闭旧版本会话，不在本次同时改动并发边界。

Pi 在同一工单会话中复用对应 MCP 连接。MySQL 的 SQL 能力、结果格式和读取限制由所选 MCP 服务及数据库账号负责；不再提供原生 `db` 查询、导出接口或其事务保证。需要交付时在工单工作目录处理 MCP 返回结果，直接保存普通文件并使用工作文件下载链接。

### DMS

DMS 使用原生 SSE，只执行验证过的只读 SQL；导出完整 MCP JSON 到工单根目录的普通工作文件，完成写入后原子替换目标。一次操作预算 120 秒，首次握手预算 12 秒，握手最多两次。429 优先遵守有效 `Retry-After`，最多等待 5 秒后进行一次握手重试；更长提示直接报告限流。401/403 不重试，已发送的 SQL 不自动重放。

失败通过工具错误 JSON 返回稳定 `error` 和脱敏 `diagnostics`：阶段 connect/discovery/execute/export/close、总耗时、阶段耗时、`sqlDispatchAttempted` 和可用的 `retryAfterSeconds`。阶段时间可能重叠，不能求和；`export` 指普通工作文件写入和原子替换，导出失败不会自动重试 SQL；尝试发送不证明服务端执行。原始错误、目标 URL、SQL 和认证不进入该错误 JSON。取消保留原原因。

批量任务串行并保留间隔，根据耗时与错误调整批量。核对已保存结果后才主动重查只读批次，同一批次重查一次仍失败则拆分或暂停。连续两次恢复探测失败，或单轮累计五次 DMS 调用失败即保存断点并停止，探测成功不清零累计失败数。该规则是 Agent 指引，不是服务端限流器。未完成不能推断成零值或无记录。

### aliyun sls

SLS 通过固定的 `aliyun sls GetLogsV2` 命令查询，运行环境需要 aliyun CLI；镜像安装固定版本 3.5.2。应用用 `0600` 临时配置注入选定凭证，关闭 CLI 自动重试，使用 HTTPS，结束或取消后删除临时配置，不修改宿主默认 profile，不把密钥放进 argv。

保留明确时间范围、Trace ID、目标校验和分页预算。只有 meta.progress=Complete 才接受结果；SQL 分析按 SQL LIMIT/ORDER BY 返回一页，普通查询按 offset 分页。晚一页失败时整次调用失败，不返回前面页面作为完整结果。未知 CLI 错误统一隐藏，已知 Code/StatusCode 转为稳定诊断。CLI 缺失报 `sls_cli_not_available`；超时或取消终止进程组并完成凭证清理。

### 服务 MCP 与钉钉导入连接

支持 HTTPS Streamable HTTP、SSE 和本地 stdio。服务说明只展示当前部署的连接；Agent 只加载入口／已包含服务在可用来源环境中的部署所属连接。无 deployment_id 的历史全局条目不自动给所有工单使用；不根据名称猜测其服务归属。默认 dingtalk 及 user_preferences.source.mcp 指定的连接仅用于应用导入，任何服务工具加载都排除它们。只读提示是描述，不是授权。SDK 负责协议传输，Pi 的公开 `createMcpExtension` 负责发现、工具注册、资源、连接生命周期与关闭。应用不再直接依赖 `@earendil-works/pi-mcp`；Pi SDK 内部仍可能传递依赖它。

保留 HTTPS 同源、禁止重定向、私有 stdio 环境、取消、输入 schema 与结果预算。MCP URL 可以包含钉钉所需的查询认证，但普通列表和模型服务说明隐藏查询部分。会话过期时报告本次失败并关闭连接，下一次显式调用重新连接，不自动重放本次操作。外部 MCP 不再预设 Playwright 或浏览器工具。

## Agent 基座与资源

Skills、Prompts、Extensions、SYSTEM/APPEND_SYSTEM 与全局指令通过 Pi 标准 ResourceLoader 从 `getAgentDir()` 加载，默认 `~/.pi/agent`，尊重 Pi 自己的目录配置。全局 settings 是基线，全局 Agent 配置的 runtime.settings 可显式覆盖运行参数；`agent.runtime.networkAllowedDomains` 为本地工具和 stdio MCP 追加按域名或 `host:port` 限定的出口，使用 SRT 的域名规则校验，不能覆盖宿主控制地址与端口的拒绝规则。省略运行设置时清除旧数据库设置覆盖并采用全局 Pi settings；省略网络追加项时清除旧数据库网络覆盖，采用根配置的基础域名列表。应用不再绑定源码 `.pi` 目录，不另建应用资源目录，也不加载工单中生成的 `.pi` 扩展。用户扩展不能覆盖应用保护的工具名称。

资源检查 GET 仅发现扩展路径，不执行用户扩展。实际会话创建时加载资源，正常触发扩展启动和关闭。模型接口定义继续由全局 Pi `models.json` 管理。改变资源后重建会话或重启应用。

## 处理方式

| workMode | 环境 | Issue type | 代码 |
| --- | --- | --- | --- |
| production_analysis | prod | smart_analysis | 只读快照 |
| test_analysis | test | smart_analysis | 只读快照 |
| development_fix | dev | defect_fix | 独立 worktree |
| development_feature | dev | feature_development | 独立 worktree |

旧 `production_data` / `data_processing` 由迁移 0062 统一改为 `production_analysis` / `smart_analysis`，同时转换处理历史的前后模式。新请求及数据库写入拒绝旧类型。全部处理方式均可创建普通工作文件；DMS 导出取决于配置与凭证。

## 身份与权限

可信网关负责认证，`X-Issue-Pilot-Subject` 选择活跃用户；未提供时同一请求固定首次解析出的默认身份，失活后不自动切换。业务角色 product/test/developer 与 isAdmin 独立。维护用户须保留至少一个活跃的 developer 管理用户。

## 入站工单 MCP

同源 `/mcp` 提供无状态 Streamable HTTP，复用 HTTP 身份和业务入口。创建和发消息只表示异步受理，超时先查询确认，不自动重复提交。`issue_create` 支持 `attachments` 数组，每项填写 `fileName`、可选 `mediaType`（默认 `application/octet-stream`）和标准 Base64 `contentBase64`，不含 `data:` 前缀。支持文本、图片和二进制文件，不设置应用层请求总大小或附件数量上限；调用方传输和运行内存仍有实际容量限制。工单与附件复用 HTTP multipart 的同一校验、事务和回滚流程，保存成功后才入队；文件权限为 `0400`。附件内容不回显在创建结果中，通过 `issue_get` 取得附件 ID 后调用 `attachment_read` 或下载接口读取。

```json
{
  "title": "检查附件中的数据",
  "serviceKey": "orders",
  "workMode": "test_analysis",
  "attachments": [
    { "fileName": "note.txt", "mediaType": "text/plain", "contentBase64": "aGVsbG8=" }
  ]
}
```

二进制工作文件返回已验证的下载路径，不把文件内容塞进 MCP 文本。DMS 导出返回 `downloadPath`，对话应使用该路径提供下载。`work_files` 列出当前工作文件，`work_file_read` 使用列表返回的 `path` 读取根目录或子目录普通文件。两者统一使用 `/api/issues/:key/files`；旧 `output_read` 名称、`fileName` 读取参数、`/outputs/:fileName` 路由和 Issue 详情的 `outputs` 字段已经移除。DMS 用 `export: { fileName: "evidence.json" }` 请求导出，结果的 `export` 对象包含 `fileName`、`size`、`format` 和 `downloadPath`，不接受旧 `output` 导出字段。
