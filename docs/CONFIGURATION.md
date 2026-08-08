# 配置说明

## 配置事实源

Web 配置页面保存的服务 deployment 配置是 Agent 模型、凭据、连接和能力授权的唯一事实源。运行时不会扫描仓库配置，也不会从环境变量补全 deployment credentials。

每个服务必须至少配置一个仓库。每个环境最多一份 deployment。服务和 deployment 按创建顺序展示，不支持拖动排序。

## 环境和工单类型

环境固定为：

| 环境 | 显示名 | 允许的工单类型 |
| --- | --- | --- |
| `prod` | 正式 | `data_processing`、`smart_analysis` |
| `test` | 测试 | `smart_analysis` |
| `dev` | 开发 | `defect_fix`、`feature_development` |

前端会按环境过滤类型，API 会再次验证，不接受环境与类型不匹配的请求。

## 仓库

仓库类型只能是：

- `frontend`
- `backend`

每个服务至少一个仓库，URL 在同一服务内不能重复。deployment 的 `baseBranch` 是该环境所有仓库使用的远端基线分支。

删除仓库前应确认相关工单 worktree 不再需要。已有脏工作区不会被自动移除。

## 模型

每个 deployment 必须配置：

- `provider`
- `model`
- `thinkingLevel`

模型列表来自 Pi 的认证模型目录。保存时 API 会验证 provider/model 仍然可用，并验证 thinking level 是否包含在该模型支持列表中。

thinking level 可选值：

```text
off, minimal, low, medium, high, xhigh, max
```

页面模型控件显示 model ID，并在 deployment 编辑器中保持已选择且不可自由输入。模型配置缺失时 Agent 不会启动。

## 能力

可配置能力固定为：

```text
playwright, nacos, db, redis, mq, es, sls
```

只有勾选的能力会被保存到 deployment policy 并注册为 Pi tool。勾选能力时对应连接配置必须完整；取消能力后对应配置不会进入保存的 deployment config。

### Playwright

字段：

- `baseUrl`：必须是 `http://` 或 `https://` URL。
- `username`、`password`：可同时为空，或同时填写。

URL 不允许嵌入用户名、密码、query 或 fragment。Agent 只能从固定 base URL 发起相对路径导航。宿主全局 `playwright-core@1.62.1` 提供 runner，固定版本浏览器容器提供 Chromium。登录凭据通过临时 `0600` 文件挂载给浏览器容器，不进入命令行、policy、session 或工具结果。

### Nacos

字段：

- `serverUrl`：`http://` 或 `https://` origin，只允许根路径。
- `namespace`：允许为空。
- `group`：必填精确 group。
- `dataIds`：1 到 50 个精确 Data ID。
- `username`、`password`：可同时为空，或同时填写。

`group` 和 Data ID 只允许字母、数字、点、下划线和连字符。`srm*`、`*`、`?` 等 glob 不受支持。Nacos tool 会一次返回所有授权 Data ID 的原始内容或明确失败，不做仓库配置展开。

### MySQL

字段：

- `url`：严格格式 `mysql://host:port/database`。
- `username`、`password`：必填。

拒绝以下格式：

- `mariadb://...`
- `jdbc:mysql://...`
- URL 中嵌入用户名或密码
- query string 或 fragment
- 缺少 database 名称

配置只代表连接边界。生产环境仍必须使用数据库侧只读账号。执行时还会验证 statement，并开启服务端只读事务。

### Redis

字段：

- `host`
- `port`：1 到 65535，默认 6379。
- `username`：允许为空。
- `password`：允许为空。
- `database`：0 到 1,000,000，默认 0。

Redis 使用原生 `node-redis` 客户端，并在隔离 worker 中约束大型 RESP 响应。能力只暴露约定的只读命令，不接受任意 Redis command。

### RabbitMQ

字段：

- `host`
- `port`：AMQP 端口，默认 5672。
- `managementPort`：Management API 端口，默认 15672。
- `username`、`password`
- `virtualHost`

Agent 只访问 Management HTTP API 元数据，不建立消费消息的 AMQP 流程。冻结 policy 只保存 virtual host 和 deployment ID，不保存凭据。

### Elasticsearch

字段：

- `url`：`http://` 或 `https://`，允许反向代理路径。
- `username`、`password`：可同时为空，或同时填写。

只开放 search、count 和 mapping。客户端拒绝 HTTP redirect，避免凭据被转发到其他 origin。

### SLS

字段：

- `accessKeyId`
- `accessKeySecret`
- `region`
- `project`
- `logstores`：至少一个明确 logstore。

region、project 和 logstore 必须满足保存校验。Agent 只能查询 policy 中列出的 logstore。执行使用宿主 Aliyun CLI 内置 `Sls GetLogs`，不依赖 `aliyun-cli-sls` plugin。Aliyun credentials 在执行时写入临时私有配置，不进入 capability 结果。

## 密钥回写

`GET /api/config` 返回实际保存的连接密码和 `accessKeySecret`，因为编辑页面会读取、修改并完整提交 deployment 配置。响应不是脱敏占位符。

因此必须遵守：

- API 默认只绑定 `127.0.0.1`。
- 不要把 API 直接暴露到局域网或公网。
- 外部访问必须由认证代理保护，并限制 `/api/config` 权限。
- 不要把 `/api/config` 响应写入日志、测试快照或问题评论。

## 删除和引用完整性

删除仍被工单引用的 deployment 或服务会返回冲突错误。更新服务配置会在事务内验证：

- deployment 环境存在且不重复。
- 模型和 thinking level 可用。
- 仓库 ID 属于当前服务且不重复。
- 即将删除的 deployment 未被已有工单引用。

浏览器表单校验只用于用户体验；API 和 broker 校验始终是权威边界。
