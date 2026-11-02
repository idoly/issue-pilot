# 依赖补丁

## Pi SDK 输出保存回调

`@earendil-works/pi-coding-agent` 固定为 1.5.0，补丁文件为 `@earendil-works+pi-coding-agent+1.5.0.patch`。1.5.0 尚未提供调用方输出存储接口，原补丁已核对并迁移；补丁只增加可选 `saveOutput(data, extension)` 回调：

- `createCodemodeExtension` 将图片与截断输出交给该回调。
- `createMcpExtension` 将二进制资源与截断输出交给该回调，包含 `read_mcp_resource`。
- 不提供回调时，SDK 原有行为不变；工具 schema、传输、发现、错误与会话格式不变。

应用回调由工作文件 owner 实现：直接在当前工单根目录生成 `0600` 文件，完成写入后原子公开。回调按工单闭包传入，支持并发会话。

`npm ci` 的 postinstall 使用固定版本安装脚本，通过 Git 校验并应用补丁，失败即停止安装；重复安装校验已应用状态。Containerfile 在 npm ci 前复制补丁及安装脚本，并将已修补的生产依赖带入最终镜像。修改 SDK 版本必须重新核对补丁、运行 fresh-install 验证及 Codemode/MCP 文件回归；不可跳过补丁后直接启动新代码。

本补丁没有提交到上游。待上游提供等价保存接口后删除补丁及对应安装逻辑。1.5.0 已自行固定 `undici@8.12.3`，应用移除了重复的 undici override，依赖解析结果保持不变；不是取消安全版本约束。

## 已由正式版本替代的安全回补

`package-lock.json` 使用 `node-forge@1.4.2`，符合 SRT 声明的 `^1.4.0` 范围。原先仅修复嵌套 `DigestAlgorithm` 校验的 1.4.0 本地回补及安装条目已删除，不再向正式修复版叠加旧补丁。`tests/agent/forge-security.test.ts` 继续使用真实 RSA 签名验证正常 ASN.1，并拒绝包含额外嵌套元素的签名，覆盖有/无 NULL 两种形式。

DBHub 的 Azure Identity 从 4.14.0 更新至兼容的 4.14.1，其声明依赖的 MSAL Node 更新至 7.1.2，消除 [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) 对应版本告警。没有强制跨越父依赖声明范围，也没有改变应用的模型／Git／数据库凭据选择规则。

Zod 统一锁定 4.6.7，包含正式的集合上限安全修复。MCP／DBHub 使用其 Zod 4 API，SRT 已自行导入公开的 `zod/v3` 入口，因此覆盖 SRT 的旧包范围不会把其 schema 切到 v4；仍保留下述 v3 加固，不引入转换包装。Fastify Static 定向覆盖 `glob@14.0.3`，其 minimatch 解析到 11.0.4；原 glob 13 的取消缺陷与旧 minimatch 的放大问题均由正式版修复。glob 的主版本覆盖仅作用于 Fastify Static，并通过真实预计算路由、带空格／方括号文件名和隐藏文件回归验证其所用 API，不采用审计建议的 Fastify Static 降级。

独立副本验证带 postinstall 的 fresh install、安全回归、完整前后端检查和生产审计；不能仅用版本号代替协议、SRT 或授权验证。真实 Azure 登录、远程数据库及完整容器验收仍需对应部署环境。

源码和锁文件更新不自动替换运行中依赖；实际安装、发布与服务切换仍按 Runbook 授权和验收流程执行。

## Zod v3 集合上限加固

`zod+4.6.7.patch` 只修改包内公开 v3 入口的 ESM／CJS Array 和 Set：超过已有 `.max`／`.length`／`.size` 时先拒绝，再决定是否遍历元素。正式版 v4 Classic／Mini 已修复 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，不再叠加原 3.25.76 包的 v4 回补；旧补丁删除。保留 v3 加固是为了不因换包退回原先已受保护的行为，并非应用恢复旧版 Zod 依赖。

正常大小的数据、异步转换和无上限 schema 沿用原解析器；越过原始集合大小上限时不执行元素转换和后续 refinement。不为无上限 schema 自动添加限制，也不宣称消除所有大输入风险，应用与协议 owner 仍须维护字节、数量和执行预算。

`tests/agent/zod-security.test.ts` 在独立临时目录比较六种入口：原生 v4 已提前拒绝，v3 加固后也只报告上限错误。还覆盖真实 MCP Client/Server 的正常请求、超限拒绝后重试及 SRT 配置解析，验证安装幂等、版本与上下文漂移拒绝，并核对共享安装 hash，绝不在运行服务的依赖上反向应用补丁。若上游 v3 入口提供等价保护，应删除这份剩余补丁并保留行为回归。

postinstall 固定 4.6.7 并执行正反向补丁校验。源码、锁文件或补丁存在不代表运行中依赖已切换，实际安装和部署仍按 Runbook 授权和验收流程执行。
