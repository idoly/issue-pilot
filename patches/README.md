# Pi SDK 输出保存回调

`@earendil-works/pi-coding-agent` 固定为 1.3.0。补丁只增加可选 `saveOutput(data, extension)` 回调：

- `createCodemodeExtension` 将图片与截断输出交给该回调。
- `createMcpExtension` 将二进制资源与截断输出交给该回调，包含 `read_mcp_resource`。
- 不提供回调时，SDK 原有行为不变；工具 schema、传输、发现、错误与会话格式不变。

应用回调由工作文件 owner 实现：直接在当前工单根目录生成 `0600` 文件，完成写入后原子公开。回调按工单闭包传入，支持并发会话。

`npm ci` 的 postinstall 使用固定版本安装脚本，通过 Git 校验并应用补丁，失败即停止安装；重复安装校验已应用状态。Containerfile 在 npm ci 前复制补丁及安装脚本，并将已修补的生产依赖带入最终镜像。修改 SDK 版本必须重新核对补丁、运行 fresh-install 验证及 Codemode/MCP 文件回归；不可跳过补丁后直接启动新代码。

本补丁没有提交到上游。待上游提供等价保存接口后删除补丁及安装脚本。
