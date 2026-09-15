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

`GET /api/catalog` 只返回 Environment 和 Service 可用范围。配置页按需读取 `GET /api/config`，后者包含 Repository、全局 model、capability scope、`credentialConfigured` 和已存 credential。两个接口都使用 `Cache-Control: private, no-store`，并经 scope queue 读取一致 SQLite snapshot。Config 响应只能进入受信配置 UI，不得写入日志、监控或诊断附件。

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

Environment name 在启动时同步。DMS URL 只用于新 Deployment 表单，可编辑；已保存 Deployment 不会被默认值覆盖。

### Runtime 与 limits

| Boundary | 当前值 |
| --- | ---: |
| Agent model response idle | 300000 ms |
| Agent message | 50000 chars |
| Agent clipboard image | 复用 multipart file/request/count：20 MiB / 40 MiB / 20 |
| Attachment file/request/count | 20 MiB / 40 MiB / 20 |
| Multipart field | 100000 bytes |
| Process output | 5 MiB |
| Git operation/output | 120 s / 2 MiB |
| Disk usage | 120 s / 1 MiB output |
| Capability default/connection timeout | 15 s / 10 s |
| Capability result | 1 MiB，DMS MCP 除外 |
| Source file/tree | 2 MiB / 500 entries |
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
| `active` | Active user 可选择、创建/编辑 Issue 并作为 assignee/CC |

停用不会删除 row 或历史关系。Transaction 拒绝停用最后一名 active user。`/api/users` 只返回 active user，`/api/users/manage` 返回全部。

## Environment 与 Issue type

| Environment | Issue types | Repository mode |
| --- | --- | --- |
| `prod` | `data_processing`、`smart_analysis` | Read-only current Deployment commit |
| `test` | `smart_analysis` | Read-only current Deployment commit |
| `dev` | `defect_fix`、`feature_development` | Issue-local writable branch/worktree |

Web 过滤输入，API 使用同一 domain contract 再次验证。Prod/test 不能通过直接 API 调用获得写权限。

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

- `alias` 在 Service 内唯一，最多 100 chars。
- `url` 在 Service 内唯一。
- Create 不接受 client-supplied ID；edit ID 必须属于当前 Service。
- 每个 Deployment 必须恰好覆盖 Service 当前全部 Repository。

Alias 用于配置和展示；Issue `workspace_name` 从 URL basename/hash 稳定分配，不随 alias rename 移动。Existing dev 保留历史 base branch/workspace name；新增 Repository 使用当前 Deployment branch；待删除 dev worktree 必须 clean。

### Deployment

一个 Deployment 包含：

```text
Environment
Repository branches, one per current Service Repository
Selected capability sections
```

创建 Issue 前，目标 Service/Environment 必须已有 Deployment。每个 `repositoryBranches[]` 使用 current Repository alias 和 non-empty base branch。Prod/test 每轮读取当前 branch；dev 首次加入 Repository 时将 branch 固化为 Issue 历史。

服务编辑器中的 Deployment：

- 添加时只从尚未配置的 Environment 中选择；加入后 Environment 身份固定，不再使用行内下拉框。
- 折叠标题在桌面和移动端始终用一行显示环境名、已启用 capability、展开和删除控件。
- 折叠前后标题内容和位置保持一致。
- 已启用 capability 可从标题直接移除。
- 展开区的“添加能力”只列出尚未启用的 capability，不重复列出已启用项。
- 展开区继续编辑 Repository branch 和各 capability 参数；折叠不会清除 draft。

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

Pi 原生文件由 Operator 提供：

- `models.json` 只读读取。
- `auth.json`、`models-store.json` 复制到 process-private `0700` 临时目录，文件 `0600`，供 Pi storage 使用。
- Operator 更新这些文件后需重启 application，以创建新的 process snapshot。

## Built-in Pi tools

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

## Capability 通用合同

固定 key/order：

```text
nacos, db, redis, mq, es, dms, sls
```

Service 保存时，每个 selected capability 显式提交 credential intent：

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

Tool input 是空对象。调用读取全部 exact Data ID；404 返回 `content:null`。Login response 和总内容受 budget 限制。

### MySQL (`db`)

Config：`mysql://host:port/database`，显式 port、单段 database、无 URL credential/query/fragment；username/password required。

Input：

```json
{ "statement": "SELECT ..." }
```

最多 20000 chars，单 statement，无 comment。允许 `SELECT/SHOW/DESCRIBE/DESC/EXPLAIN`；拒绝 write、lock、multi-statement、file/variable output、`EXPLAIN ANALYZE` 和已知副作用函数。Client 在 server-enforced read-only transaction 中 stream，最多 500 rows/1 MiB，最后 rollback；abort 销毁 connection。数据库账号仍必须是只读账号。

### Redis

Config：host、port 1..65535、optional username/password、database 0..1000000。

Actions：`get,mget,hget,hgetall,type,ttl,scan`。Key/field/pattern 最多 1024 chars，mget 最多 100 keys，结果最多 500。node-redis 在 heap-limited Worker 中运行，不能执行 arbitrary command。

### RabbitMQ (`mq`)

Config：host、AMQP port、management port、required username/password、virtualHost。Actions：`overview,queues,queue,bindings`；后两者 require queue。只访问 Management HTTP API，不创建 producer/consumer，不 follow redirect。

