# 配置说明

本文定义当前根配置、SQLite 业务配置、Service/Deployment、全局 Pi model、七种 capability 和 credential 数据流。状态生命周期见[架构说明](ARCHITECTURE.md)，运行环境见[部署说明](DEPLOYMENT.md)。

## 配置来源

| 配置 | 事实源 |
| --- | --- |
| Path、port、default、retention、timeout、budget | `issue-pilot.config.ts` |
| User、Service、Repository、Deployment、branch、全局模型、credential | SQLite |
| Image、resource、mount、probe | `Containerfile`、`deploy/issue-pilot.yaml` |
| Pi/npm/Maven/SSH 原生配置 | Operator 管理的 `/etc/issue-pilot` |
| Agent session 选择 | 每轮从全局模型、实际 Repository access、Deployment capability 生成 |

应用不接受环境变量覆盖。环境变量只用于标准进程环境，例如 `HOME`，不能改变 Issue Pilot state root、端口或业务默认值。

`GET /api/catalog` 只返回 Environment 和 Service 可用范围。配置页按需读取 `GET /api/config`，后者包含 Repository、全局 model、capability scope 和 `credentialConfigured`，不返回已存 credential。两个接口都使用 `Cache-Control: private, no-store`，并经 scope queue 读取一致 SQLite snapshot。Config 响应只能进入受信配置 UI，不得写入日志、监控或诊断附件。

## 根配置

### State 与区域

| Field | 当前值 | 作用 |
| --- | --- | --- |
| `state.directory` | `.issue-pilot` | 相对 project root 的 state root |
| `state.databaseFile` | `issues.db` | 相对 state root 的 SQLite 文件 |
| `state.sqliteBusyTimeoutMs` | `5000` | libSQL busy timeout |
| `regional.locale` | `zh-CN` | Web locale |
| `regional.timeZone` | `Asia/Shanghai` | Issue key 日期与 Agent 时间上下文 |
| `bootstrapUser` | 根配置中的 subject/name/email | 仅 `subjects` 为空时插入一次 |

已有 User 不会被 bootstrap 配置覆盖。未提供 subject header 时 API 选择最早创建的 active user；显式 `X-Issue-Pilot-Subject` 也只能选择 active user。该 header 不是认证。

### HTTP 与 Web

| Field | 当前值 |
| --- | ---: |
| `http.host` / `port` | `0.0.0.0` / `3000` |
| `http.logger` | `true` |
| `http.sseHeartbeatMs` | `15000` |
| `web.host` / `port` | `0.0.0.0` / `4173` |
| `web.agentStreamReconnectMs` | `1000` |
| `web.agentStreamStaleMs` | `45000` |
| `web.agentToolOutputCharacters` | `40000` |
| `web.markdownCacheEntries` | `512` |
| `web.markdownCacheCharacters` | `4194304` |

Vite API proxy 固定连接本机 `127.0.0.1:3000`。API 和 Vite 都监听所有接口，只能用于可信网络。

### Workspace

| Field | 当前值 |
| --- | ---: |
| `retentionMs` | `604800000`（7 天） |
| `highWaterBytes` | `21474836480`（20 GiB） |
| `targetBytes` | `17179869184`（16 GiB） |
| `maintenanceIntervalMs` | `900000`（15 分钟） |
| `taskConcurrency` | `4` |

Non-zero target 必须小于 high-water；concurrency 必须为正整数。Interval 设为 0 只禁用周期 timer，启动时仍执行一次 maintenance。

### Defaults

| Field | 当前值 |
| --- | --- |
| `environments` | `prod=正式`、`test=测试`、`dev=开发` |
| `deployment.baseBranch` | `main` |
| `dms.sseUrl` | `https://dms-mcpr-qcuenv-ralojeaice.cn-hangzhou.fcapp.run/sse` |
| `nacos.group` | `DEFAULT_GROUP` |
| `redis` | port `6379`、database `0`、scanResults `50` |
| `rabbitmq` | AMQP `5672`、management `15672`、vhost `/` |

Environment name 在启动时同步。已保存的 DMS URL 由资源连接目录持有，不随根默认值覆盖。

### Runtime 与 limits

