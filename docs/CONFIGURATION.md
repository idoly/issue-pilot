# 配置与协议

应用数据继续保存在安装项目下的 `.issue-pilot/`。程序、npm 依赖和 Python 环境位于应用目录，不放入业务数据目录。工单文件与 Git 的布局见[存储设计](STORAGE.md)，升级与恢复见[运维手册](RUNBOOK.md)。

## 配置文件

| 位置 | 内容 |
| --- | --- |
| `.issue-pilot/service.yaml` | 全局 Agent 选择、并发、仓库、服务环境、分支及查询目标 |
| `.issue-pilot/user.yaml` | 所有已登记账号的凭证、各账号的钉钉来源，以及显式共享的服务凭证 |
| `.issue-pilot/mcp.json` | MCP 地址、协议和本地程序启动方式；MySQL 使用 stdio 模板 |
| Pi 全局目录 | `models.json`、Operator 认证、settings、Skills、Prompts、Extensions、全局指令 |
| SQLite | 工单与执行状态、配置的校验投影、既有用户和历史执行事实 |
| `issue-pilot.config.ts` | 程序路径、默认值、预算和维护策略 |

没有文件时继续使用既有数据库配置，便于逐步迁移。存在相应文件时，启动阶段在 Agent 和维护任务运行之前校验、事务应用配置，数据库作为运行投影与历史存储；页面返回 `fileManaged` 标记并禁止维护第二份配置。文件变更重启生效；钉钉导入在请求时读取当前账号的连接与来源配置。省略旧服务或仓库不自动删除其历史记录；MCP 文件中省略的旧连接会停用并从普通列表、连接测试和编辑入口隐藏，私有历史记录保留。不要直接修改数据库来绕过文件配置。

三个文件都必须是私有 regular file，权限 `0600`，父目录 `0700`。支持 `${ENV_VAR}`，变量不存在时报稳定错误；不运行 `!command` 或 shell 展开。解析失败不返回 YAML 原文、SQL 参数或认证信息。完整示例见 [service.yaml](../examples/service.yaml)、[user.yaml](../examples/user.yaml)、[mcp.json](../examples/mcp.json)。

### service.yaml

```yaml
version: 2
issuesDirectory: workspaces
agent:
  provider: xhgj
  model: your-model-id
  thinkingLevel: medium
  codemode: on
automation:
  maxConcurrentIssues: 3
repositories:
  app: git@example.com:team/app.git
services:
  orders:
    name: Orders
    environments:
      dev:
        repositories:
          app: develop
      test:
        repositories:
          app: test
        mysql:
          - host: db-test.example.com
            port: 3306
            database: orders
            username: reader
            password: "${MYSQL_PASSWORD}"
      prod:
        repositories:
          app: prod
        dms:
          alias: ORDERS-PROD
          schema: orders
        sls:
          region: cn-hangzhou
          project: example-production
          logstores: [application]
```

仓库在顶层保存别名和地址，环境保存分支。新工单采用当前基线，既有开发分支和工作区不自动切换。当前目录升级保留 `issuesDirectory: workspaces`，相对 `.issue-pilot` 解析；更换已有 Git worktree 的根路径需要单独的显式迁移，不能只改配置。

单个 DMS/SLS 目标直接填写字段，多个目标用数组；SLS 多目标显式填写各自的 `name`。例如：

```yaml
dms:
  - alias: ORDERS-FIRST
    schema: orders
  - alias: ORDERS-SECOND
    schema: orders_archive
sls:
  - name: application
    region: cn-hangzhou
    project: example-production
    logstores: [application]
  - name: gateway
    region: cn-shanghai
    project: example-gateway
    logstores: [access]
```

DMS 已有准确数据库绑定在目标相同时复用，新的 alias/schema 在首次查询前严格解析。SLS 多目标查询必须同时选择 `target` 和该目标的 `logstore`。开发工单仍显式选择 prod/test 证据；开发配置中的 DMS/SLS 声明必须已存在于正式或测试部署，不能暗中创建不同的查询来源。MySQL 可在各环境配置多个连接。

