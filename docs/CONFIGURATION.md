# 配置说明

[文档导航](README.md) · [部署](DEPLOYMENT.md) · [接口](HTTP.md)

## 配置分层

| 来源 | 权威内容 | 生效方式 |
| --- | --- | --- |
| 根 issue-pilot.config.ts | state、监听、区域、bootstrap、硬预算和参数默认值 | API 重启；Web 引用的设置需重新构建，Vite 需重启 |
| SQLite | 用户、凭证、仓库、Service／Deployment、MCP、偏好、模型及参数覆盖 | 页面／API 持久保存；按 owner 的预约、revision 和热更新边界生效 |
| 运行用户 Pi 目录 | 模型定义、settings、指令、skills、prompts、extensions | 模型目录离线刷新；资源／settings 在准备会话时加载，文件变化不保证更新已有会话 |

目标机的 state.directory 为 `data`，databaseFile 为 `issues.db`；路径分别相对源码根和 state root，不随 Shell cwd 改变。没有 state/database 环境变量覆盖，也不通过 .env 或 YAML 导入业务设置。不要用历史私有文件补数据库缺值。来源：[config.ts](../src/config.ts)、[configuration](../src/configuration)。

当前 API 监听 0.0.0.0:3000，实际访问边界见[部署](DEPLOYMENT.md#访问与认证)。bootstrapUser 只在用户表为空时插入，改它不会更新已有用户；默认环境名会在启动按根配置同步。

### Operator 模型目录

运行用户的 Pi `getAgentDir()` 默认指向 `~/.pi/agent`；SDK 的 `PI_CODING_AGENT_DIR` 可改该目录，**不改变应用 state root**。主机 supervisor 或容器必须给运行进程提供相同目录和读取权限，不能以另一个 Shell 的配置代替。

[models.json 示例](../examples/models.json) 是无密钥的目录模板。将 `baseUrl`、模型 `id`、`api`、输入能力、上下文及输出上限替换为供应商实际支持的值，再合并到运行用户的 `models.json.providers`；不要覆盖已有配置。示例的 `.invalid` 地址不能执行模型请求，目录被接受也不证明上游协议、权限或费用正确。示例省略费用字段，不作为计价依据。完整格式以本次 `npm ci` 安装的 `node_modules/@earendil-works/pi-coding-agent/docs/models-configuration.md` 为准。

完成安装和目录准备后，在仓库根用 Bash 执行以下**离线目录检查**。它只输出目录路径和候选标识，不启动 API、不写业务数据库、不调用模型；Pi 的临时目录由 `close()` 清理：

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { PiAgentModelCatalog } from './src/agent/model-runtime.ts';
const catalog = new PiAgentModelCatalog();
try {
  console.log('Pi directory:', getAgentDir());
  const models = await catalog.list();
  if (!models.length) throw new Error('global_agent_model_unavailable');
  console.log(models.map(({ provider, id }) => ({ provider, id })));
} finally {
  await catalog.close();
}
NODE
```

首次空库从按 provider／id 排序的候选中选第一项，thinking 优先 `medium`，否则取模型支持的第一项，Codemode 初始为 `on`；不是自动选择“最适合”的模型。启动后由管理员核对并保存共享模型与 Key。已有全局配置时启动不会重新选型，模型被移除后需显式修正选择。依据：[模型目录](../src/agent/model-runtime.ts)、[全局初始化](../src/configuration/agent.ts)、[离线目录回归](../tests/agent/model-runtime.test.ts)。

## 身份与权限

X-Issue-Pilot-Subject 是选择器，不是认证。可信网关必须校验身份、覆盖来访头并阻止绕过直连。调用身份校验的路由要求活跃用户；不传头时按 createdAt、subject 升序取首个活跃用户并固定该请求的选择，失活后不换账号。部分目录和详情 GET 不检查身份，没有逐工单 ACL，见[HTTP 边界](HTTP.md#身份与访问边界)。

| 条件 | 用途 |
| --- | --- |
| 活跃用户 | 工单操作、源码及生命周期变更等；执行前重检 |
| developer | 开发处理方式、仓库／服务／用户维护及约定的私有描述读取 |
| isAdmin | 共享模型／凭证、全局 MCP、参数和管理操作 |

product／test／developer 与 isAdmin 独立。用户变更保护活跃用户、开发者、管理员，以及至少一名活跃且有管理权限的 developer。等待相关 scope／预约后再次授权，不能以页面按钮隐藏代替权限。

## 凭证与 owner

工单 owner 为处理人，否则报告人，必须活跃。所选身份失败不切换到其他人或共享凭证。

| 组 | 选择规则 |
| --- | --- |
| 模型 | 任何角色的完整个人 provider／model／thinking／Codemode／Key 替换共享整组；无个人组才取共享组 |
| Git | developer 的远程仓库只用本人 SSH 私钥；缺失或失败不回退 Operator／ssh-agent／其他用户 |
| DMS | prod/test 有完整个人 URL／Authorization 则取个人，否则共享；残缺报错 |
| SLS | prod/test 有完整个人 AccessKey ID／Secret 则取个人，否则共享；残缺报错 |

凭证不能创建查询目标或扩大范围，开发证据仍显式选 prod/test。普通配置 GET 隐藏连接密钥；developer 选定的说明／MCP 编辑接口只暴露其契约允许值，原生 DMS Authorization 和 SLS Key 不暴露。连接密钥不进入提示、工具输入、argv、诊断或普通日志；授权结果中的业务 token 与连接密钥不是同一类数据。

个人 Git 使用 ssh -F /dev/null、IdentityAgent=none 和 BatchMode=yes，不读 ~/.ssh/config。仓库 URL 必须带实际用户／主机，非默认端口用 `ssh://git@git.example.test:2222/team/repo.git`；Host 别名、ProxyJump 和交互私钥口令不生效。运行用户需预先核验 known_hosts，保存凭证不测试连接。owner：[user-credentials.ts](../src/configuration/user-credentials.ts)、[git-credentials.ts](../src/workspace/git-credentials.ts)。

## 个人与共享设置

“我的凭证”分 API Key、SSH、DMS、SLS。管理员弹窗默认编辑共享组，取消共享选项后编辑个人；非管理员不读取共享状态，SSH 仅 developer。

页面未修改的秘密留空表示保留，实际通过省略 Key 或不发送请求实现；直接 API 的空字符串不代表保留。替换要提供完整有效组，清除使用 `mode: "clear"`。DMS URL 改变需重填 Authorization；模型换 provider 不能保留旧 provider Key。

共享模型位于 global_agent_configuration，个人模型位于 user_credentials.model_credentials；候选来自运行用户 models.json 的 provider。Operator auth.json／models.json 密钥或 headers 不成为模型请求 fallback。全局 runtime 仍适用于所有服务，Deployment 没有模型覆盖。

共享 DMS／SLS 位于 application_settings，独立 revision，密钥不在 Deployment。凭证／模型变更预约受影响工单并关闭旧会话，有活动则冲突；参数更新是另一条路径。

## 运行参数

GET /api/config/parameters 返回 revision、overrides、values、defaults、bounds。管理员 PUT 提交 `{ expectedRevision, overrides }`，overrides 是完整覆盖快照，省略项回到根默认值；只改一项时先合并已有覆盖，不能意外撤销网络或保留期。`overrides: {}` 清除全部覆盖，revision 冲突为 configuration_changed。

| 参数 | 根默认值 | 作用范围 |
| --- | --- | --- |
| maxConcurrentIssues | 10 | 取得执行名额的工单轮次，调低不取消已有轮次 |
| modelResponseIdleMs | 300 秒 | 连续无模型更新等待；更新重置，工具期间暂停，不是整轮时长 |
| workspaceRetentionMs | 7 天 | 从开发工单 resolvedAt 起算，再检查是否可安全释放 |
| workspaceHighWaterBytes／workspaceTargetBytes | 20／16 GiB | 工单根合计触发回收，不含共享 Git，不是磁盘配额 |
| workspaceMaintenanceIntervalMs | 15 分钟 | 后续维护计时，0 停周期但启动仍维护一次 |
| capabilityConnectionMs | 10 秒 | 后续 SLS CLI connect-timeout，向上取整秒，不控制 MCP／DMS |
| mcpExecutionMs | 120 秒 | 后续服务 MCP 工具／资源请求开始时取值 |
| dmsExecutionMs／slsExecutionMs | 120／30 秒 | 后续对应原生查询 |
| dingtalkAttachmentHosts | 根配置主机列表 | 后续导入附件允许来源 |
| networkMode／networkAllowedDomains | open／根基础名单 | 新代理连接读取，既有连接不中断 |

这里只列代码默认值，目标实际值以 API values 为准。数值范围、跨字段关系和列表限制以 [parameters.ts](../src/configuration/parameters.ts) 为准：并发 1–64，保留期 1 小时至 365 天，非零维护周期至少 1 分钟，非零高水位大于目标，列表最多 100 且无重复。

高水位 0 仅关闭容量触发。回收只释放已解决、空闲、干净且绑定一致的开发代码，不删除附件、JSONL、工作文件或私有 Git。保存先持久化再替换有效快照，通知 Engine／维护／网络；不预约全部工单、不关闭所有会话、不中断既有调用。服务 MCP 通过 getter 和[SDK 补丁](../patches/README.md#服务-mcp-调用预算)在每次调用读取预算，已有会话的后续调用也生效。网络同步失败下次获取沙箱再同步，不重放业务操作。

页面使用秒／分钟／小时／MiB，但 API 保存整数毫秒／字节；未改字段保留原值，不因显示单位四舍五入。源码 taskConcurrency、端口、state 路径、时区和硬预算不在热参数页。回归：[application-parameters.test.ts](../tests/http/application-parameters.test.ts)。

### 工单网络访问

open 默认开放已有 HTTP／SOCKS 代理支持的出站能力，不按远端读写操作过滤；allowlist 按 networkAllowedDomains 基础名单加全局 Agent runtime 追加项过滤。域名可带端口，无端口匹配任意端口，裸 `*` 不接受，需开放时选 open。切模式保留名单内容。

每个新请求／CONNECT 检查模式，不追溯切断已建 TCP 隧道和 keep-alive，也不解除宿主控制地址／应用端口拒绝或文件隔离。自动开放排除未显式允许的本机、回环、链路本地和云元数据地址。DNS／上游代理仍影响实际路由，不能把本机检查当远端解析保证。

此设置不创建浏览器、保存网站登录或提供任意 UDP／ICMP 支持。远程网站／MCP 的权限仍独立；SDK／Operator 扩展属于可信应用代码。旧数据库缺此覆盖时采用根默认 open，需保留白名单的安装应显式保存 allowlist。owner：[issue-sandbox.ts](../src/agent/issue-sandbox.ts)。

## 服务和查询目标

仓库目录保存 URL、名称与独立分组；Service 关联仓库，prod/test Deployment 保存基线和目标。dev 基线从同服务 prod 推导，不能单独覆盖；既有工单分支和路径是历史记录，不能随配置猜测改绑。

保存服务必须显式提供 deployments 数组，省略不等于清空。revision 冲突保留草稿，仓库 URL 级联变更推进服务版本。目标保存不要求已有凭证，实际调用才校验完整组。

### DMS 与 SLS

DMS 只保存 instanceAlias／schema 意图，服务器按当前 owner 凭证解析实例、host、port、databaseId，不信客户端提供的解析结果。SLS 保存 region／project／logstores，targets 可列多组；`*` 允许该 Project 的日志库，调用仍必须指定具体名字。同 region／project 可有不同日志库授权，不存在自定义 target 名字。

调查只访问本环境，开发显式选择 prod/test。配置目标决定可用性，凭证不创建目标。原生查询契约集中在 [Agent](AGENT.md#原生证据查询)，真实查询记录不代表所有配置目标均已测试。

### DBHub

DBHub 为部署所属 stdio MCP，支持页面中的 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle，Oracle database 为服务名。配置位于 deployment.config.dbhub，MySQL 使用 type=mysql，旧 mysql 字段拒绝。固定依赖见锁文件。

生成连接不能经通用 MCP API 任意改删。DSN 只经 DBHUB_DSN 环境传递，不进 argv；[dbhub.toml](../scripts/dbhub.toml) 限制只读、行数和超时，远端账号仍须实际只读。可选驱动安装脚本被阻止不等于这些数据库都已可用。

## 服务 MCP 与钉钉

服务 MCP 支持 HTTPS Streamable HTTP、SSE、stdio。Agent 只获得允许环境中入口／包含服务的部署所属连接；无 deployment_id 的全局连接、默认钉钉和个人导入偏好连接都不注入 Agent。全局连接管理／私有读取／测试仅 admin；测试需发现和关闭都成功才算通过。

钉钉来源偏好只含源与字段映射，不保存网关密钥。导入走所选全局 MCP，读取 /notable/record 的 dentryUuid／sheetId／rowId，精确查 recordIds。字段缺失或重名报错，个人偏好逐项覆盖共享。

重复来源返回原工单；另外会精确匹配没有钉钉来源的手工同标题工单，当前不限定服务／环境，也未定义多个同名候选优先级，调用方须核对返回范围。不同来源已导入工单不因同名自动合并。

附件仅从允许 HTTPS 主机下载，不重定向、不转发 MCP 密钥。导入、工单与附件协调提交；下载暂存／响应流清理失败不能降格成普通取消。HTTP 和页面启动默认不同，见[导入接口](HTTP.md#钉钉导入)，回归：[dingtalk.test.ts](../tests/http/dingtalk.test.ts)、[dingtalk-attachments.test.ts](../tests/http/dingtalk-attachments.test.ts)。

## Agent 基座与资源

资源来自运行用户 getAgentDir()，默认 ~/.pi/agent；PI_CODING_AGENT_DIR 只改变 SDK 资源目录，不改变业务 state。只读资源检查不执行扩展，工单本地扩展不加载，Operator 扩展不能覆盖应用工具。

Pi settings 为基线，SQLite runtime.settings 只覆盖契约允许项，省略恢复基线。runtime.networkAllowedDomains 是全局追加项，个人模型组不维护独立 runtime。详细生命周期见 [Agent](AGENT.md)。

## 入站工单 MCP

`/mcp` 为无状态 Streamable HTTP POST，复用 HTTP 身份，GET／DELETE 为 405。从配置端点复制客户端配置，先 users_list／services_list 核对范围。结构示例见 [mcp.json](../examples/mcp.json)。

| 工具 | 用途 |
| --- | --- |
| issues_search／issue_get | 筛选和读取工单 |
| issue_create／issue_message | 保存工单或受理消息，异步执行 |
| issue_conversation | 分页读取对话 |
| dingtalk_import | 默认 p2、不启动、指派当前调用者 |
| attachment_read | 校验原件，文本分页或下载元数据 |
| work_files／work_file_read | 普通工作文件，管理文件只列名 |

Base64 不带 data 前缀，默认最多 20 件，单件及解码后合计不超过 20 MiB；整个 JSON 请求限 32 MiB，解析前超限为 HTTP 413 payload_too_large。工具预检超限为 isError=true 的 mcp_attachments_too_large／mcp_attachment_too_large，不创建工单。这些不是进程总内存或 HTTP 流式上传上限。

列表和对话 offset 从 0 起，默认 limit=30、最多 100，返回 total／offset／items／nextOffset，null 到末尾，不是跨修改稳定游标。文本默认每页 200 行、最多 1000 行，整文件读取预算默认 64 MiB、每页响应 1 MiB；超预算返回 inline=false 和下载路径。完整定义以 [server.ts](../src/mcp/server.ts) 为准。

issues_search 对 HTTP 摘要排序后筛选编号／标题、服务、环境和状态，不全文搜索描述。成功 JSON 位于 content[].text；HTTP 200 内也可能是 isError=true，不能只看状态。结果不明先读已有工单／会话，不拆包反复创建或自动重发。
