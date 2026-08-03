# 工单智研（Issue Pilot）

Issue Pilot 是基于 pi 的研发工单智能体。一个工单绑定一个持久 pi session，可关联多个 Git 仓库和指定基线分支，并把日志、数据库、代码、附件、诊断、测试与 code-server 工作区归档到同一上下文。

## 当前状态

已实现：

- pi 扩展：工单创建、查询、更新、评论、统计、SLS/DMS/MySQL 证据工具
- MCP stdio server：供 Codex、Claude 等 MCP 客户端调用同一组工单工具
- Agent Skills：分诊、Java、React、Solid 2、数据库、浏览器测试、code-server
- 工单编码按业务日期生成 `ISSUE-YYYYMMDD-NNNN`，每日独立递增；新建 Git 分支与工单编码完全一致
- 每工单持久 pi session；同一工单恢复原 JSONL 会话
- 同一项目多工单并发：共享 Git 缓存，每工单独立 worktree 和修复分支
- PostgreSQL Drizzle schema 与 migrations，共 17 张业务表
- Keycloak JWT/JWKS 保护的 Fastify API：组织配置、工单列表/详情/创建/编辑、环境与服务管理
- 工单支持优先级、类型、可选处理人、可选多抄送人，并在详情展示创建人和创建时间
- 工单创建后异步拉取服务仓库，为每个仓库创建隔离 worktree/issue 分支，建立持久 pi session，并按工单描述启动智能体处理
- 工单编辑支持更新当前环境下的多服务上下文；实际变更后续接原 pi session，重新读取最新描述和服务仓库并再次处理
- 页面 pi 对话提交后立即恢复输入；空闲时启动普通 prompt，运行中发送的新消息通过 `AgentSession.followUp()` 正常排入当前 Session，标题栏可调用 `session.abort()` 停止当前处理；长对话在桌面和移动端使用独立滚动区，实时输出仅在用户停留底部时自动跟随
- 自动工单处理的最终回答可持久化为工单评论；页面人工对话直接调用 pi session，不写 `issue_comments`，历史以 pi JSONL active branch 为唯一事实源；处理期间通过带 Keycloak Bearer 鉴权的 NDJSON 长连接实时显示回答 partial，可放大对话并暂时隐藏工单详情
- 全局 `nacos-cli 1.1.4` 已安装，可通过 profile 或 `config-get <dataId> <group>` 读取 Nacos 配置
- “智能分析”类型由 agent 先分类为缺陷修复、临时需求、数据处理、问题排查或技术咨询，再按分类处理并回写类型
- 独立“配置”视图：创建、编辑和删除组织环境，并维护服务的单一所属环境、仓库地址、默认分支、关联服务及项目描述
- 服务详情页：集中展示环境、仓库、关联服务，并安全渲染 Markdown 项目文档
- 已被历史工单引用的环境或服务禁止删除；内置“正式”和“测试”环境不可编辑、不可删除，API 返回 `409`
- 环境和服务列表均按创建时间从早到晚排列
- 环境和服务统一归属“咸亨国际”组织并持久化到 PostgreSQL，不提供个人级配置
- 新建工单支持批量附件：最多 10 个、单文件 20 MB，流式写入私有目录并在 PostgreSQL 记录 SHA-256、媒体类型、大小和扫描状态
- rootless Podman PostgreSQL、Keycloak 和按工单 code-server 脚本
- 生产证据：Aliyun CLI SLS + DMS；测试证据：Aliyun CLI SLS + Drizzle MySQL
- agent 结束、工单完成且前后端测试通过后，通过 `dws` 发送幂等钉钉通知
- Solid `2.0.0-beta.29` 工作台，使用已发布的 `@idoly/ant-design-solid@0.2.4`，clone 后不依赖宿主机相邻目录
- 工单统计：处理周期平均值/中位数/P95，个人、项目、类型、状态和优先级分组

尚未接生产：

- 当前 API 是本机开发部署；生产还需完善管理员 RBAC、组织切换、TLS、审计导出与限流
- Podman code-server 样例使用本地密码；生产必须放在校验工单处理人的 Keycloak 网关后
- 附件当前使用本机私有目录且扫描状态为待处理；生产仍需接对象存储、病毒扫描与截图解析
- SLS、DMS、MySQL 和钉钉均未配置组织凭据或真实目标

## Clone 与验证

```bash
git clone https://github.com/idoly/issue-pilot.git
cd issue-pilot
./infra/verify-clone.sh
```

该脚本在干净 clone 中安装锁定依赖并执行 root/frontend 的 typecheck、测试和生产构建。源码环境与包含凭据的运行时恢复必须分开处理，详见 [Clone and restore](docs/CLONE_AND_RESTORE.md)。

## Demo

```bash
cd apps/web
npm ci --legacy-peer-deps
npm run dev -- --host 0.0.0.0
```

当前地址：<http://localhost:4173/>。默认连接 Keycloak 和真实 PostgreSQL API；测试/纯 UI 模式使用：

```bash
VITE_AUTH_DISABLED=true VITE_USE_FIXTURES=true npm run dev
```

## 验证

```bash
npm test
npm run typecheck
cd apps/web
npm test
npm run typecheck
npm run build
```

## Podman

不会安装 WSL 系统服务。PostgreSQL 数据放在项目 `.issue-agent/podman/postgres`。

