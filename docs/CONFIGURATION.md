# 配置说明

## 配置事实源

Web 配置页面保存的 service deployment 是 Agent 模型、连接、credential 和 capability 授权的唯一事实源。运行时不会扫描仓库配置，也不会从环境变量补全 deployment credential 或 capability scope。

每个服务必须至少配置一个 repository。每个 environment 最多一份 deployment。服务和 deployment 按创建顺序展示，不支持拖动排序。

保存 service 后，使用该 service 的现有内存 Agent session 会被关闭；下一次执行从最新 deployment 创建新的冻结 policy。已写入 Pi JSONL 的历史消息和 session ID 不会被修改。

## Environment 和 issue type

| environment | 显示名 | 允许的 issue type | worktree/access |
| --- | --- | --- | --- |
| `prod` | 正式 | `data_processing`、`smart_analysis` | detached/read |
| `test` | 测试 | `smart_analysis` | detached/read |
| `dev` | 开发 | `defect_fix`、`feature_development` | hotfix 或 feature/write |

前端按 environment 过滤 issue type，API 再次验证。不能通过直接 HTTP 请求给 prod/test 工单授予可写 repository。

## Repository

每个服务至少一个 repository，URL 在同一服务内不能重复。Repository 不区分前后端类型；所有 repository 使用相同的 workspace、policy 和 Git 生命周期。Deployment 的 `baseBranch` 是该 environment 下所有 repository 使用的远端基线。

创建工单后，Issue Pilot 会把 service repository 固化到 issue workspace 记录。Service 删除 repository 时，下一次 Agent 准备会清理不再授权的 clean worktree；dirty workspace 明确失败并保留，防止丢失未提交修改。

## Agent model

每个 deployment 必须配置：

- `provider`
- `model`
- `thinkingLevel`

模型列表来自 Pi 的认证模型目录。保存时 API 验证 provider/model 当前可用，并验证 thinking level 属于该模型支持列表。

```text
off, minimal, low, medium, high, xhigh, max
```

页面模型控件只允许选择 model catalog 中的值。模型缺失、credential 不可用或 thinking level 不支持时 deployment 不能保存或 Agent 不能启动。`PI_PROVIDER`、`PI_MODEL` 等进程环境变量不作为后备授权。

## Policy snapshot

一次 Agent session 的 policy 包含 issue、model、service/environment、repository grant 和 capability scope。Credential 不进入 policy。

本地工具由 repository grant 计算：

| 条件 | 本地工具 |
| --- | --- |
| 任一 repository 为 read，或 repository 列表为空 | `read`、`grep`、`find`、`ls` |
| 至少一个 repository 且全部为 write | 上述工具加 `bash`、`edit`、`write` |

Capability tool 只在 capability 被勾选、对应配置完整且 scope 成功写入 policy 时注册。配置页面的 checkbox 本身不是授权边界，API、policy、tool schema 和客户端都会复核。

## Capability 概览

可配置 capability 固定为：

```text
playwright, nacos, db, redis, mq, es, sls
```

| capability | policy 中保留 | policy 中排除 |
| --- | --- | --- |
| Playwright | deployment ID、base URL | username、password |
| Nacos | deployment ID、server、namespace、group、exact Data IDs | username、password |
| MySQL | deployment ID | URL、username、password |
| Redis | deployment ID | host、username、password、database |
| RabbitMQ | deployment ID、virtual host | host、ports、username、password |
| Elasticsearch | deployment ID | URL、username、password |
| SLS | deployment ID、region、project、logstores | AccessKey ID/secret |

取消 capability 后，对应连接对象不会进入保存的 deployment config。修改 capability config 会使依赖该 service 的内存 session 失效，避免旧 closure 继续使用旧授权。

## Playwright

字段：

- `baseUrl`：必须是 `http://` 或 `https://` URL。
- `username`、`password`：可同时为空，或同时填写。

URL 不允许嵌入 username/password、query 或 fragment。Agent 只能从固定 base URL 发起相对路径导航；request、redirect 和 WebSocket 都必须保持同 origin。动作最多 50 个，单动作 selector/value 也有长度限制。

宿主固定 `/usr/local/node/lib/node_modules/playwright-core@1.62.1` 提供 runner，固定 `mcr.microsoft.com/playwright:v1.62.1-noble` 提供 Chromium。Credential 通过单次 `0600` 文件挂载，不进入 command line、policy、session 或 tool result。

## Nacos

字段：

- `serverUrl`：`http://` 或 `https://` origin，只允许根路径。
- `namespace`：允许为空。
- `group`：必填 exact group。
- `dataIds`：1 到 50 个 exact Data ID。
- `username`、`password`：可同时为空，或同时填写。

