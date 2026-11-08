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
| 本机启停入口 | 应用目录中的 `restart.sh` |
| 启停实现 | `~/.local/share/issue-pilot-runtime/host-runner.py` |
| PID、锁和日志 | `~/.local/state/issue-pilot-host` |
| 模型目录和 Pi 资源 | `~/.pi/agent` |
| SSH 主机信任 | 运行用户的 `~/.ssh/known_hosts` |

`restart.sh` 和 `host-runner.py` 是当前机器的私有配套文件，不包含在普通 clone 中；发布时必须保留。不要把 `data/` 放进测试夹具或测试容器。

## 启动、停止与重启

用 `idoly` 登录，不使用 sudo 启动应用：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
./restart.sh start
```

- `./restart.sh stop`：优雅停止。
- `./restart.sh restart` 或 `./restart.sh`：先停止，再启动。
- `./restart.sh start`：已运行则直接返回，不重复启动。

脚本**不是固定等待 600 秒**：启动后检查 health，通过立即返回，失败时最多等 600 秒；进程提前退出立即报错。停止最多等 1800 秒用于任务收尾，超时不强杀。

```bash
curl -fsS http://127.0.0.1:3000/health
```

健康检查只证明应用能响应，不证明模型和外部服务正常。重启卡住时按[运维指南](RUNBOOK.md#重启慢或失败)排查，不按端口杀进程。

## 访问与认证

当前监听 `0.0.0.0:3000`。应用没有自带登录认证或逐工单 ACL，账号选择和 subject 头都不是认证。

对不可信网络开放前，必须设置可信认证网关：保护网页、全部 API、下载、SSE、MCP，覆盖来访身份头并阻止绕过网关直连；SSE 应关闭代理缓冲并允许长连接。当前文档不代替网关配置。

## 首次本地运行

以下只用于**独立安装目录和空数据库**，不是在现有业务目录重复初始化。

1. 准备[宿主机工具](TOOLS.md)及公共 Python 库，继续使用当前 JDK 8。
2. 获取匹配的源码与锁文件，核对 `issue-pilot.config.ts` 的数据目录、监听和初始用户。初始用户只在空用户表生效。
3. 为运行用户准备 `~/.pi/agent/models.json`。参考[无密钥示例](../examples/models.json)填写真实模型目录；示例域名不可直接使用。检查方法见[模型目录](ai/CONFIGURATION.md#operator-model-catalog)。模型请求 Key 随后在应用中保存。
4. 核验 SSH `known_hosts`；开发者的私钥由本人在应用中设置，不能依赖宿主 ssh-agent。
5. 在该独立目录依次执行，任何一步失败就停止：

```bash
npm ci
python3 -c 'import openpyxl, et_xmlfile; print(openpyxl.__version__)'
npm run build
node --experimental-strip-types src/http/production.ts
```

`npm ci` 必须执行补丁校验。API 首次启动会升级、初始化数据库；不用先运行 `db:migrate`。没有 `npm start`，Web build 也不会启动服务。

数据路径由根配置确定，不受当前 shell 目录影响；没有 state/database 环境变量覆盖，也不创建旧 `.issue-pilot` 兼容目录。

启动后打开网页，按[配置指南](CONFIGURATION.md)设置用户、共享模型、服务、目标和凭证。真实模型验证可能计费；测试创建的工单应明确只读范围。开发调试和不调用模型的检查见[开发指南](DEVELOPMENT.md)。

## 已有应用的部署更新

1. **独立准备**：在本机独立 checkout 安装完整依赖，验证类型、测试和 Web 构建；不能用生产数据作测试。
2. **准备产物**：在独立发布副本保留同版本源码、完整 `src/web/dist` 和生产依赖，可在该副本执行 `npm prune --omit=dev`。不在运行中的应用目录内安装依赖或原地构建。
3. **核对保留项**：核对目标根配置，保留 `data/`、启停脚本、Pi 配置、SSH 身份和共享工具，不能被测试配置覆盖。
4. **授权切换**：获得发布／重启授权后，按[运维流程](RUNBOOK.md#按风险发布与重启)排空、停止、切换、启动并验证。涉及迁移先准备相应恢复保障。

应用发布不会默认升级宿主工具或公共 Python 库。纯文档更新不重启服务。数据库备份不能恢复会话、附件和工作文件，详见[备份与恢复](RUNBOOK.md#当前备份策略)。
