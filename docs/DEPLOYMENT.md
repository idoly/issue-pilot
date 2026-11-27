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

`restart.sh` 是当前机器的私有入口，新 clone 不自带；它调用 `~/.local/share/issue-pilot-runtime/host-runner.py`。更新 runner 的顺序见[协调发布](#协调发布后端与-web)。

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

启动时从根配置读取数据路径和监听地址；读取失败就停止。重启前先核对[停机时间预算](#停机上限30-秒)，不能把 runner 的超时当作允许的停机时间。

```bash
curl -fsS http://127.0.0.1:3000/health
```

`/health` 成功说明应用和数据库连接可用，不证明模型或外部服务可用。启动不扫描全部工单或重建历史工作区；恢复顺序和 Node 编译缓存见[启动与关闭](ai/ARCHITECTURE.md#startup-and-shutdown)。异常见[重启慢或失败](RUNBOOK.md#重启慢或失败)。

## 访问与认证

当前监听 `0.0.0.0:3000`。应用没有自带登录认证或逐工单 ACL，账号选择和 subject 头都不是认证。

对不可信网络开放前，必须设置可信认证网关：保护网页、全部 API、下载、SSE、MCP，覆盖来访身份头并阻止绕过网关直连；SSE 应关闭代理缓冲并允许长连接。当前文档不代替网关配置。

根配置 `http.identity` 决定页面能否选择账号：

- `"selectable"`（默认）：右上角可切换任意启用账号，适合本机或受控内网。
- `"gateway"`：身份由网关提供。页面隐藏账号切换，不再发送页面选择的 subject 头，并清除浏览器记住的选择。服务端拒绝缺少 `X-Issue-Pilot-Subject` 的 `/api/*` 和 `/mcp` 请求（401 `current_subject_required`），不再默认使用最早的启用账号；`/health` 和网页静态资源不受影响。

浏览器原生 EventSource 不会带页面设置的身份头，对话流也必须由网关注入身份。修改 `http.identity` 后需重启。

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

先对比**当前运行的版本**与候选版本，再选发布方式：

| 变更 | 处理方式 |
| --- | --- |
| 仅文档、测试或开发工具 | 做相应检查，不部署、不重启。 |
| 可热更新的参数 | 通过应用配置保存，核对新值和受影响行为，不重启。 |
| 仅 Web 或其构建依赖 | 与当前 API、SSE、MCP 兼容时[在线切换](#在线更新兼容的-web)；不能确认兼容就协调发布。 |
| 原版本重启；后端、运行脚本、启动配置、生产依赖或 Node 变化 | 核对根配置和产物，按下面的停机上限排空。原版本复用原产物；有变化时[协调发布](#协调发布后端与-web)。 |
| 数据库迁移、存储／Git 修复或异常恢复 | 先验证相应流程，按风险准备[恢复材料](RUNBOOK.md#当前备份策略)，另做相关的数据检查。 |

**常规验收：同一提交、同一份已验证产物，不重跑合并前已通过的测试或浏览器验收，也不逐文件比对静态资源及其 `.br`、`.gz` 版本。** 切换后核对运行版本和 `/health`，确认首页加载新入口，只检查受影响的接口或页面。产物或构建条件变化、检查失败时，才针对变化或异常项加验。清理旧资源前仍须校验当前构建清单。

### 停机上限：30 秒

需要停机的发布或重启，从**发出优雅停止请求**计时，到**用户入口的 `/health` 正常、首页及其入口资源可加载**为止，不得超过 30 秒，记录实测秒数。下载、安装、构建和预检在旧版在线时完成，清理留到恢复服务后。

停机前确认没有排队、执行中或环境准备中的工单，预约可以排空。根据同类切换实测，给排空、必要的迁移与检查点、启动和失败恢复都留出余量。**不能确认能在 30 秒内恢复，就保持旧版在线，不发停止信号。** 单进程 runner 的等待超时不是可用性保证；切换有超时风险时立即报告，按已核验的方案恢复服务，不等超时、不强杀、不跳过数据保护。

### 在线更新兼容的 Web

当前服务按请求读取 `src/web/dist`，只对外提供 `index.html` 和 `assets/`。构建为大于等于 1 KiB 的 JS/CSS 生成有收益的 `.br`/`.gz` 压缩文件，它们与原文件一起发布；缺少压缩文件时仍可读取原文件。构建同时生成不对外提供的 `.vite/manifest.json`，记录本代页面引用的全部哈希资源（含按需加载的代码块、worker 和字体）。

成功发布后只保留当前 Web 构建，不制作旧入口或清单副本。旧标签页若尚未加载某个按需资源，清理后再打开该功能可能收到 404；先保存未发送的草稿，再刷新页面。

手工更新时，`$target` 是根配置指定的运行 Web 目录，`$build` 是独立 checkout 中已验证的 `src/web/dist`。持宿主操作锁完成切换和清理，避免同时发布：

1. 用 `node scripts/prune-web-assets.ts "$build" --check-current` 校验候选。先把 `$build/assets/` 完整复制到 `$target/assets/`，不使用带删除的同步命令。已有哈希资源同名时内容应一致；稳定命名的文件（图标、许可文本）若内容变化，只有确认新旧页面均兼容才逐个原子替换，否则走协调发布。
2. 在同一文件系统内先放好临时文件，再分别原子替换 `.vite/manifest.json` 和 `index.html`，入口最后切换。确认首页能加载新入口，并检查受影响页面；验证失败则停止，不清理。
3. 即使入口和清单已是候选版本，也要检查是否残留旧产物。默认只列出待删文件，核对后再加 `--apply`：

```bash
node scripts/prune-web-assets.ts "$target"
node scripts/prune-web-assets.ts "$target" --apply
```

脚本清理当前清单未引用的哈希文件及其 `.br`/`.gz`，并移除旧流程生成的 `index.previous.html` 和 `.vite/manifest.previous.json`。不动图标目录及其他稳定命名文件。当前清单不完整、资源缺失或首页与清单不匹配时拒绝清理。

不要在运行目录构建、安装依赖或覆盖旧进程仍会读取的工具文件。

### 协调发布（后端与 Web）

先确认符合[停机上限](#停机上限30-秒)，再从已验证的独立 worktree 运行发布脚本。两个 checkout 必须干净，候选提交能快进运行目录，安装输入、状态路径、操作锁和监听地址不变。脚本核对运行版本、依赖补丁和 Web 清单；运行进程与 checkout 版本不一致时，先查明差异，不跳过预检。

```bash
candidate=/absolute/path/to/release-checkout
"$candidate/scripts/host/release.sh" \
  --root /home/idoly/issue-pilot \
  --candidate "$candidate" \
  --revision "$(git -C "$candidate" rev-parse HEAD)" \
  --checkpoint /home/idoly/.local/state/issue-pilot-host/checkpoints
```

脚本只读比较迁移日志。没有待执行迁移就不建检查点；有迁移则必须传 `--checkpoint`（已存在、0700、非符号链接的绝对目录），先在数据库副本上预演，再于停机后创建并验证检查点。脚本不轮换检查点，保留规则见[运维指南](RUNBOOK.md#当前备份策略)。

脚本持同一把宿主操作锁排空并停止旧进程，确认退出后才快进源码、切换 Web、按候选提交启动；健康检查通过后按当前清单清理旧资源。

**依赖输入变化时**：`release.sh` 在预检发现 `package.json`（含 postinstall）、`package-lock.json`、`patches/` 或 `scripts/apply-pi-sdk-patch.mjs` 与运行版本不同，会在停机前拒绝。此时手工协调，任一步失败都停止并保留现场：

1. 在独立副本准备依赖和 Web 产物（`npm ci`、补丁校验、`npm run build`），完成受影响验证和生产依赖审计。仅当锁定的安装树、脚本、补丁、Node、平台及 npm 安装选项一致时，才可复用匹配的依赖。
2. 用旧 runner 停止旧进程并等待排空：`python3 ~/.local/share/issue-pilot-runtime/host-runner.py --root /home/idoly/issue-pilot stop`。
3. 只有候选迁移日志显示待执行迁移时，才在旧进程停止后从数据库创建并验证检查点（父目录要求同上）。
4. 确认进程退出且无其他发布操作，再快进源码、切换已核验的依赖和 Web。保留 `data/`、启停脚本、Pi 配置和 SSH 身份；不制作依赖回退副本，不随应用发布升级宿主共享工具。
5. 启动新进程：`python3 ~/.local/share/issue-pilot-runtime/host-runner.py --root /home/idoly/issue-pilot start --revision <候选提交>`。runner 参数未变时使用已部署副本；参数也变化时，用候选 `scripts/host/runner.py` 启动，成功后再同步副本。
6. 健康检查通过且页面正常后，把仓库 `scripts/host/runner.py` 同步到 `~/.local/share/issue-pilot-runtime/host-runner.py`，并用 `./restart.sh status` 核对。清理本次切换暂存且已确认不再使用的旧依赖目录，只留正在使用的一套。

停机或启动失败，停止后续清理，按[恢复与回退](RUNBOOK.md#恢复与回退)处理。