### Elasticsearch (`es`)

Config：HTTP(S) URL，可含 reverse-proxy path，无 credential/query/fragment；username/password 同时为空或填写。Actions：`search,count,mapping`。Search query 为 object，limit 1..200；不 follow redirect。

### DMS MCP

每个 Deployment 共享一份 DMS connection，并授权 1..20 个 schema：

```text
url
Authorization
databases[]
  instanceAlias
  schemaName
  instanceId       # 后台解析
  instanceHost     # 后台解析
  instancePort     # 后台解析
  databaseId       # 后台解析
```

- URL required、HTTPS、无 embedded credential/query/fragment，可按 Deployment 编辑。
- Authorization required，格式严格为 `Bearer <token>`。
- `schemaName` 在 Deployment 内唯一；同名 schema 不能跨实例重复配置。
- 解析后的 DatabaseId 也必须唯一。
- 用户只填写 alias 和 schema，不填写额外名称、host、port、InstanceId 或 DatabaseId。
- 每行 alias/schema 停止输入约 500 ms 后独立调用 `POST /api/dms/scope/resolve`。
- API 在同一短生命周期 MCP session 中调用唯一、read-only 的 `listInstances` 和 `getDatabase`。
- `listInstances(search_key=alias)` 必须按 `InstanceAlias` 唯一精确匹配。
- `getDatabase(host, port, schema_name)` 必须返回相同 InstanceId 与 schema。
- 所有数据库都完整解析后才允许保存。

旧 Aliyun CLI `accessKeyId/accessKeySecret/dbId/logic/tid` 配置仍不解析、不迁移、不兼容、不回退。Migration `0039_dms_database_targets` 把当前 MCP 单数据库合同提升为 `databases[]`；遇到不完整的当前 scope 会显式失败，不猜测目标。`0040_dms_schema_selector` 删除过渡数组中的冗余 name，使 schema 成为唯一 Agent selector。运行时不保留单目标 JSON 兼容路径。

Transport 使用 MCP SDK `SSEClientTransport`。Authorization 同时用于初始 SSE GET 和同源 message POST。Client 只允许 HTTPS、拒绝 redirect、拒绝跨源 message endpoint，并在完成、失败或 abort 后关闭连接。

Agent tool input：

```json
{ "schema": "xhgj_oms", "script": "SELECT ...", "logic": false }
```

`schema` required，并由当前 Deployment 的 `databases[].schemaName` 动态生成 enum；`logic` optional。Agent 只看到一个 `dms` custom tool，不能提交 DatabaseId、列出远端工具或调用 scope resolve 工具。Runtime 把 schema 精确映射到持久化 DatabaseId，只接受唯一且 schema 包含 required `database_id`/`script` 的 `executeScript`，并由服务器注入 DatabaseId。SQL 只允许单条 `SELECT/SHOW/DESCRIBE/EXPLAIN`，拒绝 DDL/DML、comment、multi-statement、lock 和已知副作用函数。一次调用只选择一个数据库；连接与调用共享 30 秒 operation signal；DMS script/result 不应用 1 MiB 应用层限制。

### SLS

Config：required AccessKey、合法 region/project、至少一个 exact logstore。Session 创建 SLS tool 时把当前 Deployment logstore 白名单投影为 input enum。

Input：

```text
logstore
from/to          # optional，必须同时出现
query            # optional
trace_id         # UUID，与 query 互斥
```

普通 query 默认最近 15 分钟，trace 默认 24 小时。Client 以 100 条/page 自动读取到耗尽，不设置 record-count 上限；每页后检查统一 1 MiB result budget，超限整次失败。

每次调用创建临时 HOME 与 `0600 ~/.aliyun/config.json`，由 Aliyun CLI 读取，finally 删除。AccessKey 不在 argv；query、project、logstore 和时间范围可能出现在 application process argv。

## Result 与 secret

| Capability | 主要 budget |
| --- | --- |
| Nacos | 50 Data IDs / 1 MiB |
| MySQL | 20k chars / 500 rows / 1 MiB |
| Redis | 100 keys / 500 results / 1 MiB |
| RabbitMQ | 1 MiB response |
| Elasticsearch | 200 results / 1 MiB |
| DMS MCP | 30 s / argument 和 result 无应用层 byte limit |
| SLS | 自动分页 / 30 s / 1 MiB |

Secret flow：

1. SQLite 保存完整 typed Deployment config。
2. Catalog 不读取 config JSON；Config GET 返回完整配置与 credential。
3. 配置页 draft 回填 secret，并通过 `preserve|replace|clear` 提交。
4. API 合并、解析后 transaction 保存。
5. Agent context、prompt、tool schema/input 不含 credential。
6. `createCapabilityTools()` clone session-local config，只在 tool closure 传给 client。
7. DMS Bearer 只作为 HTTPS Authorization header；SLS credential 只进入临时 profile；其他 credential 只进入 in-process client。
8. Tool result 进入 model context 和 Pi JSONL，可能包含敏感业务数据。

不得记录 Config GET response、configuration write body、Authorization/Cookie、credential、temporary profile、package auth 或完整敏感 tool result。
