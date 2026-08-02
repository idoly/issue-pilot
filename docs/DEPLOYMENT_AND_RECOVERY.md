# Issue Pilot 部署与灾难恢复手册

本文用于在服务器损坏、WSL 重装或迁移主机后，还原“工单智研（Issue Pilot）”的当前运行环境和业务状态。

> 恢复成功的定义不是“页面能打开”，而是业务数据库、Keycloak、pi Session、附件、服务/仓库配置、认证关系和代码工作区均可继续使用。

> **敏感仓库警告：** 根据仓库所有者要求，私有 Git 仓库中的 `recovery/current/` 包含可直接恢复的数据库、Keycloak 数据、runtime secrets、容器环境变量和 Pi provider 凭据。任何仓库读取权限都等价于生产凭据读取权限。SSH 私钥仍需在仓库外单独配置，因为它是克隆私有仓库的前置凭据。

## 1. 恢复原则

1. PostgreSQL 逻辑备份是业务数据和 Keycloak 数据的权威备份。
2. pi Session JSONL 是页面人工对话历史的唯一事实源，不由 `issue_comments` 替代。
3. `.issue-agent` 中除 PostgreSQL 物理目录外的内容必须备份。
4. 当前私有仓库有意保存明文恢复快照；仓库权限必须按生产 Secret 权限管理。
5. 优先在新服务器保持相同 Unix 用户名和绝对项目路径。
6. 不复制运行中的 PostgreSQL 物理数据目录；使用 `pg_dump`/`pg_restore`。
7. 恢复后必须执行本文的数据库、Keycloak、Session 和页面验收。

## 2. 当前基线

### 2.1 主机与工具

| 项目 | 当前值 |
|---|---|
| OS | Fedora Linux 44 on WSL2 |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` |
| Node.js | `v24.18.0` |
| npm | `12.0.1` |
| Podman | `5.8.4`，rootless |
| Git | `2.55.0` |
| Pi Coding Agent | `0.83.0` |
| Nacos CLI | `1.1.4` |
| PostgreSQL image | `postgres:17.5-alpine` |
| Keycloak image | `quay.io/keycloak/keycloak:26.3.1` |
| code-server image | `ghcr.io/coder/code-server:4.99.4` |

恢复时应优先使用这些版本。升级应在恢复成功后单独进行，不要把“迁移服务器”和“升级依赖”合并成一次操作。

### 2.2 源码

| 项目 | 值 |
|---|---|
| Issue Pilot remote | `git@github.com:idoly/issue-pilot.git` |
| 主分支 | `main` |
| 本文生成前基线提交 | `56f898d15256d6d9776039776b240f81e479c7cd` |
| Ant Design Solid remote | `git@github-antd-design-solid:idoly/antd-design-solid.git` |
| Ant Design Solid commit | `d9ed10e01dcc13dcb4522d46ea502f0f95cdf466` |
| Ant Design Solid package version | `0.2.4` |

实际恢复必须优先使用备份 manifest 中的 commit，而不是盲目使用上表中的历史基线。

前端依赖是本地文件依赖：

```text
/home/idoly/issue-agent/apps/web
  -> file:../../../antd-design-solid
  -> /home/idoly/antd-design-solid
```

因此默认恢复路径为：

```text
/home/idoly/issue-agent
/home/idoly/antd-design-solid
```

### 2.3 端口

| 服务 | 地址 |
|---|---|
| PostgreSQL | `127.0.0.1:5432` |
| Keycloak | `http://127.0.0.1:8081` |
| Issue Pilot API | `http://127.0.0.1:3000` |
| Issue Pilot Web | `http://127.0.0.1:4173` |
| code-server sample | `http://127.0.0.1:8443` |

所有基础服务默认只绑定 loopback。不要直接将 Keycloak `start-dev`、PostgreSQL、API 或 code-server 暴露到公网。

### 2.4 当前容器方式

