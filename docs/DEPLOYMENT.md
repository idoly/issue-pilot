# 部署指南

给负责安装、启动和发布应用的人员阅读。[文档导航](README.md) · [本机工具](TOOLS.md) · [运维](RUNBOOK.md)

只维护**宿主机直接部署**，不构建应用容器镜像、不使用 Kubernetes 或远端 CI。Playwright／SSH 容器只用于测试。

## 当前宿主机

Debian 13 amd64，以 `idoly` 运行。一个 Node API 在 **3000** 提供网页、HTTP、SSE 和 MCP；生产不需要 Vite 的 4173 端口。没有 systemd service、开机自启或故障自动拉起。

| 内容 | 实际位置 |
| --- | --- |
| 应用源码、依赖与 Web 产物 | `/home/idoly/issue-pilot` |
| 业务数据 | `/home/idoly/issue-pilot/data` |
| 根配置 | 应用目录中的 `issue-pilot.config.ts` |
| 本机启停入口 | 应用目录中的 `restart.sh`（调用已部署的 runner 副本） |
| 发布、启停与巡检脚本 | 仓库内 `scripts/host/{runner.py,release.sh,health-probe.sh}` |
| PID、锁和日志 | `~/.local/state/issue-pilot-host` |
| 模型目录和 Pi 资源 | `~/.pi/agent` |
| SSH 主机信任 | 运行用户的 `~/.ssh/known_hosts` |

`scripts/host/` 中的脚本随仓库维护；`restart.sh` 是当前机器的私有包装，调用已部署的 runner 副本 `~/.local/share/issue-pilot-runtime/host-runner.py`。启动参数变化时，必须用旧 runner 核验并停止旧进程，再用新 runner 启动新进程；发布成功后、下次使用 `restart.sh` 前，把仓库 `scripts/host/runner.py` 同步到该副本，并用 `./restart.sh status` 核对。不要把 `data/` 放进测试夹具或测试容器。

## 启动、停止与重启

