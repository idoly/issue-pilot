# 配置说明

本文说明配置页面中的字段、校验和授权效果。代码生命周期见 [架构说明](ARCHITECTURE.md)，部署安全要求见 [部署说明](DEPLOYMENT.md)。

## 配置层级

一个 Service 包含：

- 至少一个 Repository。
- 每个 Environment 最多一个 Deployment。
- 每个 Deployment 为各 Repository 分别配置 `baseBranch`，并配置自己的 Pi model 和 capability。

Deployment 是 Agent 授权的唯一配置来源。Runtime 不扫描仓库配置，也不从环境变量补全 model、credential 或 capability scope。

保存 Service 后，受影响的内存 Agent session 会关闭；下一次执行使用新配置。已经写入 Pi JSONL 的历史内容不会改变。

配置来源保持单一：

| 配置 | 事实源 | 用途 |
| --- | --- | --- |
| 应用运行参数 | 根目录 `issue-pilot.config.ts` | 路径、端口、默认值、timeout、资源和结果上限 |
| Service/Deployment | SQLite | Repository 别名、各环境仓库分支、model、capability 和 credential |
| Issue policy | 每次 session 从 Deployment 和实际代码状态生成 | 冻结本次 Agent 授权，不保存 credential |

页面不会定义第二份默认值，Shell 也只读取根配置。根配置中的 `subject` 是默认操作人，`users` 是右上角允许切换的操作人名单；配置用户会同步到 SQLite 人员目录。运行时 policy 不反向修改 Deployment。

## Environment 与 Issue type

| Environment | 允许的 Issue type | 代码权限 |
| --- | --- | --- |
| `prod` | `data_processing`, `smart_analysis` | Deployment 最新 commit，只读 |
| `test` | `smart_analysis` | Deployment 最新 commit，只读 |
| `dev` | `defect_fix`, `feature_development` | 独立工作分支和 worktree，可写 |

Web 负责过滤选项，API 再次验证。直接调用 API 也不能给 prod/test 授予写权限。

## Service 与 Repository

### Service

- `name` 必填，最多 200 字符。
- `description` 可为空。
- Service key 从名称生成并保证唯一，创建后不随名称改变。
- 被 Issue 引用的 Service 不能删除。
- 存在运行中 Issue 时不能更新 Service。

### Repository

- 每个 Service 至少一个 Repository。
- 每个 Repository 必填别名和 URL；别名、URL 在同一 Service 内都不能重复。
- 别名用于配置页面识别仓库，Deployment 通过稳定 Repository ID 保存关联，修改别名不会把分支绑定到其他仓库。
- 已有 Issue 的 workspace/runtime 目录名继续来自其 Repository URL basename，修改 Service 别名不会移动真实代码目录。
- Basename 冲突时自动追加稳定 URL hash。

修改 Repository 列表后：

- Prod/test 下一轮使用最新列表和当前 Deployment 分支。
- 活动 dev 下一轮补入新增 Repository；新增仓库使用当前 Deployment 分支，已有仓库继续保留该 Issue 的历史 `base_branch`。
- 被删除 Repository 的 clean dev worktree 可以在下一次准备时移除。
- 删除前会先检查全部待移除 worktree；任意一个 dirty 时准备失败。Git 删除或数据库行更新中途失败时，已删除项会从原本地 branch commit 回滚，保留全部待移除 worktree 和数据库记录。
- Released dev 在重新打开前保留其历史 Repository 集合；不要仅因当前 Service 仓库更多就直接回填数据库。
- 数据库 `local_path` 与当前推导路径不一致时明确失败，不自动移动目录。