当前实际运行方式是：

```bash
./infra/podman-stack.sh start
```

其 PostgreSQL 数据目录是：

```text
/home/idoly/issue-agent/.issue-agent/podman/postgres
```

仓库中的 `infra/compose.yaml` 和 Quadlet 文件是可选替代方案。恢复时不要混用 bind-mounted 数据目录、compose named volume 和 Quadlet volume。

### 2.5 Keycloak 基线

| 配置 | 当前值 |
|---|---|
| Realm | `issue-agent` |
| Realm enabled | `true` |
| Organizations enabled | `true` |
| Organization | `咸亨国际` |
| Organization ID | `87a2af8a-e22d-4b39-89f3-d8af97651b58` |
| Client | `issue-agent-web` |
| Client UUID | `ab42c5db-74ed-4d6f-aaa3-35799312bd46` |
| Client type | public client |
| Standard flow | enabled |
| Direct access grants | disabled |
| Browser flow | Authorization Code + PKCE |
| Business users | 1 |

当前 redirect URIs：

```text
http://127.0.0.1:4173/*
http://localhost:4173/*
http://192.168.1.21:4173/*
```

当前 Web Origins：

```text
http://127.0.0.1:4173
http://localhost:4173
http://192.168.1.21:4173
```

服务器地址变化后，应替换旧 LAN 地址，但保留 loopback 地址用于本机验收。

## 3. 状态与凭据清单

### 3.1 必须备份

| 内容 | 位置/来源 | 用途 |
|---|---|---|
| Issue Pilot 数据库 | PostgreSQL database `issue_agent` | 工单、服务、环境、Session 绑定、附件元数据 |
| Keycloak 数据库 | PostgreSQL database `keycloak` | Realm、用户、密码哈希、Organization、OIDC client |
| pi Sessions | `.issue-agent/sessions/` | 页面人工对话与 Agent 上下文 |
| 附件 | `.issue-agent/attachments/` | 私有工单附件 |
| Git 缓存/仓库 | `.issue-agent/repositories/` | 加快恢复，可重新克隆但建议保留 |
| Issue workspaces | `.issue-agent/workspaces/` | 未提交的 Agent 工作成果与 issue branch |
| Runtime 凭据 | `.issue-agent/secrets/runtime.json` | PostgreSQL、Keycloak、code-server 本地运行信息 |
| code-server password | `.issue-agent/secrets/code-server-password` | workspace 登录 |
| Podman env | `infra/.env` | PostgreSQL/Keycloak 容器凭据和端口 |
| Pi auth | `~/.pi/agent/auth.json` | 模型认证，文件模式必须为 `600` |
| Pi model config | `~/.pi/agent/models.json` | 自定义 provider/model |
| Pi settings | `~/.pi/agent/settings.json` | Pi 运行设置 |
| 源码 | Git bundle 或已推送 remote | Issue Pilot 和 Ant Design Solid |

`.issue-agent/podman/postgres` 不进入状态 tar 包，它由数据库逻辑备份代替。

### 3.2 Runtime JSON 结构

`runtime.json` 必须包含以下字段，文档不保存实际值：

```json
{
  "postgres": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "issue_agent",
    "username": "issue_agent",
    "password": "<secret>"
  },
  "keycloak": {
    "url": "http://127.0.0.1:8081",
    "username": "<admin-user>",
    "password": "<secret>",
    "realm": "issue-agent",
    "organization": "咸亨国际",
    "user": {
      "name": "<name>",
      "email": "<email>",
      "password": "<secret>"
    }
  },
  "codeServer": {
    "url": "http://127.0.0.1:8443",
    "passwordFile": ".issue-agent/secrets/code-server-password"
  }
}
```

文件权限：

```bash
chmod 600 infra/.env
chmod 600 .issue-agent/secrets/runtime.json
chmod 600 .issue-agent/secrets/code-server-password
chmod 600 ~/.pi/agent/auth.json
```

