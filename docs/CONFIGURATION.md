# 配置说明

本文定义当前根配置、SQLite业务配置、Service/Deployment、Pi model、七种capability和credential数据流。状态生命周期见[架构说明](ARCHITECTURE.md)，运行环境见[部署说明](DEPLOYMENT.md)。

## 配置来源

| 配置 | 事实源 |
| --- | --- |
| Path、port、default、retention、timeout、budget | `issue-pilot.config.ts` |
| Image、resource、mount和probe | `deploy/issue-pilot.yaml` |
| User、Service、Repository、Deployment、branch、完整credential | SQLite |
| Pi/npm/Maven/SSH原生配置 | Operator维护的`/etc/issue-pilot`只读目录 |
| Agent session选择 | 每轮从实际Repository access和Deployment生成 |

应用不接受环境变量覆盖。Node和Web直接导入根配置。环境变量只用于标准进程环境，例如`HOME`，不是Issue Pilot配置override。

普通工作台读取`GET /api/catalog`，只含Environment和Service可用范围。配置页按需读取`GET /api/config`，包含Repository、model、capability scope、`credentialConfigured`以及已存password和AccessKey。该接口只能在受信应用网络内访问，响应不得进入访问日志、监控或诊断附件。两种读取均经scope queue进入SQLite snapshot transaction。

Service保存时，每个selected capability显式提交：

- `preserve`：保留同Service/Environment现有credential。
- `replace`：提交完整新credential。
- `clear`：只允许optional credential。

API在内存中合并一次，由Registry解析为typed config，reservation受影响Issue并关闭内存session，最后在SQLite transaction提交。Config GET会把旧secret返回受信配置页，因此编辑表单可直接回填；`preserve`仍供未携带secret的调用者使用。

## 根配置

### State和区域

| Field | 当前值 | 作用 |
| --- | --- | --- |
| `state.directory` | `.issue-pilot` | 相对project root的state root |
| `state.databaseFile` | `issues.db` | 相对state root的SQLite文件 |
| `state.sqliteBusyTimeoutMs` | `5000` | libSQL busy timeout |
| `regional.locale` | `zh-CN` | Web locale |
| `regional.timeZone` | `Asia/Shanghai` | Issue key日期和Agent时间上下文 |
| `bootstrapUser` | 根配置中的subject/name/email | 仅`subjects`为空时插入一次 |

已有User不会被bootstrap配置覆盖。未传subject header时API选择最早创建的active user；显式header只能选择active subject。该header不是认证。

### HTTP和Web

| Field | 当前值 |
| --- | ---: |
| `http.host/port` | `0.0.0.0` / `3000` |
| `http.logger` | `true` |
| `http.sseHeartbeatMs` | `15000` |
| `web.host/port` | `0.0.0.0` / `4173` |
| `web.agentStreamReconnectMs` | `1000` |
| `web.agentStreamStaleMs` | `45000` |
| `web.agentToolOutputCharacters` | `40000` |
| `web.markdownCacheEntries` | `512` |
| `web.markdownCacheCharacters` | `4194304` |

`http.host`是application Pod的API listen地址。ClusterIP Service和Vite同样监听all interfaces，只能通过可信Ingress或开发网络访问。Vite API proxy固定连接本机`127.0.0.1:3000`。

### Workspace

| Field | 当前值 |
| --- | ---: |
| `retentionMs` | `604800000`，7天 |
| `highWaterBytes` | `21474836480`，20GiB |
| `targetBytes` | `17179869184`，16GiB |
| `maintenanceIntervalMs` | `900000`，15分钟 |
| `taskConcurrency` | `4` |

Non-zero target必须小于high-water；concurrency必须是正整数。Interval为0只禁用timer，启动仍执行一次maintenance。

### Defaults

| Field | 当前值 |
| --- | --- |
| `environments` | `prod=正式`, `test=测试`, `dev=开发` |
| `deployment.baseBranch` | `main` |
| `dms.sseUrl` | `https://dms-mcpr-qcuenv-ralojeaice.cn-hangzhou.fcapp.run/sse`（新Deployment表单默认值，可编辑） |
| `nacos.group` | `DEFAULT_GROUP` |
| `redis` | port`6379`, database`0`, scanResults`50` |
| `rabbitmq` | AMQP`5672`, management`15672`, vhost`/` |

