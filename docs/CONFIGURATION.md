# 配置与协议

[文档导航](README.md) · [使用指南](USAGE.md) · [Agent](AGENT.md)

## 配置来源

| 来源 | 内容 |
| --- | --- |
| SQLite | 用户、凭证、仓库、服务部署、MCP、Agent 与业务偏好 |
| `issue-pilot.config.ts` | 路径、启动默认值、预算与维护策略 |
| Operator Pi 目录 | 模型、认证、settings、Skills、Prompts、Extensions 和指令 |

SQLite 是业务配置唯一来源，页面和 API 由 owner 读写。配置页顺序为用户、仓库、服务、端点，分类首次访问加载，之后保留状态。标准 MCP JSON 导入接受 [mcpServers 结构](../examples/mcp.json)，结果保存到数据库。

## 身份与权限

`X-Issue-Pilot-Subject` 选择活跃用户，可信网关负责认证并绑定该请求头。未显式提供时，同一请求固定首次解析出的默认身份，失活后不切换其他用户。

角色为 product／test／developer，`isAdmin` 独立。用户维护须保留至少一个活跃且有管理权限的 developer。页面与 API 继续检查角色、管理权限和相关任务活动。

## 凭证与 owner

owner 是 assignee，否则为 reporter，必须活跃。开发任务要求 developer；developer owner 使用本人模型和 Git 身份，缺失或失败直接报告。

个人凭证分 API Key／SSH Key／DMS／SLS 四组，空白保留已有值，单独清除才删除。DMS 的 URL／Authorization、SLS 的两个 Key 各自构成完整组；个人正式组独立、完整覆盖部署组，缺少该组才使用部署配置，不能创建不存在的目标。服务密钥更新通过 `credentialUpdate` 明确 preserve／replace。

普通 GET 隐藏配置密钥；开发者选定服务的私有接口可返回约定的 DBHub／MCP 编辑值，native DMS Authorization 和 SLS Key 保持隐藏。配置密钥不进入提示词、工具输入、argv 或普通日志。用户明确请求的业务 token 可作为授权查询结果返回，附来源与时间，不扩大访问范围。

## 服务和查询目标

仓库目录登记 URL 和显示名，服务关联仓库，部署配置正式／测试基线。开发继承同服务正式分支，不接受独立覆盖；缺少正式部署时拒绝保存。既有工单分支、commit 和路径按自身记录恢复。

| 能力 | 配置 |
| --- | --- |
| DBHub | 选择数据库类型，维护 host、port、username、password、database |
| DMS | alias／schema，首次按当前连接严格解析绑定 |
| SLS | region、project、logstores；`*` 允许该 Project 下任意日志库，查询仍指定一个具体名称 |

环境收起显示能力标签，展开原位显示 DBHub／DMS／SLS 复选框；切换保留草稿，保存才提交。DMS 与 SLS 都按连接凭证、查询目标编辑，DMS 目标显示数据库解析状态。能力按真实目标配置展示，不按环境名称额外禁用。开发查询显式选择 prod／test，代码增删仍属开发环境。

状态响应带整数 revision，页面保存携带版本，冲突返回 `configuration_changed` 并保留输入。API 允许省略 `expectedRevision`，需要冲突保护时应始终提供。仓库 URL 级联更新推进关联服务 revision，显示名变更只更新仓库。相关 Agent／预约活动阻止冲突写入。

## 内建能力与工具

