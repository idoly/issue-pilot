# 配置管理实现与验收

配置页已按确认的流程实现：用户 → 仓库 → 服务 → 端点，默认进入用户。代码位于 `design/configuration-workflows`，当前未提交、未部署；真实 state root、线上数据库与 Git 工作区没有改动。原型和本次实现一并保留，便于对照。

[桌面／手机截图](configuration-workflows/index.html) · [机器验证记录](configuration-workflows/verification.json) · [配置说明](../CONFIGURATION.md) · [切换与导入流程](../RUNBOOK.md#页面配置切换与显式导入)

## 实现

- 用户页支持搜索、隐藏停用人员、新建、编辑、角色／管理权限和启停；保留现有活跃用户、管理者与至少一名开发管理者的业务保护。API Key、SSH Key、DMS、SLS 使用直接输入弹窗，空值保留、显式清除、失败保留输入；身份变化丢弃旧身份草稿并忽略迟到响应。
- 仓库页按地址排序，登记／编辑显示名和地址，查看引用服务并跳转；服务 Tab 的选择同步给导航 owner，可重复从仓库跳转同一服务。未使用仓库提供删除，历史占用仍由后端保护。
- 服务保留顶部 Tab、固定操作、分支矩阵和描述。开发基线从正式部署读取，不存独立覆盖；正式分支草稿立即更新开发显示。已存在工单继续使用记录的分支、commit 和路径。
- MySQL、DMS、SLS 支持环境目标维护。目标添加自动聚焦，稳定保留其他字段、滚动和输入位置。MySQL 密码仅开发者选定服务的私有读取返回，普通配置 GET 返回 passwordConfigured；DMS Authorization、SLS 密钥继续不回显。服务描述去掉内部 DMS ID／地址，以及重复的部署 MySQL MCP 列表。
- 页面编辑携带 revision，旧版本返回 configuration_changed，保留草稿并提供重新加载。现有 API 调用仍可省略 expectedRevision；需要冲突保护的调用方应始终携带。

## 存储与生命周期

SQLite 成为业务配置唯一来源。正常启动删除文件投影和管理锁，旧 YAML／JSON 不覆盖页面保存，钉钉请求改读数据库偏好。追加迁移 0063 新增 user_preferences、application_settings，给用户、凭证、仓库、服务添加 revision，并为部署生成的 MCP 条目增加 deployment_id 外键；已发布迁移未改写。

MySQL 目标属于 service_deployments.config.mysql，生成连接由小型配置 owner 在同一事务维护。密码放在私有环境变量，不进入 argv，写操作开关固定关闭；通用 MCP 编辑／删除不能修改部署生成条目。工具全局可见，因此 MySQL 连接声明变化预约所有工单并关闭旧会话；不改变连接的普通服务修改仍按原服务／环境范围预约。

新增显式离线导入命令，使用实例租约，运行中的 API 会拒绝导入。导入失败回滚配置且不改原文件；相同输入重复导入不改写凭证、服务或连接。部署内容变化也更新服务 revision。导出默认只读数据库，历史 reference 文件必须显式指定。钉钉来源／字段偏好已入库和支持离线导入／导出，本次未增加单独的偏好编辑器。

保留单 Node 应用、现有配置 scope queue 和 Issue reservation 顺序、Pi／SRT／Git 文件边界，没有新增运行框架、数据库配置引擎或依赖。

## 验证

- `npm run typecheck`：通过。
- 全量后端 `node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'`：533 项，532 通过、1 项 OpenSSH fixture 环境跳过、0 失败。
- 全量 Web `vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1`：26 文件、208 项通过。
- `npm run build -- --outDir /tmp/issue-pilot-implementation-build --emptyOutDir`：通过，产物仅用于独立演示服务。
- `git diff --check`：通过。
- 真正 API + Chromium，1440／390：人员创建及启停、个人凭证保存、仓库登记和服务导航、开发只读／正式联动、MySQL 私有加载与保存、DMS／SLS 添加移除焦点、草稿／滚动保持、SLS 多目标保留、公开投影隐私、页面刷新、端点格式、无全页溢出、无 pageerror。
- 永久回归覆盖实际重启和旧文件不覆盖、角色读取限制、MySQL 回滚及归属、全局工具预约、旧版本拒绝、导入租约与失败回滚／重复调用，以及既有开发分支保留。
- Python `pip check` 通过；已有线上 `/health` 和 Web 返回 200，仅检查可用性，不代表已部署新功能。

生产依赖 audit 仍报告已有的 3 个 high 包项：SRT、node-forge、Zod，沿用已安装的固定 backport，未改变依赖或隐藏告警。没有使用真实 MySQL／DMS／SLS 账户做连接验证；浏览器使用独立临时数据库和演示目标，既有协议测试仍全部执行。SSH 端到端 fixture 需要可用 OpenSSH server。

## 上线条件

首次切换需按 Runbook 在一致备份后停服，用新版本显式导入原文件，再启动和核对偏好、凭证组、MySQL 归属、DB integrity／FK 与已有工单 Git 事实。旧开发分支声明需在上线前对比并保留证据；只改变未来基线，不能用当前正式分支重置旧工单。回滚需要匹配的完整状态恢复。本次尚未执行这些真实状态操作。
