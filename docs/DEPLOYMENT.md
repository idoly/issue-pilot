# 部署说明

本文说明Compose生产模型、application镜像、宿主依赖、网络、proxy和首次验收。Kubernetes见[Kubernetes基线](KUBERNETES.md)，升级恢复见[运维手册](RUNBOOK.md)。

## 部署模型

Issue Pilot是可信内部环境中的有状态单体：

- 一个application容器运行Fastify、Web/Workbench、Pi、SQLite、Git managers、protocol clients和project tools。
- SQLite、Git、Pi JSONL、Attachment和worktree共享一个state root。
- Compose和Kubernetes使用同一image和`ProcessToolRuntime`。
- 生产只允许一个application副本。
- Agent不访问Podman/Kubernetes API，不创建tool container。
- Playwright临时container只属于Operator应用验收。
- API没有内置authentication/authorization。

```text
Browser
  -> TLS + authentication/authorization proxy
  -> host 0.0.0.0:3000
  -> application container 0.0.0.0:3000
       -> state root / Pi config / package config and cache
```

Compose发布`0.0.0.0:3000`是为了WSL/Windows端口转发，不是安全边界。宿主防火墙必须限制不可信来源；外部流量必须经可信proxy。

## 宿主前置条件

- Linux/WSL低权限专用账号，当前配置要求UID/GID `1000:1000`。
- Node/npm用于依赖安装、测试、配置读取和image build。
- Podman和Compose provider。
- `~/.pi/agent`目录。
- Owner-only `~/.npmrc`和`~/.m2/settings.xml`。
- Owner可写且不可group/world写的`~/.npm`和`~/.m2/repository`。
- 可选owner只读`~/.gitconfig`和`~/.ssh`。

检查：

```bash
id
/usr/local/node/bin/node --version
/usr/local/node/bin/npm --version
podman version
podman compose version
stat -c '%a %U:%G %n' ~/.npmrc ~/.m2/settings.xml
stat -c '%a %U:%G %n' ~/.npm ~/.m2/repository
```

Project broker拒绝非owner配置、group/world-readable配置文件和group/world-writable cache。Credential内容不会进入HTTP或日志。

## Application image

`infra/images/application/Containerfile`为三阶段构建：

| Stage | 内容 |
| --- | --- |
| `node:26-bookworm-slim` | `npm ci`、Vite build、`npm prune --omit=dev` |
| `maven:3.9-eclipse-temurin-8` | Maven和Temurin 8 |
| `ubuntu:26.04` | Production app、Node/npm、Maven/JDK、Aliyun CLI、Git/SSH、rg、curl |

Image默认Kubernetes root为`/opt/issue-pilot`。Compose build传入当前宿主absolute project root和HOME，使image path、OCI `io.issue-pilot.root` label、SQLite local paths、Git worktree metadata和runtime symlink使用同一命名空间。

Runtime rootfs只读；`/tmp`为1GiB tmpfs；state和package cache读写；Pi/npm/Maven config只读。Container使用current UID/GID、keep-id user namespace、drop all capabilities、no-new-privileges、2048 PIDs、4GiB memory和1800s stop grace period。

## 安装和构建

Fresh checkout先创建state和cache目录；`~/.npmrc`、`~/.m2/settings.xml`和`~/.pi/agent`必须已由Operator提供：