Environment name在启动时同步。其他default用于新配置；保存后SQLite是事实源。

### Runtime

| Field | 当前值 |
| --- | --- |
| `agent.modelResponseIdleMs` | `300000` |
| `sourceBrowser.gitExecutable/searchExecutable` | `git` / `rg` |
| `projectTools.node` | `.npmrc`, `.npm` relative to HOME |
| `projectTools.maven` | `.m2/settings.xml`, `.m2/repository` |
| `projectTools.executionMs` | `1800000` |
| `redisWorker` | old`96MiB`, young`16MiB` |

Image、UID、memory、termination grace和probe属于Kubernetes deployment，不在应用配置中重复。`ProcessToolRuntime`执行当前image PATH中的`npm`、`mvn`和`aliyun sls`；调用不选择image或container。DMS通过application内的MCP client访问Deployment配置的HTTPS endpoint。Playwright harness参数由`scripts/playwright.sh`拥有，不进入Service、Deployment或Agent。

### Limits

| Boundary | 当前值 |
| --- | ---: |
| Agent message | 50,000 chars |
| Attachment file/request/count | 20MiB / 40MiB / 20 |
| Multipart field | 100,000 bytes |
| Process output | 5MiB |
| Git operation/output | 120s / 2MiB |
| Disk usage | 120s |
| Capability result | 1MiB（DMS MCP除外） |
| Capability default/connection timeout | 15s / 10s |
| Source file/tree | 2MiB / 500 entries |
| Source query/matches | 200 chars / 200 |
| Source history/changes | 100 commits / 500 files |
| Source command/output | 5s / 2MiB |
| Project action | 30 minutes |

## User

SQLite `subjects`字段：

| Field | Rule |
| --- | --- |
| `subject` | 创建后不可变；1..255；字母数字、`.`、`_`、`@`、`+`、`-` |
| `name` | Required，最多100 chars |
| `email` | Required，最多254 chars，转小写 |
| `active` | Active user可被选择、创建/编辑Issue和作为assignee/CC |

停用不删除row和历史关系。Transaction拒绝停用最后一名active user。`/api/users`只返回active users；`/api/users/manage`返回全部。

## Environment和Issue type

| Environment | Issue types | Repository mode |
| --- | --- | --- |
| `prod` | `data_processing`, `smart_analysis` | Read-only current Deployment commit |
| `test` | `smart_analysis` | Read-only current Deployment commit |
| `dev` | `defect_fix`, `feature_development` | Issue-local writable branch/worktree |

Web过滤选项，API再次验证。Prod/test不能通过直接API调用获得write access。

## Service和Repository

Service：

- `name` required，最多200 chars。
- `description` optional。
- `key`创建时从name生成并保证唯一，后续rename不改变。
- 至少一个Repository。
- 每Environment最多一个Deployment。

被Issue引用的Service不能删除。编辑时reservation全部关联Issue；running/reserved Issue或session close失败会阻止提交。

Repository：

- `alias`在Service内唯一，最多100 chars。
- `url`在Service内唯一。
- Create不接受client-supplied ID；edit ID必须属于当前Service。
- 每个Deployment必须恰好覆盖Service当前全部Repository。

Alias用于配置和显示；Issue `workspace_name`从URL basename/hash稳定分配，不随alias rename移动。Existing dev保留历史base branch和workspace name；新增Repository使用当前Deployment branch；待删除dev worktree必须clean。Released dev保持历史集合直到reopen，不在后台自动补齐。

## Deployment

一个Deployment包含：

```text
Environment
Repository branches (one per current Service Repository)
Selected capability sections
```

创建Issue前scope必须存在Deployment。每个`repositoryBranches[]`使用current Repository alias和non-empty base branch。Prod/test每轮读取当前branch；dev首次加入Repository时把branch写入Issue历史。配置页的每个Deployment可独立折叠；折叠只隐藏编辑控件，不清除或提交表单状态。

