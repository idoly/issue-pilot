# 配置与协议

应用数据继续保存在安装项目下的 `.issue-pilot/`。程序、npm 依赖和 Python 环境位于应用目录，不放入业务数据目录。工单文件与 Git 的布局见[存储设计](STORAGE.md)，升级与恢复见[运维手册](RUNBOOK.md)。

## 配置来源与离线格式

| 位置 | 内容 |
| --- | --- |
| `.issue-pilot/service.yaml` | 离线导入／导出：Agent、并发、仓库、服务环境及查询目标 |
| `.issue-pilot/user.yaml` | 离线导入／导出：个人凭证、偏好及共享连接组 |
| `.issue-pilot/mcp.json` | 离线导入／导出：全局 MCP 和 MySQL 启动模板 |
| Pi 全局目录 | `models.json`、Operator 认证、settings、Skills、Prompts、Extensions、全局指令 |
| SQLite | 人员、凭证、仓库、服务、环境目标、偏好与运行状态的唯一业务来源 |
| `issue-pilot.config.ts` | 程序路径、默认值、预算和维护策略 |

根配置中的 `http.sseRecentEventIds` 默认 4096，必须为正整数，控制单条 SSE 连接实时阶段保留的近期临时事件 ID 数量。完整回放及缓冲重叠先完成去重，再切换到这个窗口；持久条目 ID 在连接期间继续保留去重。该预算不限制消息内容、历史回放条数或网络背压队列，修改后随应用重启生效。

人员、仓库、服务、个人凭证在页面保存后直接持久化到 SQLite，重启不被旧文件覆盖。旧文件即使仍位于 state root，也不会在正常启动或钉钉请求中读取。首次切换必须先按运维手册备份，停服后显式运行 `scripts/import-configuration.ts --state-root ROOT --apply`，将现有偏好及服务目标导入；导入与 API 共用实例租约，不允许在线执行，失败回滚且原文件不改写。导入时省略的旧服务／仓库不自动删除；普通手工 MCP 条目可停用，部署生成的 MySQL 连接由服务 owner 管理。

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
  runtime:
    networkAllowedDomains:
      - packages.example.com:443
      - git.example.com:22
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

`agent.runtime.networkAllowedDomains` 为模型本地工具和 stdio MCP 追加出口，按域名或 `host:port` 限定。SSH 使用的 22 端口与 HTTPS 的 443 端口应分别配置；代码仓库地址本身不会自动放通网络。规则从全局 Agent 数据库配置读取，修改沿用配置预约及会话重建流程；不能覆盖宿主地址和应用控制端口的拒绝规则。它不改变 DMS/SLS 业务查询的服务、环境及目标校验。

页面中仓库登记一次地址和显示名，服务选择仓库，正式／测试环境配置分支。开发代码基线只读继承同服务正式分支，不接受独立覆盖，缺少正式部署时明确拒绝。离线格式中的开发分支仅属旧资料，导入不会用它覆盖正式继承规则。新工单采用当前基线，既有开发分支和工作区不自动切换。当前目录升级保留 `issuesDirectory: workspaces`，相对 `.issue-pilot` 解析；更换已有 Git worktree 的根路径需要单独的显式迁移，不能只改配置。

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

`maxConcurrentIssues` 限制同时执行的工单轮次；排队任务仍计入该工单活动，阻止冲突预约。每工单顺序和失败清理不变，关闭等待队列完成。每个用户的来源声明放在 `users.<subject>.dingtalk.source`；`service.yaml` v2 不接受 `sources`。`intervalMinutes` 仅保留轮询偏好，当前功能通过顶部“钉钉”手动读取，不启动定时同步器。服务和目标始终从当前数据库导出；旧单用户文件与钉钉来源仅由 `scripts/prepare-configuration.ts` 显式离线转换，转换实现位于 `scripts/configuration-conversion.ts`；显式导入只接受数值 `version: 2`，不从退役 db 字段自动生成当前 MySQL 目标。版本不符时导入拒绝并保留原文件，不影响正常数据库启动。个人 DMS 配置必须独立提供 URL 与 Authorization。

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
        url: https://alidocs.dingtalk.com/notable/record?dentryUuid=YOUR_BASE_ID&sheetId=YOUR_TABLE_ID&rowId=YOUR_RECORD_ID
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