```bash
npm ci
install -d -m 0700 .issue-pilot "$HOME/.npm" "$HOME/.m2/repository"
infra/playwright.sh prepare
infra/application.sh config
infra/application.sh prepare
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

`prepare`：

1. 从根配置生成临时Compose JSON。
2. 使用`--pull=always`构建application。
3. 验证image root label和Healthcheck。
4. 保留最新完整build stage为`${image}-build-cache`。
5. 只prune本项目label的无tag、未被container引用的旧image。

它不会删除其他项目image。Running container引用的旧image会保留到container remove。

检查：

```bash
infra/application.sh status
infra/playwright.sh status
podman image inspect localhost/issue-pilot:0.1.0-node26-ubuntu2604
```

## 配置和state root

唯一配置是`issue-pilot.config.ts`。`src/config.ts`计算：

```text
projectRoot = source checkout root
stateRoot = resolve(projectRoot, state.directory)
databaseFile = resolve(stateRoot, state.databaseFile)
webRoot = <projectRoot>/src/web/dist
```

默认state为`<project>/.issue-pilot`。API、migration、Git、runtime、Source Browser和project broker必须使用同一root。

生产project directory必须稳定。不要通过另一个working directory启动，不要在API运行时移动project/state，也不要使用环境变量尝试覆盖path。

## 首次启动

确保没有同名container：

```bash
infra/application.sh status
infra/application.sh start
infra/application.sh logs
```

`npm run server`等同于`infra/application.sh start`。`start`要求prepared image、state root、Pi config、npm/Maven config/cache存在，并拒绝覆盖existing container。

启动前application会：

1. 打开SQLite、migration、foreign keys和structure checks。
2. 插入空库bootstrap user并同步Environment。
3. 收敛interrupted Agent/Workspace状态。
4. 拒绝unmanaged Issue/workspace。
5. 验证generated checkout并清理runtime。
6. 启动`0600 control/project-tools.sock`。
7. 重建dev和已有session的read-only runtime。
8. 执行一次Workspace maintenance。
9. 注册HTTP route并启动timer。

任一步失败会关闭已打开资源并保留durable evidence。

## Container lifecycle

```bash
infra/application.sh config
infra/application.sh prepare
infra/application.sh status
infra/application.sh start
infra/application.sh logs
infra/application.sh stop
infra/application.sh remove
```

- `stop`发送SIGTERM并保留stopped container和logs。
- Graceful close drain maintenance/inspection、Agent/reservation、Pi sessions、model runtime、project processes和SQLite。
- `remove`只允许stopped container，随后Compose down并prune可删除的旧application images。
- `clean`只允许container不存在；删除current application image和named build cache，不删state。

Project socket阻止第二API实例。不要用`podman run`绕过generated Compose mount和path检查。

## Production Web和proxy

`npm run build`生成`src/web/dist`。Production API验证`index.html`和`vscode.html`后同源提供：

- HTML：`private, no-cache, no-store`
- Hashed `assets/`：一年immutable
- 其他文件：不公开

Nginx核心配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

在该location外层加入组织认证、授权、TLS和审计。SSE要求禁用buffer、使用长read timeout，并保留`Cache-Control: no-cache, no-transform`和`X-Accel-Buffering: no`语义。

Vite：

```bash
npm run dev:web
```

默认`0.0.0.0:4173`，只用于可信开发网络。

## Workbench和Source边界

Workbench在同源`vscode.html` iframe中运行，只注册固定LocalProcess extension、Web Worker Markdown extension、固定theme/icon/language contributions。

Source API限制：

- Repository alias来自SQLite Issue关系。
- Runtime必须是受管symlink。
- Active dev target等于DB `local_path`；read-only target位于managed checkout root。
- Path经normalize和realpath双重containment。
- Tree最多500项，file最多2MiB UTF-8。
- Search是literal `rg --json`，最多200 matches。
- History最多100 commits；commit必须是HEAD ancestor；change list最多500。
- Source header中的path/query经百分号编码，response为`private,no-store`，route关闭普通access log。

没有Terminal、PTY、Node extension host、gallery、save、Source write、stage、commit、discard或任意Git route。只读Source仍返回内部代码，必须受proxy授权。

## Project tools

Writable dev runtime生成`node-project`和`maven-project`。Wrapper通过`0600`Unix socket发送versioned request；broker从SQLite重新授权Issue、Repository、workspace和project realpath。

允许：

```text
npm ci|install
npm run test|build|typecheck
mvn test|verify|package
```

Node拒绝non-npm package manager、server/watch action和`--watch*`。Execution固定`CI=1`，同Issue串行，timeout 30分钟。`ProcessToolRuntime`只使用image PATH，不调用Podman。

这些命令执行Repository script并与API共享UID和可读mount。只部署可信内部代码；package credential使用可轮换的read-only专用身份。

## Aliyun CLI

Image按architecture安装官方Aliyun CLI latest。Issue Pilot不读取Operator持久`~/.aliyun`。

每次DMS/SLS：

1. 创建temporary HOME。
2. 写`0600 ~/.aliyun/config.json`。
3. `ProcessToolRuntime`执行allowlisted Aliyun command。
4. Finally递归删除temporary HOME。

AccessKey不进入argv。DMS SQL、SLS query、project/logstore和time range会短暂出现在application process list。字段和最小权限见[配置说明](CONFIGURATION.md)。

## Playwright application test

```bash
infra/playwright.sh prepare
infra/playwright.sh status
infra/playwright.sh run <test.cjs> <output-directory>
infra/playwright.sh clean
```

`run`启动一个`--rm`临时browser container，挂载只读test script和Playwright Core、读写output，使用host network、readonly rootfs、current UID/GID、drop all capabilities、no-new-privileges、256 PIDs、1GiB memory和300s hard timeout。它不挂state、Issue workspace、Deployment config、project socket或Podman socket。

Service/Deployment/Agent没有Playwright入口。

## 安全要求

- API无内置认证；subject switch不是认证。
- 防火墙限制Compose host port；外部入口必须TLS/auth/authorization。
- API/Pi使用专用non-root账号。
- Application container不是untrusted code sandbox。
- Source和Config API按敏感接口授权，不记录body。
- SQLite、backup、Pi JSONL、Attachment、源码、legacy editor data和capability result都是敏感数据。
- Deployment credential只存SQLite；Pi/npm/Maven原生credential只读挂载。
- 不记录Authorization、Cookie、config write body、password、AccessKey、temporary profile、package auth header或完整敏感result。

## 首次业务配置

1. 确认bootstrap user并创建其他用户。
2. 创建Service和至少一个Repository。
3. 为需要的Environment创建Deployment。
4. 为每个Repository设置base branch。
5. 选择当前available Pi model/thinking level。
6. 只启用必要capability并使用最小权限credential。
7. 先创建test `smart_analysis`验证read-only，再创建dev Issue验证worktree。

## 首次验收

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
infra/application.sh status
infra/playwright.sh status
stat -c '%a %U:%G %n' .issue-pilot/control/project-tools.sock
ss -ltnp | rg ':3000'
```

验收：

- Health为`{"ok":true}`，container healthy/restart 0。
- Web和`vscode.html`同源可达。
- Socket mode `0600`。
- User CRUD和最后active user约束正确。
- Config GET脱敏且`private,no-store`。
- Prod/test无dev workspace且tools只读。
- Dev创建Issue-local branch/worktree和wrapper。
- SSE顺序为replay、`snapshot_ready`、live。
- Source multi-root/tree/file/search/history/commit/diff只读可用。
- Attachment mode/size/hash正确，无独立write route。
- 对全部已有Issue核对Repository state、runtime symlink、HEAD/branch和Git clean，而不是只抽查一张。
