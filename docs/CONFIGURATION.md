# 配置与工具

## 配置来源

| 内容 | 来源 |
| --- | --- |
| 进程路径、端口、预算、默认值、回收策略 | [issue-pilot.config.ts](../issue-pilot.config.ts) |
| 绝对 state/database/Web 路径 | [src/config.ts](../src/config.ts) |
| 用户、服务、部署、仓库、开关、MCP、全局模型与个人凭证 | [SQLite schema](../src/db/schema.ts) |
| 模型目录与 provider 配置 | [Agent model runtime](../src/agent/model-runtime.ts) |
| 工具/能力输入与保存解析 | [registry.ts](../src/capabilities/registry.ts)、[service-query-tool.ts](../src/agent/service-query-tool.ts) |

生产入口没有 state root 环境变量覆盖。修改根路径配置前必须按[运维](RUNBOOK.md)准备匹配状态；测试通过构造参数注入临时路径。

## 页面与数据关系

设置页提供用户、模型、能力、仓库、服务、端点；默认打开服务。各面板保持挂载，切换不丢未保存草稿。

- **仓库**是 URL 与名称的统一目录。服务引用已登记仓库；更新目录 URL 会同步服务配置，工单仓库 URL 保留历史。
- **服务**保存手写业务知识、仓库集合和各环境部署，不构成同环境调查的唯一资源边界。
- **部署**由 Service + Environment 唯一确定，保存每个服务仓库的分支以及能力配置和出站 MCP 选择。
- **开发部署**只维护代码分支，查询继承正式和测试来源。旧开发配置的 `archivedDevelopment` 是私有历史，不投影或执行。
- **全局 Agent**只有一份 provider/model/thinking level，所有服务和环境共用，部署不含覆盖。

服务编辑器按开发、测试、正式排列，缺失环境会形成草稿，保存后持久化。服务描述由手写知识和当前配置生成，不把生成文本再次存入数据库；仓库分支单独展示。原地能力对话框复用同一部署表单和序列化路径。

配置 mutation 会预约受影响工单并关闭空闲会话。正式/测试能力变更也影响继承它们的开发工单；正在运行时返回冲突，不中断执行。

## 用户与凭证

`product`、`test` 可创建正式/测试调查；`developer` 还可创建开发和正式数据处理。开发/数据处理的执行及凭证 owner 同样受角色限制。用户停用保留历史署名，不能停用最后一个活跃用户。

工单凭证 owner 为 assignee，未分配时为 reporter，必须活跃。个人开发凭证只向 developer 提供：按 provider 存模型 API Key，Git 只支持 SSH 私钥，校验主机身份并使用会话级临时私有文件。**owner 为 developer 的工单会使用其个人模型 Key 和 SSH 环境，包括正式/测试调查**；缺少必需凭证时显式失败，不切换到共享凭证。其他角色使用 Operator 的 Pi runtime。

所有活跃用户可维护个人生产 DMS URL/Authorization、SLS AccessKey ID/Secret。覆盖规则由 [user-credentials.ts](../src/configuration/user-credentials.ts) 实现：

| 条件 | 使用值 |
| --- | --- |
| prod 已配置 DMS，owner 有个人 DMS | 整组个人 URL + Authorization，保留部署数据库目标 |
| prod 已配置 SLS，owner 有完整个人 SLS | 整组个人 ID + Secret，保留部署 region/project/logstore |
| owner 未配置该项 | 该部署凭证 |
| test 配置 | 该测试部署凭证 |
| 外部请求失败 | 返回失败，不更换身份自动重试 |

不同凭证行独立保存，不混合个人与部署的半组密钥，不为未配置的能力凭空创建目标。

## 密钥投影

普通 `GET /api/config` 移除凭证，仅返回公开参数和 `credentialConfigured`。个人凭证 GET 仅返回状态及必要公开地址，不返回密钥。编辑使用 `credentialUpdate` 的 preserve、replace、clear；必填凭证不能 clear，DMS 更换目标不能沿用旧认证。

`GET /api/services/:key/configuration-description` 是单独的 developer-only、no-store、静默日志接口，可在受信页面展示部分原生连接密码及出站 MCP 认证。**DMS Authorization 与 SLS AccessKey 始终不写入描述。** 默认服务 context、Agent 和入站 MCP 不包含这些密钥。敏感 Markdown 不进入共享缓存，切换身份/服务丢弃过期响应。

字段表和合并规则的唯一所有者为 [configuration/contracts.ts](../src/configuration/contracts.ts)、[credentials.ts](../src/configuration/credentials.ts)。不要把配置响应、请求 body、Authorization、密钥或完整敏感结果写入日志、监控、prompt、工具输入或进程参数。查询返回的业务数据会进入模型上下文与 Pi JSONL，成果和备份也可能包含敏感内容。

## 内建查询与出站 MCP

所有内建能力经 `service_query` 调用，显式选择 `environment`、`service`、`capability` 和操作。prod/test 工单访问本环境，开发工单可选择 prod/test；调用端仍验证精确目标、只读、超时、取消和结果完整性。全局开关与部署配置共同决定可用能力。