## 4. 仓库内当前恢复快照

私有仓库直接跟踪以下目录：

```text
recovery/current/
├── README.md
├── manifest.txt
├── keycloak-baseline.json
├── issue_agent.dump
├── keycloak.dump
├── issue-agent-state.tar.gz
├── pi-agent-config.tar.gz
├── infra.env
└── SHA256SUMS
```

这份快照是新服务器恢复当前环境的首选来源：

- `issue_agent.dump`：完整业务数据库和 Drizzle 迁移记录。
- `keycloak.dump`：完整 Keycloak realm、用户、密码哈希、Organization、成员关系和 client。
- `issue-agent-state.tar.gz`：Session、附件、workspaces、repositories 和 runtime secrets。
- `pi-agent-config.tar.gz`：Pi auth、models 和 settings。
- `infra.env`：容器、数据库、Keycloak 和 code-server 当前环境值。

检查完整性：

```bash
cd recovery/current
sha256sum -c SHA256SUMS
podman exec -i issue-agent-postgres pg_restore -l < keycloak.dump \
  | grep -Ei 'TABLE DATA.*(realm|user_entity|client|organization)'
podman exec -i issue-agent-postgres pg_restore -l < issue_agent.dump \
  | grep 'TABLE DATA'
```

更新快照时必须先建立一致性窗口，再同时替换两个 dump 和状态包；禁止只更新业务库而不更新 Keycloak。

## 5. 生成新的外部完整备份

### 5.1 备份前检查

```bash
export PROJECT_ROOT=/home/idoly/issue-agent
cd "$PROJECT_ROOT"

git status --short
git rev-parse HEAD
git -C /home/idoly/antd-design-solid status --short
git -C /home/idoly/antd-design-solid rev-parse HEAD

./infra/podman-stack.sh status
curl -fsS http://127.0.0.1:3000/health
```

工作区有未提交源码时，先提交或确保 Git bundle 包含对应 commit。Issue worktree 中的未提交改动由 `.issue-agent/workspaces` 备份保留。

检查是否有 Agent 正在运行：

```bash
podman exec issue-agent-postgres \
  psql -U issue_agent -d issue_agent -c \
  "select i.key, w.status from issues i join issue_workspaces w on w.issue_id=i.id where w.status in ('preparing','running');"
```

结果必须为空。

### 5.2 建立一致性窗口

1. 停止 API，避免新增工单、评论、附件和 Session 写入。
2. 停止所有 code-server workspace，避免工作区文件变化。
3. 停止 Keycloak，避免认证数据库变化。
4. PostgreSQL 保持运行，用于逻辑备份。

若使用手工进程，先找到 PID 再终止，不要使用宽泛的 `pkill -f node`：

```bash
pgrep -af 'src/server.ts|vite.*4173'
podman ps --filter 'name=issue-agent-workspace'
podman stop issue-agent-keycloak
```

### 5.3 生成加密备份包

以下流程会把两个数据库、Keycloak 全部状态、pi Session、附件、workspace、凭据和源码 bundle 放入一个 GPG 对称加密包。

