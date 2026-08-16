# 部署说明

本文面向首次安装和生产部署维护者，说明当前代码需要的宿主工具、进程、Podman runtime、反向代理、安全边界和验收步骤。状态原理见 [架构说明](ARCHITECTURE.md)，业务字段见 [配置说明](CONFIGURATION.md)，上线后的操作见 [运维手册](RUNBOOK.md)。

## 部署模型

Issue Pilot 是可信单机应用，不是多租户服务：

- 生产应用容器以同一低权限UID运行Fastify、Pi SDK、Git和capability client；SQLite和Git state保留在宿主持久目录。
- Fastify在生产中同源提供SolidJS Web和Workbench静态资源；Vite只用于开发。
- Web内置VS Code Workbench，通过只读文件系统overlay和Fastify Source API读取Issue runtime。
- Node/Maven项目命令每次启动一个`--rm`临时容器。
- Playwright只由operator运行Issue Pilot自身浏览器测试时启动`--rm`临时容器，不属于Agent capability。
- DMS/SLS 每次调用启动一个受限的 `--rm` Aliyun CLI容器。
- API没有内置authentication/authorization。
- 代码浏览器不启用Terminal、本地/Node extension host、任意Git或文件写接口；仅打包的Markdown功能使用Web Worker extension host。

推荐生产拓扑：

```text
Browser
   |
TLS + Authentication/Authorization Proxy
   |
   +-- all paths -> 127.0.0.1:3000 (Compose host publish)
                            |
        application container: 0.0.0.0:3000 Fastify + static Web/Workbench + Pi/Git
                            |
             SQLite/state + rootless Podman API socket
```

应用容器使用bridge网络并监听容器端口，Compose只把该端口发布到宿主loopback。所有外部访问必须经过同机可信代理。`deploy/kubernetes/base`提供单副本应用Kustomize基线，但在Job runner完成前会fail closed拒绝临时容器能力；边界见[Kubernetes基线](KUBERNETES.md)。

## 固定宿主工具

构建宿主和本地开发要求以下工具；生产应用镜像内置运行时Git/SSH、ripgrep、curl和Podman remote client：

| Component | 路径或版本 |
| --- | --- |
| Node.js | `/usr/local/node`，24+ |
| Node binary | `/usr/local/node/bin/node` |
| npm/Pi | `/usr/local/node/bin/{npm,pi}` |
| Pi package/model runtime | 项目依赖与 `~/.pi/agent` 配置 |
| Git | `git` in PATH |
| Source search | `rg` in PATH |
| Wrapper client | `curl`、`base64` in PATH |
| Podman | `podman` in PATH；生产还需`podman-compose` provider及`runtime.application.podmanSocket`对应的rootless API socket |
| Application image | `localhost/issue-pilot:0.1.0-node24-bookworm`，按当前checkout绝对路径构建 |
| Aliyun CLI image | `localhost/issue-pilot-aliyun-cli:3.4.11-alpine3.22.1`，仅启用DMS/SLS时执行 |
| Playwright core | `1.62.1` |
| Playwright image | `mcr.microsoft.com/playwright:v1.62.1-noble` |
| Node project image | 固定digest的`node:24-bookworm-slim` |
| Maven project image | 固定digest的`maven:3.9-eclipse-temurin-8` |

项目工具broker要求运行账号拥有`~/.npmrc`、`~/.npm`、`~/.m2/settings.xml`和`~/.m2/repository`。配置文件必须由运行账号拥有且group/world权限为0，缓存目录必须由运行账号拥有且不可group/world写；配置文件只读挂载，缓存目录读写挂载，code browser和Web进程不能直接读取这些文件。

快速检查：

```bash
/usr/local/node/bin/node --version
/usr/local/node/bin/pi --version
git --version
rg --version
curl --version
podman version
podman compose version
infra/application.sh config
infra/application.sh status
infra/aliyun-cli.sh status
infra/project-tools.sh status
```

不要用环境变量、临时PATH或不同容器image绕过缺失的固定工具；API、wrapper和测试必须使用根配置中的一致工具链。应用容器中的`HOME`只保持运行账号绝对路径一致，不覆盖任何Issue Pilot配置字段。

## 安装与构建

在固定项目目录中执行：

