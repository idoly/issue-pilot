# 配置说明

本文说明 Issue Pilot 当前配置来源、Service/Deployment 模型、Environment/Issue type、Pi model 和八种 capability 的保存及执行边界。代码生命周期见 [架构说明](ARCHITECTURE.md)，宿主和网络要求见 [部署说明](DEPLOYMENT.md)。

## 配置来源

Issue Pilot 只有三类配置来源：

| 配置 | 事实源 | 内容 |
| --- | --- | --- |
| 应用配置 | 根目录 `issue-pilot.config.ts` | State path、用户、端口、默认值、retention、runtime、timeout 和结果预算 |
| Service/Deployment 配置 | SQLite | Repository、各环境分支、Pi model、capability scope 和 credential |
| IssuePolicy | 每次 Pi session 从实际代码状态和 Deployment 生成 | 冻结 model、Repository access/commit/path 和无 credential capability scope |

应用不接受环境变量覆盖。Node 和 Web 直接导入根配置；Shell 通过 `infra/config-value.mjs` 读取同一对象的标量字段。页面不定义第二套后端默认值。

普通工单工作台只读取 `/api/catalog`，其中只有 Environment key/name 和 Service key/name/可用 Environment，不包含 Repository URL、model、capability 或 credential。配置视图才按需读取 `/api/config`；该响应包含 Repository、model、capability scope 和每组 `credentialConfigured` 状态，但不包含已存 password、AccessKeyId 或 AccessKeySecret。两种响应共用 `src/configuration/contracts.ts`，分别由 `src/configuration/read.ts` 投影。

`/api/catalog` 和 `/api/config` 通过 scope queue 串行进入 SQLite snapshot transaction，避免单连接并发 transaction 的 `SQLITE_BUSY`，也不会跨过正在提交的 Service 配置读取混合版本。每个 Service 带一个 64 字符 opaque revision，它是 Service 字段、Repository、Deployment 完整 config（包括 credential）和 branch 关系的规范化 HMAC-SHA-256。HMAC key 在 API 启动时随机生成且不落盘，避免 revision 成为 credential 猜测 oracle；API 重启会使已打开表单的旧 revision失效。时间戳不参与，因此同一秒连续保存也能区分，字段顺序或查询顺序不会制造伪变化。

Web 的 catalog/config resource 使用递增 generation，只允许最新请求提交 state 或 error；旧响应不能覆盖较新的 revision。首次配置读取失败时页面保留原地重试，不要求切换视图或刷新整个应用。

保存或删除 Service 必须通过 `If-Match` 提交当前 revision。缺失返回 `428 service_revision_required`；当前内容已变化返回 `409 service_configuration_changed`，且不会关闭 Issue session或进入写事务。每个已选 capability 还必须显式提交一种 credential 更新：`preserve` 保留目标 Environment 当前值，`replace` 提交一组完整新值，`clear` 只允许可选 credential。API 在内存中合并当前 SQLite 配置并重新执行 registry 校验，然后把请求、model 和关系状态固化为 prepared configuration，再 reservation 全部受影响 Issue并关闭内存 Pi session，最后在一个 SQLite transaction 中 apply；事务阶段不会重新解析请求或重新读取配置关系。已存在的 Pi JSONL 不会改写；下一轮执行使用新配置。

## 根配置

当前 `issue-pilot.config.ts` 的主要分组如下。

### State 与区域

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `state.directory` | `.issue-pilot` | 相对项目根的 state directory |
| `state.databaseFile` | `issues.db` | 相对 state directory 的 SQLite 文件 |
| `state.sqliteBusyTimeoutMs` | `5000` | SQLite busy timeout |
| `regional.locale` | `zh-CN` | Web 区域显示 |
| `regional.timeZone` | `Asia/Shanghai` | Issue key 日期和 Agent 时间上下文 |
| `subject` | `users[0].subject` | 未指定请求 header 时的默认操作人 |
| `users` | 配置中的四名用户 | Web 可切换操作人和 SQLite subject 同步来源 |