### 全局Pi model

SQLite `global_agent_configuration`保存唯一全局模型，所有Service和Environment共享，不允许Deployment覆盖。顶级“配置”页使用“用户 / 模型 / 服务”三个独立Tab，默认进入“服务”；三个面板保持挂载，切换时不丢失draft或弹窗状态。“模型”入口编辑required provider、model、thinkingLevel。修改时按`scope queue -> all Issue reservations`获取锁，关闭已有空闲session后提交；任一Issue正在运行时整次拒绝。Thinking level：

```text
off, minimal, low, medium, high, xhigh, max
```

API用共享Pi `ModelRuntime`离线刷新当前配置并验证model可用性和level。Agent启动和SSE snapshot均读取这一全局行。Issue Pilot不通过环境变量或远程catalog补model。Migration `0038`只接受旧Deployment中唯一一致的agent值，将其提升为全局行并从所有Deployment JSON删除；多个不同旧值会因singleton约束失败，不静默选择。

`models.json`从Operator只读配置读取。`auth.json`和`models-store.json`复制到process-private `0700`临时目录，文件`0600`，供Pi storage实现加锁/更新；runtime close后删除。Operator修改auth/store后需重启application，明确替换当前process snapshot。

## Built-in Pi tools

| 实际Repository access | Tools |
| --- | --- |
| 至少一个且全部write | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| 其他 | `read`, `grep`, `find`, `ls` |

Writable runtime PATH提供：

```text
node-project <project> install|test|build|typecheck
maven-project <project> test|verify|package
```

Node仅支持npm。Server/watch action不可用；wrapper和broker验证project path。

## Capability共同合同

固定key/order：

```text
nacos, db, redis, mq, es, dms, sls
```

Registry保存时解析external unknown并生成typed config。Pi tool使用Registry TypeBox schema解析一次input，然后直接调用protocol client。Client信任内部shape，但限制外部target、redirect、timeout、abort、response和result。超限整次失败，不静默截断。

### Nacos

Config：

- `serverUrl`为HTTP(S) root origin，无credential/query/fragment。
- `namespace`可空，最多255。
- `group`和去重后的1..50个`dataIds`只含字母数字、`.`、`_`、`-`，每项最多255。
- username/password同时为空或同时填写。

Tool input为空对象。调用读取全部exact Data ID；404返回`content:null`。Login response和总内容受budget限制。

### MySQL (`db`)

Config：`mysql://host:port/database`，显式port和单段database，无URL credential/query/fragment；username/password required。

Input：

```json
{ "statement": "SELECT ..." }
```

最多20,000 chars，单statement，无comment。允许`SELECT/SHOW/DESCRIBE/DESC/EXPLAIN`，拒绝write、lock、multi-statement、file/variable output、`EXPLAIN ANALYZE`和已知副作用函数。Client执行`START TRANSACTION READ ONLY`，stream最多500 rows/1MiB，最后rollback；abort销毁connection。DB账号仍须只读。

### Redis

Config：host，port 1..65535，optional username/password，database 0..1,000,000。

Actions：`get,mget,hget,hgetall,type,ttl,scan`。Key/field/pattern最多1024 chars，mget最多100 keys，结果最多500。node-redis在heap受限Worker中执行；arbitrary command不可用。

### RabbitMQ (`mq`)

Config：host，AMQP port，management port，required username/password，virtualHost。Actions：`overview,queues,queue,bindings`；后两者require queue。只访问Management HTTP API，不建立producer/consumer，不follow redirect。

### Elasticsearch (`es`)

Config：HTTP(S) URL，可含reverse-proxy path，无credential/query/fragment；username/password同时为空或填写。Actions：`search,count,mapping`。Search query为object，limit 1..200；不follow redirect。

### DMS