`shared` 提供部署查询与全局 MCP 连接的凭证。个人 DMS/SLS 组仍各自完整覆盖部署组。钉钉导入只使用选定的全局 MCP 连接。`shared.dingtalk.apiKey` 在显式导入时写入全局连接，用户不再配置钉钉 API Key 或连接地址，也没有个人身份覆盖、凭证补齐或失败回退分支。用户凭证页仅展示模型、SSH、DMS、SLS。默认来源链接只读取当前账号的声明，未声明单条记录来源时在弹窗填写。钉钉记录不再按人员或状态过滤。

准备脚本从数据库导出账号、凭证与钉钉偏好，普通导出无需指定账号，不默认读取旧配置文件，也不输出个人钉钉 API Key／连接地址。显式 reference 文件必须存在；用户参考资料缺少的 DMS／SLS 共享组分别从唯一的数据库组补足，多个组仍要求 owner 处理。服务参考资料只迁移钉钉来源，不覆盖数据库并发设置或服务目标。MySQL 模板参数与 MCP 名称原样导出，不按名称过滤服务或改写包版本。只有显式传入 `--fill-missing-from SUBJECT` 时，才把指定账号现有凭证复制到其他账号缺失的项；保留其他账号已有值，模型 Key 按 provider 补齐，DMS/SLS 按完整组补齐，不复制该账号的表格来源或人员筛选。结果写入私有暂存目录供验证，不修改线上文件或数据库。运行时仍按工单 owner 的配置读取凭证，没有跨账号自动回退。

### 钉钉导入

顶部“钉钉”打开“导入”弹窗，只接受 `/notable/record?dentryUuid=BASE&rowId=RECORD&sheetId=TABLE` 单条记录链接。选择入口服务、处理方式、优先级后直接点击“导入工单”，不预览、不扫表、不分页，不按人员、模块或状态筛选。当前连接身份仍负责读取权限，创建的工单归当前应用用户。页面导入成功后立即启动 Agent，不显示当前用户信息和启动选项；重复导入只返回已有工单，不重复启动。成功后显示工单链接，弹窗保留，链接输入清空，方便继续导入。

字段映射保存在数据库偏好中，不提供临时调用参数覆盖。旧格式可通过离线 user.yaml 显式导入。支持精确字段名或 ID；找不到或重名时明确报错。个人 user_preferences.dingtalk.fields 按项覆盖 application_settings.dingtalk_fields。标题直接使用“序号”原值，不拼接其他标题。可以设置空字符串跳过可选字段。

```yaml
shared:
  dingtalk:
    apiKey: "${DINGTALK_MCP_KEY}"
    fields:
      title: 序号
      description: 工单描述
      number: 序号
      attachments: 附件
```

只调用 `get_tables` 和按 recordIds 精确读取的 `query_records`。同一来源记录的重复导入返回已有工单；既有手工工单按完整标题或编号精确查找，不模糊匹配，不自动写入历史来源绑定。附件下载、大小校验和工单保存均完成后才返回成功；失败清理暂存文件并回滚工单，允许显式重试。附件仅允许配置的钉钉 HTTPS 存储主机，禁止重定向，不转发 MCP 凭证，最终原件权限为 `0400`。

MCP 端点提供 `dingtalk_import`，与页面复用同一接口和配置。参数为 `url`、`serviceKey`、`workMode`，可选 `priority`（默认 p2）、`startAgent`（默认 false）；返回 `status: created|existing` 和 `issueKey`。响应不明时重复调用会核对已有来源，不能绕过同一记录防重复。关闭弹窗或切换身份会取消未完成请求，已提交工单不会撤回。