`X-Issue-Pilot-Subject` 只能选择 `users` 中的 subject。它改变列表视角和写入署名，不构成认证。

### HTTP 与 Web

| 字段 | 当前值 |
| --- | ---: |
| `http.host` / `http.port` | `127.0.0.1` / `3000` |
| `http.logger` | `true` |
| `http.sseHeartbeatMs` | `15000` |
| `http.ssePendingBytes` | `4194304` |
| `web.host` / `web.port` | `0.0.0.0` / `4173` |
| `web.agentStreamReconnectMs` | `1000` |
| `web.markdownCacheEntries` | `512` |
| `web.markdownCacheCharacters` | `4194304` |

Vite 监听 `0.0.0.0` 仅用于受信任开发网络。生产安全边界仍要求受保护的统一入口，见 [部署说明](DEPLOYMENT.md#安全边界)。

### Workspace policy

| 字段 | 当前值 | 作用 |
| --- | ---: | --- |
| `workspace.retentionMs` | `604800000` | Resolved dev workspace 保留 7 天 |
| `workspace.highWaterBytes` | `21474836480` | 总量 20 GiB 时触发 quota 回收；`0` 关闭 |
| `workspace.targetBytes` | `17179869184` | 回收到 16 GiB |
| `workspace.maintenanceIntervalMs` | `900000` | 每 15 分钟运行；`0` 关闭定时器 |

Non-zero target 必须小于 high-water。无论 interval 是否为 0，API 启动都会运行一次 maintenance。

### 默认值

| 字段 | 当前值 |
| --- | --- |
| `defaults.environments` | `prod=正式`, `test=测试`, `dev=开发` |
| `defaults.deployment.baseBranch` | `main` |
| `defaults.nacos.group` | `DEFAULT_GROUP` |
| `defaults.redis` | port `6379`, database `0`, scan results `50` |
| `defaults.rabbitmq` | AMQP `5672`, management `15672`, vhost `/` |

这些值只用于初始化 Environment 或新建表单。Deployment 保存后以 SQLite 数据为准。

### Runtime

| 字段 | 当前值 |
| --- | --- |
| `runtime.codeServer.publicUrl` | `http://127.0.0.1:18080/` |
| `runtime.codeServer.listenHost/listenPort` | `127.0.0.1` / `18080` |
| `runtime.codeServer.containerPort` | `8080` |
| `runtime.codeServer.image` | `ghcr.io/coder/code-server:4.131.0-39` |
| `runtime.codeServer.version` | `keep-id-v24-code-server-4.131.0-current-layout-auth-none` |
| `runtime.codeServer.chatDisableAiFeatures` | `true` |
| `runtime.playwright.version` | `1.62.1` |
| `runtime.playwright.image` | `mcr.microsoft.com/playwright:v1.62.1-noble` |
| `runtime.playwright.playwrightCoreRoot` | `/usr/local/node/lib/node_modules/playwright-core` |
| `runtime.playwright.actionTimeoutMs` | `10000` |
| `runtime.playwright.navigationTimeoutMs` | `20000` |
| `runtime.playwright.containerPids/memory` | `256` / `1g` |
| `runtime.playwright.viewport` | `1280 x 720` |
| `runtime.redisWorker` | old heap `96 MiB`, young heap `16 MiB` |
| `runtime.containerUser` | fallback UID/GID `1000:1000` |
| `runtime.aliyunCli` | `/usr/local/sbin/aliyun` |
| `runtime.dms.endpoint` | `dms-enterprise.aliyuncs.com` |
| `runtime.dms.cliRegion` | `cn-hangzhou` |

DMS endpoint 是固定 central endpoint；`cliRegion` 只用于单次 Aliyun CLI profile，不是数据库 scope。

### 通用上限

| 边界 | 当前值 |
| --- | ---: |
| Agent message | 50,000 字符 |
| Attachment single file | 20 MiB |
| Attachment request | 40 MiB |
| Attachment count | 20 |
| Multipart form field | 100,000 bytes |
| Local command aggregate output | 5 MiB |
| Capability serialized result | 1 MiB |
| Capability default timeout / connection timeout | 15s / 10s |
| Git operation / output | 120s / 2 MiB |
| Disk usage | 120s |
| code-server ensure | 180s |

各 capability 的细分上限见后文。

## Environment 与 Issue type

| Environment | 允许 Issue type | Repository 模式 |
| --- | --- | --- |
| `prod` | `data_processing`, `smart_analysis` | 当前 Deployment commit，read-only |
| `test` | `smart_analysis` | 当前 Deployment commit，read-only |
| `dev` | `defect_fix`, `feature_development` | Issue 专属 working branch/worktree，writable |

Web 过滤选项，API 再次验证。直接调用 API 也不能给 prod/test 授予写权限。

## Service

Service 字段：

| 字段 | 规则 |
| --- | --- |
| `name` | 必填，最多 200 字符 |
| `description` | 可为空 |
| `key` | 创建时从名称生成并保证唯一；后续改名不改变 key |
| `repositories` | 至少一个 |
| `deployments` | 每个 Environment 最多一个 |

被 Issue 引用的 Service 不能删除。Service 编辑会 reservation 该 Service 的全部 Issue；任一 Issue 正在运行或 session 关闭失败时，不提交配置。

## Repository

每个 Repository 必填：

| 字段 | 规则 |
| --- | --- |
| `alias` | 同一 Service 内唯一，最多 100 字符 |
| `url` | 同一 Service 内唯一 |
| `id` | 创建 Service 时不接受；编辑时必须属于该 Service |

Deployment 通过 Repository ID 保存关联，但 API input 使用 alias 建立分支映射。每份 Deployment 必须恰好覆盖 Service 当前全部 Repository，不能重复、缺失、额外或跨 Service。

Repository alias 用于配置和展示；Issue workspace name 根据 URL basename 和稳定 hash 分配，不随 alias 修改而移动。

Service Repository 集合变化的影响：

- Prod/test 下一轮使用当前完整集合和当前 Deployment branch。
- Active dev 下一轮补入新增 Repository；新增项使用当前 Deployment branch。
- Existing dev Repository 保留该 Issue 已保存的历史 `base_branch`。
- 待删除 dev worktree 必须全部 clean；批量 prepare/remove/finalize 失败会回滚。
- Released dev 在 reopen 前保留历史集合，不由后台按当前 Service 自动扩充。

## Deployment

一个 Deployment 由以下部分组成：

```text
Environment
Repository branches (one per Service Repository)
Pi agent model
Selected capabilities and their configuration
```

创建该 Environment 的 Issue 前，Service 必须存在对应 Deployment。被 Issue 使用的 Deployment 不能删除，也不能改到另一个 scope。

### Repository branch

每个 `repositoryBranches[]` 项包含：

| 字段 | 含义 |
| --- | --- |
| `repositoryAlias` | 当前 Service Repository 的唯一 alias |
| `baseBranch` | 该 Repository 在当前 Environment 的基线 branch |

Prod/test 每轮 fetch 当前 Deployment branch。Dev Repository 首次加入 Issue 时把当前 branch 写入 `issue_repositories.base_branch`；之后它属于 Issue 历史，不随 Deployment 修改。

### Pi model

每份 Deployment 必填：

| 字段 | 规则 |
| --- | --- |
| `provider` | Pi model provider |
| `model` | Provider 内 model ID |
| `thinkingLevel` | Model 支持的 level |

Thinking level 固定集合：

```text
off, minimal, low, medium, high, xhigh, max
```

API 保存前从本机 Pi `ModelRuntime` 获取已配置认证且当前可用的 model，并验证 thinking level。不存在环境变量 fallback。

## 本地 Pi 工具

工具由实际准备结果计算，不由页面 checkbox 直接授权：

| 实际 Repository access | Built-in tools |
| --- | --- |
| 至少一个 Repository 且全部 writable | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` |
| 任一只读、空列表或异常 | `read`, `grep`, `find`, `ls` |

Writable dev 的 `bash` PATH 前置 Issue runtime `bin`，提供：

- `node-project <project> install|test|build|typecheck`
- `maven-project <project> test|verify|package`

Wrapper 只接受当前 Issue workspace 内的真实 project path。

## Capability contract

固定 key 和显示顺序：

```text
playwright, nacos, db, redis, mq, es, dms, sls
```

`src/capabilities/registry.ts` 是 capability 保存解析、credential-free scope、tool schema 和 metadata 的共同定义。`src/configuration/contracts.ts` 统一声明每种 capability 的 credential 字段、是否必需及配置中心读写 DTO；`credentials.ts` 负责脱敏和 preserve/replace/clear 合并。Web 仍为每种能力保留显式表单，`configuration-model.ts` 只序列化已选择 capability；未选择 section 不进入 payload 或 SQLite。

一次执行经过：

1. Service save parser 校验并规范化配置。
2. Registry 从保存配置投影 credential-free IssuePolicy scope。
3. Pi tool schema 解析 Agent input，拒绝 additional properties。
4. Broker 确认 capability 在 frozen allowlist 中，并取得 session config。
5. Protocol client 再次比较 frozen scope、当前 config、输入和结果预算。

Capability 都是只读且 bounded。应用检查不能替代外部系统的最小权限账号。

## Playwright

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `baseUrl` | `http://` 或 `https://`，必须有 host，不能含 credential、query 或 fragment |
| `username`, `password` | 同时为空或同时填写 |

### Tool input

```text
actions: 1..50
  goto(path)
  login(username_selector, password_selector, submit_selector)
  click(selector)
  fill(selector, value)
  select(selector, value)
  wait_for(selector)
screenshot?: boolean
```

`goto.path` 必须以单个 `/` 开始。Runner 将页面请求、redirect 和 WebSocket 限制在 frozen `baseUrl` origin。每次调用创建 `--rm` Chromium 容器；request 和 credential 分别写入私有 `0600` 文件。Credential 不进入 tool input 或 container argv。文本与可选 PNG 合计受 1 MiB 限制。

## Nacos

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `serverUrl` | HTTP(S) origin，只允许根 path，不允许 credential/query/fragment |
| `namespace` | 可为空，最多 255 字符 |
| `group` | Exact group，最多 255 字符 |
| `dataIds` | 去重后 1..50 个 exact ID，每项最多 255 字符 |
| `username`, `password` | 同时为空或同时填写 |

Group/Data ID 只允许字母、数字、点、下划线和连字符。

Tool input 是空对象。一次调用读取 frozen 列表中的全部 Data ID；404 映射为 `content: null`，其他 HTTP 失败整次失败。Login response 和所有配置内容受独立/合计 byte budget 限制。

## MySQL (`db`)

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `url` | `mysql://host:port/database`，显式 port，单段 database path |
| `username`, `password` | 必填 |

URL 不能嵌入 credential、query 或 fragment。

### Tool input 与执行

```json
{ "statement": "SELECT ..." }
```

Statement 最多 20,000 字符、单条、无 comment。允许以 `SELECT`、`SHOW`、`DESCRIBE`、`DESC`、普通 `EXPLAIN` 开始；拒绝 DDL/DML、lock、multi-statement、file/variable output、`EXPLAIN ANALYZE` 和已知副作用函数。

Client 使用 `START TRANSACTION READ ONLY`，以 stream 读取，最多 500 行/1 MiB，最后 `ROLLBACK`。Abort 会 destroy active connection。生产账号仍必须在数据库侧只读。

## Redis

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `host` | 必填，最多 255 字符 |
| `port` | 1..65535，默认 6379 |
| `username`, `password` | 可为空 |
| `database` | 0..1,000,000，默认 0 |

### Tool action

```text
get, mget, hget, hgetall, type, ttl, scan
```

Key/field/pattern 最多 1,024 字符；`mget` 最多 100 keys；结果最多 500 项。Redis 在 worker thread 中执行，受连接 timeout、结果 budget 和 V8 heap limit 约束。Arbitrary command 不可用。

## RabbitMQ (`mq`)

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `host` | 必填 |
| `port` | AMQP port，默认 5672 |
| `managementPort` | HTTP management port，默认 15672 |
| `username`, `password` | 必填 |
| `virtualHost` | 必填，默认 `/`，进入 frozen scope |

Tool action 为 `overview`、`queues`、`queue`、`bindings`。后两者要求 queue，最长 255 字符。Client 只访问 Management HTTP API，不建立 AMQP producer/consumer，不跟随 redirect。

## Elasticsearch (`es`)

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `url` | HTTP(S)，允许 reverse-proxy path，不允许 credential/query/fragment |
| `username`, `password` | 同时为空或同时填写 |

Tool action 为 `search`、`count`、`mapping`。Search 默认 `match_all`，可传 object query 和 1..200 limit。Client 保留 configured reverse-proxy path，禁止 redirect，结果受 1 MiB 限制。

## DMS

DMS 使用宿主 Aliyun CLI 内置命令：

```text
aliyun dms-enterprise ExecuteScript
```

固定 endpoint 为 `dms-enterprise.aliyuncs.com`，显式 `--secure`。数据库 region 不是 Deployment 字段。

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `accessKeyId`, `accessKeySecret` | 专用 RAM AccessKey，必填 |
| `dbId` | DMS DatabaseId，`1..2147483647` |
| `logic` | `false` 物理库，`true` 逻辑库 |
| `tid` | 可选 DMS tenant ID，`1..9007199254740991` |

`ExecuteScript` 适用于 DMS 安全托管数据库，不支持 NoSQL。Issue Pilot 不发送 `RealLoginUserUid`；AccessKey 所属 RAM 用户就是审计主体。

推荐外部权限：

- 专用 RAM 用户，不启用控制台密码。
- RAM 只授予 `dms:ExecuteScript`；该 action 的 resource 为 `*`。
- DMS tenant 内保持普通用户，不授予 admin/DBA/Owner/change/export。
- 只授予目标数据库 query 权限，并继续使用列权限、行权限和脱敏。
- Deployment frozen scope 再固定 exact `dbId/logic/tid`。

最小 RAM policy：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "dms:ExecuteScript",
      "Resource": "*"
    }
  ]
}
```

### SQL contract

复用 MySQL read-only syntax；额外要求 `SELECT` 以顶层末尾 `LIMIT n` 结束，`1 <= n <= 500`。不接受 OFFSET，也不会自动改写 SQL。`SHOW`、`DESCRIBE` 和普通 `EXPLAIN` 不要求 LIMIT，但响应仍受 500 行/1 MiB/30s 限制。

每次调用创建临时 HOME 和 `0600 ~/.aliyun/config.json`，结束后递归删除。AccessKey 不进入 argv；由于 CLI API 不支持从 file 读取 Script，SQL 会在执行期间出现在宿主 `ps` 参数中。若 SQL 也不能被本机进程观察，应替换为 SDK/签名 HTTP client。

Client 接受官方对象数组 `Rows` 和官方示例中的单层包装对象数组，归一化后核对 `RowCount`；其他结构失败。

## SLS

### Deployment 字段

| 字段 | 规则 |
| --- | --- |
| `accessKeyId`, `accessKeySecret` | 必填 |
| `region` | 小写字母/数字/连字符，最多 63 字符 |
| `project` | 合法 SLS project 名，3..63 字符 |
| `logstores` | 至少一个 exact logstore |

### Tool input

```text
logstore
from? / to?        # 必须同时提供
query?
trace_id?          # UUID；与 query 互斥
limit?             # 1..200，默认 20
```

未指定时间时，普通 query 默认最近 15 分钟，trace ID 默认最近 24 小时。Endpoint 为 `<region>.log.aliyuncs.com`，project/logstore 与 frozen scope逐项核对。分页达到 limit 后会探测下一条；仍有数据时返回 `capability_result_too_large`，不会把前 N 条伪装成完整结果。

每次调用创建临时 `0600` Aliyun CLI profile。AccessKey 不进入 argv，但 query、project、logstore 和时间范围会出现在宿主进程参数中。

## 结果与数据留存

Capability 超限时整次失败，不返回静默截断的部分成功。调用方应缩小 SQL、时间范围、limit 或目标集合。

| Capability | 主要上限 |
| --- | --- |
| Playwright | 50 actions，90s，文本+图片 1 MiB |
| Nacos | 50 Data IDs，合计 1 MiB |
| MySQL | 20,000 chars，500 rows，1 MiB |
| Redis | 100 keys，500 results，1 MiB |
| Elasticsearch | 200 results，1 MiB |
| DMS | 20,000 chars，500 rows，30s，1 MiB |
| SLS | 200 records，30s，1 MiB |
| RabbitMQ | HTTP response 1 MiB |

所有 capability 结果都会作为 Agent tool result进入模型上下文和该 Issue Pi JSONL。不要查询不需要的敏感列、配置内容或日志字段。

## Secret 数据流

- Deployment credential 以 JSON 存在 SQLite，仍是唯一事实源；没有第二套 secret 文件或环境变量来源。
- `GET /api/catalog` 不读取 Deployment config JSON；普通工作台不接触 credential。
- `GET /api/config` 只由配置视图按需调用。Projection 先用 registry 规范化已存 section，再移除 password、AccessKeyId 和 AccessKeySecret，只返回 `credentialConfigured`。
- 配置表单中的 secret input 始终为空。已有值显示“已配置”；留空保存发送 `preserve`，填写完整新值发送 `replace`，可选认证关闭后发送 `clear`。
- `preserve` 只从同一 Service、同一 Environment 的当前 Deployment 取值。目标不存在或没有已配置值时失败，不从其他 Environment 猜测或复制。
- Service prepare 在 API 内存中合并 credential 更新，再调用 registry 完整解析；SQLite transaction 保存的是规范化完整配置。
- `IssuePolicy`、system prompt、tool schema 和 Agent tool input不含这些 credential。
- `createCapabilityTools()` 对 Deployment config 做 session-local clone；完整配置只在 API 进程闭包内传给 broker/client。
- Playwright credential 进入临时 `0600` file。
- DMS/SLS AccessKey 进入调用级临时 `0600` Aliyun profile。
- MySQL、Redis、RabbitMQ、Elasticsearch 和 Nacos credential 只传给对应 API 进程 client。

禁止记录配置写请求 body、Authorization、Cookie、临时 credential file 或完整敏感 capability result。配置 GET 已脱敏，但仍含内部 Repository URL、model 和 capability scope，不应写入普通访问日志。

## 保存示例

以下只展示结构，不能提交真实 secret：

```json
{
  "name": "Orders",
  "description": "Order service",
  "repositories": [
    { "alias": "orders-api", "url": "git@example.internal:orders-api.git" },
    { "alias": "orders-web", "url": "git@example.internal:orders-web.git" }
  ],
  "deployments": [
    {
      "environmentKey": "test",
      "repositoryBranches": [
        { "repositoryAlias": "orders-api", "baseBranch": "develop" },
        { "repositoryAlias": "orders-web", "baseBranch": "release/test" }
      ],
      "agent": {
        "provider": "enterprise-provider",
        "model": "engineering-model",
        "thinkingLevel": "high"
      },
      "capabilities": ["db"],
      "db": {
        "url": "mysql://db.example.internal:3306/orders",
        "username": "reader",
        "credentialUpdate": {
          "mode": "replace",
          "values": { "password": "<configured-in-ui>" }
        }
      }
    }
  ]
}
```