| Boundary | 当前值 |
| --- | ---: |
| Agent model response idle | 300000 ms |
| Spreadsheet batch | Pi CodemodeSandbox 工作线程中的 QuickJS，30 s / 256 MiB，最多 2 个 worker；仅本工单授权输入与成果 XLSX 输出 |
| Agent message | 50000 chars |
| 关联工单（所有处理方式） | 最多 20 个其他工单；Environment/type 不限 |
| Agent clipboard image | 20 MiB / 40 MiB / 20；这是 Pi message image 的独立保护，不适用于 Attachment |
| Attachment file/request/count | 应用层不限制；上传先流式写入临时文件 |
| Issue multipart metadata | `issue` JSON 仍最多 100000 bytes |
| Process output | 5 MiB |
| Git operation/output | 120 s / 2 MiB |
| Disk usage | 120 s / 1 MiB output |
| Capability default/connection timeout | 15 s / 10 s |
| Native MySQL targets | 每个 Deployment 最多 20 个 |
| Capability result | 1 MiB，DMS MCP 除外 |
| Source file/tree | no application file-size limit / 500 entries |
| Source query/history/changes | 200 chars / 100 commits / 500 files |
| Source command/output | 5 s / 2 MiB |
| Project action | 30 minutes |
| Redis Worker heap | old 96 MiB / young 16 MiB |

Source executables 为 `git` 与 `rg`。Project tool 原生配置/cache 相对 `HOME`：Node 使用 `.npmrc`、`.npm`；Maven 使用 `.m2/settings.xml`、`.m2/repository`。

## User

SQLite `subjects` 规则：

| Field | Rule |
| --- | --- |
| `subject` | 创建后不可变；1..255；字母数字、`.`、`_`、`@`、`+`、`-` |
| `name` | Required，最多 100 chars |
| `email` | Required，最多 254 chars，保存为小写 |
| `role` | `product`（产品）、`test`（测试）、`developer`（开发）；新建默认产品 |
| `active` | Active user 可选择、创建/编辑 Issue 并作为 assignee/CC |

停用不会删除 row 或历史关系。Transaction 拒绝停用最后一名 active user，也拒绝移除最后一名 active developer。开发角色管理团队用户，避免产品/测试通过修改自身角色绕过限制。修改用户先获取 scope queue 和其创建/负责工单的 reservation，拒绝 running 工单并关闭旧 session。`/api/users` 只返回 active user，`/api/users/manage` 返回全部。

只有开发角色可创建 `production_data`、`development_fix`、`development_feature` 或 plan/apply 到这些处理方式。产品/测试仅可选择正式/测试问题调查。API 强制校验角色，Web 隐藏不可用处理方式；正式数据处理与开发工单的处理人必须是开发。正式数据处理的 retry、Agent message 和 Agent owner 也校验开发权限，防止从历史工单或直接 API 绕过。迁移 `0045_user_roles_credentials` 将已有用户保留为开发，新增用户默认产品；Operator 应在升级后调整团队角色。

### 个人模型与 Git 凭证

SQLite `user_credentials` 按 subject 保存 provider→API Key 与 Git SSH 私钥；凭证只允许本人通过 GET/PUT /api/me/credentials 管理；model/git 仅开发角色可写，production 对全部 active 用户开放。GET 只返回已配置 provider 与 Git 状态，PUT 显式 replace/clear；省略的配置保持不变，任何用户列表、工单、配置 DTO 都不返回个人密钥。UI 位于用户页“我的开发凭证”，仅 `apiKey`、`sshKey` 两个输入与一个保存按钮。模型服务商自动使用全局 provider；留空不修改，输入新值替换。切换用户清除密钥 draft，API Key 使用无显示按钮的 password 输入，SSH 私钥保持多行粘贴并遮蔽显示；保存成功保留本次输入并继续遮蔽；刷新不回填后端密钥。

每轮 Agent 由当前 assignee（无 assignee 时 reporter）确定凭证 owner。开发 owner 使用该全局 provider 的个人 API Key、独立 process-private Pi ModelRuntime，禁止回退共享 API Key；模型选择仍是全局配置。产品/测试 owner 的只读调查使用 Operator 模型配置。开发工单 owner 非开发或停用、个人模型 key 缺失时显式失败。更新个人凭证遵循 scope queue → owned Issue reservation，running 拒绝，idle session 关闭后下轮重新读取。

