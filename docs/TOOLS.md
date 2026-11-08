# 本机工具

给负责准备宿主机的人员阅读。[文档导航](README.md) · [应用部署](DEPLOYMENT.md)

工具统一安装在宿主机，工单直接使用。**不要为每张工单安装一套 Node、Java、Maven 或 Python。** 管理员维护共享环境；工单不能修改它。

## 当前工具清单

下表为本次文档整理时核对的安装，不是要求每次发布都更新到最新版本。

| 工具 | 当前版本 | 入口 |
| --- | --- | --- |
| Node / npm | 26.13.0 / 11.20.0 | `/usr/local/node/bin` |
| Temurin JDK | 8u504-b01 | `/usr/local/java` |
| Maven | 3.9.16 | `/usr/local/maven` |
| Python | 3.13.5 | `/usr/bin/python3` |
| pip | 25.1.1 | `python3 -m pip`，命令也在 `~/.local/bin` |
| openpyxl / et_xmlfile | 3.1.5 / 2.0.0 | 运行用户的 Python 包目录 |
| Git | 2.56.0 | `/usr/bin/git` |
| aliyun CLI | 3.5.2 | `/usr/local/bin/aliyun` |
| 全局 Pi | 与应用 SDK 独立维护 | `~/.local/bin/pi` |
| Podman | 5.4.2 | `/usr/bin/podman`，仅用于测试 |

当前继续使用 **JDK 8**，不安装或切换 Java 25。项目要求其他 JDK 时明确报告环境不匹配，不擅自修改 POM、升级依赖或跳过测试。

## 安装系统基础工具

新机器由管理员安装；不要在运行中的机器为了重复执行文档而升级所有工具。

```bash
sudo apt-get update
sudo apt-get install --yes ca-certificates curl openssl locales python3 python3-pip \
  bubblewrap socat proxychains4 ripgrep fd-find openssh-client rsync
```

- `bubblewrap`、`socat`、`proxychains4`：工单沙箱和网络代理必需。
- `rg`、`fdfind`、SSH、rsync：搜索、仓库和文件操作。
- 内核必须允许当前运行用户使用沙箱需要的命名空间。
- Podman 按测试需要安装，不是应用部署依赖：`sudo apt-get install --yes podman`。

## 安装独立发行工具

| 工具 | 安装方式 |
| --- | --- |
| Node/npm | Node 官方 Linux amd64 发行包，安装到 `/usr/local/node` |
| Java | Eclipse Temurin 官方 JDK 8 发行包，安装到 `/usr/local/java` |
| Maven | Apache Maven 官方发行包，安装到 `/usr/local/maven` |
| aliyun CLI | 阿里云官方 Linux amd64 发行包，安装到 `/usr/local/bin` |
| Git | 当前使用本地 Debian 包 `1:2.56.0+issuepilot1`，由 dpkg 管理 |

下载后先核验官方校验和／签名，再安装。不要覆盖活动工单正在使用的目录。发行版默认 Git 不一定支持应用所需的工作树操作；只安装默认包不等于兼容验收通过。安装后按本文末尾检查版本，并运行相关测试。

全局 Pi 可通过用户级 npm 安装，不使用 sudo：

```bash
npm install --global --prefix "$HOME/.local" --ignore-scripts @earendil-works/pi-coding-agent
```

应用仍使用 `package-lock.json` 锁定并打补丁的 Pi SDK。升级全局 Pi 不升级应用依赖。

## 运行用户环境

当前机器在 `/etc/profile` 配置了环境，启停脚本也显式设置。新安装需为运行用户提供等效配置：

```bash
export JAVA_HOME=/usr/local/java
export MAVEN_HOME=/usr/local/maven
export PATH="/usr/local/node/bin:$JAVA_HOME/bin:$MAVEN_HOME/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
```

使用 `Asia/Shanghai` 时区和 UTF-8 locale；当前默认 `zh_CN.UTF-8`，保留 `en_US.UTF-8`。新机器先生成所选 locale，登录后检查 `locale charmap`。中文浏览器测试还需要浏览器环境有中文字体。

## 安装公共 Python 库

使用应用运行用户，在有 `requirements.txt` 的源码目录中执行：

```bash
python3 -m pip --version
python3 -m site --user-site
python3 -m pip install --upgrade --target "$(python3 -m site --user-site)" -r requirements.txt
python3 -c 'import openpyxl, et_xmlfile; print(openpyxl.__version__)'
```

当前用户包目录为 `/home/idoly/.local/lib/python3.13/site-packages`。Python 会自动读取，不再需要项目 `.venv`。更换 Python 主次版本或运行用户后要重新安装、验证公共库。

没有 pip 时先由管理员准备 `python3-pip` 或经过审核的 pip 安装。Debian 的系统 Python 有安装保护，普通 `pip install --user` 也可能被拒绝；以上明确写入用户包目录，不使用 `sudo pip` 或 `--break-system-packages`。

更新公共库前先确认没有活动工单依赖旧版本。缺库由管理员补装，不能让任一工单自行改变所有工单共用的环境。

## 哪些仍属于工单

| 内容 | 位置／规则 |
| --- | --- |
| 项目 Node 依赖 | 各项目 `node_modules`，不能跨项目混用 |
| 编译、测试和生成文件 | 当前工单内 |
| npm 下载缓存 | 工单根 `.npm-cache` |
| Maven 本地仓库 | 工单根 `.maven-cache`，不是公共可写的 `~/.m2/repository` |

不要将运行工具共用误解为所有项目依赖也共用。不得为了清理运行环境删除真实工单缓存或业务文件。

## 验证安装

以应用运行用户检查：

```bash
command -v node npm java javac mvn python3 git aliyun pi bwrap socat proxychains4 rg fdfind ssh rsync
node --version
npm --version
java -version
javac -version
mvn -version
python3 --version
python3 -m pip --version
python3 -c 'import openpyxl, et_xmlfile; print(openpyxl.__version__)'
git --version
aliyun version
locale charmap
```

版本和导入检查后，还要在独立 checkout 执行相关的[开发验证](DEVELOPMENT.md#验证入口与边界)。工具可运行不等于 SSH、模型、云服务凭证或任意项目已经验证。
