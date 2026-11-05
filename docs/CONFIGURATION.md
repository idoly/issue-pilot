# 配置与协议

[文档导航](README.md) · [使用](USAGE.md) · [Agent](AGENT.md)

## 配置分层

| 来源 | 内容 |
| --- | --- |
| SQLite | 用户、凭证、仓库、服务部署、MCP、模型、偏好及运行参数覆盖 |
| 根配置 | 路径、监听、bootstrap 用户、区域、硬预算与运行参数默认值 |
| Operator Pi 目录 | 模型定义、settings、指令、skills、prompts、extensions |

业务设置由页面／API 持久化，不从 YAML 或历史私有字段填补缺失值。state 路径相对于源码根解析，没有 state／database 环境变量覆盖。Operator auth.json／models.json 的密钥或 headers 不能成为模型请求的 fallback。

配置页面分类为用户、仓库、服务、端点、参数。根配置不是所有值的运行时来源；参数页只开放明确支持热更新的项目，不代表端口、时区和硬上限也可热改。

## 身份与权限

`X-Issue-Pilot-Subject` 选择活跃用户，**不是认证**。可信网关必须认证并绑定该头。调用身份校验时，无显式头会按 `createdAt`、`subject` 升序选择第一名活跃用户，并在该请求内固定选择；等待后该用户失活则拒绝，不换账号。这不是固定的全局登录账号。部分目录／详情 GET 不调用身份校验，因此错误 subject 头也不能作为这些接口拒绝访问的保证；认证边界必须在网关，详见 [HTTP 身份边界](HTTP.md#身份与访问边界)。

| 身份条件 | 主要用途 |
| --- | --- |
| 活跃用户 | 工单操作；源码写入、Git、状态、关联、回收等执行前均重检 |
| developer | 开发处理方式、仓库／服务／用户维护及约定的私有配置读取 |
| isAdmin | 全局模型、共享凭证、全局 MCP 管理及运行参数写入 |

product／test／developer 是业务角色，isAdmin 独立。用户维护保护活跃用户、开发者、管理员，以及至少一名活跃开发管理用户。队列等待后重新授权，不能把页面隐藏按钮当权限边界。提交作者使用预约内重新读取的人员资料。

## 凭证与 owner

owner 为 assignee，否则 reporter，必须活跃。完整个人组和共享组只按规则二选一，失败不更换身份。

| 组 | 选择规则 |
| --- | --- |
| 模型 | 任何角色 owner 有个人组时整组替换共享 provider／model／thinking／Codemode／Key；没有个人组才用共享组 |
| Git | developer owner 使用本人 SSH 私钥，严格 known_hosts，不回退 Operator 或其他用户身份 |
| DMS | prod/test 选择 owner 的完整 URL／Authorization；没有个人组才用应用共享组 |
| SLS | prod/test 选择 owner 的完整 AccessKey ID／Secret；没有个人组才用应用共享组 |

个人组残缺、所选 Key 缺失或调用失败均报错。凭证不创建目标、不扩大范围；开发查询仍须明确选择 prod/test。

普通配置 GET 脱敏。developer 选定服务的私有编辑／说明接口仅暴露契约规定的 DBHub／MCP 值，native DMS Authorization 和 SLS Key 保持隐藏。连接密钥不进入提示词、工具输入、argv 或普通日志。授权查询结果中的业务登录 token 可在用户明确请求时附来源和时间返回，不扩大访问权限。

## 个人与共享设置

“我的凭证”分 API Key、SSH、DMS、SLS。admin 打开 API Key／DMS／SLS 弹窗默认编辑共享组，取消共享勾选才编辑个人组；非 admin 不读取共享状态。SSH 仅 developer。

空白保留与显式 clear 不同。切换个人／共享目标清空 Key 草稿，保存期间不可切换；关闭或换身份后旧请求不能覆盖新弹窗。

共享完整模型组在 global_agent_configuration，个人组在 user_credentials.model_credentials，候选只来自运行用户 Pi `models.json.providers` 声明的 provider 下的模型；应用离线刷新目录，不自动联网补齐模型。空目录在首次创建全局模型配置时会阻止启动，见[首次运行](DEPLOYMENT.md#首次本地运行)。`PUT /api/config/agent` 的 apiKey 是 replace／clear，省略保留；个人 `PUT /api/me/credentials` 的 model 是完整 replace 组或 clear。更换 provider 必须提供对应 Key 或清除，不能保留跨 provider Key。

共享 DMS／SLS 位于 application_settings，独立 revision；更换 DMS URL 需同时提供 Authorization，没有代码默认连接地址。模型和凭证变更按受影响工单预约、关闭旧会话，活动冲突拒绝修改。服务 DMS／SLS 不接受 credentialUpdate，连接密钥只在个人／共享入口维护。

## 运行参数

[参数页截图](images/parameters.jpg)。owner 为 [parameters.ts](../src/configuration/parameters.ts)，默认值位于 [根配置 parameters](../issue-pilot.config.ts)。

| 参数 | 默认值 | 生效边界 |
| --- | --- | --- |
| maxConcurrentIssues | 10 | 调高放行排队，调低不终止已有轮次 |
| modelResponseIdleMs | 300 秒 | 下一次响应计时，工具执行时间不累计 |
| workspaceRetentionMs | 7 天 | 后续维护／采样 |
| workspaceHighWaterBytes／workspaceTargetBytes | 20／16 GiB | 后续压力回收，非零高水位须大于目标 |
| workspaceMaintenanceIntervalMs | 15 分钟 | 保存后重新计时，0 停止周期维护 |
| capabilityConnectionMs | 10 秒 | 后续连接 |
| mcpExecutionMs／dmsExecutionMs／slsExecutionMs | 120／120／30 秒 | 后续调用 |
| dingtalkAttachmentHosts | 根配置中的 HTTPS 主机列表 | 后续导入 |
| networkAllowedDomains | 根配置中的基础域名列表 | 沙箱获取／网络配置同步，不替代宿主拒绝规则 |

高水位 0 关闭按占用触发的回收，不关闭其他释放检查。字段范围来自 API bounds：并发 1–64、列表最多 100 项且去重，非零维护周期至少一分钟。默认值在代码中仍有必要；没有覆盖时跟随默认值。

`GET /api/config/parameters` 返回 revision、overrides、values、defaults、bounds。`PUT` 要求 admin 和 `{ expectedRevision, overrides }`；overrides 是完整覆盖快照，省略项回到默认值。非法值返回 400，revision 冲突为 `configuration_changed`。页面只向 admin 展示编辑表单。

保存先持久化再更新进程快照，通知并发、维护和网络 owner；不预约全部工单、不关闭会话。已有调用继续使用已取得的预算，不能把“无需重启”理解成撤销所有在途操作。网络同步失败时数据库仍为权威，下次获取沙箱重试同步。

workspace.taskConcurrency 仍是代码设置，控制后台准备／检查／测量的批次并发，不是 Agent 并发；端口、state 路径、时区、SSE 和文件等硬预算也不在参数页。

## 服务和查询目标

仓库目录保存 URL、显示名和手动指定的分组，分组独立于服务关联。prod/test Deployment 保存基线与目标。dev 分支从同服务正式部署推导，不接受独立开发覆盖；既有工单分支和路径仍按自己的历史恢复。

服务保存必须显式提供 deployments 数组，省略不是清空。revision 冲突保留草稿；仓库 URL 级联变化推进关联服务版本。目标和凭证分离：保存目标不要求凭证已配置，实际调用才校验所选组。

### DBHub

固定 `@bytebase/dbhub@1.5.0`，支持页面中的 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle；Oracle database 为服务名。目标位于 deployment.config.dbhub，MySQL 使用 `type: "mysql"`，旧 mysql 字段拒绝。

生成 stdio 连接属于 Deployment，通用 MCP API 不得改删。DSN 编码后只通过 DBHUB_DSN 环境传递，不进入 argv。[dbhub.toml](../scripts/dbhub.toml) 限制只读、行数与超时，数据库账号仍须实际只读。

升级 0068 仅转换顶层旧数组，保留字面值、顺序和无关历史。冲突、无效／重复目标、活动开发目标或未知历史命令会使迁移回滚，不猜测修复。

### DMS 与 SLS

DMS 保存 alias／schema 意图，不相信客户端的 instanceId、host、port 或 databaseId；实际解析按当前操作／查询 owner 的所选凭证完成。

SLS 保存 region、project、logstores／targets，`*` 可表示 Project 下日志库，但查询仍指定具体名称。能力按实际部署目标开放，不按环境名称硬编码禁用；调查保持本环境，开发显式选择 prod/test。

## 服务 MCP 与钉钉

服务 MCP 支持 HTTPS Streamable HTTP、SSE 和 stdio。Agent 只获得入口／已包含服务在允许来源环境中的部署所属连接；无 deployment_id 的全局连接、默认 dingtalk 和个人偏好指定的导入连接不注入 Agent。

全局连接的导入、私有配置读取、增删改和连接测试仅 admin。Pi 管理发现、资源、连接和关闭，应用保留同源／禁止重定向、输入／结果预算、取消和发送前校验。readOnlyHint 不是授权，URL 查询部分不出现在普通列表和模型说明中。测试发现与关闭都成功才报告成功，清理失败不被取消或操作错误覆盖。

钉钉接受 `/notable/record` 的 dentryUuid／sheetId／rowId，只调用 get_tables 和精确 recordIds 查询。个人字段偏好逐项覆盖共享映射，不保存网关密钥，也不能通过调用参数临时改映射。缺失／重名字段报错，默认标题取“序号”原值。

导入默认指派当前调用者，重复来源返回原工单、不改派、不重复启动。除来源记录去重外，读取记录后还会用解析出的标题／序号精确匹配**没有钉钉导入来源的手工工单**；当前匹配不限定服务或环境，也没有多个同名候选的优先级约定，调用方必须核对返回的工单范围。不同来源记录即使同名，也不会仅因另一个已导入工单同名而合并。依据：[导入路由](../src/http/dingtalk-routes.ts)、[同名与重复导入回归](../tests/http/dingtalk.test.ts)。

附件只从允许的 HTTPS 主机下载，不重定向、不转发 MCP 凭证；链接附件留在描述，工单与文件一起保存后返回。HTTP 的 `startAgent` 默认和超时／清理错误见 [HTTP 钉钉导入](HTTP.md#钉钉导入)，不要混用页面和 MCP 的默认行为。

附件下载 owner 在文件暂存开始前接管响应流，目录创建、文件打开、读取、大小校验或取消失败时仍取消流并释放读取器。暂存或响应清理失败优先于超时／取消返回服务端失败，原始原因留在内部错误链；页面和日志不包含签名 URL 或私密下载诊断。下载所有权与清理规则见 [dingtalk-attachments.ts](../src/http/dingtalk-attachments.ts)，失败回归见 [dingtalk-attachments.test.ts](../tests/http/dingtalk-attachments.test.ts)。

## Agent 基座与资源

资源来自运行用户 `getAgentDir()`，默认 ~/.pi/agent；应用不维护另一套 skills/extensions，不加载工单本地扩展。检查资源只发现路径，不执行扩展，Operator 扩展不能覆盖应用保护工具。

Pi settings 为基线，SQLite runtime.settings 只覆盖契约允许项，省略恢复基线。runtime.networkAllowedDomains 是**全局 Agent** 的追加列表，与参数中的基础列表组合，个人模型组不维护独立 runtime。域名语法／去重／数量按同一 owner 校验，不解除宿主控制地址拒绝。

## 入站工单 MCP

`/mcp` 为无状态 Streamable HTTP POST，复用 HTTP 身份，GET／DELETE 为 405。客户端从“配置 → 端点”复制配置，先 users_list／services_list 核对身份与范围。标准连接结构见 [mcp.json](../examples/mcp.json)。

| 工具 | 行为 |
| --- | --- |
| issues_search／issue_get | 搜索与读取范围、状态、附件 |
| issue_create | 工单与附件保存后入队，省略处理人即未分配 |
| dingtalk_import | 默认 p2、不启动、指派当前用户 |
| issue_message／issue_conversation | 异步发送和分页读取 |
| attachment_read | 校验原件，文本分页或返回下载元数据 |
| work_files／work_file_read | 工作文件访问，管理文件只列名称 |

Base64 附件不带 data 前缀，默认最多 20 个、单个 20 MiB；入站 MCP 在内存解码，不能与 HTTP 流式上传混同。HTTP 附件不设业务总量／数量上限，由部署控制传输容量。

文本读取默认整文件预算 64 MiB，每页响应 1 MiB、最多 100 项／1,000 行；超 readBytes 返回 inline=false、read_budget_exceeded 和下载路径，二进制只返回元数据。具体 schema 与限额见 [server.ts](../src/mcp/server.ts) 和根配置。响应不明先查询，不盲目重发。

列表与对话分页使用从 0 开始的 `offset`，默认 `limit=30`、最多 100；文本按行分页默认 200 行、最多 1,000 行。分页返回 `{ total, offset, items, nextOffset }`，`nextOffset=null` 表示到末尾，不是跨修改稳定的游标。`issues_search` 先按 HTTP 列表的创建时间／编号倒序取数据，再过滤编号／标题、服务、环境和状态；不是全文描述搜索。工具成功结果位于 `content[].text`，内容为 JSON 字符串；工具失败可能是 HTTP 200 内的 `isError: true` 和稳定错误码，不能只检查 HTTP 状态。HTTP、SSE 与 MCP 的区别见 [HTTP 接口约定](HTTP.md)。