`maxConcurrentIssues` 限制同时执行的工单轮次；排队任务仍计入该工单活动，阻止冲突预约。每工单顺序和失败清理不变，关闭等待队列完成。每个用户的来源声明放在 `users.<subject>.dingtalk.source`；`service.yaml` v2 不接受 `sources`。`intervalMinutes` 仅保留轮询偏好，当前功能通过顶部“钉钉”手动读取，不启动定时同步器。旧版服务与单用户文件仍可读取，准备脚本输出新版 YAML。

### user.yaml

```yaml
version: 2
shared:
  sls:
    accessKeyId: "${SLS_ACCESS_KEY_ID}"
    accessKeySecret: "${SLS_ACCESS_KEY_SECRET}"
  dms:
    url: https://dms.example.com/sse
    authorization: "${DMS_AUTHORIZATION}"
  dingtalk:
    apiKey: "${DINGTALK_MCP_KEY}"
users:
  user@example.com:
    apiKeys:
      xhgj: "${MODEL_API_KEY}"
    ssh:
      privateKey: "${GIT_SSH_PRIVATE_KEY}"
    dingtalk:
      source:
        mcp: dingtalk
        url: https://alidocs.dingtalk.com/i/nodes/YOUR_BASE_ID?sheetId=YOUR_TABLE_ID
        assignee: 示例用户
        intervalMinutes: 15
  another@example.com:
    apiKeys: {}
    ssh: {}
    dms: {}
    sls: {}
    dingtalk: {}
```

`users` 以已有账号的 `subject` 为键，可保留停用账号的配置，但不会启用账号或授予角色、管理权限。每个列出的账号按文件完整投影，未列出的账号仍保留数据库配置。API Key 按 Pi provider 名称关联；SSH 私钥可以用 YAML 块字符串直接保存。个人 DMS 的 `url/authorization`、SLS 的两个 Key 分别组成完整组，不拼接不同身份。

`shared` 提供部署查询与全局 MCP 连接的凭证。个人 DMS/SLS 组仍各自完整覆盖部署组。钉钉导入优先采用当前账号的 `dingtalk.apiKey` 和可选 `url`，没有个人连接组时采用显式共享连接；个人连接失败后不会换用共享连接。默认来源链接只读取当前账号的声明，未声明来源时可在弹窗填写链接。每页只展示匹配当前账号 `dingtalk.source.assignee`（未配置时使用当前用户姓名）的记录；人员列为钉钉 user 类型时，按精确姓名查找唯一人员身份，并同时匹配 userId/corpId。同名或结果未完整返回时拒绝猜测。

准备脚本导出数据库中全部账号并保留已有文件配置。只有显式传入 `--fill-missing-from SUBJECT` 时，才把指定账号现有凭证复制到其他账号缺失的项；保留其他账号已有值，模型 Key 按 provider 补齐，DMS/SLS 按完整组补齐，不复制该账号的表格来源或人员筛选。结果写入私有暂存目录供验证，不修改线上文件或数据库。运行时仍按工单 owner 的配置读取凭证，没有跨账号自动回退。

### 钉钉导入

顶部“钉钉”打开标题为“导入”的预览弹窗，使用当前用户的连接配置。填写包含 `sheetId` 的数据表链接（支持顶层参数和钉钉 `iframeQuery` 内嵌参数），或 `/notable/record?dentryUuid=BASE&rowId=RECORD&sheetId=TABLE` 单条记录链接后读取字段和记录。单条链接直接按 recordIds 查询该行，不扫全表；仍执行人员、状态和已有工单过滤。可选择标题、描述、人员、状态、模块、编号、附件字段。默认使用“工单标题”“工单描述”“开发人员（归档字段）”“状态（归档字段）”“对应模块”“序号”“附件”，桌面七项一行，窄屏换行。读取范围是链接指定的整张数据表，忽略 `viewId`，不读取视图条件或排序。每次向钉钉查询待处理状态的一页（最多 100 行），再按当前用户过滤展示：研发状态列精确匹配 `A待安排`，截图所选的“状态（归档字段）”精确匹配其实际选项“待处理”；不匹配“待安排”、开发中、已完成、挂起或无需处理。后续页面通过“继续读取”获取，即使本页无匹配记录也保留后续游标。只调用 `get_tables`、`query_records`，人员 ID 匹配时调用 `search_entities`，不写钉钉数据。`entrance=data`、`sheetId` 支持顶层和 `iframeQuery` 内嵌参数；非 data 入口拒绝读取。视图、共享认证与追踪参数不进入来源地址。