`service_query` 提供 DMS 和 SLS。DMS 使用受校验的只读 SQL 与 SSE；SLS 调用 `aliyun sls GetLogsV2`。目标和凭证由服务端选择，完整性、预算、取消与重试规则统一见[原生证据查询](AGENT.md#原生证据查询)。

### DBHub

数据库能力使用固定版本 `@bytebase/dbhub@1.5.0` 的 stdio MCP，页面支持 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle。DBHub 原生另支持 SQLite，本页配置远程数据库；Oracle 的 database 字段填写服务名。

目标属于 `service_deployments.config.dbhub`，连接与配置在同一事务保存，按部署、类型、host、port、database 标识。页面保留分字段输入；旧 MySQL 字段可读取为 MySQL 类型，保存时使用 DBHub。生成连接归部署所有，通用 MCP API 不可改删，移除目标按归属删除。

DSN 经 URL 编码后只注入 `DBHUB_DSN` 环境，不进入 argv。`scripts/dbhub.toml` 只引用环境变量，设置 execute_sql 只读、最多 1000 行、连接 10 秒、查询 30 秒；数据库账号还应具有实际只读权限。Pi 管理工具发现与进程生命周期，连接变更沿用全部工单预约关闭旧会话。

### 服务 MCP 与钉钉导入连接

支持 HTTPS Streamable HTTP、SSE 和本地 stdio。Agent 只加载入口／已包含服务在允许来源环境中的部署所属连接，服务说明同样按当前部署展示。无 deployment_id 的连接不注入服务工具。默认 dingtalk 及用户偏好指定的连接仅供导入。

Pi 管理发现、注册、资源、连接与关闭。应用保留字面私有配置、同源／禁止重定向、预算、取消及发送前校验；只读 hint 不是授权。普通列表和模型说明隐藏 URL 查询部分。

## 钉钉导入

接受 `/notable/record?dentryUuid=BASE&rowId=RECORD&sheetId=TABLE`，只调用 `get_tables` 和按 recordIds 精确读取的 `query_records`。

个人 `user_preferences.dingtalk.fields` 按项覆盖共享 `application_settings.dingtalk_fields`，支持精确名称或 ID，缺失／重名报错，空字符串可跳过可选字段；参数不能临时覆盖映射。默认标题取“序号”原值。

新工单默认指派给当前调用用户，可用 assigneeSubject 指定活跃处理人，null 表示未分配；开发工单的实际 owner 必须为开发者。重复来源返回原工单、不改派或重复启动。页面新导入启动 Agent；MCP 默认不启动。附件只从允许的 HTTPS 存储主机下载，不跟随重定向、不转发 MCP 凭证，工单与附件保存成功才返回。关闭或切换身份取消未完成请求，已提交工单保持有效。

## Agent 基座与资源

全局模型、thinking、Codemode 应用于所有服务／环境。Pi ResourceLoader 从 getAgentDir 加载资源，默认 `~/.pi/agent`，模型由 models.json 定义；工单扩展不加载，Operator 扩展不能覆盖保护工具。

Pi settings 为基线，数据库 runtime.settings 显式覆盖，省略则清除该覆盖。runtime.networkAllowedDomains 为本地工具和 stdio MCP 追加精确域名／端口，省略回到根配置列表；不能覆盖宿主控制地址拒绝或替代业务授权。资源检查 GET 只发现路径，实际会话才加载扩展，变化后重建会话或重启。

`application_settings.maxConcurrentIssues` 限制并发轮次，排队计入活动。根配置 `http.sseRecentEventIds` 默认 4096，只控制临时事件 ID 窗口。

## 处理方式

| workMode | 环境 | Issue type |
| --- | --- | --- |
| production_analysis | prod | smart_analysis |
| test_analysis | test | smart_analysis |
| development_fix | dev | defect_fix |
| development_feature | dev | feature_development |

调查使用只读快照，开发使用独立 worktree。全部类型可创建工作文件，查询与导出取决于目标和凭证。

## 入站工单 MCP

同源 `/mcp` 使用无状态 Streamable HTTP，复用 HTTP 身份。客户端配置从“配置 → 端点”复制，`users_list` 核对账号，`services_list` 发现可用范围。

`issue_create` 创建后自动入队，assigneeSubject 省略时未分配。`dingtalk_import` 的 assigneeSubject 省略时为当前用户、null 为未分配，也可填 users_list 返回的 subject；priority 默认 p2、startAgent 默认 false，返回 status 和 issueKey。创建与发消息为异步受理，响应不明先查询确认。

附件使用 fileName、可选 mediaType（默认 application/octet-stream）和标准 Base64 contentBase64，无 data 前缀。工单、附件一起保存后才入队，应用不设附件总大小／数量业务上限，传输与内存容量由部署控制。

`issue_get` 返回附件 ID，`attachment_read` 读取原件。`work_files` 列文件，`work_file_read` 使用返回的 path，下载入口为 `/api/issues/:key/files`。DMS 的 `export: { fileName: "evidence.json" }` 返回文件元数据和 downloadPath。
