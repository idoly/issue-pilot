# 部署说明

本文面向首次安装和生产部署维护者，说明统一的进程工具执行机制、Podman构建环境、反向代理、安全边界和验收步骤。状态原理见[架构说明](ARCHITECTURE.md)，业务字段见[配置说明](CONFIGURATION.md)，上线后的操作见[运维手册](RUNBOOK.md)。

## 部署模型

Issue Pilot 是可信单机应用，不是多租户服务：

- 生产应用容器以同一低权限UID运行Fastify、Pi SDK、Git和capability client；SQLite和Git state保留在宿主持久目录。
- Fastify在生产中同源提供SolidJS Web和Workbench静态资源；Vite只用于开发。
- Web内置VS Code Workbench，通过只读文件系统overlay和Fastify Source API读取Issue runtime。
- API只从application镜像启动；Compose和Kubernetes共用同一个`ProcessToolRuntime`和镜像PATH。
- 运行请求不携带image，也不启动工具子容器。
- Playwright只由operator运行Issue Pilot自身浏览器测试时启动`--rm`临时容器，不属于Agent capability。
- API没有内置authentication/authorization。
- 代码浏览器不启用Terminal、本地/Node extension host、任意Git或文件写接口；仅打包的Markdown功能使用Web Worker extension host。

推荐生产拓扑：

```text
Browser
   |
TLS + Authentication/Authorization Proxy
   |
   +-- all paths -> 0.0.0.0:3000 (Compose host publish)
                            |
        application container: 0.0.0.0:3000
        Fastify + Web/Workbench + Pi/Git + Node/Maven/JDK/Aliyun CLI
                            |
                        SQLite/state
```

应用容器使用bridge网络并监听容器端口，Compose只把该端口发布到宿主loopback。所有外部访问必须经过同机可信代理。`deploy/kubernetes/base`复用同一大镜像和进程工具运行时；边界见[Kubernetes基线](KUBERNETES.md)。

## 构建与运行工具

宿主只负责依赖安装、测试、镜像构建和Operator验收；API运行工具全部由application镜像提供：

| Component | 路径或版本 |
| --- | --- |
| Host build Node/npm | `/usr/local/node`，用于npm、配置读取和Web构建，不作为API运行时 |
| Application tools | Node `26`、Pi、Maven `3.9`/Temurin 8和构建时获取的Aliyun CLI latest |
| Pi model runtime | application内项目依赖与只读挂载的`~/.pi/agent`配置 |
| Application utilities | Git/SSH、`rg`、`curl`、`base64` |
| Podman | 构建application镜像和运行Playwright验收需要；API工具执行不需要 |
| Application image | `localhost/issue-pilot:0.1.0-node26-ubuntu2604`，按当前checkout绝对路径构建 |
| Application build images | `node:26-bookworm-slim`、`maven:3.9-eclipse-temurin-8`和`ubuntu:26.04` |
| Playwright core | `1.62.1` |
| Playwright image | `mcr.microsoft.com/playwright:v1.62.1-noble` |

项目工具broker要求运行账号拥有`~/.npmrc`、`~/.npm`、`~/.m2/settings.xml`和`~/.m2/repository`。配置文件必须由运行账号拥有且group/world权限为0，缓存目录必须由运行账号拥有且不可group/world写；配置文件只读挂载，缓存目录读写挂载；配置内容不会进入命令参数、HTTP响应或日志。

快速检查：

```bash
/usr/local/node/bin/node --version
/usr/local/node/bin/npm --version
podman version
podman compose version
infra/application.sh config
infra/application.sh status
```

API工具版本只通过application镜像升级。容器中的`HOME`只保持运行账号绝对路径一致，不覆盖任何Issue Pilot配置字段。

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
```

预期application大镜像按当前绝对项目根构建并带Healthcheck。Playwright image应ready，且没有持久application-test容器。

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

application API启动时执行Drizzle migration。数据库文件创建为 `0600`，启用 WAL 和配置的 busy timeout；migration 后启用 foreign keys。

生产升级前仍必须停止 API 并创建一致备份。不要把自动migration当作跳过备份和隔离副本dry-run的理由。

## 启动

API只通过已准备的application容器启动：

```bash
npm run server
```

容器在`http://127.0.0.1:3000`同源提供Web和API。前端迭代可另启`npm run dev:web`，Vite在`0.0.0.0:4173`监听并代理容器API；不能直接暴露到不可信LAN或Internet。

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