读取与勾选都不创建工单。表格支持多选，选择本批记录、入口服务、处理方式与优先级后点击“创建选中工单”；创建后弹窗保持打开，成功或已存在的记录自动从候选表格移除，工单链接保留在回执区，可继续勾选剩余记录并切换其他系统创建下一批。部分失败项保留以便重试。读取每页时会按来源绑定、完整标题或外部编号与已有工单精确比对并过滤，页面显示过滤数量；不采用模糊标题匹配，也不自动建立历史来源绑定。“创建后立即启动 Agent”默认关闭。创建前重新读取所选记录并验证预览签名、当前用户、所选状态列的待处理状态与附件元数据。已变化的记录须重新预览。来源绑定与工单、Workspace 在同一数据库事务中保存，失败清理文件；同一个 Base/Table/Record 重复提交返回已有工单。逐条展示创建、已存在、变化和失败结果，失败项可重试。既有手工工单只进行精确匹配过滤，不自动写入来源绑定。

切换身份或关闭弹窗会取消未发送操作并忽略旧响应；已提交的单个工单事务可能已完成，再次读取会显示已有工单。游标异常、版本变化、读取失败均丢弃本轮结果，不能拼接不同快照。预览展示附件名称和大小，不返回签名下载地址。创建时重新读取记录附件并串行下载，只允许配置中的钉钉存储 HTTPS 主机，禁止重定向，不传递 MCP 凭证；校验文件大小后复用附件事务写入私有 `0400` 文件。附件下载、校验或写入失败时该条不创建，清理暂存文件并保留记录供重试。来源地址移除共享认证参数。

## 凭证与 owner

工单 owner 为 assignee，未分配时为 reporter，必须活跃。开发和正式数据处理要求 owner 为 developer。developer owner 使用个人模型和 Git 身份，缺失或失败不回退到其他身份。个人正式 DMS/SLS 配置各自完整覆盖部署组，没有该组则使用部署配置，不能创建不存在的目标。普通配置 GET 隐藏凭证；选定 MCP 编辑配置的开发者接口可以展示其文档约定的私有值。用户文件不会注入 Agent 提示词或工具输入；当前原生工具仍以应用用户执行，文件位置和权限不构成 OS 隔离。

## 内建能力与工具

配置页不再提供独立的“能力”和“基座”分类。用户页只展示当前账号的 API Key、SSH Key、SLS、DMS 和钉钉凭证状态，不展示密钥正文或人员管理；仓库页只展示名称与地址，不提供维护操作和引用服务列。顶层 repositories 和 services 仍同属 service.yaml，仓库可独立登记，不要求绑定服务。DMS/SLS 的查询目标继续在服务详情展示，MySQL 和钉钉通过 MCP 提供；同一种能力可以有多个服务环境连接，不将连接实例数量当作能力种类数量。

原生 `service_query` 只提供 DMS 和 SLS，显式选择 service/environment。Nacos、Redis、RabbitMQ、Elasticsearch 和原生 MySQL 已移除。旧部署 JSON 仅作为私有恢复证据保留，不投影、不执行；新增迁移移除旧开关，历史迁移保持不变。

### MySQL MCP

