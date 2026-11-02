# 依赖补丁

## Pi SDK 输出保存回调

`@earendil-works/pi-coding-agent` 固定为 1.4.0。补丁只增加可选 `saveOutput(data, extension)` 回调：

- `createCodemodeExtension` 将图片与截断输出交给该回调。
- `createMcpExtension` 将二进制资源与截断输出交给该回调，包含 `read_mcp_resource`。
- 不提供回调时，SDK 原有行为不变；工具 schema、传输、发现、错误与会话格式不变。

应用回调由工作文件 owner 实现：直接在当前工单根目录生成 `0600` 文件，完成写入后原子公开。回调按工单闭包传入，支持并发会话。

`npm ci` 的 postinstall 使用固定版本安装脚本，通过 Git 校验并应用补丁，失败即停止安装；重复安装校验已应用状态。Containerfile 在 npm ci 前复制补丁及安装脚本，并将已修补的生产依赖带入最终镜像。修改 SDK 版本必须重新核对补丁、运行 fresh-install 验证及 Codemode/MCP 文件回归；不可跳过补丁后直接启动新代码。

本补丁没有提交到上游。待上游提供等价保存接口后删除补丁及对应安装逻辑。

## 已由正式版本替代的安全回补

`package-lock.json` 使用 `node-forge@1.4.2`，符合 SRT 声明的 `^1.4.0` 范围。原先仅修复嵌套 `DigestAlgorithm` 校验的 1.4.0 本地回补及安装条目已删除，不再向正式修复版叠加旧补丁。`tests/agent/forge-security.test.ts` 继续使用真实 RSA 签名验证正常 ASN.1，并拒绝包含额外嵌套元素的签名，覆盖有/无 NULL 两种形式。

DBHub 的 Azure Identity 从 4.14.0 更新至兼容的 4.14.1，其声明依赖的 MSAL Node 更新至 7.1.2，消除 [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) 对应版本告警。没有强制跨越父依赖声明范围，也没有改变应用的模型／Git／数据库凭据选择规则。

独立副本通过带 postinstall 的 `npm ci`、安全回归、完整前后端测试及构建；生产审计不再列出 Forge／Azure 告警，但仍列出 Zod/SRT 和 glob/minimatch 影响链。Zod 保留下述回补；glob/minimatch 的修复涉及父依赖兼容性，未采用审计建议的 Fastify Static 降级或强制主版本覆盖。审计并未全部通过，真实 Azure 登录、远程数据库及容器验收仍需对应部署环境。

源码和锁文件更新不自动替换运行中依赖；实际安装、发布与服务切换仍按 Runbook 授权和验收流程执行。

## Zod 集合上限前置检查

`zod+3.25.76.patch` 针对 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，采用上游 [a0ebf970](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd) 的先检查集合上限再遍历元素策略。固定包版本保持 3.25.76，不改锁文件：

- 包内 Zod 4 的 Array、Set、Map 在 leading `.max`、`.length`、`.size` 检查失败时先返回上限错误。该旧版本的 Classic/Mini 会重复初始化根类型，因此在最终初始化之后安装前置检查；同时覆盖 ESM 和 CJS。
- 包内 Zod 3 的 Array／Set 对已有上限采用同样的提前拒绝策略，这是本项目对 legacy 路径的等价扩展，并非上游 v4 补丁原文。
- 正常大小的数据与异步转换继续使用原解析器。上限前的整个集合 overwrite 不被重排；越过原始集合大小上限时不再执行元素转换和后续 refinement，错误数量减少。Set／Map 元素转换本来能合并条目的边界输入，现在也按原始大小拒绝，属于上游安全语义的变化。
- 不给没有上限的 schema 自动添加限制，不宣称消除所有大输入风险；应用与协议 owner 仍须维护字节、数量和执行预算。

`tests/agent/zod-security.test.ts` 复制补丁目标到独立临时目录，比较回补前后的六种入口、真实 MCP Client/Server 往返和 SRT 配置解析，并验证完整安装脚本的幂等、版本漂移和补丁上下文漂移拒绝。测试对共享安装中所有补丁目标做 hash 核对，不在运行服务使用的 `node_modules` 上执行安装脚本。

安装时执行同一 postinstall 版本与正反向补丁校验；已经安装并正在运行的依赖不会因源码补丁文件存在而自动变化。真实安装或部署仍按 Runbook 授权和验收流程执行。生产审计按版本仍会报告 Zod 及 SRT 的影响，不屏蔽通告，也不采用审计建议的 SRT 降级。后续升级到兼容的正式修复版时移除此回补并重新运行协议与 Sandbox 验证。
