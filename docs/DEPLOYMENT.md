# 部署指南

[文档导航](README.md) · [配置](CONFIGURATION.md) · [运维](RUNBOOK.md)

## 当前宿主机

当前安装在 Debian 13 amd64，以 `idoly` 直接运行 Node API，不容器化应用，不注册 systemd service，不配置开机自启或进程自动拉起。API 同源提供 Web、HTTP、SSE、MCP，监听 3000；无需单独运行 4173。

| 内容 | 实际位置 |
| --- | --- |
| 源码、生产依赖和 Web 构建 | `/home/idoly/issue-pilot` |
| 唯一业务数据根 | `/home/idoly/issue-pilot/data` |
| 根部署配置 | `/home/idoly/issue-pilot/issue-pilot.config.ts` |
| 启停入口 | `/home/idoly/issue-pilot/restart.sh` |
| 启停实现及迁移验证记录 | `/home/idoly/.local/share/issue-pilot-runtime` |
| PID、启停锁和日志 | `/home/idoly/.local/state/issue-pilot-host` |
| Operator Pi 配置 | `/home/idoly/.pi/agent` |
| SSH 主机信任和用户文件 | `/home/idoly/.ssh` |

`restart.sh` 是此次迁移安装的本机入口，通过 Git 本地 exclude 排除，不是任意新 clone 自动具有的文件。其实现 `host-runner.py` 必须与入口一起保留。根配置、生产依赖与既有 `src/web/dist` 对应迁移记录中的源码版本。`data` 已在 `.gitignore` 和 `.containerignore` 排除，不得作为测试或构建上下文。

### 启动、停止与重启

以 `idoly` 在目标机 Bash 中逐条执行，不能使用 sudo 启动应用：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
./restart.sh start
```

`start` 遇到本脚本已管理的进程直接返回，不重复创建实例。需要重启时执行 `./restart.sh` 或 `./restart.sh restart`；需要停服时执行 `./restart.sh stop`。重启先优雅关闭，最多等待 1800 秒；不会发送 SIGKILL。启动最多等待 600 秒检查 `/health`。超时保留进程与现场，先查看 `status` 和日志，不循环启动。

脚本用 PID、进程启动时间、argv 和工作目录识别自己的进程，用锁排斥重复启停，不按端口杀进程。启动会访问 Git、恢复中断状态并准备运行视图，可能在监听前等待一段时间，不能把无监听立即当作挂死。状态和日志：

```bash
./restart.sh status
curl -fsS http://127.0.0.1:3000/health
tail -n 100 /home/idoly/.local/state/issue-pilot-host/application.log
```

只保留当前和上一次启动的 `application.log`／`application.previous.log`。日志按私有业务诊断处理。health 只证明服务已可用，不检查模型、DMS、SLS 或 SSH。

### 访问与认证

目标机本机 API 地址为 `http://127.0.0.1:3000`，同源提供网页和业务接口。当前根配置监听 `0.0.0.0:3000`；本次不配置宿主机端口转发、DNS 或外部访问入口。

