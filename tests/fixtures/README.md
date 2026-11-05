# 测试数据

## agent-image.jpg

用于 `tests/agent/codemode.test.ts` 的图片读取、输出保存与尺寸限制回归，不作为当前产品界面截图。

- 来源：仓库原 `docs/images/workspace.jpg`，独立演示人员、工单、Pi 会话和本地 Git 数据生成，无真实业务输入。
- 原截图源码：`20e51a266d5ab5ea58c2285bd17ea664a1e988e1`；移入测试目录时保持字节不变。
- SHA-256：`13aabadf61b56cd84c78b5ce1bdcd4173d835d6721edd92d14ef4ee3d88f7ffe`。

替换前检查测试所需的格式、尺寸与追加大输出行为，替换后运行对应行为测试。不要使用生产附件、用户截图或真实凭证作为夹具。

## SSH 服务

`ssh/Containerfile` 仅用于 `npm run test:ssh`。Rootless Podman 在容器内启动 OpenSSH，应用与 SRT 留在宿主执行；镜像中的测试用户匹配当前 UID/GID。服务只绑定回环地址，容器仅挂载测试自己创建的临时目录，密钥在运行时生成，不进入镜像，也不读取真实 `.issue-pilot`。

覆盖个人密钥成功推送／读取、另一密钥认证失败和未知主机拒绝。测试关闭 daemon、个人身份目录并移除临时根，容器使用 `--rm`。本地测试镜像可缓存复用；普通用户需具备 rootless Podman 和项目所需 SRT 能力。

## SLS HTTPS 协议

`tests/integration/sls-cli.acceptance.ts` 通过 `npm run test:sls-cli` 运行真实 aliyun CLI；需要 OpenSSL 生成临时证书。本地 TLS 服务和只接受精确目标的 CONNECT 代理均绑定回环地址；凭证为固定测试字符串，不访问真实 SLS。覆盖实际响应格式、分页、失败、预算和取消，清理临时配置、证书及连接。它独立于普通单元测试执行，不能替代厂商业务验收。