```bash
npm ci
infra/playwright.sh prepare
infra/application.sh config
infra/application.sh prepare
npm run typecheck
npm test
npm run build
```

准备状态：

```bash
infra/application.sh status
infra/playwright.sh status
infra/aliyun-cli.sh status
infra/project-tools.sh status
```

预期同时看到按当前绝对项目根构建、带Healthcheck的application image，正确`playwright-core`、Playwright、Aliyun CLI、Node和Maven image ready，并且没有带`io.issue-pilot.component=application-test`或`io.issue-pilot.component=pi-tool` label的持久运行容器。

## 应用配置与 state root

所有运行配置都在根目录 `issue-pilot.config.ts`。应用不读取环境变量覆盖它。`src/config.ts` 根据项目根解析：

```text
stateRoot = <project-root>/<state.directory>
databaseFile = <stateRoot>/<state.databaseFile>
```

默认：

```text
stateRoot = <project-root>/.issue-pilot
databaseFile = <project-root>/.issue-pilot/issues.db
```

`infra/config-value.mjs`只读取根配置标量，Shell中没有第二套默认值。API、migration、Git、runtime、source browser和project-tool broker必须使用同一个state root。

生产项目目录必须持久存在。升级时不能切换到一个不包含原state root的新WorkingDirectory，也不能在API运行期间移动项目、数据库或`.issue-pilot`。Application image的`io.issue-pilot.root` label和镜像内`WORKDIR`必须等于该宿主绝对项目目录；`infra/application.sh`在启动前强制核对。