应用没有登录服务和逐工单 ACL。接入不可信网络前必须由网关认证并覆盖 subject 头，保护全部业务读取、下载、SSE 和 MCP，阻止绕过网关直连。SSE 关闭代理缓冲并配置长连接超时。精确边界见[HTTP](HTTP.md#身份与访问边界)。

### 系统工具、时区与中文

| 工具 | 安装入口 |
| --- | --- |
| Node 26 | `/usr/local/node/bin/node` |
| Temurin JDK 8 | `/usr/local/java/bin/java` |
| Maven | `/usr/local/maven/bin/mvn` |
| aliyun CLI | `/usr/local/bin/aliyun` |
| Git 2.56 | `/usr/bin/git` |
| 全局 Pi | `/home/idoly/.local/bin/pi` |
| 应用 Python | `/home/idoly/issue-pilot/.venv/bin/python3` |

PATH、JAVA_HOME、MAVEN_HOME 已写入 `/etc/profile`；新登录生效，已有 Bash 可 `source /etc/profile`。启停脚本另外显式设置工具环境。Git 由本地 Debian 包 `1:2.56.0+issuepilot1` 管理，替换系统旧 Git，配套文件在 `/usr/libexec/git-core` 和 `/usr/share/git-core`；保留 lazygit。其他必要系统工具包括 bubblewrap、socat、proxychains4、rg、fdfind、OpenSSH、Python venv 和 rsync。

系统时区为 `Asia/Shanghai`，默认 locale 为 `zh_CN.UTF-8`，保留 `en_US.UTF-8`。UTF-8 和中文字符宽度已验证；Hyper-V 基本控制台的字体不能保证显示中文，请用带中文字体的 SSH 终端。不要为控制台显示问题批量改写文件编码。

### GitHub HTTPS 授权

按用户授权迁入源环境已有的 GitHub 凭证，使用 idoly 的全局 Git 配置，仅匹配 `https://github.com`。凭证由 Git store helper 保存在 `/home/idoly/.config/git/github-credentials`，目录 0700、文件 0600；这是本机私有明文凭证文件，不放入项目或提交记录。

目标机已独立完成凭证读取匹配和 push dry-run，不依赖源机临时注入。该设置用于宿主用户的 GitHub HTTPS 操作，不替代应用对工单 owner 的个人 SSH 凭证选择。授权到期或被撤销后需更新，迁移不改变上游有效期或仓库权限。

### 当前维护边界

后端直接执行 TypeScript，不生成后端 dist。不要在 live checkout 安装依赖、覆盖源码或原地重建 Web。发布、恢复和数据库检查点按[运维流程](RUNBOOK.md#按风险发布与重启)。迁移包已在真实查询验收后删除，源机原数据保留但不会接收目标的新写入；不能直接启动源机作为当前实例的无损回退。

Playwright 镜像 `mcr.microsoft.com/playwright:v1.64.1-noble` 已拉取并完成页面 smoke，只用于测试。仓库的 [Containerfile](../Containerfile) 和 [Kubernetes 示例](../deploy/issue-pilot.yaml) 保留为替代部署材料，本机没有按它们部署，也没有验证它们与本机 `data` 路径的直接互换；切换部署方式需重新检查路径绑定、工具、权限和持久介质。

## 首次本地运行

以下用于 **Linux、Bash、独立安装目录、空数据库**。不是在当前业务安装上重复初始化。源码使用同一 revision 的根配置和锁文件；当前宿主机已验证 Node 26／Git 2.56，其他版本是否满足项目 API 需单独验证，不能只看能否执行 TypeScript。

1. 在独立 checkout 核对[根配置](../issue-pilot.config.ts)。选择自己的私有数据目录，监听设为 `127.0.0.1` 或实施等效隔离，将 `bootstrapUser` 改为自己的演示身份。仅用户表为空时 bootstrap 生效，不会重命名已有用户。
2. 安装上述 Linux 工具并确认内核允许非特权 namespace。按被处理项目需要准备 JDK／Maven；SLS 需要 aliyun CLI，数据库 MCP 需其实际驱动。
3. 为运行用户准备 Pi 模型目录，按[离线目录检查](CONFIGURATION.md#operator-模型目录)核对真实 provider、model 和协议；示例中的 `.invalid` 地址不可用于请求。模型密钥之后由应用写入 SQLite，不能用 Operator 登录代替。
4. 准备可信 SSH `known_hosts`。应用个人 Git 不读取 SSH config 或 ssh-agent，非默认端口写入仓库 URL。

确认独立安装尚未运行，逐行执行，失败即停止：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

`npm ci` 必须执行项目 postinstall 校验补丁。可选驱动被 npm 策略阻止的脚本需单独审查，不因安装成功就宣称其已可用。`npm run build` 只构建 Web；没有 `npm start` 或通用安装脚本。新 clone 不包含目标机的 `restart.sh`。

首次启动会迁移并 bootstrap；无需先运行 `db:migrate`。`state.directory` 相对源码根、databaseFile 相对 state；没有 state/database 环境变量覆盖。目标安装使用 `data`，其他源码版本以自己的根配置为准，不创建 `.issue-pilot` 兼容路径。

### 完成首张工单

另一个终端直连该独立实例：

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
```

浏览器打开 3000，管理员保存可用的共享模型及 Key；登记 SSH 仓库并为服务配置实际 `test` 基线分支，给工单 owner 配置个人 SSH 私钥。创建测试调查工单，明确“只读取仓库，说明一个模块用途，不修改或提交代码”。等待 Agent 从排队／运行变为空闲，检查回复、源码和 `pending` 状态，再确认解决。

该路径会调用真实模型、可能产生费用并访问远程 Git。失败时查看 workspace.lastError、owner 和范围后再重试，不重复创建。完成演示用前台 Ctrl+C 优雅关闭，数据保留。没有模型或远程 Git 条件时执行[临时夹具流程](DEVELOPMENT.md#无需真实模型的核心流程验证)，不得把它报告成真实集成成功。
