# 移除 user／service 文件配置链路

按用户要求，不再使用 user.yaml／service.yaml 管理业务配置。本轮基于 cb8f849，彻底删除其加载、导入、导出和历史转换链路；SQLite 中的配置、凭证、偏好和历史数据保持原样。当前配置页与 HTTP owner 继续直接维护数据库。

## 删除范围

- 删除 3 个 CLI／转换文件：import-configuration.ts、prepare-configuration.ts、configuration-conversion.ts。
- 删除 file-configuration.ts、file-layout.ts 及其文件模式、环境插值、旧版本转换、查询目标压缩和跨账号凭证补齐实现。
- 删除 6 个只为上述文件链路服务的测试文件，移除 user.yaml／service.yaml 两份示例。此前审查发现的命名 SLS 目标导出丢失、参考文件覆盖共享凭证两条路径随功能退役消失，不保留替代兼容入口。
- 删除应用直接 yaml 依赖和锁文件中的顶层 yaml 2.9.1 包；其余依赖版本无变化。Pi SDK 内部仍使用自己的 yaml 2.9.0，不修改第三方资源读取实现。Monaco 的 YAML 文件语法支持不属于业务配置链路，继续保留。
- 当前钉钉来源类型仅保留 mcp、url、environment 与字段映射；无执行消费者的 assignee 筛选／intervalMinutes 轮询声明退役。数据库历史 JSON 不改写。
- 更新 README、Agent／架构／存储／开发／配置／部署／Runbook 及当前设计说明，移除已删除命令的操作指引。历史发布 review 和私有恢复记录保留过去的事实，不作为当前操作入口。
- examples/mcp.json 保留为标准 MCP JSON API 示例，删除仅供旧文件导入器使用的 MySQL 无连接模板项；MySQL 目标仍由服务 owner 生成部署所属连接。

## 保留边界

根 issue-pilot.config.ts 负责路径、端口和预算，不属于旧 user／service 文件配置。Pi 全局模型／资源文件、标准 MCP mcpServers JSON API、全局 Agent／服务／仓库／个人凭证接口、数据库偏好和已有 MySQL 私有 stdio 模板均保持其现有用途。

不自动读取 state root 的 mcp.json，也不读取或转换旧 user／service 文件。真实 state 中的旧文件是未知私有恢复材料，本轮不删除它们、不将它们作为测试夹具、不替换数据库值，也不进行数据库迁移。原有配置从 SQLite 持久化恢复；缺失配置不能从旧文件或其他身份自动补齐。

## 验证

- 在独立源码副本执行 npm ci --offline，正常运行安装补丁，没有跳过 postinstall。顶层 node_modules/yaml 不存在；SDK 传递 YAML 包存在，锁文件中其他包版本未变。共享安装和线上依赖未修改。
- 该干净安装下类型检查、构建通过；全量后端 523 项（522 通过、1 项 SSH fixture 环境跳过），Web 27 文件、221 项通过。
- 删除的测试只覆盖已退役功能。保留当前 API 的事务／凭证隐私／命名多目标／权限／重启持久化验证；旧文件不会覆盖 SQLite 的回归继续写入无效的旧文件，验证启动不解析它们。
- 钉钉失败路径用另一个数据库 MCP 服务验证不自动回退，不再构造文件配置；其最终调整单独运行 DingTalk、页面配置和 MCP HTTP 回归。
- 使用独立数据库、独立安装和构建页面，在 1440／390 Chromium 验证：旧文件存在且格式无效时正常启动；个人模型凭证经 API 保存；仓库跳转服务；正式分支保存及开发继承；MySQL 私有值保留且普通 GET 不暴露；端点可读，无 pageerror／全页溢出。
- 生产依赖 audit 仍报告既有 SRT／node-forge／Zod 3 个 high 包项和固定回补，不隐藏告警；pip check 通过。
- 活动源码、脚本、测试、依赖及操作文档中无已删除模块／命令的引用，文档链接检查及 git diff --check 通过。临时服务器、数据库、安装副本、构建与容器已清理，验证结果单独保留。

本轮未提交、推送或部署，线上仍为 414ecfb；原来已推送的 cb8f849 旧迁移入口清理作为本分支基线保留，没有改写其提交。SSE 慢客户端预算问题不在本次删除范围内。