| 能力 | 配置目标 | 执行约束 |
| --- | --- | --- |
| Nacos | URL、namespace、group、精确 dataIds | 有界 HTTP，按配置项读取 |
| MySQL | 多数据库 URL、用户名、独立密码 | 单条只读 SQL，服务端 READ ONLY transaction；支持流式 CSV/JSONL 成果 |
| Redis | host/port、逻辑库、用户名/密码 | node-redis RESP/TCP，明确只读命令与数量预算，worker 隔离 |
| RabbitMQ | 管理地址、端口、vhost、认证 | 管理 HTTP 只读操作 |
| Elasticsearch | URL、认证 | 受限查询与结果预算 |
| DMS | HTTPS SSE URL、Authorization、解析后的 schema/DatabaseId | 仅 MCP executeScript，服务端注入 DatabaseId，强制只读 SQL |
| SLS | region、project、logstores、AccessKey | 官方签名 HTTPS GetLogsV2，worker 隔离 |

DMS 的实例/数据库发现仅由受信配置解析入口调用。Agent 只看到已配置 schema 的枚举，不接收 Authorization 或任意 DatabaseId。

SLS 普通查询用 offset 获取完整页，SQL 分析单次执行并使用 SQL 自身 LIMIT/ORDER BY。progress 不完整、服务端截断、scan 模式或不合法响应显式失败。SLS 不依赖 CLI profile；Redis/SLS 共用 worker 容量、取消和错误处理。

出站 MCP 支持 HTTPS SSE / Streamable HTTP 和本地 stdio。能力页可以添加单项，或显式导入常见 `mcpServers` JSON：

```json
{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}
```

stdio 接受 command、args、env 和可选 cwd，由官方 SDK 直接启动进程。env 为字面字符串，凭证放在 env；整个启动配置作为敏感数据保存，GET 只返回配置状态，Agent context 不包含它。相对 cwd 基于当前 Issue work；连接测试基于应用 cwd。进程使用应用用户权限，遵循同一容器内可信执行的模型。导入只保存配置，整体校验、事务写入，任何重名/无效项均不写入；随后在服务环境中选择，测试连接或 Agent 使用时才启动。

每个 Agent 会话按 MCP id 复用连接及进程，单次调用有独立超时/取消；启动失败、会话停止和应用关闭均释放连接。调用前重新核对工具 schema 与只读声明。正式/测试来源只选择带只读声明且非 destructive 的工具；客户端保留工具数、结果预算及 HTTPS 同源/重定向限制。远端错误和进程 stderr 不进入诊断。不自动加载宿主 MCP 配置，也不执行配置字符串中的 Shell 表达式。它与下面的入站工单 MCP 是两个方向。

## 代码执行与成果

所有工单直接使用 Pi 原生 read/bash/edit/write/grep/find/ls，在 `issues/<key>/work` 中编写和运行代码。Node 可以通过 require 使用应用已安装的包。工作文件跨轮次保留，runtime 和 Git 目录不作为处理脚本目录。

应用与 Agent 代码共享一个容器内的信任边界，没有脚本 VM、额外 Podman 执行器或工单级强隔离。Native Shell 可以运行常规程序和联网；业务查询工具仍按配置验证只读、目标、来源与凭证，不把 cwd 当权限隔离。

正式数据处理额外获得 `output`，仅提供 list/publish。list 返回成果目录及元数据，publish 从当前工作目录复制 regular file 到本工单成果区，按字节保存、原子替换、失败保留旧文件。任意格式均由代码和常规库处理，应用不解析 workbook、执行表格脚本或为每种格式增加 operation。预览仍可按已支持格式显示，其他格式提供下载；成果预览预算来自根配置。

MySQL/DMS 的完整查询导出仍由对应客户端写成果区；普通脚本可读取这些文件，生成新交付并 publish。查询导出和 Source API 的授权是业务边界，不能据此宣称原生代码被 OS 限制为只读。

## 外部 AI 工单接入

应用提供无状态 Streamable HTTP `POST /mcp`；GET/DELETE 返回 405。地址和工具用途也可从配置页“端点”或 `GET /api/endpoints` 获取。

| 工具 | 用途 |
| --- | --- |
| services_list | 发现服务和环境 |
| users_list | 当前身份和可分配用户 |
| issues_search | 按编号、标题、服务、环境、状态搜索 |
| issue_get | 详情、运行状态、附件与成果列表 |
| issue_create | 创建并入队，立即返回工单编号 |
| issue_message | 补充信息，空闲时续跑、运行中引导/排队 |
| issue_conversation | 分页读取对话和当前进展 |
| attachment_read | 校验后读取授权文本/Excel，二进制给下载地址 |
| output_read | 读取成果文本/Excel，二进制给下载地址 |

创建/发消息复用既有 HTTP owner 的事务、角色、状态和队列。成功只表示受理；后续使用 issue_get/issue_conversation 判断完成，最后读取成果。写工具非幂等，超时先搜索或核对对话，不能盲目重试。分页字段、最大数量和文本行数以 [server.ts](../src/mcp/server.ts) schema 为准。

`X-Issue-Pilot-Subject` 是活跃身份选择，不是认证。客户端连接时可设置该头，生产网关必须根据已认证用户固定或校验它。工单 MCP 不提供任意源码、数据库或日志的低层入口。