```bash
set -eu
umask 077

export PROJECT_ROOT=/home/idoly/issue-agent
export ANTD_ROOT=/home/idoly/antd-design-solid
export BACKUP_DIR=/path/to/offline-backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
mkdir -p "$BACKUP_DIR"

# 1. 源码，即使远端不可用也能恢复。
git -C "$PROJECT_ROOT" bundle create "$WORK/issue-pilot.bundle" --all
git -C "$ANTD_ROOT" bundle create "$WORK/antd-design-solid.bundle" --all

# 2. 业务数据库和完整 Keycloak 数据库。
podman exec issue-agent-postgres \
  pg_dump -U issue_agent -d issue_agent -Fc --no-owner --no-acl \
  > "$WORK/issue_agent.dump"

podman exec issue-agent-postgres \
  pg_dump -U issue_agent -d keycloak -Fc --no-owner --no-acl \
  > "$WORK/keycloak.dump"

# 3. 项目状态；排除 PostgreSQL 物理文件。
tar --exclude='.issue-agent/podman/postgres' \
  -C "$PROJECT_ROOT" -czf "$WORK/issue-agent-state.tar.gz" \
  .issue-agent

# 4. 容器与运行配置。
install -m 600 "$PROJECT_ROOT/infra/.env" "$WORK/infra.env"

# 5. Pi provider/auth/settings。
tar -C "$HOME" -czf "$WORK/pi-agent-config.tar.gz" \
  .pi/agent/auth.json \
  .pi/agent/models.json \
  .pi/agent/settings.json

# 6. 不含 secret 值的恢复 manifest。
{
  printf 'created_at=%s\n' "$STAMP"
  printf 'project_root=%s\n' "$PROJECT_ROOT"
  printf 'issue_pilot_commit=%s\n' "$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
  printf 'antd_commit=%s\n' "$(git -C "$ANTD_ROOT" rev-parse HEAD)"
  printf 'node=%s\n' "$(node --version)"
  printf 'npm=%s\n' "$(npm --version)"
  printf 'podman=%s\n' "$(podman --version)"
  printf 'pi=%s\n' "$(pi --version)"
  podman images --format 'image={{.Repository}}:{{.Tag}} digest={{.Digest}}' \
    | grep -E 'postgres|keycloak|code-server'
} > "$WORK/manifest.txt"

podman exec issue-agent-postgres psql -U issue_agent -d issue_agent -Atc \
  "select 'issues='||count(*) from issues;
   select 'services='||count(*) from services;
   select 'environments='||count(*) from environments;
   select 'sessions='||count(*) from issue_agent_sessions;
   select 'comments='||count(*) from issue_comments;
   select 'attachments='||count(*) from issue_attachments;
   select 'migrations='||count(*) from drizzle.__drizzle_migrations;" \
  > "$WORK/issue-agent-counts.txt"

podman exec issue-agent-postgres psql -U issue_agent -d keycloak -Atc \
  "select 'realms='||count(*) from realm where name='issue-agent';
   select 'users='||count(*) from user_entity u join realm r on r.id=u.realm_id where r.name='issue-agent';" \
  > "$WORK/keycloak-counts.txt"

(cd "$WORK" && sha256sum * > SHA256SUMS)

# 7. 交互输入独立备份口令。不要把口令放到 shell history。
tar -C "$WORK" -czf - . \
  | gpg --symmetric --cipher-algo AES256 \
      --output "$BACKUP_DIR/issue-pilot-$STAMP.tar.gz.gpg"

sha256sum "$BACKUP_DIR/issue-pilot-$STAMP.tar.gz.gpg" \
  > "$BACKUP_DIR/issue-pilot-$STAMP.tar.gz.gpg.sha256"

rm -rf "$WORK"
printf 'Backup created: %s\n' "$BACKUP_DIR/issue-pilot-$STAMP.tar.gz.gpg"
```

备份包含凭据、用户认证数据、附件和源代码，必须放在离线或受访问控制的存储中。GPG 口令不得与应用密码相同。

### 5.4 备份验收

```bash
sha256sum -c issue-pilot-<STAMP>.tar.gz.gpg.sha256

gpg --decrypt issue-pilot-<STAMP>.tar.gz.gpg \
  | tar -tzf - \
  | grep -E 'issue_agent.dump|keycloak.dump|issue-agent-state|pi-agent-config|manifest|SHA256SUMS'
```

两个数据库 dump 缺一不可。只备份 `issue_agent` 而没有 `keycloak.dump`，不能还原当前认证环境。

完成备份后重新启动 Keycloak、API、Web 和需要的 code-server。

## 6. 新服务器恢复

### 6.1 首选：从私有仓库恢复