主应用大镜像是唯一API入口。它在一个Ubuntu 26.04 runtime容器中提供Fastify API、静态Web/Workbench、Pi、Node 26、Maven 3.9/Temurin 8、Aliyun CLI、Git 2.48或更高版本、SSH、ripgrep和curl。Web构建依赖位于`devDependencies`，multi-stage build完成后执行`npm prune --omit=dev`。`infra/application-compose.mjs`从根配置和当前绝对路径生成只有一个application service的Compose JSON；容器不包含Podman client，也不挂rootless Podman API socket。

构建宿主只需要Podman和Compose provider。准备及启动：

```bash
infra/application.sh config
infra/application.sh prepare
infra/application.sh status
infra/application.sh start
infra/application.sh logs
```

`prepare`从Containerfile中的稳定系列tag构建单一application image。`start`拒绝覆盖同名容器，通过Compose设置`on-failure:5`重启策略，并要求以下路径在容器内外完全相同：项目根、state root、`HOME`、Pi配置、npmrc/cache和Maven settings/repository。应用rootfs只读；state root与package cache读写；Pi/package manager配置只读。可选`~/.gitconfig`和`~/.ssh`只读挂载。Compose构建参数同时把镜像中UID 1000用户的passwd home设为宿主`HOME`，确保OpenSSH从该只读挂载读取known_hosts和私钥；Kubernetes镜像默认使用`/home/issue-pilot`。

停机保留容器日志供检查：

```bash
infra/application.sh stop
infra/application.sh logs
infra/application.sh remove
```

`clean`只在容器不存在时删除application image，不删除state。project-tools Unix socket会阻止两个API实例同时启动。

应用容器使用bridge网络，Fastify按`runtime.application.listenHost`监听`0.0.0.0:3000`，Compose固定发布`0.0.0.0:3000:3000`，使WSL地址及Windows端口代理可以访问。该端口不提供独立认证边界，Windows防火墙或前置可信网关必须限制不可信来源。`ProcessToolRuntime`只允许固定工具命令、收敛进程环境并清理调用级临时HOME；不会调用Podman。npm/Maven项目脚本与API同UID运行，因此大容器不是不可信代码sandbox，也没有调用级rootfs/cgroup隔离。

`SIGINT`/`SIGTERM`会触发graceful shutdown：停止maintenance、等待lifecycle/inspection队列和Agent reservation、停止Pi session、关闭项目工具broker并等待活动进程、关闭SQLite。Compose和Kubernetes的30分钟termination grace period覆盖当前项目工具上限。

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

代码栏用三个固定图标发送白名单Explorer/Search/Source Control view command；点击另一图标时显示并切换Primary Side Bar，再次点击当前图标时收起Primary Side Bar，原生Activity Bar保持隐藏。LocalProcess Workbench extension通过公开`workspace.registerTextSearchProvider`调用literal `/search`，大小写和整词选项映射到专用boolean header，regex控件和Replace全部隐藏。Source Control通过公开`scm.createSourceControl`和proposed history provider API投影`/diff` Changes及基于`/history`、`/commit`的Graph；Graph文件使用公开`workspace.registerFileSystemProvider`注册的只读revision scheme按需调用`/commit-file`并打开前后内容Diff，不提供输入框、stage、discard、commit或任意Git命令。

界面固定选择官方GitHub Dark Default和Material Icon Theme；构建只注册theme/icon静态资源，不导入Material扩展的Node main、activation event、command或configuration。打包的`markdown-language-features`只在Web Worker extension host中提供`markdown.api.render`，Workbench ready前完成预激活。标题Preview图标和Markdown Preview键盘命令打开通过`registerEditorPane()`注册的只读Editor Pane；Pane从当前只读Monaco模型调用扩展render API，DOMPurify清洗后写入隔离Shadow DOM，并复用Workbench原生Editor Group、Tab、关闭和`DomScrollableElement`。该路径不创建浏览器Webview、内容iframe或Service Worker；GitHub Dark/highlight样式随构建打包，不加载脚本或外部资源。拖放、文件粘贴和移动时更新链接均关闭。Terminal、本地/Node extension host、extension gallery、remote agent和任意Git命令不加载。

