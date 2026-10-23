# Pi SDK 输出保存回调

`@earendil-works/pi-coding-agent` 固定为 1.4.0。补丁只增加可选 `saveOutput(data, extension)` 回调：

- `createCodemodeExtension` 将图片与截断输出交给该回调。
- `createMcpExtension` 将二进制资源与截断输出交给该回调，包含 `read_mcp_resource`。
- 不提供回调时，SDK 原有行为不变；工具 schema、传输、发现、错误与会话格式不变。

应用回调由工作文件 owner 实现：直接在当前工单根目录生成 `0600` 文件，完成写入后原子公开。回调按工单闭包传入，支持并发会话。

`npm ci` 的 postinstall 使用固定版本安装脚本，通过 Git 校验并应用补丁，失败即停止安装；重复安装校验已应用状态。Containerfile 在 npm ci 前复制补丁及安装脚本，并将已修补的生产依赖带入最终镜像。修改 SDK 版本必须重新核对补丁、运行 fresh-install 验证及 Codemode/MCP 文件回归；不可跳过补丁后直接启动新代码。

本补丁没有提交到上游。待上游提供等价保存接口后删除补丁及对应安装逻辑。

## node-forge RSA 验签修复

`node-forge+1.4.0.patch` 回补上游 [PR #1152](https://github.com/digitalbazaar/forge/pull/1152) 的嵌套 `DigestAlgorithm` 元素数量检查，修复 [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。安装脚本固定版本、检查正向及反向补丁，无法匹配时停止安装。`tests/agent/forge-security.test.ts` 使用真实 RSA 签名验证正常 ASN.1，并拒绝包含额外嵌套元素的签名，覆盖有/无 NULL 两种形式。

核查时 npm 公共源最高发布版仍为 1.4.0。npm audit 根据包版本报告，因此仍会列出该包及 SRT 两项高危影响链；没有忽略公告、修改包版本或降级 SRT。待修复版正式发布，升级依赖并移除此回补。