Git fetch、Agent bash 的 Git 操作使用会话独立 `0700` 临时目录、`0600` 私钥文件；只接受 SSH remote URL（`git@host:path` 或 `ssh://...`），拒绝 HTTPS，关闭共享 credential helper 和 HTTP extraHeader。SSH 使用个人 key，忽略共享 SSH config，禁止 agent key fallback，BatchMode 与 StrictHostKeyChecking；仅支持无口令私钥，Operator 预配 trusted known_hosts。关闭/失败/shutdown 清理临时目录，不把密钥写入 worktree、Git config、argv、prompt 或 JSONL。scope 转换及 dev 跨 Service migration 的 Git fetch 使用同一 owner 凭证。冷启动恢复本地 dev runtime 不使用 remote 凭证；prod/test 生成快照由 Operator 保持只读拉取权限。模型目录、Repository bare store、branch 继续由现有 owner 管理。`0046_user_git_ssh_only` 删除早期个人凭证表的 HTTPS 列；当前 API/运行时不保留 HTTPS 凭证兼容路径。

## Issue work mode、Environment 与 Issue type

新建 Issue 只提交一个处理方式和 Service。Work mode 是共享 Domain 映射，不单独存入 SQLite：

| Work mode | Environment | Issue type | Repository mode |
| --- | --- | --- | --- |
| `production_data` | `prod` | `data_processing` | Read-only current Deployment commit + writable durable Issue outputs |
| `production_analysis` | `prod` | `smart_analysis` | Read-only current Deployment commit |
| `test_analysis` | `test` | `smart_analysis` | Read-only current Deployment commit |
| `development_fix` | `dev` | `defect_fix` | Issue-local writable hotfix branch/worktree |
| `development_feature` | `dev` | `feature_development` | Issue-local writable feature branch/worktree |

Web 只展示至少有一个 Service 配置对应 Deployment 的处理方式，并按目标 Environment 过滤 Service。API 使用同一 Domain 映射重新解析；旧 `environmentKey + type` 创建合同被拒绝，不能通过直接调用获得非法组合或写权限。普通 Issue edit 只接受 metadata、CC 和 Attachment；Scope 使用独立的无状态 plan/apply，apply 必须提交匹配当前 `updatedAt` 的 SHA-256 plan。Active dev 只允许保持当前 branch mode 跨 Service；成功 Apply 原子写入 Scope history，失败和 no-op 不写。Dev 到 prod/test 不原地迁移；“创建正式跟进”固定创建 `production_analysis`，复用标准创建与 related Issue 校验。

所有处理方式均可在创建时选择关联工单，未 resolved 且 runtime ready 的工单也可在详情中编辑关联，最多为 20 个。目标可以来自任意 Environment/type；Agent 始终获得只读 metadata，有受管 Pi session 时获得 conversation，只有具备本地开发 branch 的目标才附带 immutable 代码快照。保存时 API reservation 当前工单以及旧、新关联集合；有实际变化时关闭当前 Agent session、事务化更新关系并重新入队。普通 metadata PATCH 和 resolved 工单不能修改关联；范围转换保留关联关系。开发工单的关联材料位于独立 runtime，Agent prompt 提供完整路径，不向 writable workspace root 添加目录。

## Service、Repository 与 Deployment

### Service

- `name` required，最多 200 chars。
- `description` optional Markdown。
- `key` 创建时从 name 生成并保证唯一，后续 rename 不改变 key。
- 至少一个 Repository。
- 每个 Environment 最多一个 Deployment。
- 被 Issue 引用的 Service 不能删除。
- 编辑时 reservation 全部关联 Issue；running/reserved Issue 或 session close 失败会阻止提交。

### Repository

独立的“仓库”配置页统一维护 `repositories` 的 name/url，地址全局唯一，只由开发角色维护。接受 SSH（scp-like 或 `ssh://`）与无内嵌凭证的 HTTPS 地址，拒绝 password、query、fragment、本地路径和 file URL；登记 HTTPS 不代表个人 HTTPS 认证已启用，个人 Git 凭证仍仅支持 SSH。