Config包含required HTTPS `url`、required `authorization` credential，以及作为一组出现的optional `instanceId/instanceHost/instancePort/instanceLabel/databaseId/databaseLabel`。Authorization格式必须是`Bearer <token>`。URL由每个Deployment显式配置，禁止内嵌credential、query或fragment，且不接受Agent或tool input覆盖。配置页只要求手工输入实例`alias`和数据库`schema`，不提供远程下拉。两项输入停止500ms后，受信`POST /api/dms/scope/resolve`在一个MCP session内先调用`listInstances(search_key=alias)`并要求InstanceAlias唯一精确匹配，再调用`getDatabase(host, port, schema_name)`，严格核对返回InstanceId和schema并取得DatabaseId；解析成功后才保存完整scope。旧CLI `accessKeyId/accessKeySecret/dbId/logic/tid`字段不再解析、迁移或回退；新的`instanceId/databaseId`只用于MCP scope。

DMS使用MCP 2024-11-05 HTTP+SSE transport：Authorization同时发送到初始SSE GET和同源message POST。Client拒绝非HTTPS target、跨源message endpoint和HTTP redirect；每次tool调用建立独立连接并在完成、失败或abort后关闭。

Tool input：

```text
{ script: "SELECT ...", logic?: boolean }
```

Agent只看到一个`dms`工具，不能列出、选择或命名远端MCP工具。Client每次调用只查找schema精确包含`database_id`和`script`的`executeScript`，其他远端工具即使标记read-only也不向Agent开放。Issue Pilot由持久化Deployment scope强制注入`database_id`，Agent不能提供或覆盖；未配置完整database scope时调用失败。`script`复用单条只读SQL校验，仅允许`SELECT/SHOW/DESCRIBE/EXPLAIN`，拒绝DDL/DML、comment、multi-statement、lock和已知副作用函数。连接与调用总时限30秒；DMS script和result不应用统一1MiB budget，MCP tool error整次失败。Bearer不进入context、prompt、tool schema/input、result、details、argv或日志。

### SLS

Config：required AccessKey，合法region/project，至少一个exact logstore。Agent session创建SLS工具时，将当前Issue所选Deployment的logstore白名单投影为`logstore`输入枚举；不得从Service key、Service name或其他Environment的配置推断名称。

Input：

```text
logstore
from/to          # optional but must appear together
query            # optional
trace_id         # UUID, mutually exclusive with query
```

普通query默认最近15分钟，trace默认24小时。Endpoint为`<region>.log.aliyuncs.com`。Client按100条自动分页直到查询结果耗尽，不设置record count上限；每页后检查统一1MiB结果预算，超限整次返回`capability_result_too_large`，不把partial result伪装为完整。

SLS每次创建临时HOME和`0600 ~/.aliyun/config.json`，由application进程中的Aliyun CLI读取，finally递归删除。SLS AccessKey不在argv；query、project、logstore和时间范围可能在process argv中。DMS Bearer只作为HTTPS Authorization header传给当前Deployment授权的MCP endpoint。

## Result和secret

| Capability | 主要budget |
| --- | --- |
| Nacos | 50 Data IDs / 1MiB |
| MySQL | 20k chars / 500 rows / 1MiB |
| Redis | 100 keys / 500 results / 1MiB |
| RabbitMQ | 1MiB response |
| Elasticsearch | 200 results / 1MiB |
| DMS MCP | 30s total / arguments和result无应用层byte limit |
| SLS | 自动分页 / 30s total / 1MiB |

Secret flow：

1. SQLite保存完整typed Deployment config，是唯一业务secret事实源。
2. Catalog不读取config JSON；Config GET返回完整Deployment配置和credential。
3. Web编辑表单回填Config GET中的secret，并通过`preserve|replace|clear`协议提交；当前页面通常发送`replace`。
4. API内存合并后只解析一次并transaction保存。
5. `AgentSessionContext`、prompt、schema和tool input不含credential。
6. `createCapabilityTools()` clone session-local config并只在tool closure传给client。
7. DMS Bearer只传给session-local MCP client；SLS credential写入临时profile；其他credential只传给in-process protocol client。
8. Tool result进入model context和Pi JSONL，可能包含敏感业务数据。

不得记录configuration write body、Config GET响应、Authorization/Cookie、credential、temporary profile、package config或完整敏感tool result。