完整字段见 [配置说明](CONFIGURATION.md#根配置)。

## 数据库初始化

显式执行 migration：

```bash
npm run db:migrate
```

API 启动时也会执行同一组 Drizzle migration。数据库文件创建为 `0600`，启用 WAL 和配置的 busy timeout；migration 后启用 foreign keys。

生产升级前仍必须停止 API 并创建一致备份。不要把“API 会自动 migrate”当作跳过备份和 dry-run 的理由。

## 本机启动

启动 API：

```bash
npm run server
```

另一个终端启动 Vite：

```bash
npm run dev:web
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Web | `http://127.0.0.1:4173` |
| API | `http://127.0.0.1:3000` |

Vite根据根配置监听`0.0.0.0:4173`，并代理`/api`。这只适用于受信任开发网络；入口能访问真实Issue数据和源码，不能直接暴露到不可信LAN或Internet。

## API 启动行为

每次 API 启动会：

1. 打开数据库、执行 migration、恢复中断 Agent 状态并同步 Environment。
2. 验证 state root 中没有 unmanaged Issue/workspace 目录。
3. 验证 shared checkout ownership、HEAD 和 cleanliness，再受管移除可重建 checkout。
4. 删除受管Issue runtime和中断的`.runtime-*`生成目录。
5. 创建`0600 control/project-tools.sock`并启动broker。
6. 重建active/released dev runtime。
7. 为已有session的prod/test Issue fetch当前Deployment commit并重建runtime。
8. 执行一次workspace maintenance。
9. 注册route，并启动定时maintenance。

任一 durable-state 不变量失败会停止启动并保留现场。详细错误处理见 [运维手册](RUNBOOK.md)。

## 生产应用容器

主应用镜像是推荐生产入口。它在同一个Fastify进程中提供静态Web、Workbench和API，并包含Git/SSH、ripgrep、curl及只连接宿主socket的Podman remote wrapper。Remote client使用根配置固定的官方5.8.4 amd64/arm64静态tarball并验证SHA-256，不安装Podman本地runtime、CNI或OCI runtime。Web构建依赖位于`devDependencies`，multi-stage build完成后执行`npm prune --omit=dev`。`infra/application-compose.mjs`从根配置和当前绝对路径生成Compose JSON，避免手写清单复制image digest、UID、mount和资源预算。

首次启用运行账号的rootless Podman API：

```bash
systemctl --user enable --now podman.socket
systemctl --user enable podman-restart.service
loginctl enable-linger issue-pilot
```

socket路径必须与`runtime.application.podmanSocket`一致且只允许该账号访问。随后：

```bash
infra/application.sh config
infra/application.sh prepare
infra/application.sh status
infra/application.sh start
infra/application.sh logs
```

`prepare`通过同一个Compose project构建application和Aliyun CLI，并拉取固定digest的Node/Maven image；`tools` profile只管理镜像，不创建常驻工具service。`start`拒绝覆盖同名容器，通过Compose设置`on-failure:5`重启策略，并要求以下路径在容器内外完全相同：项目根、state root、`HOME`、Pi配置、npmrc/cache和Maven settings/repository。应用rootfs只读；state root读写；Pi/package manager配置在应用容器中只读，Node/Maven临时子容器按各自授权重新挂载cache。可选`~/.gitconfig`和`~/.ssh`只读挂载。

停机保留容器日志供检查：

```bash
infra/application.sh stop
infra/application.sh logs
infra/application.sh remove
```

`clean`只在容器不存在时删除application image，不删除state。切换宿主进程和应用容器前必须先停止旧API；project-tools Unix socket会阻止两个API实例同时启动。

应用容器使用bridge网络，Fastify按`runtime.application.listenHost`监听`0.0.0.0:3000`，Compose固定发布`127.0.0.1:3000:3000`。挂载rootless Podman API socket使可信API能够通过`ContainerRuntime`创建Aliyun/Node/Maven临时容器，也授予该容器运行账号级Podman控制权；由于Agent bash与API同身份，这不是Agent sandbox。不要把该socket挂到Web、目标项目容器或其他客户端。

## 宿主 API 服务（备选）

推荐使用独立低权限账号和固定 WorkingDirectory。示例 systemd unit：

```ini
[Unit]
Description=Issue Pilot API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=issue-pilot
Group=issue-pilot
WorkingDirectory=/opt/issue-pilot
Environment=PATH=/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/usr/local/node/bin/node --experimental-strip-types src/http/api.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

运行账号需要：

- 读写项目 `.issue-pilot`。
- 访问 Repository 所需 Git credential。
- 读取 Pi model/auth 配置。
- 读写需要复用的 npm/Maven cache。
- 调用 Podman。
- 启用DMS/SLS时读取并运行根配置固定的Aliyun CLI image；不需要宿主Aliyun CLI。

不要把 model key、Deployment password 或 AccessKey 写入 unit environment。Model credential 属于 Pi 配置；capability credential 属于 SQLite Deployment config。

安装 unit 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now issue-pilot-api
sudo systemctl status issue-pilot-api
journalctl -u issue-pilot-api -f
```

`SIGINT`/`SIGTERM`会触发graceful shutdown：停止maintenance、等待lifecycle/inspection队列和Agent reservation、停止Pi session、关闭项目工具broker并等待活动容器、关闭SQLite。`TimeoutStopSec`应覆盖最长项目工具和Git操作；当前30分钟项目工具上限需要相应调整unit timeout，或先由调用方取消任务。

## Production Web 与反向代理

`npm run build`输出`src/web/dist`。生产API启动时验证`index.html`和`vscode.html`存在，然后由Fastify提供静态文件：HTML使用`private, no-cache, no-store`，`assets/`中的Vite哈希资源使用一年immutable缓存，其他文件不公开。Web、Workbench和API因此天然同源。

可信网关只需把全部路径转发到loopback Fastify；Nginx核心示例：

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

必须在这些 location 外层加入组织实际使用的 authentication、authorization、TLS 和审计策略。

Agent stream 使用 SSE：

- `/api` 不能 response buffer。
- 不能使用短 read timeout。
- 代理应保留 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no` 语义。

## 内置代码浏览器

Web使用`@codingame/monaco-vscode-api`启动只读VS Code Workbench。Explorer文件系统只使用`/repositories`、`/tree`和`/file`；完整Source API仍包括：

- `/repositories`返回当前runtime可见Repository alias、branch和访问模式。
- `/tree`列出最多500项，不返回`.git`。
- `/file`只读取2 MiB以内有效UTF-8普通文件。
- `/search`使用literal `rg --json`，限制query、match、timeout和output。
- `/history`返回当前HEAD最近100条commit，选择文件时按path过滤。
- `/commit`先用`merge-base --is-ancestor`限制到当前HEAD可达commit，再返回最多500项结构化`added|modified|deleted|renamed|copied`文件清单。
- `/commit-file`读取该commit第一父版本与提交后版本，新增、删除、重命名和root commit使用显式nullable before/after。
- `/diff`使用`git diff --no-ext-diff --no-textconv --name-status -z`返回index到working tree的结构化文件清单。
- `/diff-file`从Git index和受管working tree读取选中文件，新增或删除使用显式nullable before/after。

每次打开代码浏览器都会加载独立`vscode.html` iframe，并在关闭时销毁Workbench单例。Workbench用`registerCustomView()`创建原生Agent Panel View和工单详情Secondary Side Bar View，只把两个View body矩形通过同源Issue绑定消息上报父应用；父应用继续维护SSE、草稿、输入和工单表单状态。原生标题栏保留关闭和sash resize并隐藏最大化动作，代码栏开关与Part visibility双向同步，隐藏View不销毁Agent SSE、草稿或工单状态。这里没有启用VS Code Terminal或PTY。Explorer、Editor、Graph和Markdown Preview使用VS Code原生按需显示的滚动条；工单与Agent使用同一组GitHub Dark滚动条颜色。Agent的单一滚动容器覆盖完整View body，对话、队列、运行状态、输入区和底部状态处于同一滚动流，输入区和底部状态不固定。窄屏隐藏原生右栏，通过代码栏图标打开详情抽屉。虚拟workspace和文件使用稳定`file:///issue-pilot/...` URI；VS Code原生Explorer、Editor Groups/Tabs、breadcrumb、find、goto、folding、hover和symbols直接工作。TS/JS、JSON、CSS和HTML使用Monaco standalone language worker，其他固定grammar contribution提供高亮和语言配置。

代码栏用三个固定图标发送白名单Explorer/Search/Source Control view command；点击另一图标时显示并切换Primary Side Bar，再次点击当前图标时收起Primary Side Bar，原生Activity Bar保持隐藏。Search view调用literal `/search` provider，大小写和整词选项映射到专用boolean header，regex控件和Replace全部隐藏。Source Control通过`ISCMService`投影`/diff` Changes和基于`/history`、`/commit`的Graph；单击Graph文件时，由预注册的只读revision文件系统按需调用`/commit-file`并打开前后内容Diff，不提供输入框、stage、discard、commit或任意Git命令。

界面固定选择官方GitHub Dark Default和Material Icon Theme；构建只注册theme/icon静态资源，不导入Material扩展的Node main、activation event、command或configuration。打包的`markdown-language-features`只在Web Worker extension host中提供`markdown.api.render`，Workbench ready前完成预激活。标题Preview图标和Markdown Preview键盘命令打开通过`registerEditorPane()`注册的只读Editor Pane；Pane从当前只读Monaco模型调用扩展render API，DOMPurify清洗后写入隔离Shadow DOM，并复用Workbench原生Editor Group、Tab、关闭和`DomScrollableElement`。该路径不创建浏览器Webview、内容iframe或Service Worker；GitHub Dark/highlight样式随构建打包，不加载脚本或外部资源。拖放、文件粘贴和移动时更新链接均关闭。Terminal、本地/Node extension host、extension gallery、remote agent和任意Git命令不加载。

文件系统provider声明`Readonly`和`FilePermission.Readonly`，write、mkdir、delete、rename全部返回`FileWriteLocked`。API不接受绝对宿主路径。它从SQLite读取Issue Repository关系、重新推导alias，验证runtime必须是受管symlink；active dev target必须等于数据库`local_path`，read-only target必须位于合法的`git/checkouts/<hash>/<commit>`。所有最终path均realpath后再次检查Repository containment。Source route只读，不提供保存、shell、terminal或任意Git命令；Repository、path和query经百分号编码后放在专用request header而不是URL query string，响应带`private, no-store`，route关闭普通request access log，避免源码路径和搜索词进入应用或proxy URL日志。iframe用于隔离Workbench单例和生命周期，不替代外层authentication、authorization、TLS或Source API授权。

## Node/Maven项目工具

管理命令：

```bash
infra/project-tools.sh prepare
infra/project-tools.sh status
infra/project-tools.sh clean
```

API启动Unix socket `<state>/control/project-tools.sock`，目录`0700`、socket `0600`。Writable dev runtime中的`node-project`和`maven-project` wrapper只发送Issue segment、Repository alias、相对project path、有限action和参数；broker从SQLite重新授权，客户端不能控制image或mount。

Node action为`install|test|build|typecheck`，使用固定Node 24 image；`start/dev/serve/preview`不可用，`--watch*`被broker拒绝且容器固定`CI=1`。Maven action为`test|verify|package`，使用固定Maven 3.9/Temurin 8 image。容器共同使用：

- `--rm --pull never`、只读rootfs、host network。
- 当前UID/GID与`userns=keep-id`。
- `cap-drop ALL`、`no-new-privileges`、PID/内存/30分钟上限。
- 单一Repository读写mount和`/tmp` tmpfs。
- npmrc/Maven settings只读mount；npm/Maven cache读写mount。

同一Issue的项目命令串行，不同Issue可并行。Output使用共享进程预算。API关闭会先停止接受新请求，再等待活动队列。项目命令可以执行Repository中的脚本，因此任务容器仍按不可信代码处理；目标脚本能够读取该次任务挂载的npmrc或Maven settings，必须使用仅具包读取权限、可轮换的专用身份。任务不能获得Podman socket、Pi model配置、Deployment credential或其他Issue workspace。

## Playwright application test runtime

管理和执行命令：

```bash
infra/playwright.sh prepare
infra/playwright.sh status
infra/playwright.sh run <test.cjs> <output-directory>
infra/playwright.sh clean
```

`prepare`确保全局`playwright-core`版本和browser image与根配置一致，不安装持久browser daemon。`run`只供operator执行Issue Pilot自身的桌面/窄屏回归、截图、请求审计和editor/canvas像素验收；测试脚本从`/tool/node_modules/playwright-core`加载Playwright，产物写入`/out`。

每次`run`只挂载一个只读测试脚本、只读Playwright Core和一个读写输出目录，启动带固定label和唯一名称的`podman run --rm`容器。容器使用host network、只读rootfs、当前UID/GID、drop all capabilities、no-new-privileges及PID/内存限制，并由Podman在300秒后硬停止；Shell退出时也会按名称强制清理。它不挂载SQLite、Deployment配置、Issue workspace、项目工具socket或Podman socket。

Service/Deployment不配置或授权Playwright；IssuePolicy、Pi tool和capability broker没有浏览器入口。Agent和目标项目不能通过capability broker启动该容器。`status`发现持久application-test container时失败。

## Aliyun CLI runtime

管理命令：

```bash
infra/aliyun-cli.sh prepare
infra/aliyun-cli.sh status
infra/aliyun-cli.sh clean
```

Image基于固定digest的Alpine `3.22.1`，安装固定Aliyun CLI `3.4.11`；amd64和arm64官方versioned tarball分别执行固定SHA-256校验。宿主不安装Aliyun CLI，运行时也不会读取或修改operator的`~/.aliyun`。

每次DMS/SLS调用：

1. 创建调用级临时HOME并写入`0600 ~/.aliyun/config.json`。
2. 启动使用当前UID/GID的非root `podman run --rm`。
3. 容器drop全部capability、启用no-new-privileges、只读rootfs和PID/内存上限。
4. 临时HOME以只读方式作为唯一credential mount，调用结束后在finally中递归删除。
5. 返回metadata标记`container-cli`；不保留持久tool container。

DMS使用`dms-enterprise ExecuteScript`、固定central endpoint和`--secure`。SLS使用regional log endpoint。Credential不进入argv，但DMS SQL和SLS query仍会作为容器命令参数短暂出现在宿主进程列表。详细权限和字段见[配置说明](CONFIGURATION.md#dms)。

## 安全边界

### Authentication 与网络

- Issue Pilot API 没有内置认证。
- `X-Issue-Pilot-Subject` 和页面用户切换不是认证。
- 内置代码浏览器只读但会返回内部源码；Source API与其他Issue API使用相同授权边界。
- 宿主开发API必须监听`127.0.0.1`；Compose必须只向宿主`127.0.0.1`发布生产容器端口。
- 外部入口必须由可信代理执行 authentication、authorization 和 TLS。
- `/api/config` 虽已脱敏，仍包含内部 Repository、model 和 capability scope；`/api/services/*` 写请求还可能携带新 credential，配置路由必须单独授权和审计。
- 不要直接暴露 Vite dev server 到不受信任网络。

### 宿主权限

Pi built-in tools不是OS sandbox。API/Pi必须使用专用低权限账号，不能以root运行。该账号能访问的文件、网络和credential都可能被Agent命令访问。

项目工具和Aliyun CLI容器限制降低了单次任务权限，但Agent的Pi session仍与API处于同一OS身份；不要把Podman边界或application container误认为Agent host sandbox。Application container持有rootless Podman API socket，等同于该账号的容器控制权。Playwright application-test容器属于operator测试边界，不为Agent提供额外隔离或能力。Source browser只读HTTP边界也不能防止同一运行身份下的恶意Agent直接访问其OS权限范围。

### Secret 与敏感数据

Deployment credential存储在 SQLite。`GET /api/config` 只返回 `credentialConfigured`，不会回传 password、AccessKeyId 或 AccessKeySecret；配置表单以 preserve/replace/clear 更新，只有 replace 写请求携带新值。禁止记录：

- Config write request body和未经审查的配置 response body。
- Authorization、Cookie 或代理 identity token。
- Deployment password、AccessKey 或临时 profile。
- npmrc、Maven settings或package manager请求header。
- 包含生产数据的完整capability result或Source API response body。

SQLite、backup、Pi JSONL、Attachment、源码、历史遗留的code-server data和API log都按敏感数据管理。Capability结果会进入模型上下文和Pi JSONL。

## 首次业务配置

服务启动后在 Web 中：

1. 在用户页确认bootstrap用户，并添加需要的内部用户。
2. 创建 Service。
3. 添加至少一个 Repository，并设置唯一 alias。
4. 为需要的 Environment 创建 Deployment。
5. 为每个 Repository 设置 `baseBranch`。
6. 选择当前可用的 Pi provider/model/thinking level。
7. 只启用确实需要的 capability，并使用最小权限 credential。

字段和权限见 [配置说明](CONFIGURATION.md)。系统不提供业务 seed。

建议先创建 test `smart_analysis` Issue验证只读路径，再创建 dev Issue 验证独立 worktree。

## 首次验收

### 服务检查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
infra/application.sh status
infra/playwright.sh status
infra/aliyun-cli.sh status
infra/project-tools.sh status
ss -ltnp | rg ':3000'
```

预期：

- `/health` 返回 `{"ok":true}`。
- Compose只向宿主loopback发布端口，主页和`/vscode.html`由同一入口返回。
- Application image root label/Healthcheck正确，容器状态符合部署方式。
- Playwright application-test、Aliyun CLI、Node和Maven tool/image ready，且无持久application-test或pi-tool container。
- `<state>/control/project-tools.sock`存在且mode为`0600`。

### Web 与业务检查

- SQLite启用用户可加载和切换，用户页可新增、编辑、启停；未知或停用subject被拒绝，最后一名启用用户不能停用。
- Service/Repository/Deployment round-trip正确。
- `/api/config` 响应带 `private, no-store`，且代理/日志不记录 body。
- Prod/test policy只含 read tools，`workspaces/<key>` 不存在。
- Dev 创建 `hotfix-*` 或 `feature-*` 本地 branch和独立 worktree。
- Agent stream先replay，再收到`snapshot_ready`，刷新后仍可恢复。
- 代码浏览器可切换全部Repository、展开文件树、读取UTF-8文件、搜索和查看Git diff；不存在source write route。
- Attachment可读取，mode、size和SHA-256正确；不存在独立写route。

### 全量 Repository 验收

对已有全部 Issue，而不是只抽查一张：

- 读取`/api/issues/<key>`并确认`sourceAvailable`与runtime状态一致。
- 调用`/source/repositories`，验证每个alias link存在且realpath符合数据库Repository状态。
- 使用 `GIT_OPTIONAL_LOCKS=0` 只读检查 HEAD、branch、`status --porcelain` 和最近 log。
- Prod/test 为 detached checkout且 HEAD等于当前 Deployment fetched commit。
- Active dev worktree HEAD等于本地 working branch ref。
- Released dev runtime HEAD等于本地 working branch tip。

Released dev历史 Repository集合与当前 Service不同可以合法存在；不要只按数量批量补行或改写 base branch。