Service 使用多选框选择已登记仓库，不再要求或展示服务别名；现有绑定标识仅在分支保存协议内部保留，展示名称统一读取仓库目录。`service_repositories.url` 是引用 catalog URL 的外键（ON UPDATE CASCADE / DELETE RESTRICT），不再由服务页任意填写或创建地址。`GET /api/repositories` 返回仓库与引用服务列表；POST/PATCH/DELETE 使用 scope queue。改址先 reservation 所有引用服务的 Issues，运行中拒绝，空闲 session 关闭后 transaction 更新 catalog，外键同步配置引用。历史 `issue_repositories.url`、working branch、local_path 均不改写；下一轮按照现有 Repository prepare/remove 合同处理差集，dirty/unknown 状态继续保留并拒绝。被引用仓库不能删除。

Migration `0047_repository_catalog` 从已有 Service URL 去重导入，初始 name 为原 URL（可在仓库页重命名），完整保留 Service Repository ID、rowid、alias、Deployment branch rows/order/timestamps。切换前需一致备份并在隔离 copy dry-run；不迁移或移动 Git store、worktree、Attachment 或 JSONL。

- Service Repository 的内部绑定标识在服务内唯一，已有标识保留；新增关联由目录 ID 生成，无需用户填写。
- `url` 在 Service 内唯一，且必须已在统一仓库配置登记。
- Create 不接受 client-supplied ID；edit ID 必须属于当前 Service。
- 每个 Deployment 必须恰好覆盖 Service 当前全部 Repository。

内部标识只用于关联分支，服务页展示统一仓库名称。Issue `workspace_name` 从 URL basename/hash 稳定分配，不随 alias rename 移动。Existing dev 保留历史 base branch/workspace name；新增 Repository 使用当前 Deployment branch；待删除 dev worktree 必须 clean。

### Deployment

一个 Deployment 包含：

```text
Environment
Repository branches, one per current Service Repository
Selected capability sections
```

创建 Issue 前，目标 Service/Environment 必须已有 Deployment。每个 `repositoryBranches[]` 使用 current Repository alias 和 non-empty base branch。Prod/test 每轮读取当前 branch；dev 首次加入 Repository 时将 branch 固化为 Issue 历史。

配置“服务”保留服务切换、添加/编辑入口，主体展示服务名称、仓库/正式/测试/开发分支矩阵和一份 Markdown 描述；去掉仓库/部署数量横幅、冗余维护说明和环境部署卡片。services.description 保存手写业务知识与排查范例；service-context.ts 从当前部署配置自动生成各环境公开能力参数和开发继承说明，GET config 的 context 用于页面展示。Agent 的 workspace describe 共用这个生成器，仓库/分支单独作为结构化 repositories 返回。地址、schema、namespace、实例/数据库 ID、logstore、用户名等公开值完整呈现；共享访问配置的内部名称/ID、Token、密码、AccessKey 不进入生成描述。生成内容不反向持久化，不要求配置块语法。每个能力采用名称标题与无重复表头的字段表，多值参数逐项换行，省略空用户名；描述环境顺序固定为开发、测试、正式。开发角色的配置页面另外读取 GET /api/services/:key/configuration-description，在同一生成器中加入数据库等实际密码；DMS Authorization 与 SLS AccessKey 始终不在服务描述展示。该接口校验开发角色并禁止缓存和请求日志。AI、MCP 和普通 GET config 仍使用不含密钥的 context，调用工具时服务端注入凭证。前端在切换服务/用户或离开页面时取消旧请求、清除明文，敏感描述不进入 Markdown 全局缓存或 localStorage。

服务编辑弹窗在正式/测试环境下维护分支、能力参数、认证字段和 MCP；开发环境只维护分支，不配置第三套能力。开发工单的 service_query 显式选择 prod/test 来源环境和任意服务，均使用只读操作，正式/测试工单仍限于自身环境。workspace include/remove 仍只管理工单代码环境，不因跨环境查询改变代码分支。

## 全局 Pi model

SQLite `global_agent_configuration` 保存唯一全局模型，所有 Service 和 Environment 共享，Deployment 不允许包含 Agent override。

配置页“模型”Tab 编辑：

```text
provider
model
thinkingLevel
```

Thinking level：

```text
off, minimal, low, medium, high, xhigh, max
```