`mcp.json` 的 `mysql` 项是 stdio 启动模板，连接参数只在 `service.yaml` 中填写。应用按服务、环境、数据库展开连接，注入 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASS`、`MYSQL_DB`；固定关闭 INSERT/UPDATE/DELETE 开关。密码保留有效空白，不进入 argv。示例固定 `@benborla29/mcp-server-mysql@2.0.9`。模板本身不作为无连接参数的服务器启动。

Pi 在同一工单会话中复用对应 MCP 连接。MySQL 的 SQL 能力、结果格式和读取限制由所选 MCP 服务及数据库账号负责；不再提供原生 `db` 查询、导出接口或其事务保证。需要交付时在工单工作目录处理 MCP 返回结果，再使用 `output publish`。

### DMS

DMS 使用原生 SSE，只执行验证过的只读 SQL；导出完整 MCP JSON 到成果存储。一次操作预算 120 秒，首次握手预算 12 秒，握手最多两次。429 优先遵守有效 `Retry-After`，最多等待 5 秒后进行一次握手重试；更长提示直接报告限流。401/403 不重试，已发送的 SQL 不自动重放。

失败通过工具错误 JSON 返回稳定 `error` 和脱敏 `diagnostics`：阶段 connect/discovery/execute/publish/close、总耗时、阶段耗时、`sqlDispatchAttempted` 和可用的 `retryAfterSeconds`。阶段时间可能重叠，不能求和；尝试发送不证明服务端执行。原始错误、目标 URL、SQL 和认证不进入该错误 JSON。取消保留原原因。

批量任务串行并保留间隔，根据耗时与错误调整批量。核对已保存结果后才主动重查只读批次，同一批次重查一次仍失败则拆分或暂停。连续两次恢复探测失败，或单轮累计五次 DMS 调用失败即保存断点并停止，探测成功不清零累计失败数。该规则是 Agent 指引，不是服务端限流器。未完成不能推断成零值或无记录。

### aliyun sls

SLS 通过固定的 `aliyun sls GetLogsV2` 命令查询，运行环境需要 aliyun CLI；镜像安装固定版本 3.4.11。应用用 `0600` 临时配置注入选定凭证，关闭 CLI 自动重试，使用 HTTPS，结束或取消后删除临时配置，不修改宿主默认 profile，不把密钥放进 argv。

保留明确时间范围、Trace ID、目标校验和分页预算。只有 meta.progress=Complete 才接受结果；SQL 分析按 SQL LIMIT/ORDER BY 返回一页，普通查询按 offset 分页。晚一页失败时整次调用失败，不返回前面页面作为完整结果。未知 CLI 错误统一隐藏，已知 Code/StatusCode 转为稳定诊断。CLI 缺失报 `sls_cli_not_available`；超时或取消终止进程组并完成凭证清理。

### 全局外部 MCP

支持 HTTPS Streamable HTTP、SSE 和本地 stdio，开启的外部工具对所有工单可用。只读提示是描述，不是授权。SDK 负责协议传输，Pi 的公开 `createMcpExtension` 负责发现、工具注册、资源、连接生命周期与关闭。应用不再直接依赖 `@earendil-works/pi-mcp`；Pi SDK 内部仍可能传递依赖它。

保留 HTTPS 同源、禁止重定向、私有 stdio 环境、取消、输入 schema 与结果预算。MCP URL 可以包含钉钉所需的查询认证，但普通列表和模型服务说明隐藏查询部分。会话过期时报告本次失败并关闭连接，下一次显式调用重新连接，不自动重放本次操作。外部 MCP 不再预设 Playwright 或浏览器工具。

## Agent 基座与资源

Skills、Prompts、Extensions、SYSTEM/APPEND_SYSTEM 与全局指令通过 Pi 标准 ResourceLoader 从 `getAgentDir()` 加载，默认 `~/.pi/agent`，尊重 Pi 自己的目录配置。全局 settings 是基线，`service.yaml` 的 `agent.runtime.settings` 可显式覆盖运行参数；该项省略时清除旧数据库覆盖，采用全局 Pi 默认值，避免隐藏的旧配置继续生效。配置准备脚本会把原有运行偏好一并导出以便审核。应用不再绑定源码 `.pi` 目录，不另建应用资源目录，也不加载工单中生成的 `.pi` 扩展。用户扩展不能覆盖应用保护的工具名称。

资源检查 GET 仅发现扩展路径，不执行用户扩展。实际会话创建时加载资源，正常触发扩展启动和关闭。模型接口定义继续由全局 Pi `models.json` 管理。改变资源后重建会话或重启应用。

## 处理方式

| workMode | 环境 | Issue type | 代码 |
| --- | --- | --- | --- |
| production_analysis | prod | smart_analysis | 只读快照 |
| test_analysis | test | smart_analysis | 只读快照 |
| production_data | prod | data_processing | 只读快照与成果发布 |
| development_fix | dev | defect_fix | 独立 worktree |
| development_feature | dev | feature_development | 独立 worktree |

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

二进制成果返回已验证的下载路径，不把文件内容塞进 MCP 文本。原生发布与 DMS 导出返回 `downloadPath`，对话应使用该路径提供下载。