## 凭证与 owner

工单 owner 为 assignee，未分配时为 reporter，必须活跃。开发要求 owner 为 developer。developer owner 使用个人模型和 Git 身份，缺失或失败不回退到其他身份。个人正式 DMS/SLS 配置各自完整覆盖部署组，没有该组则使用部署配置，不能创建不存在的目标。普通配置 GET 隐藏凭证；选定 MCP 编辑配置的开发者接口可以展示其文档约定的私有值。用户文件不会注入 Agent 提示词或工具输入；本地工具经 SRT 限制持久文件写入范围，执行与远程服务的信任边界见 [Agent](AGENT.md#执行边界)。

用户明确请求的业务登录 token、session token 和业务 Authorization 可以作为 SLS/DMS 查询结果返回，并注明来源与时间，不需要重复确认。该规则针对授权查询返回的业务证据；用于连接 SLS、DMS、MCP、模型和 Git 的应用配置密钥仍隐藏。查询结果不授予额外服务或环境权限。

## 内建能力与工具

配置页顺序为用户、仓库、服务、端点。分类首次访问时才挂载和读取；已访问分类保留实例和筛选，默认用户页不预加载服务配置、仓库、端点或私有服务说明。用户页提供四组个人凭证和人员管理；凭证弹窗直接填写，留空保留，清除显式执行，不回显秘密。仓库页登记／编辑地址与显示名、查看使用服务并可跳转；未使用仓库可删除。服务保留顶部 Tab、代码分支矩阵和描述，开发基线只读继承正式分支；MySQL、DMS、SLS 仍按环境维护。MySQL 密码只在开发者选定服务的私有详情／编辑读取，普通配置 GET 只返回 passwordConfigured。服务、仓库和个人凭证状态响应始终携带整数 revision，前端类型不再接受缺失版本的旧响应。页面编辑使用对应版本，过期返回 configuration_changed，保留输入并在编辑弹窗提供重新加载。仓库 URL 的级联变更同时推进所有关联服务的 revision，避免旧服务草稿恢复旧地址；仅修改仓库显示名不推进服务版本，也不扩大工单预约。API 仍允许省略 expectedRevision 的现有调用；需要冲突保护的客户端应始终携带它。

原生 `service_query` 只提供 DMS 和 SLS，显式选择 service/environment。Nacos、Redis、RabbitMQ、Elasticsearch 和原生 MySQL 已移除。旧部署 JSON 仅作为私有恢复证据保留，不投影、不执行；新增迁移移除旧开关，历史迁移保持不变。

### MySQL MCP

MySQL 目标保存在 service_deployments.config.mysql，保存与关联全局 MCP 条目同一事务完成。默认启动模板固定 `@benborla29/mcp-server-mysql@2.0.9`，显式导入可保存已有 stdio 模板到 application_settings。应用按部署、host、port、database 标识连接，注入 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASS`、`MYSQL_DB`；固定关闭 INSERT/UPDATE/DELETE 开关。密码保留有效空白，不进入 argv。示例固定 `@benborla29/mcp-server-mysql@2.0.9`。模板本身不作为无参数服务器启动。生成条目带 deployment_id，不允许经通用 MCP 接口修改或删除；服务移除目标时按归属删除。由于工具全局可见，连接声明变化预约全部现有工单，避免旧 Pi 会话继续持有过期连接。

Pi 在同一工单会话中复用对应 MCP 连接。MySQL 的 SQL 能力、结果格式和读取限制由所选 MCP 服务及数据库账号负责；不再提供原生 `db` 查询、导出接口或其事务保证。需要交付时在工单工作目录处理 MCP 返回结果，直接保存普通文件并使用工作文件下载链接。

### DMS

DMS 使用原生 SSE，只执行验证过的只读 SQL；导出完整 MCP JSON 到工单根目录的普通工作文件，完成写入后原子替换目标。一次操作预算 120 秒，首次握手预算 12 秒，握手最多两次。429 优先遵守有效 `Retry-After`，最多等待 5 秒后进行一次握手重试；更长提示直接报告限流。401/403 不重试，已发送的 SQL 不自动重放。

失败通过工具错误 JSON 返回稳定 `error` 和脱敏 `diagnostics`：阶段 connect/discovery/execute/export/close、总耗时、阶段耗时、`sqlDispatchAttempted` 和可用的 `retryAfterSeconds`。阶段时间可能重叠，不能求和；`export` 指普通工作文件写入和原子替换，导出失败不会自动重试 SQL；尝试发送不证明服务端执行。原始错误、目标 URL、SQL 和认证不进入该错误 JSON。取消保留原原因。

批量任务串行并保留间隔，根据耗时与错误调整批量。核对已保存结果后才主动重查只读批次，同一批次重查一次仍失败则拆分或暂停。连续两次恢复探测失败，或单轮累计五次 DMS 调用失败即保存断点并停止，探测成功不清零累计失败数。该规则是 Agent 指引，不是服务端限流器。未完成不能推断成零值或无记录。

### aliyun sls

SLS 通过固定的 `aliyun sls GetLogsV2` 命令查询，运行环境需要 aliyun CLI；镜像安装固定版本 3.5.2。应用用 `0600` 临时配置注入选定凭证，关闭 CLI 自动重试，使用 HTTPS，结束或取消后删除临时配置，不修改宿主默认 profile，不把密钥放进 argv。

保留明确时间范围、Trace ID、目标校验和分页预算。只有 meta.progress=Complete 才接受结果；SQL 分析按 SQL LIMIT/ORDER BY 返回一页，普通查询按 offset 分页。晚一页失败时整次调用失败，不返回前面页面作为完整结果。未知 CLI 错误统一隐藏，已知 Code/StatusCode 转为稳定诊断。CLI 缺失报 `sls_cli_not_available`；超时或取消终止进程组并完成凭证清理。

### 全局外部 MCP

支持 HTTPS Streamable HTTP、SSE 和本地 stdio，开启的外部工具对所有工单可用。只读提示是描述，不是授权。SDK 负责协议传输，Pi 的公开 `createMcpExtension` 负责发现、工具注册、资源、连接生命周期与关闭。应用不再直接依赖 `@earendil-works/pi-mcp`；Pi SDK 内部仍可能传递依赖它。

保留 HTTPS 同源、禁止重定向、私有 stdio 环境、取消、输入 schema 与结果预算。MCP URL 可以包含钉钉所需的查询认证，但普通列表和模型服务说明隐藏查询部分。会话过期时报告本次失败并关闭连接，下一次显式调用重新连接，不自动重放本次操作。外部 MCP 不再预设 Playwright 或浏览器工具。

## Agent 基座与资源

Skills、Prompts、Extensions、SYSTEM/APPEND_SYSTEM 与全局指令通过 Pi 标准 ResourceLoader 从 `getAgentDir()` 加载，默认 `~/.pi/agent`，尊重 Pi 自己的目录配置。全局 settings 是基线，全局 Agent 配置的 runtime.settings 可显式覆盖运行参数；`agent.runtime.networkAllowedDomains` 为本地工具和 stdio MCP 追加按域名或 `host:port` 限定的出口，使用 SRT 的域名规则校验，不能覆盖宿主控制地址与端口的拒绝规则。省略运行设置时清除旧数据库设置覆盖并采用全局 Pi settings；省略网络追加项时清除旧数据库网络覆盖，采用根配置的基础域名列表。配置准备脚本会把原有运行偏好一并导出以便审核。应用不再绑定源码 `.pi` 目录，不另建应用资源目录，也不加载工单中生成的 `.pi` 扩展。用户扩展不能覆盖应用保护的工具名称。

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