新服务器必须先在仓库外配置 GitHub SSH key。当前网络环境可使用 GitHub SSH 443：

```bash
mkdir -p /home/idoly

git clone ssh://git@ssh.github.com:443/idoly/issue-pilot.git \
  /home/idoly/issue-agent

git clone ssh://git@ssh.github.com:443/idoly/antd-design-solid.git \
  /home/idoly/antd-design-solid

cd /home/idoly/issue-agent
export RESTORE=/home/idoly/issue-agent/recovery/current
chmod 700 "$RESTORE"
chmod 600 "$RESTORE"/*
(cd "$RESTORE" && sha256sum -c SHA256SUMS)

git -C /home/idoly/antd-design-solid checkout \
  "$(sed -n 's/^antd_design_solid_commit=//p' "$RESTORE/manifest.txt")"
```

### 6.2 可选：从外部 GPG 备份恢复

仅在没有私有仓库快照时使用：

### 6.3 准备主机

要求：

- Linux 或 WSL2，支持 rootless Podman。
- 相同用户名 `idoly`，推荐相同 HOME `/home/idoly`。
- Node.js 24、npm 12、Podman 5、Git、GPG。
- Pi Coding Agent 0.83.0。
- 不进行全局 WSL 网络或权限改造。

私有仓库恢复时已经设置 `RESTORE`，跳到依赖安装。外部备份恢复时创建临时目录：

```bash
umask 077
RESTORE=$(mktemp -d)
gpg --decrypt /path/to/issue-pilot-<STAMP>.tar.gz.gpg \
  | tar -xzf - -C "$RESTORE"
(cd "$RESTORE" && sha256sum -c SHA256SUMS)
cat "$RESTORE/manifest.txt"
```

### 6.4 恢复源码和依赖

私有仓库恢复已经完成源码 clone，只需安装依赖：

```bash
cd /home/idoly/issue-agent
npm ci
(cd apps/web && npm ci)
```

外部备份中包含 Git bundle 时，可改用：

```bash
mkdir -p /home/idoly

git clone "$RESTORE/issue-pilot.bundle" /home/idoly/issue-agent
git -C /home/idoly/issue-agent checkout main

git clone "$RESTORE/antd-design-solid.bundle" /home/idoly/antd-design-solid
git -C /home/idoly/antd-design-solid checkout \
  "$(sed -n 's/^antd_commit=//p' "$RESTORE/manifest.txt")"

cd /home/idoly/issue-agent
npm ci
(cd apps/web && npm ci)
```

确认本地依赖解析正确：

```bash
node -e "console.log(require('./apps/web/node_modules/@idoly/ant-design-solid/package.json').version)"
```

### 6.5 恢复配置和 pi 凭据

```bash
cd /home/idoly/issue-agent
install -m 600 "$RESTORE/infra.env" infra/.env

tar -C /home/idoly -xzf "$RESTORE/pi-agent-config.tar.gz"
chmod 600 /home/idoly/.pi/agent/auth.json

# 恢复 Session、附件、workspace、repositories 和 runtime secrets。
tar -C /home/idoly/issue-agent -xzf "$RESTORE/issue-agent-state.tar.gz"
chmod 700 .issue-agent .issue-agent/secrets
chmod 600 .issue-agent/secrets/runtime.json
chmod 600 .issue-agent/secrets/code-server-password

# 确保不带入源服务器的 PostgreSQL 物理目录。
rm -rf .issue-agent/podman/postgres
```

私有仓库中的 `recovery/current` 是受版本控制的权威恢复快照。仅外部 GPG 恢复产生的临时解密目录不得提交到 Git，并应在验收后删除。

### 6.6 启动空 PostgreSQL/Keycloak

`infra/.env` 中至少保证：

```text
POSTGRES_PORT=5432
KEYCLOAK_PORT=8081
KEYCLOAK_ISSUER=http://127.0.0.1:8081/realms/issue-agent
```