Group 和 Data ID 只允许字母、数字、点、下划线和连字符。`srm*`、`*`、`?` 等 glob 不支持。Tool 会一次返回全部授权 Data ID 的原始内容；共享结果预算超限时整次失败。

## MySQL

字段：

- `url`：严格格式 `mysql://host:port/database`。
- `username`、`password`：必填。

拒绝：

- `mariadb://...` 或 `jdbc:mysql://...`
- 缺少显式 port
- 缺少 database，或包含多段 database path
- URL 中嵌入 username/password
- query string 或 fragment

生产环境必须使用数据库侧 read-only account。运行时只接受单条 `SELECT`、`SHOW`、`DESCRIBE`/`DESC` 或 `EXPLAIN`，拒绝 comment、多 statement、file/variable output、lock 和已知副作用函数，并在 server-enforced read-only transaction 中 streaming 读取。

## Redis

字段：

- `host`
- `port`：1 到 65535，默认 6379
- `username`、`password`：允许为空
- `database`：0 到 1,000,000，默认 0

Redis 使用隔离 worker 中的 `node-redis` client，只接受 `get`、`type`、`ttl`、`hget`、`hgetall`、`mget`、`scan` 等约定操作，不接受 arbitrary command。Worker 有独立 heap limit，主进程还验证 key/count/result budget。

## RabbitMQ

字段：

- `host`
- `port`：AMQP port，默认 5672
- `managementPort`：Management API port，默认 15672
- `username`、`password`
- `virtualHost`

Agent 只访问 Management HTTP API 的 overview、queue 和 binding metadata，不连接 AMQP、不消费 message。每次调用都要求 config virtual host 与冻结 policy 完全一致。

## Elasticsearch

字段：

- `url`：`http://` 或 `https://`，允许 reverse-proxy path
- `username`、`password`：可同时为空，或同时填写

只开放 search、count 和 mapping。Client 拒绝 HTTP redirect，避免 authorization header 被转发到其他 origin。

## SLS

字段：

- `accessKeyId`
- `accessKeySecret`
- `region`
- `project`
- `logstores`：至少一个 exact logstore

Agent 只能查询冻结 policy 中列出的 logstore。Runtime 固定调用 `/usr/local/sbin/aliyun` 的内置 `Sls 2020-12-30 GetLogs`，不使用 plugin，也不接受环境变量替换 CLI 路径。

每次调用创建私有临时 HOME 和 `0600` profile。Query 显式分页；达到调用方 limit 后探测下一条，仍有记录则返回 `capability_result_too_large`，调用方必须缩小时间范围或 query。

## 配置示例

下面示例只展示结构，credential 必须在页面中实际配置，不要把真实 secret 提交到仓库：

```json
{
  "environmentKey": "test",
  "baseBranch": "develop",
  "agent": {
    "provider": "enterprise-provider",
    "model": "engineering-model",
    "thinkingLevel": "high"
  },
  "capabilities": ["nacos", "db", "sls"],
  "nacos": {
    "serverUrl": "https://nacos.example.internal",
    "namespace": "test",
    "group": "DEFAULT_GROUP",
    "dataIds": ["orders-test.yaml"],
    "username": "reader",
    "password": "<configured-in-ui>"
  },
  "db": {
    "url": "mysql://db.example.internal:3306/orders",
    "username": "reader",
    "password": "<configured-in-ui>"
  },
  "sls": {
    "region": "cn-hangzhou",
    "project": "orders-test",
    "logstores": ["application"],
    "accessKeyId": "<configured-in-ui>",
    "accessKeySecret": "<configured-in-ui>"
  }
}
```

## Secret 回写

`GET /api/config` 返回真实保存的 connection password 和 AccessKey，因为编辑页面会读取、修改并完整提交 deployment config。响应不是脱敏 placeholder。

必须遵守：

- API 固定绑定 `127.0.0.1`，不接受监听地址覆盖。
- 不把 API 直接暴露到 LAN 或公网。
- 外部访问只通过同机 authentication/TLS proxy，并单独限制 `/api/config`。
- 不把 `/api/config` response 写入 log、snapshot、issue comment 或 Agent prompt。
- SQLite 数据库、backup、Pi session 和 code-server data 都按敏感数据管理。

## 删除和引用完整性

删除仍被 issue 引用的 deployment 或 service 会返回 conflict。更新 service config 在 transaction 内验证：

- environment 存在且 deployment 不重复
- model/thinking level 可用
- repository ID 属于当前 service 且不重复
- service 至少保留一个 repository
- 即将删除的 deployment 未被现有 issue 引用
- capability declaration 无未知值或重复值
- 勾选 capability 的 connection config 完整

浏览器表单只负责交互体验；HTTP API 和 runtime policy 始终是 authoritative boundary。