文件系统provider声明`Readonly`和`FilePermission.Readonly`，write、mkdir、delete、rename全部返回`FileWriteLocked`。API不接受绝对宿主路径。它从SQLite读取Issue Repository关系、重新推导alias，验证runtime必须是受管symlink；active dev target必须等于数据库`local_path`，read-only target必须位于合法的`git/checkouts/<hash>/<commit>`。所有最终path均realpath后再次检查Repository containment。Source route只读，不提供保存、shell、terminal或任意Git命令；Repository、path和query经百分号编码后放在专用request header而不是URL query string，响应带`private, no-store`，route关闭普通request access log，避免源码路径和搜索词进入应用或proxy URL日志。iframe用于隔离Workbench单例和生命周期，不替代外层authentication、authorization、TLS或Source API授权。

## Node/Maven项目工具

API启动Unix socket `<state>/control/project-tools.sock`，目录`0700`、socket `0600`。Writable dev runtime中的`node-project`和`maven-project` wrapper只发送Issue segment、Repository alias、相对project path、有限action和参数；broker从SQLite重新授权，客户端不能控制可执行文件、配置路径或cache路径。

Node action为npm `install|test|build|typecheck`；其他package manager、`start/dev/serve/preview`不可用，`--watch*`被broker拒绝且执行环境固定`CI=1`。Maven action为`test|verify|package`。命令统一使用application镜像中的Node 26和Maven 3.9/Temurin 8。

`ProcessToolRuntime`是唯一执行机制。它不接受image或任意可执行文件；broker传入已验证的真实project/config/cache路径，执行器为项目命令创建临时HOME。读写cache、30分钟timeout、abort和output预算继续生效。同一Issue串行，不同Issue可并行。API关闭会先停止接受新请求，再等待活动队列。

项目命令会执行Repository脚本，并与API共享application容器OS身份，可能读取该身份可读的state、Pi配置和其他workspace。因此部署只适用于可信内部Repository，package credential必须使用仅具包读取权限、可轮换的专用身份。

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

application镜像按目标架构安装官方Aliyun CLI latest。Issue Pilot不读取或修改operator持久`~/.aliyun`。

每次DMS/SLS调用都会创建调用级临时HOME并写入`0600 ~/.aliyun/config.json`，`ProcessToolRuntime`再使用该临时HOME执行当前PATH中的`aliyun`，调用结束后在finally中递归删除。运行时只允许`dms-enterprise`和`sls`命令。DMS使用`ExecuteScript`、固定central endpoint和`--secure`；SLS使用regional log endpoint。Credential不进入argv，但SQL和SLS query仍会短暂出现在API所在环境的进程参数中。详细权限和字段见[配置说明](CONFIGURATION.md#dms)。

## 安全边界

### Authentication 与网络

- Issue Pilot API 没有内置认证。
- `X-Issue-Pilot-Subject` 和页面用户切换不是认证。
- 内置代码浏览器只读但会返回内部源码；Source API与其他Issue API使用相同授权边界。
- Compose为Windows/WSL端口转发向宿主`0.0.0.0:3000`发布application端口；宿主防火墙必须只允许可信来源。
- 外部入口必须由可信代理执行 authentication、authorization 和 TLS，不能把该裸端口暴露到不可信LAN或Internet。
- `/api/config` 虽已脱敏，仍包含内部 Repository、model 和 capability scope；`/api/services/*` 写请求还可能携带新 credential，配置路由必须单独授权和审计。
- 不要直接暴露 Vite dev server 到不受信任网络。

### 宿主权限

Pi built-in tools不是OS sandbox。API/Pi必须使用专用低权限账号，不能以root运行。该账号能访问的文件、网络和credential都可能被Agent命令访问。

Agent的Pi session和npm/Maven/Aliyun子进程都与API处于同一OS身份；不要把application container误认为Agent sandbox。生产application不持有容器管理socket。Playwright application-test容器属于operator测试边界，不为Agent提供额外隔离或能力。Source browser只读HTTP边界也不能防止同一运行身份下的恶意Agent访问其OS权限范围。

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
ss -ltnp | rg ':3000'
```

预期：

- `/health` 返回 `{"ok":true}`。
- Compose只向宿主loopback发布端口，主页和`/vscode.html`由同一入口返回。
- Application image root label/Healthcheck正确，容器状态符合部署方式。
- Playwright image ready，且无持久application-test container。
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