以下两个 Keycloak 数据库密码字段必须一致：

```text
KEYCLOAK_DB_PASSWORD=<same-secret>
KC_DB_PASSWORD=<same-secret>
```

启动容器：

```bash
cd /home/idoly/issue-agent
./infra/podman-stack.sh start
podman stop issue-agent-keycloak
```

### 6.7 恢复业务数据库和 Keycloak 数据库

API、Web 写操作和 Keycloak 必须保持停止。

```bash
# 终止残留连接并重建空数据库。
podman exec issue-agent-postgres psql -U issue_agent -d postgres -v ON_ERROR_STOP=1 -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('issue_agent','keycloak') and pid <> pg_backend_pid();"

podman exec issue-agent-postgres dropdb -U issue_agent --if-exists issue_agent
podman exec issue-agent-postgres createdb -U issue_agent -O issue_agent issue_agent

podman exec issue-agent-postgres dropdb -U issue_agent --if-exists keycloak
podman exec issue-agent-postgres createdb -U issue_agent -O keycloak keycloak

# 恢复 Issue Pilot。
podman exec -i issue-agent-postgres \
  pg_restore -U issue_agent -d issue_agent --no-owner --no-acl --exit-on-error \
  < "$RESTORE/issue_agent.dump"

# 恢复完整 Keycloak 状态。以 keycloak role 恢复对象所有权。
podman exec -i issue-agent-postgres \
  pg_restore -U keycloak -d keycloak --no-owner --no-acl --exit-on-error \
  < "$RESTORE/keycloak.dump"
```

校验并补齐迁移记录：

```bash
DB=$(node -e 'const p=require("./.issue-agent/secrets/runtime.json").postgres; process.stdout.write(`postgres://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}`)')
DATABASE_URL="$DB" npm run db:migrate

podman exec issue-agent-postgres \
  psql -U issue_agent -d issue_agent -Atc \
  "select count(*) from drizzle.__drizzle_migrations;"
```

当前应至少为 `9`，并与备份的 `issue-agent-counts.txt` 一致。

### 6.8 启动并验证 Keycloak

```bash
podman start issue-agent-keycloak

until curl -fsS http://127.0.0.1:8081/realms/issue-agent/.well-known/openid-configuration >/dev/null; do
  sleep 2
done
```

使用 `.issue-agent/secrets/runtime.json` 中的管理账号登录 `kcadm.sh`，不要把密码写入命令历史或文档。

必须核对：

```text
Realm: issue-agent, enabled=true
Organizations enabled=true
Organization: 咸亨国际
Organization ID: 87a2af8a-e22d-4b39-89f3-d8af97651b58
Client: issue-agent-web
publicClient=true
standardFlowEnabled=true
directAccessGrantsEnabled=false
业务用户数量与 keycloak-counts.txt 一致
```

服务器地址变化时更新 client 的 redirect URIs 和 Web Origins。不要为了测试永久开启 Direct Access Grant。

## 7. 启动应用

### 7.1 API

当前模型：

```text
PI_PROVIDER=xhgj
PI_MODEL=gpt-5.6-sol
ISSUE_AGENT_REASONING=low
```

启动命令：

```bash
cd /home/idoly/issue-agent

DB=$(node -e 'const p=require("./.issue-agent/secrets/runtime.json").postgres; process.stdout.write(`postgres://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}`)')