保存流程按 `scope queue -> all Issue reservations` 获取锁，关闭已有空闲 session 后事务提交。任一 Issue 正在运行时整次返回 `global_configuration_has_running_issues`，不会中断当前执行。

`PiAgentModelCatalog` 从 Operator 的 Pi model 配置离线列出可用模型，保存时验证 provider/model 与 thinking level。首次启动若 singleton 缺失，选择 catalog 第一项，优先使用 `medium`。Published migration `0038_global_agent_configuration` 将旧 Deployment 中唯一一致的模型提升为 singleton；多个不同旧值不会被静默选择。

Pi SDK 版本与接入验证见[开发指南](DEVELOPMENT.md#pi-sdk-升级)。应用通过 public `ModelRuntime` 管理凭证和模型，`SessionManager` 是会话上下文事实源，`session.systemPrompt` 是有效 prompt；不修改 `session.agent.state` 作为配置方式。

Pi 原生文件由 Operator 提供：

- `models.json` 只读读取。
- `auth.json`、`models-store.json` 复制到 process-private `0700` 临时目录，文件 `0600`，供 Pi storage 使用。
- Operator 更新这些文件后需重启 application，以创建新的 process snapshot。

## Built-in Pi tools

所有工单额外提供独立的 `sandbox` Node/Shell 分析工具。`runtime.sandbox` 与 `limits.sandbox` 定义执行环境和预算；`runtime.agent.codemode` 默认关闭，可由 Operator 显式开启 SDK 编排。权限、文件传输和部署条件见[工单分析沙盒](SANDBOX.md)。这不改变下表的 Repository access。

| 实际 Repository access | Tools |
| --- | --- |
| 至少一个且全部 write | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| 其他 | `read`, `grep`, `find`, `ls` |

Writable runtime PATH 提供：

```text
node-project <project> install|test|build|typecheck
maven-project <project> test|verify|package
```

Node 只支持 npm。Server/watch action、任意 executable、absolute host path 和自定义 config/cache path 不可用。

## 统一能力配置

“能力”页以一个列表维护原生能力的全局开关及自定义 MCP。类型标明 HTTP、数据库、Redis 或 MCP；MCP 不再有独立管理区域。DMS/SLS 的地址、认证与 schema/logstore 直接保存在服务的 prod/test Deployment；自定义 MCP 也必须在对应服务环境中显式选用。

Agent 只注册一个 service_query 查询入口，参数包含 environment、service、capability 和该能力的参数。原生适配器仍负责协议、exact target、只读操作、预算和取消，提示词不能替代授权。workspace list/describe 发现服务并按需读取描述。开发工单可读取全部 prod/test 服务配置；其他工单只读取自身 Environment。全局开关、服务配置的变化必须预约受影响工单，包含继承其能力的开发工单，关闭 idle session 后提交。

自定义 MCP 使用 HTTPS Streamable HTTP 或 SSE，由客户端发现并校验 schema；每次调用重新检查工具仍存在、schema 与只读注解，prod/test 来源只允许 readOnlyHint=true 且 destructiveHint!=true。凭证 preserve/replace/clear，改址/协议不能保留原认证。测试只 initialize/tools/list，不执行远端工具。配置入口沿用 /api/mcp-services，后端存于 mcp_services，部署 config.mcpServices 保存显式引用；被引用条目不能删除。宿主 mcp.json、stdio 与自动服务发现不参与应用配置。

## 外部 AI 工单接入（MCP）

“配置 → 端点”展示 MCP 地址、复制入口、一行接入说明与工具名称/用途列表。地址使用当前浏览器 origin 与 /mcp 组合，工具清单由 GET /api/endpoints 和 MCP tools/list 共用定义，不重复维护。此 MCP 是远程工单客户端：本地 AI 创建工单并与工单 Agent 交互，不直接开放服务源码、数据库或日志查询。

| 工具 | 用途 |
| --- | --- |
| services_list | 发现可选服务与环境 |
| users_list | 查看当前连接身份和可分配用户 |
| issues_search | 搜索已存在工单、分页查询 |
| issue_get | 查看工单详情、运行状态、附件和成果列表 |
| issue_create | 创建工单，复用现有角色校验与事务，成功后自动入队 |
| issue_message | 给指定工单补充信息、提问或要求继续处理 |
| issue_conversation | 分页读取对话与进展，包含尚未写入 JSONL 的当前轮次事件 |
| attachment_read | 按附件 ID 读取内容或获取下载路径 |
| output_read | 按成果文件名读取交付或获取下载路径 |

创建与发送消息标为非只读、非幂等；其余标为只读。创建返回工单编号，发送消息返回 accepted，均不等待 Agent 完成；用 issue_get 判断是否运行，再用 issue_conversation 分页读取回复。请求中断或响应不明时先搜索/核对对话，不自动重试写操作。本版本不提供文件上传、删除、发布、修改生产数据或完整工单管理 API。

客户端示例（地址替换成部署入口）：

```json
{
  "mcpServers": {
    "issue-pilot": {
      "url": "https://issue-pilot.example.com/mcp",
      "headers": { "X-Issue-Pilot-Subject": "your-subject" }
    }
  }
}
```

subject 只选择用户，不是认证；TLS/auth 网关必须认证并校验该身份，不能允许外部客户端任意冒用。MCP 沿用创建和 agent-messages HTTP owner 的角色、状态、并发和业务授权，不新增第二套执行逻辑。端点页不返回配置凭证，端点标签在导航最后。

## Capability 通用合同

固定 key/order：

```text
nacos, db, redis, mq, es, dms, sls
```

Service 保存原生 selected capability（nacos/db/redis/mq/es）时显式提交 credential intent；DMS/SLS 通过 connectionId 引用共享访问配置：

- `preserve`：保留同 Service/Environment 现有 credential。
- `replace`：提交完整新 credential。
- `clear`：只允许 optional credential。

API 在内存中合并一次，由 Registry 解析为 typed config，再在 reservation 和 transaction 内保存。Pi custom tool 使用 Registry TypeBox schema 解析一次 input，然后调用 session-local protocol client。超限整次失败，不把 partial result 伪装成完整结果。

### Nacos

Config：

- `serverUrl` 为 HTTP(S) root origin，无 credential/query/fragment。
- `namespace` 可空，最多 255。
- `group` 和去重后的 1..50 个 `dataIds` 只含字母数字、`.`、`_`、`-`，每项最多 255。
- username/password 同时为空或同时填写。

Tool input 选择同环境的 `service`；调用读取该服务配置的全部 exact Data ID，404 返回 `content:null`。Login response 和总内容受 budget 限制。

### MySQL (`db`)

每个 Deployment 授权 1..20 个数据库，每个目标独立配置连接与凭据：

```text
databases[]
  url       # mysql://host:port/database
  username
  password
```

URL 必须包含显式 port 和单段 database，不允许 embedded credential、query 或 fragment。URL 路径中的 database 名在当前 Deployment 内唯一，并直接作为 Agent selector；相同 URL 也不能重复。每行 username/password required，凭据独立执行 `preserve/replace`，不在目标间共享。

Input：

```json
{ "environment": "prod", "service": "orders", "capability": "db", "database": "orders", "statement": "SELECT ..." }
```

`database` 由所选 service 的当前 Deployment URL database 名动态生成 enum；Runtime 精确映射到该行 URL 和凭据，Agent 不能提交任意连接地址。SQL 最多 20000 chars，单 statement，无 comment。允许 `SELECT/SHOW/DESCRIBE/DESC/EXPLAIN`；拒绝 write、lock、multi-statement、file/variable output、`EXPLAIN ANALYZE` 和已知副作用函数。普通调用在 server-enforced read-only transaction 中 stream，完整返回查询结果，不设应用层 row/byte limit，最后 rollback；大结果会占用进程内存、Pi 上下文和 JSONL 空间。仅 `production_data` 可提交可选 `output: { fileName, format: "csv"|"jsonl" }`，此时 rows 直接流式写入当前 Issue 的 durable output，不进入模型上下文且不设应用层 row/byte limit；成功 rollback 后才原子发布文件，失败或 abort 清理临时文件。数据库账号仍必须是只读账号。

Migration `0044_db_database_targets` 将旧 `{url,username,password}` 合同提升为单元素 `databases[]`；不完整旧配置会使 migration 显式失败，不猜测或丢弃凭据。运行时不保留旧单目标兼容路径。

工具 `output` 还提供 `spreadsheet` operation：以当前工单 Attachment ID 选择 Excel，可选 `outputFiles` 读取同一工单已保存的 JSON/JSONL、CSV/TSV、Excel，或 `data` 接收结构化数据。JSON 在 `files[i].data`，CSV/Excel 在 `files[i].sheets`；脚本由 `@earendil-works/pi-codemode` 的 CodemodeSandbox 在独立 worker 中运行，只有一次受控的已授权输入读取能力，不开放 filesystem/network/Node API。超时、取消和 VM 内存限制由该包实现，并发名额通过 acquireWorker 在实际 worker 退出后释放；脚本错误和 console 输出不回显业务数据。返回多工作表结构后由服务端校验、编码真实 `.xlsx`，成功后原子发布到成果区；失败或取消保留旧成果。只返回文件名、大小、工作表行数给模型，原附件保持不变。Excel 解析和编码仍属于应用业务流程，此处只迁移脚本执行。

### Redis

Config：host、port 1..65535、optional username/password、database 0..1000000。

Actions：`get,mget,hget,hgetall,type,ttl,scan`。Key/field/pattern 最多 1024 chars，mget 最多 100 keys，结果最多 500。node-redis 在 heap-limited Worker 中运行，不能执行 arbitrary command。

### RabbitMQ (`mq`)

Config：host、AMQP port、management port、required username/password、virtualHost。Actions：`overview,queues,queue,bindings`；后两者 require queue。只访问 Management HTTP API，不创建 producer/consumer，不 follow redirect。

### Elasticsearch (`es`)

Config：HTTP(S) URL，可含 reverse-proxy path，无 credential/query/fragment；username/password 同时为空或填写。Actions：`search,count,mapping`。Search query 为 object，limit 1..200；不 follow redirect。

### DMS MCP

Deployment 直接保存 DMS 的 HTTPS 地址、Token 和 databases[]，SLS 的 AccessKey 与目标参数；已移除共享访问配置、选择器和管理接口。服务编辑时直接填写，留空保留已存认证，DMS 改址必须替换 Token。POST /api/dms/scope/resolve 使用本次输入或已保存的服务环境认证解析数据库。

Agent 通过 service_query 选择 environment、service、capability=dms、schema 和 script。schema 从对应来源部署动态形成 enum，服务端注入 DatabaseId，只调用唯一、schema-compatible 的 executeScript。SQL 仅允许单条只读 statement，拒绝 DDL/DML、comment、multi-statement、lock 和已知副作用函数。

Transport 保留 MCP SDK SSEClientTransport。初始 SSE GET 和同源 message POST 均携带认证，只允许 HTTPS，拒绝 redirect/跨源 endpoint。连接/调用共享 120 秒预算，首次握手 12 秒无响应时仅重试一次握手并使用剩余预算；403、协议错误与 executeScript 不重试。DMS argument/result 不应用通用 1 MiB 限制。Pi 原生 MCP 不支持 legacy SSE，不能直接替代该客户端。

仅 production_data 开放 output: { fileName: "batch-001.json" }，把完整 {tool,result} 原子保存到当前工单成果区，只返回摘要。之后可由 output.spreadsheet 或 sandbox import_output 处理；失败/取消保留旧成果。

Migration 0052_deployment_capabilities 将资源目标按原服务/环境关系写回 Deployment，保留共享连接和 branch rows，将原资源名称/说明加入手写服务描述，再移除 resources/resource_services 两张表与旧 CRUD。无服务归属、无对应部署、disabled 或无法表达的多连接/多 SLS project 映射均在删除前显式失败。旧开发能力配置存为私有 archivedDevelopment 历史，正常读取和执行不使用它，分支编辑继续保留它。既有全局 MCP 显式挂接到 prod/test 部署；新建服务环境必须手动选择。

### SLS

Deployment sls 直接保存 region、project、logstores 和 AccessKey。Agent 通过 service_query 的 environment/service/capability=sls/logstore 选择目标；from/to 必须同时出现，query 和 UUID trace_id 互斥。普通检索默认最近 15 分钟，trace 默认 24 小时。

SLS 使用官方 @alicloud/sls20201230 的 HTTPS GetLogsV2，SDK 负责签名，不运行 CLI、不写认证文件。read-worker.ts 为 SLS/Redis 共享工作线程生命周期、并发预算和取消，worker 中禁用 debug/宿主代理等环境继承，错误只返回稳定代码。native Redis 继续使用 RESP/TCP 的 node-redis，不额外引入 HTTP 网关。

普通日志检索以 100 条/page 递增 offset 直到耗尽；SQL 分析按服务端 hasSQL 分支，只请求一次，LIMIT/ORDER BY 定义结果与分页。服务端默认行数上限已触及时返回 sls_sql_limit_required，不把默认截断当成完整交付。progress 不是 Complete、SCAN/phrase 特殊模式或响应无效时完整失败；总查询时间 30 秒，结果 1 MiB 上限，取消时终止 worker/socket。SQL offset 无效，不能重复请求后累加同一页。

## Result 与 secret

| Capability | 主要 budget |
| --- | --- |
| Nacos | 50 Data IDs / 1 MiB |
| MySQL | 20 targets / 20k chars / result 无应用层 row/byte limit |
| Redis | 100 keys / 500 results / 1 MiB |
| RabbitMQ | 1 MiB response |
| Elasticsearch | 200 results / 1 MiB |
| DMS MCP | 120 s / argument 和 result 无应用层 byte limit |
| SLS | 自动分页 / 30 s / 1 MiB |

Secret flow：

1. SQLite typed Deployment config 保存服务能力参数与认证；个人覆盖保存在 user_credentials。
2. Catalog 不读取 config JSON；Config GET 只返回公开配置与 `credentialConfigured`，MySQL 各目标独立标识，所有 secret 字段都省略。
3. 编辑表单的 secret draft 初始为空，输入遮蔽；留空 preserve，输入新值 replace，optional credential 可 clear。按用户要求，开发角色在服务只读配置说明中可见实际明文凭证；该明文来自专用配置读取接口，不保存到 services.description 或 AI context。MySQL 每个目标独立执行；DMS/SLS 认证直接保存于服务部署。
4. API 合并、解析后 transaction 保存。
5. Agent context、prompt、tool schema/input 不含 credential。
6. createCapabilityTools clone session-local 配置并统一通过 service_query 分派，只在 tool closure 内把凭证传给协议客户端。
7. DMS Bearer 只作为 HTTPS Authorization header；SLS AccessKey 只进入隔离 worker 内的官方签名 SDK；不再写临时 profile 或执行 Aliyun CLI。其他 credential 只进入 in-process client。
8. Tool result 进入 model context 和 Pi JSONL，可能包含敏感业务数据。

不得记录 Config GET response、configuration write body、Authorization/Cookie、credential、temporary profile、package auth 或完整敏感 tool result。


### 个人生产覆盖

配置用户页使用一张“我的凭证”卡片，开发、DMS、SLS 分行布局并独立保存，不重复用户姓名邮箱。只有开发角色显示和维护 API Key/SSH 开发行；所有 active 用户都可在同一“我的凭证”卡片维护自己的 DMS/SLS 生产配置。后端对 model/git 更新强制开发角色校验，非开发用户的凭证状态不返回开发凭证信息。DMS 保存 HTTPS 地址与 Token，SLS 保存 AccessKey ID/Secret。复用 /api/me/credentials 的 production 字段，GET 仅返回状态和 DMS 地址。正式来源调用逐能力优先使用工单凭证 owner 的个人值；未配置则使用服务能力配置，测试不覆盖。认证失败不回退重试。0053 将共享连接完整迁入部署后移除旧表；0054 新增个人生产字段，默认不复制服务密钥。

能力页点击原生能力配置时自动准备并展开该能力的表单，尚未启用的能力仅在保存后生效，不再要求额外点击添加能力。服务页仓库区域标题为“代码分支”。

服务编辑弹窗固定提供开发、测试、正式三个部署，按该顺序展示，不提供添加/删除部署操作。旧服务缺失项在编辑时生成默认分支，保存后写入；现有参数保持。生成描述的公开版与开发角色配置版都按开发、测试、正式排序。能力页只保留添加能力按钮，进入/身份切换/保存自动更新，失败提供重试。