Released dev 为什么保留历史 Repository 和本地分支，见 [Git 存储原理](ARCHITECTURE.md#git-存储原理)。

## Deployment

每个 Environment 最多一份 Deployment。创建对应 Environment 的 Issue 前，Service 必须已有该 Deployment。每份 Deployment 必须为 Service 的每个 Repository 配置且只配置一个分支。新建表单的仓库分支、Nacos group、Redis 和 RabbitMQ 默认值来自根目录 `issue-pilot.config.ts` 的 `defaults`，保存后以 Deployment 数据为准。

### Repository `baseBranch`

每个 Repository 的 `baseBranch` 是该仓库在当前环境的基线，不是 Issue 工作分支。同一 Deployment 的不同 Repository 可以使用不同分支：

- Prod/test 每轮 Agent 前分别 fetch 各 Repository 的 `origin/<baseBranch>`，使用当时最新 commit。
- Dev Repository 首次加入工单时，从当前 Deployment 的 `origin/<baseBranch>` 创建同名 `hotfix-<issue-key>` 或 `feature-<issue-key>` 本地工作分支。
- 首次准备后，每个 Repository 的分支写入 `issue_repositories.base_branch` 作为该 Issue 的代码历史快照；以后修改 Deployment 分支不会改写已有 dev Repository。
- Reopen released dev 时从各自本地 Issue branch 重建 worktree，并使用保存的 Issue `base_branch` 验证远程基线。
- Service 后续新增 Repository 时，该 Repository 第一次加入活动 dev 工单才采用当前 Deployment 分支；released dev 不在后台自动扩充历史集合。

因此远程 Issue 分支可以删除；当前 Deployment 分支和历史 Issue `base_branch` 都应长期可访问。Prod/test 的 `issue_repositories` 会在每轮准备时刷新到当前 Deployment 分支和 commit，不承担 dev 历史快照语义。

### Agent model

每份 Deployment 必填：

| 字段 | 含义 |
| --- | --- |
| `provider` | Pi model provider |
| `model` | Provider 内的 model ID |
| `thinkingLevel` | 该 model 支持的 thinking level |

Thinking level 可选值：

```text
off, minimal, low, medium, high, xhigh, max
```

保存时 API 从 Pi model catalog 验证 model 当前可用，并验证 thinking level。`PI_PROVIDER`、`PI_MODEL` 等进程变量不作为 fallback。

## 本地工具授权

本地工具根据实际准备后的 Repository state 计算，而不是根据页面 checkbox 计算。

| 条件 | Pi built-in tools |
| --- | --- |
| 至少一个 Repository，且全部为 writable dev | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` |
| 任一 Repository 只读、列表为空或状态异常 | `read`, `grep`, `find`, `ls` |

`bash` 还会获得当前 Issue 专属的 `node-project` 和 `maven-project` wrapper。Wrapper 强制项目路径位于当前 dev workspace。

## Capability 授权原理

固定 capability key 及顺序由 `CAPABILITY_KEYS` 唯一定义：

```text
playwright, nacos, db, redis, mq, es, sls
```

API 的 `capabilityCatalog`、配置页按钮、详情标签和编辑表单都按这一顺序投影。只有被选择且配置完整的 capability 才会写入 Deployment。每次 Agent session 会从保存配置创建冻结 policy；credential 留在 session 持有的配置副本中，不进入 policy 或 prompt。

一次调用会经过四层检查：

1. 保存配置时验证字段和 scope。
2. Tool schema 验证输入结构。
3. Broker 比较冻结 policy 与 session 配置。
4. Client 验证协议、目标、timeout 和结果预算。

### 能力概览

| Capability | 允许操作 | 主要边界 |
| --- | --- | --- |
| Playwright | 固定 origin 的声明式浏览器动作 | 不执行任意脚本，不跨 origin |
| Nacos | 读取 exact Data IDs | 不模糊扫描，不写配置 |
| MySQL | 一条只读 SQL | Read-only transaction，不接受多语句 |
| Redis | Allowlisted read action | 不接受 arbitrary command |
| RabbitMQ | Management metadata | 不发布或消费消息 |
| Elasticsearch | Search、count、mapping | 不写入，不跟随 redirect |
| SLS | 查询授权 logstore | 不跨 project/logstore scope |

## Playwright

| 字段 | 规则 |
| --- | --- |
| `baseUrl` | `http://` 或 `https://`；不能含 credential、query、fragment |
| `username`, `password` | 同时为空或同时填写 |

允许动作：

```text
goto, login, click, fill, select, wait_for
```

一次最多 50 个动作。所有 HTTP、redirect 和 WebSocket 都必须保持 `baseUrl` origin。Credential 写入单次 `0600` 文件，只挂载给临时 Chromium 容器。

## Nacos

| 字段 | 规则 |
| --- | --- |
| `serverUrl` | HTTP(S) origin，只允许根路径 |
| `namespace` | 可为空 |
| `group` | 必填 exact group；新建表单默认使用 `defaults.nacos.group` |
| `dataIds` | 1 到 50 个 exact Data ID |
| `username`, `password` | 同时为空或同时填写 |

Group 和 Data ID 只允许字母、数字、点、下划线和连字符。不支持 `*`、`?` 或 glob。

Tool 一次读取全部授权 Data ID。任一响应或合计结果超限时整次失败。

## MySQL

| 字段 | 规则 |
| --- | --- |
| `url` | `mysql://host:port/database` |
| `username`, `password` | 必填 |

URL 必须包含显式 port 和单段 database path，不能嵌入 credential、query 或 fragment。

允许语句以 `SELECT`、`SHOW`、`DESCRIBE`、`DESC` 或 `EXPLAIN` 开始。Runtime 拒绝 comment、多语句、写操作、lock、file/variable output 和已知副作用函数，并在 server-enforced read-only transaction 中流式读取。

应用侧检查不能代替数据库权限；生产 Deployment 应使用数据库侧 read-only account。

## Redis

| 字段 | 规则 |
| --- | --- |
| `host` | 必填 |
| `port` | 1 到 65535，默认 6379 |
| `username`, `password` | 可为空 |
| `database` | 0 到 1,000,000，默认 0 |

允许 action：

```text
get, mget, hget, hgetall, type, ttl, scan
```

Redis client 在隔离 worker 中运行，并受 heap、key 数量和结果大小限制。

## RabbitMQ

| 字段 | 规则 |
| --- | --- |
| `host` | 必填 |
| `port` | AMQP port，默认 5672 |
| `managementPort` | Management HTTP port，默认 15672 |
| `username`, `password` | 必填 |
| `virtualHost` | 默认 `/`，并进入冻结 policy |

允许 action：`overview`、`queues`、`queue`、`bindings`。Runtime 只访问 Management API，不建立 AMQP 消费连接。

## Elasticsearch

| 字段 | 规则 |
| --- | --- |
| `url` | HTTP(S)，允许 reverse-proxy path |
| `username`, `password` | 同时为空或同时填写 |

只开放 `search`、`count` 和 `mapping`。Client 禁止 HTTP redirect，避免 Authorization 被转发到其他 origin。

## SLS

| 字段 | 规则 |
| --- | --- |
| `accessKeyId`, `accessKeySecret` | 必填 |
| `region` | 必填 |
| `project` | 必填 |
| `logstores` | 至少一个 exact logstore |

Runtime 固定调用 `/usr/local/sbin/aliyun sls GetLogs`。每次调用创建私有临时 HOME 和 `0600` profile，结束后删除。Agent 只能查询冻结 policy 中的 logstore。

## 结果边界

Capability 不返回部分成功结果。超过边界时返回 `capability_result_too_large`，调用方应缩小 SQL、query、时间范围或目标集合。下表当前值统一来自根目录 `issue-pilot.config.ts` 的 `limits.capability`。

| 边界 | 最大值 |
| --- | ---: |
| 序列化结果 | 1 MiB |
| MySQL statement / rows | 20,000 字符 / 500 行 |
| Nacos Data IDs | 50 |
| Redis keys / results | 100 / 500 |
| Elasticsearch results | 200 |
| SLS results | 200 |
| Playwright actions | 50 |

连接 timeout、浏览器动作 timeout、SLS 默认窗口/分页、Redis worker heap 等执行策略也集中在根配置。SLS 达到调用方 `limit` 后会探测下一条；仍有数据时整次失败，避免把“前 N 条”误认为完整结果。

## 保存与删除

Service 保存是一个数据库事务。API 会同时验证：

- Environment 存在且不重复。
- 新建 Service 的 Repository 不接受 ID；编辑时 Repository ID 必须属于当前 Service，且不能重复，别名和 URL 也不能重复。
- 每个 Deployment 恰好覆盖当前 Service 的全部 Repository；运行时还会再次拒绝缺失、额外或跨 Service 的关联。
- Model 和 thinking level 可用。
- Capability 名称、配置和 scope 完整。
- 即将删除的 Deployment 没有被 Issue 引用。

保存成功后关闭相关内存 session。保存失败不会留下半套 Repository 或 Deployment。

被 Issue 引用的 Service 或 Deployment 返回 `409`，不能通过页面或直接 HTTP 绕过引用完整性。

## 示例

下面只展示结构，不要把真实 secret 提交到仓库：

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
        "password": "<configured-in-ui>"
      }
    }
  ]
}
```

## Secret 回写

`GET /api/config` 返回真实保存的 password 和 AccessKey，因为页面需要读取并完整回写 Deployment。响应不是脱敏 placeholder。

不要记录 config request/response body，也不要把 secret 放入 Issue、prompt、comment 或 session。API 暴露和数据文件保护要求集中在 [部署安全](DEPLOYMENT.md#安全边界)。