DATABASE_URL="$DB" \
KEYCLOAK_ORGANIZATION_ID='87a2af8a-e22d-4b39-89f3-d8af97651b58' \
KEYCLOAK_ISSUER='http://127.0.0.1:8081/realms/issue-agent' \
ISSUE_AGENT_PROVIDER='xhgj' \
ISSUE_AGENT_MODEL='gpt-5.6-sol' \
ISSUE_AGENT_REASONING='low' \
PORT=3000 \
npm run server
```

验收：

```bash
curl -fsS http://127.0.0.1:3000/health
# 期望：{"status":"ok"}
```

### 7.2 Web

当前环境使用 Vite dev server：

```bash
cd /home/idoly/issue-agent/apps/web
npm run dev -- --host 0.0.0.0 --port 4173
```

浏览器访问：

```text
http://127.0.0.1:4173/
```

若页面只剩 Ant Design 基础样式，检查：

```bash
curl -fsS http://127.0.0.1:4173/src/styles.css | grep '__vite__css'
```

`__vite__css` 不得为空。若为空，停止并重新启动 Vite，清除失效的 HMR 模块图。

### 7.3 code-server

当前 sample container 使用：

```text
image: ghcr.io/coder/code-server:4.99.4
host port: 8443
container port: 8080
```

按需要恢复：

```bash
cd /home/idoly/issue-agent
./infra/workspace-podman.sh create \
  ISSUE-0042 \
  /home/idoly/issue-agent \
  8443 \
  .issue-agent/secrets/code-server-password
```

真实 issue workspace 应使用数据库中的 `issue_repositories.local_path` 或 `.issue-agent/workspaces/<issue>`，不要让多个并发工单共享同一个可写目录。

## 8. 恢复验收

### 8.1 数据计数

```bash
podman exec issue-agent-postgres psql -U issue_agent -d issue_agent -Atc \
  "select 'issues='||count(*) from issues;
   select 'services='||count(*) from services;
   select 'environments='||count(*) from environments;
   select 'sessions='||count(*) from issue_agent_sessions;
   select 'comments='||count(*) from issue_comments;
   select 'attachments='||count(*) from issue_attachments;
   select 'events='||count(*) from issue_agent_events;
   select 'migrations='||count(*) from drizzle.__drizzle_migrations;"
```

结果必须与备份中的 `issue-agent-counts.txt` 一致。本文生成时的参考值（会随使用变化）是：

```text
issues=4
services=2
environments=3
sessions=2
comments=13
attachments=1
migrations=9
```

### 8.2 Keycloak

```bash
podman exec issue-agent-postgres psql -U issue_agent -d keycloak -Atc \
  "select 'realm='||count(*) from realm where name='issue-agent';
   select 'users='||count(*) from user_entity u join realm r on r.id=u.realm_id where r.name='issue-agent';"
```

参考值：

```text
realm=1
users=1
```

还必须实际完成一次浏览器 PKCE 登录；数据库计数正常但浏览器无法登录不算恢复成功。

### 8.3 pi Session

```bash
find .issue-agent/sessions -type f -name '*.jsonl' -size +0

podman exec issue-agent-postgres psql -U issue_agent -d issue_agent -Atc \
  "select i.key, s.pi_session_id, s.session_file from issue_agent_sessions s join issues i on i.id=s.issue_id order by i.key;"
```

逐项确认：

1. 数据库 `session_file` 存在。
2. JSONL 文件非空。
3. 页面打开对应工单后能看到 pi Session 对话。
4. 发送“上一条回复是什么”时，pi 能利用之前的上下文回答。
5. 页面人工对话不会增加 `issue_comments` 行数。

### 8.4 附件

```bash
podman exec issue-agent-postgres psql -U issue_agent -d issue_agent -Atc \
  "select count(*), coalesce(sum(size),0) from issue_attachments;"
find .issue-agent/attachments -type f -size +0
```

数据库元数据数量和磁盘文件必须匹配。恢复后抽查 SHA-256。

### 8.5 页面与流式对话

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:4173/ >/dev/null
```

浏览器验收：

- 品牌显示“工单智研 / Issue Pilot”。
- Keycloak 登录成功。
- 环境、服务、工单和附件可见。
- 工单详情能解析服务仓库。
- pi Session 历史可滚动查看。
- AI 回答实时增长并在完成后保留。
- 处理中发送新消息使用 `followUp`，不打断当前回答。
- 方形停止按钮可以调用 `session.abort()`。
- 放大对话时详情隐藏，对话占满原详情区域。

