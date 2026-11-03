# 依赖补丁与安全版本

[文档导航](../docs/README.md) · [开发验证](../docs/DEVELOPMENT.md#验证)

依赖版本由 package-lock 固定，postinstall 校验补丁版本与正反向上下文。安装失败即停止，不跳过、不静默套用到新版本。容器构建复制补丁后执行同一安装流程，并携带已修补生产依赖。

## 当前补丁

| 包 | 文件 | 保留原因 |
| --- | --- | --- |
| @earendil-works/pi-coding-agent 1.5.0 | [Pi patch](@earendil-works+pi-coding-agent+1.5.0.patch) | 上游尚无等价的调用方输出保存接口 |
| zod 4.6.7 | [v3 patch](zod+4.6.7.patch) | 保留公开 v3 入口的集合上限提前拒绝保护 |

### Pi 输出保存

为 createCodemodeExtension、createMcpExtension（含 read_mcp_resource）增加可选 `saveOutput(data, extension)`。图片、二进制与截断输出通过当前 Issue 闭包交给工作文件 owner，0600 临时文件完成后原子公开；无回调时保持 SDK 默认行为。

不修改工具 schema、发现、传输、错误和会话格式，不给模型新增存储权限。上游提供等价公共能力后，应删除该补丁及安装条目，并保留 Codemode／MCP 文件回归。

### Zod v3 集合保护

Zod 4.6.7 的 v4 Classic／Mini 已正式修复 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。补丁只修改其公开 v3 导出的 ESM／CJS Array、Set：越过已有上限时先拒绝，不遍历全部元素或执行后续转换／refinement。

正常大小、异步转换与无上限 schema 保持原解析路径；不为业务自动添加上限，也不宣称消除所有大输入风险。SRT 自身使用 `zod/v3`，不是把其 schema 改成 v4。

[安全测试](../tests/agent/zod-security.test.ts) 在独立目录比较六种入口，验证正常数据、超限、异步、真实 MCP 往返／拒绝后重试和 SRT 配置；检查安装幂等、版本及上下文漂移，并核对共享安装 hash。上游 v3 若提供等价保护，应移除剩余补丁。

## 版本覆盖的范围

| 约束 | 依据与验证 |
| --- | --- |
| Zod 统一 4.6.7 | MCP／DBHub 使用正式 v4，SRT 使用包内公开 v3；覆盖旧包范围但不切换 SRT API |
| Fastify Static 的 glob 14.0.3 | 定向替代有取消缺陷的 glob，解析到已修复的 minimatch；验证预计算路由、特殊文件名与 dotfile 排除 |
| DOMPurify 与 seroval | 版本约束见 package.json，保持配套 Solid 序列化与清洗依赖 |

Node Forge／Azure 的安全修复已由锁定的正式依赖提供，不叠加旧回补。Pi 自带的 undici 约束不重复覆盖。审计不能通过降级父依赖、修改版本报告或屏蔽通告掩盖；无已知通告也不等于所有边界安全。

## 更新流程

1. 读取父依赖实际 API、上游变更与相关公告，决定兼容升级或最小补丁。
2. 在独立安装更新锁文件，检查引入／移除的依赖与安装脚本。
3. 验证 fresh install、postinstall、聚焦攻击与兼容回归、完整检查和生产审计。
4. 运行所需容器／外部环境验收，再按[发布流程](../docs/RUNBOOK.md#按风险发布与重启)激活。

源码或补丁文件更新不会自动改变运行中的依赖。不要在 live node_modules 上反向应用补丁或试验安装。
