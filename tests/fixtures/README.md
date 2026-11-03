# 测试数据

## agent-image.jpg

用于 `tests/agent/codemode.test.ts` 的图片读取、输出保存与尺寸限制回归，不作为当前产品界面截图。

- 来源：仓库原 `docs/images/workspace.jpg`，独立演示人员、工单、Pi 会话和本地 Git 数据生成，无真实业务输入。
- 原截图源码：`20e51a266d5ab5ea58c2285bd17ea664a1e988e1`；移入测试目录时保持字节不变。
- SHA-256：`13aabadf61b56cd84c78b5ce1bdcd4173d835d6721edd92d14ef4ee3d88f7ffe`。

替换前检查测试所需的格式、尺寸与追加大输出行为，替换后运行对应行为测试。不要使用生产附件、用户截图或真实凭证作为夹具。