## 9. 路径或主机地址变化

### 9.1 项目路径

pi Session、数据库绑定和 Git workspace 中包含绝对路径。最安全的方案是保持：

```text
/home/idoly/issue-agent
/home/idoly/antd-design-solid
```

若必须更换路径，需要同时迁移：

- `issue_agent_sessions.session_file`
- `issue_agent_sessions.workspace_path`
- `issue_repositories.local_path`
- Session JSONL header 中的 `cwd`
- Git worktree metadata
- code-server volume source

不要只修改数据库路径。路径迁移应先复制备份并单独演练。

### 9.2 IP/域名

变化后更新：

- Keycloak client redirect URIs
- Keycloak Web Origins
- `KEYCLOAK_ISSUER`
- 前端 `VITE_KEYCLOAK_URL`（非默认地址时）
- `ISSUE_AGENT_BASE_URL`
- code-server URL
- 反向代理和防火墙规则

生产环境应使用 HTTPS 和受信任反向代理；Keycloak 不应继续使用 `start-dev` 暴露公网。

## 10. 不应从运行时复制的内容

- `node_modules/`
- `apps/web/dist/`
- `.vite/`
- `coverage/`
- 运行中的 `.issue-agent/podman/postgres` 物理目录
- `/tmp` 日志
- 已失效的 Vite HMR 缓存
- 可重新拉取的容器 writable layer

这些内容通过 `npm ci`、Vite build 和容器镜像重新生成。

## 11. 回滚

恢复失败时：

1. 停止 API、Web、Keycloak 和 workspace 容器。
2. 保留失败环境，不在其上反复覆盖。
3. 新建一个空项目目录和空 Podman state。
4. 从同一加密备份重新恢复。
5. 先验收两个数据库，再启动应用。
6. 不要在未确认 Keycloak dump 完整时重置用户密码或重新创建同名 Realm，这会改变 subject、Organization ID 和 client UUID。

## 12. 常见故障

### `Permission denied (publickey)`

当前 GitHub SSH 22 端口不可用，仓库本地使用 GitHub SSH 443 rewrite，并绑定用户已有 SSH key。新服务器应重新配置自己的 GitHub key，不应从普通应用备份中复制私钥。

### `invalid_service_for_environment`

服务和环境关系未正确恢复。检查 `services`、`service_environments`、`issue_services`。

### `selected_services_have_no_repository`

服务没有 `service_repositories` 记录，或仓库 URL/默认分支配置丢失。

### `issue_agent_model_not_configured`

检查：

```text
~/.pi/agent/auth.json
~/.pi/agent/models.json
ISSUE_AGENT_PROVIDER
ISSUE_AGENT_MODEL
```

### Keycloak 登录循环

检查 issuer、端口、redirect URI、Web Origin 和浏览器访问地址是否完全一致。

### 页面布局全部失效

检查 Vite 返回的 `styles.css` 模块是否为空。源码正常但模块为空时重启 Vite。

### Session 文件存在但页面无历史

页面人工对话只显示 Session 中 `issue-agent-web-conversation` marker 之后的 active branch。检查数据库绑定是否指向正确 JSONL，并确认 marker 位于当前 branch。

## 13. 备份频率建议

| 内容 | 建议频率 |
|---|---|
| PostgreSQL 两个数据库 | 每日，重大变更前额外备份 |
| `.issue-agent/sessions` | 每日或每次重要工单完成后 |
| 附件与 workspace | 每日增量 |
| `infra/.env`、runtime、Pi auth | 凭据变更后立即更新加密备份 |
| Git bundle | 每次未推送提交后 |
| 完整恢复演练 | 每季度 |

每次备份都应生成 manifest、计数和 SHA-256，并至少在隔离目录做一次解密与列表检查。只有实际完成过恢复演练的备份才可视为可用备份。