```bash
cp infra/.env.example infra/.env
chmod 600 infra/.env
./infra/podman-stack.sh start
./infra/podman-stack.sh status
```

停止并删除本项目开发容器：

```bash
./infra/podman-stack.sh stop
```

执行 Drizzle migration：

```bash
export DATABASE_URL='postgres://issue_agent:<password>@127.0.0.1:5432/issue_agent'
npm run db:migrate
```

## 部署与灾难恢复

完整部署、数据库/Keycloak 快照、新服务器迁移和恢复验收见 [部署与灾难恢复手册](docs/DEPLOYMENT_AND_RECOVERY.md)。

历史 `recovery/current/` 已存在于仓库历史，包含业务数据库、Keycloak 数据、pi Sessions、runtime secrets 和 Pi provider 配置，仓库读取权限必须按生产 Secret 权限管理。源码提交不会刷新这份历史快照；当前实时状态只能通过手册中的 GPG 加密备份流程经受控渠道迁移，禁止把新快照直接提交到 GitHub。

按工单启动 code-server：

```bash
printf '%s' '<strong-password>' > /tmp/issue-code-password
chmod 600 /tmp/issue-code-password
./infra/workspace-podman.sh create ISSUE-0042 .issue-agent/workspaces/issue-0042 8443 /tmp/issue-code-password
```

生产环境不要直接暴露该端口。网关必须验证 Keycloak subject 与工单 `assigneeSubject` 一致。

## Keycloak 与 API

- Keycloak：<http://127.0.0.1:8081>
- Realm：`issue-agent`
- Organization：`咸亨国际`
- OIDC client：`issue-agent-web`（Authorization Code + PKCE）
- 登录用户：严欣 / `694590014@qq.com`
- 临时密码与本地管理凭据只保存在被 `.gitignore` 排除的 `.issue-agent/secrets/runtime.json`，不得写入文档、日志或提交

启动 API：

```bash
DATABASE_URL='postgres://issue_agent:<password>@127.0.0.1:5432/issue_agent' \
KEYCLOAK_ORGANIZATION_ID='<organization-id>' \
KEYCLOAK_ISSUER='http://127.0.0.1:8081/realms/issue-agent' \
npm run server
```

## pi 扩展

```bash
pi --no-extensions -e ./src/extension.ts -a
```

数据默认写入 `.issue-agent/issues.json`。可配置：

```bash
export ISSUE_AGENT_DATA_FILE=.issue-agent/issues.json
export ISSUE_AGENT_CONNECTORS_FILE=$PWD/config/connectors.json
export ISSUE_AGENT_ISSUE_ID=ISSUE-0042
```

## MCP

启动：

```bash
npm run mcp
```

Codex `~/.codex/config.toml` 示例：

```toml
[mcp_servers.issue-agent]
command = "node"
args = ["--experimental-strip-types", "/home/idoly/issue-agent/src/mcp-server.ts"]
cwd = "/home/idoly/issue-agent"

[mcp_servers.issue-agent.env]
ISSUE_AGENT_DATA_FILE = ".issue-agent/issues.json"
ISSUE_AGENT_CONNECTORS_FILE = "/home/idoly/issue-agent/config/connectors.json"
```

Claude Code 示例：

```bash
claude mcp add issue-agent -- \
  node --experimental-strip-types /home/idoly/issue-agent/src/mcp-server.ts
```

MCP 当前使用已测试的本地 Store。生产 HTTP 服务应将相同领域接口切换到 Drizzle Repository。

## 云证据

项目内 Aliyun CLI：`.tools/bin/aliyun`，当前 SLS 插件通过 `aliyun plugin install --names sls` 安装。复制并修改配置：

```bash
cp config/connectors.example.json config/connectors.json
```

环境路由：

- `production`: Aliyun SLS + `dms-enterprise ExecuteScript`
- `test`: Aliyun SLS + 本地 MySQL（Drizzle MySQL，连接串来自环境变量）

```bash
export ISSUE_AGENT_TEST_MYSQL_URL='mysql://readonly:<password>@127.0.0.1:3306/app_test'
```

只使用只读云 profile 和只读 MySQL 账号。模型只能选择配置中的 query key 和参数，不能提交任意 SQL、数据库 ID、project、logstore、endpoint 或 AccessKey。

## 钉钉通知

已安装 `dws v1.0.55`，但需要登录：

```bash
dws auth login
```

群通知：

```bash
export DINGTALK_NOTIFY_GROUP='<openConversationId>'
export ISSUE_AGENT_BASE_URL='https://issues.example.com/issues'
```

处理人单聊：

```bash
export DINGTALK_NOTIFY_OPEN_ID='<openDingTalkId>'
```

两者只能配置一个。测试配置可加 `DINGTALK_DRY_RUN=1`。通知使用 `dws chat message send --uuid ...`，同一工单完成版本在 24 小时内幂等。

## 数据与并发边界

- `issue_agent_sessions.issue_id` 是主键：每工单一个 session
- session run 按工单串行；不同工单可并行
- Git fetch/worktree 元数据按仓库串行；代码分析和测试按工单并行
- 工单 `updatedAt` 单调递增，支持乐观并发控制
- 生产数据库使用 session lease 字段避免多实例同时驱动同一工单
- 原始日志、数据库结果、token 和凭据不进入钉钉通知或普通评论