用 `idoly` 登录，不使用 sudo 启动应用：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
./restart.sh start
```

- `./restart.sh stop`：优雅停止。超时后再次执行只继续等待，不重复发送停止信号；`status` 显示 `stopping: true`。
- `./restart.sh restart` 或 `./restart.sh`：先核对数据目录、数据库、Web 产物、依赖和根配置，全部通过才停止旧进程再启动；端口检查在停止后进行。
- `./restart.sh start`：已运行则直接返回，不重复启动。

数据目录、数据库文件、监听地址和 Web 产物位置由根配置决定，脚本启动前用 Node 读取一次；读取失败直接报错，不回落到默认值。每次启动把上一份日志改名为 `application.<UTC 时间>.log`，保留最近 5 份。

脚本**不是固定等待 600 秒**：启动后检查 health，通过立即返回，失败时最多等 600 秒；进程提前退出立即报错。停止最多等 1800 秒用于任务收尾，超时不强杀。

```bash
curl -fsS http://127.0.0.1:3000/health
```

健康检查证明应用能响应且数据库连接可用（连接关闭或失败时返回 503），不证明模型和外部服务正常。重启卡住时按[运维指南](RUNBOOK.md#重启慢或失败)排查，不按端口杀进程。

健康检查通过前会恢复数据库，并用索引处理未收尾的工单。普通启动不遍历工单记录、目录或共享 Git 快照，也不拉取远端或重建历史代码视图。读取代码时才校验所选快照。监听后等到配置的维护周期再运行容量采样和自动回收；周期为 0 时停用自动维护。

Node 使用运行用户的私有编译缓存加快后续启动，默认位于 `~/.cache/issue-pilot/node-compile-cache`，设置 `XDG_CACHE_HOME` 时使用该缓存根。服务加载后将缓存写盘，本地工具通过 Node 的 `NODE_COMPILE_CACHE_READONLY=1` 只读复用，沙箱仍禁止修改宿主缓存。缓存独立于业务数据，首次运行或缓存不可用时正常编译；`NODE_DISABLE_COMPILE_CACHE=1` 同时禁用服务和本地工具的缓存。

## 访问与认证

当前监听 `0.0.0.0:3000`。应用没有自带登录认证或逐工单 ACL，账号选择和 subject 头都不是认证。

对不可信网络开放前，必须设置可信认证网关：保护网页、全部 API、下载、SSE、MCP，覆盖来访身份头并阻止绕过网关直连；SSE 应关闭代理缓冲并允许长连接。当前文档不代替网关配置。

根配置 `http.identity` 决定页面能否选择账号：

- `"selectable"`（默认）：右上角可切换任意启用账号，适合本机或受控内网。
- `"gateway"`：身份由网关提供。页面隐藏账号切换，不再发送页面选择的 subject 头，并清除浏览器记住的选择。服务端拒绝缺少 `X-Issue-Pilot-Subject` 的 `/api/*` 和 `/mcp` 请求（401 `current_subject_required`），不再默认使用最早的启用账号；`/health` 和网页静态资源不受影响。

`"gateway"` 不是认证，也不代替网关；网关必须为每个 API、下载、SSE 和 MCP 请求注入身份头并覆盖来访值。浏览器原生 EventSource（对话 SSE）不会带页面的头，只能由网关注入，否则对话流会被拒绝。修改后需重启。

## 首次本地运行

以下只用于**独立安装目录和空数据库**，不是在现有业务目录重复初始化。

1. 准备[宿主机工具](TOOLS.md)及公共 Python 库，继续使用当前 JDK 8。
2. 获取匹配的源码与锁文件，核对 `issue-pilot.config.ts` 的数据目录、监听和初始用户。初始用户只在空用户表生效。
3. 为运行用户准备 `~/.pi/agent/models.json`，只填写真实的 provider、baseUrl、api、模型 ID 和能力；完整格式以锁定的 Pi SDK `docs/models-configuration.md` 为准。检查方法见[模型目录](ai/CONFIGURATION.md#operator-model-catalog)。模型请求 Key 随后在应用中保存。
4. 核验 SSH `known_hosts`；开发者的私钥由本人在应用中设置，不能依赖宿主 ssh-agent。
5. 在该独立目录依次执行，任何一步失败就停止：

```bash
npm ci
python3 -c 'import openpyxl, et_xmlfile; print(openpyxl.__version__)'
npm run build
node src/http/production.ts
```

`npm ci` 必须执行补丁校验。服务启动时还会核对 Pi SDK 和 zod 的运行时补丁内容，缺失时拒绝启动并提示 `dependency_patch_not_applied`（例如用了 `--ignore-scripts`）；此时重新执行 `npm ci` 或 `node scripts/apply-pi-sdk-patch.mjs`。API 首次启动会升级、初始化数据库；不用先运行 `db:migrate`。没有 `npm start`，Web build 也不会启动服务。

数据路径由根配置确定，不受当前 shell 目录影响；没有 state/database 环境变量覆盖，也不创建旧 `.issue-pilot` 兼容目录。

启动后打开网页，按[配置指南](CONFIGURATION.md)设置用户、共享模型、服务、目标和凭证。真实模型验证可能计费；测试创建的工单应明确只读范围。开发调试和不调用模型的检查见[开发指南](DEVELOPMENT.md)。

## 已有应用的部署更新

先对比**当前运行的版本**与候选版本，按下面几类叠加准备。相同候选版本已经在本机独立 checkout 验证通过，发布时复用结果和对应产物；源码、依赖或构建条件变了，重跑受影响的检查。

| 变更 | 发布前准备 | 切换及验证 |
| --- | --- | --- |
| 原版本重启 | 核对当前运行产物、配置与活动工单 | 排空后重启，检查进程和健康；复用原产物与已有验证结果 |
| 纯文档、测试或未影响运行的开发工具 | 完成相应检查 | 无运行产物要切换，无需重启 |
| 应用可热更新的参数 | 通过应用配置保存 | 核对保存后的值和受影响行为，无需发布或重启 |
| 仅 Web，且与当前 API、SSE 和 MCP 契约兼容 | 独立构建 Web，验证页面和受影响交互 | 可在线更新静态产物；检查首页、新资源及受影响页面 |
| 后端、运行脚本或启动配置 | 验证源码和受影响行为；Web 构建输入未变时沿用已验证的 Web 产物 | 排空、切换、重启；检查进程、健康、首页及受影响 API |
| 依赖、补丁或 Node 运行环境 | 依据受影响部分重新安装、校验补丁、构建和审计；准备匹配的生产依赖 | 生产依赖或 Node 变更需重启；仅 Web 构建依赖变化按 Web 发布 |
| 数据库迁移、存储／Git 修复或异常恢复 | 验证对应迁移或恢复流程，按风险准备恢复材料 | 按[运维流程](RUNBOOK.md#按风险发布与重启)做相关数据检查 |

依赖清单、锁文件、安装脚本及补丁一致，且 Node、平台和 npm 安装选项相同时，可沿用对应的依赖目录。完整依赖用于开发验证，生产目录可沿用匹配的仅生产依赖；无需为了发布再跑一次相同的安装或裁剪。需要安装或构建时在独立副本完成。核对根配置和数据位置，保留 `data/`、启停脚本、Pi 配置、SSH 身份和共享工具。应用发布不会默认升级宿主工具或公共 Python 库。

### 在线更新兼容的 Web

当前服务按请求读取 `src/web/dist`，只对外提供 `index.html` 和 `assets/`。构建为大于等于 1 KiB 的 JS/CSS 生成有收益的 `.br`/`.gz` 压缩文件，它们与原文件一起发布；缺少压缩文件时仍可读取原文件。构建同时生成不对外提供的 `.vite/manifest.json`，记录本代页面引用的全部哈希资源（含按需加载的代码块、worker 和字体）。

运行目录保留两代：`index.html` 与 `.vite/manifest.json` 是当前代，`index.previous.html` 与 `.vite/manifest.previous.json` 是上一代，供回退和已打开的旧页面继续加载。手工更新时 `$target` 是运行目录中 `src/web/dist` 的绝对路径（即根配置的 Web 产物目录），`$build` 为独立 checkout 中已验证的 `src/web/dist`。先比较 `$build` 与 `$target` 的 `index.html` 和 `.vite/manifest.json`：相同表示当前代已是该构建，跳过更新；不同才按顺序执行，否则第 1 步会用当前代覆盖真正的上一代：

1. 记录上一代：`cp -p $target/index.html $target/index.previous.html`，`cp -p $target/.vite/manifest.json $target/.vite/manifest.previous.json`。
2. 把 `$build/assets/` 完整复制到 `$target/assets/`，不使用带删除的同步命令。已有哈希资源同名时内容应一致；稳定命名的文件（图标、许可文本）若内容变化，只有确认新旧页面均兼容才逐个原子替换，否则走协调发布。
3. 在同一文件系统内先放好临时文件，再原子替换 `.vite/manifest.json` 和 `index.html`。切换后读取首页和它引用的新资源，并检查受影响页面。需要回退时原子切回上一代 HTML 和清单。
4. 确认新页面可用后清理更早的资源。默认只列出待删文件，核对后再加 `--apply`：

```bash
node scripts/prune-web-assets.ts $target
node scripts/prune-web-assets.ts $target --apply
```

脚本只删除两份清单都未引用的哈希文件及其 `.br`/`.gz`，不动目录（如 `editor-icons-*`）和稳定命名文件。任一清单缺失、清单引用的文件不存在，或清单与对应 HTML 不匹配时拒绝执行，此时按步骤 1–3 修正，不要手工删除。

后端与 Web 必须一起切换的变更，或无法证明在线更新兼容的变更，走[重启流程](RUNBOOK.md#按风险发布与重启)。避免在运行目录原地构建网页、安装依赖或覆盖旧进程仍会读取的动态工具文件。

### 协调发布（后端与 Web）

在独立 worktree 完成安装、构建和验证，再从候选目录运行发布脚本。保留运行目录当前源码，脚本在旧进程排空并退出后才快进合并。此入口适用于可快进且安装输入、状态路径、监听地址不变的发布。预检比较整个 `package.json`，仅改 npm 命令也会被拦下；此时单独核对安装输入并协调切换，不跳过预检。

```bash
candidate=/absolute/path/to/release-checkout
"$candidate/scripts/host/release.sh" \
  --root /home/idoly/issue-pilot \
  --candidate "$candidate" \
  --revision "$(git -C "$candidate" rev-parse HEAD)" \
  --checkpoint /home/idoly/.local/state/issue-pilot-host/checkpoints
```

`--checkpoint` 必须是已存在、绝对路径、非符号链接且权限 0700 的父目录；仅当候选迁移日志显示有待执行迁移时必填。脚本只在该目录下新建一份检查点，不会轮换或删除旧检查点；“保留最新及上一份”需要运维在确认新版本健康后手工完成。

1. **预检**：两个 checkout 必须干净；候选提交必须能快进运行目录。校验候选构建及运行页面的清单、资源和已安装依赖。先确认活动工单和预约可以排空：在首页执行状态和工单队列确认没有“执行中”或“环境准备中”的轮次。Engine 排空没有总时限；runner 的 1800 秒超时只表示进程保留、不会自动拉起，重跑同一发布命令会继续等待且不会重发 SIGTERM。
2. **迁移**：先只读比较数据库与候选迁移日志。仅有待执行迁移时复制在线数据库做迁移预演，并在停机后生成经过验证的检查点。
3. **停机与切换**：持同一把宿主操作锁停止旧进程，确认退出后快进源码、保留上一代页面和清单，再切换候选 Web。相同页面和清单不重复轮换。
4. **启动和清理**：启动时核对提交，健康检查通过后保留最近两代哈希资源。上线后核对首页、入口资源及受影响接口。

**依赖输入变化时**：`release.sh` 在预检发现 `package.json`（含 postinstall）、`package-lock.json`、`patches/` 或 `scripts/apply-pi-sdk-patch.mjs` 与运行版本不同，会在停机前拒绝。此时手工协调，任一步失败都停止并保留现场：

1. 在独立副本准备匹配的依赖和 Web 产物（`npm ci`、补丁校验、`npm run build`），完成受影响验证。
2. 用旧 runner 停止旧进程并等待排空：`python3 ~/.local/share/issue-pilot-runtime/host-runner.py --root /home/idoly/issue-pilot stop`。
3. 只有候选迁移日志显示待执行迁移时，才在旧进程停止后从数据库创建并验证检查点（父目录要求同上）。
4. 确认进程退出且无其他发布操作，在运行目录快进到候选提交。切换到按候选锁文件独立准备并核验的依赖，保留原依赖供回退。如果只把已有传递依赖列为直接依赖，锁定的安装树、安装选项、脚本和补丁均未变，可逐项核验后复用；不能确认就不启动。Web 产物按上一节规则切换，保留上一代。
5. 启动新进程：`python3 ~/.local/share/issue-pilot-runtime/host-runner.py --root /home/idoly/issue-pilot start --revision <候选提交>`。runner 参数未变时使用已部署副本；参数也变化时，用候选 `scripts/host/runner.py` 启动，成功后再同步副本。
6. 健康检查通过且页面正常后，把仓库 `scripts/host/runner.py` 同步到 `~/.local/share/issue-pilot-runtime/host-runner.py`，并用 `./restart.sh status` 核对。

停机失败时保留运行文件。新版本启动失败时，脚本尝试停止新进程，保留同版本源码与 Web，不自动回退单一产物。需要回退时，先确认进程及子进程已退出，核对迁移日志和上线后写入情况；将确认可运行的旧源码、依赖、HTML 和清单一同恢复后再启动。迁移已执行时按[恢复检查点](ai/STORAGE.md#restoring-a-checkpoint)评估数据恢复，避免覆盖新写入。

迁移、存储／Git 修复或异常恢复的发布仍需按[运维流程](RUNBOOK.md#按风险发布与重启)检查相关数据完整性。
