# 审查修复记录（基于 c35d2ec）

本次修复接续 [HEAD b5c0971 审查](head-b5c0971-systematic-review.md)，并核对 `c35d2ec` 的复核结果。历史报告描述当时 HEAD，保留原结论；本记录说明本次提交的最终行为和验证，不把历史失败探针计作当前失败。

本提交整合工作区已有的相关修复，补齐模型认证头、批量查询、测试发现和缓存卷权限处理。未修改迁移历史，未升级依赖，未重启或部署服务。用户修改的 Skill/Reference 及另一份未跟踪历史报告未纳入提交。

## 问题与最终行为

| 审查项 | 修复及对应验证 |
| --- | --- |
| H01 身份失配 | 同一请求的默认 subject 只解析一次，首次并行检查共享解析，后续重新检查该用户活跃状态与角色；MCP 向内部 API 显式传递固定身份。覆盖停用、等待与内部 dispatch。 |
| H02 发布提交点 | 临时文件关闭及最终取消检查发生在 rename 前，元数据从临时句柄读取并验证，rename 后不再通过 stat 使已发布操作返回失败；output/MySQL/DMS 传递取消信号。覆盖旧交付保留及取消窗口。 |
| H03 Operator 认证头 | 个人模型 runtime 移除 provider/model 的继承 apiKey 和整个自定义 headers 组，SDK 最终请求仅使用个人 Key；请求捕获回归覆盖任意认证头名称。共享 endpoint/模型参数继续使用。依赖 Operator 自定义路由头的模型需明确个人接入协议，不能继续混用私有头。 |
| H04 SQL 参数上限 | DB owner 提供每批最多 500 个值的顺序查询；工单摘要和只读 runtime 仓库加载复用，保持完整列表与原顺序。实际 SQLite 33,000 工单回归验证无丢失/重复；hydration 仓库查询真实执行，单工单 runtime 准备替换为断言夹具，避免创建 33,000 个 Git runtime。 |
| H05 测试发现 | 递归 glob 加引号交给 Node，包含 tests 根目录和子目录，开发文档使用同一入口。 |
| H06 缓存卷权限 | 默认缓存改为 `.npm/issue-pilot`、`.m2/repository/issue-pilot`；broker 以应用 UID 创建私有目录，继续拒绝已有不安全 owner/mode。0700 子目录可在模拟 fsGroup 的 2775 卷根下使用，不 chmod 卷根或自动搬迁旧缓存。实际 Pod 验收仍未执行。 |
| H07 凭证校验 | 完整校验本次模型/SSH/生产组后再关闭预约的会话；无效输入不打断会话、不写凭证。 |
| H08 密码空白 | 原生密码通过校验后按原字符串保存及执行；覆盖 replace/preserve 和 driver 入参。旧版本已裁剪的值无法还原，需重新填写。 |
| H09 MQ 字面目标 | 不 trim 队列名；拒绝会被 URL 归一化的 dot segment，其他名字分别编码。 |
| H10 同名 MySQL 列 | 查询/导出统一 fields 检查，重复列名明确拒绝并要求 AS 别名；包括空结果。失败不覆盖旧成果。 |
| H11 清理异常 | MySQL 查询/rollback/close 与 Agent session/Git cleanup 保留主错及清理错，单错保留原对象，调用方取消保留原原因。 |
| H12–H14 Git | 远程基线使用完整 ref；共享 checkout 复用检查 ignored/untracked；仅明确不存在的返回码视为分支缺失，损坏 ref/object 保留错误，不远程 fallback。 |
| H15–H17 Source | blame 先拒绝非普通文件；Git blob 严格 UTF-8 解码，允许合法 U+FFFD；共享 DTO 明确 head/index/working-tree 来源。 |
| H18–H20 Web | 保存/加载绑定身份及生命周期世代，A→B→A 不接受旧任务；卸载后不关闭新弹窗或导航；评论只清除仍与提交内容相同的草稿；新创建和重开弹窗使旧列表/候选请求失效。 |
| H21 长文件名 | 同目录临时文件使用固定长度随机名，长 ASCII/Unicode 名正常保存，冲突及清理语义保留。 |

同批已有补丁还保留了 broker 并发启动/关闭共享清理结果、SSE 每轮批量移除已发送帧、Source `..notes` 合法路径及响应契约统一等修复；相应行为回归随完整套件执行。SSE 改动不宣称生产性能收益。

## 验证

- 重点测试：31 项通过。
- 后端全套：445 项通过，0 失败、0 跳过；按开发文档使用 `--test-concurrency=2` 和 Node 原生递归发现。
- 前端全套：26 文件、235 项通过，`--maxWorkers=1`。
- `npm run typecheck`、独立目录 `npm run build`、生产依赖审计、Python `pip check` 均退出 0；审计未报告已知漏洞。
- 真实 Chromium：独立项目副本、临时 DB/Git、假 Agent；桌面/移动页面、工单打开、Monaco 加载、源文件自动保存、配置页与许可资源均通过，无 pageerror/非 favicon HTTP 错误。临时服务已停止，临时状态已删除。
- 浏览器工具/镜像就绪，无残留应用测试容器；现有部署只读 `/health` 返回 200，不能视为本提交已部署。
- `git diff --check` 通过，Skill/Reference 哈希保持本轮开始时的版本。

原始验证日志在本机 `/tmp/issue-pilot-fix-validation`，不作为长期可用的仓库资源；关键回归保留在项目测试中。未连接真实生产模型/MySQL/DMS/SLS，未构建启动 Node 26 镜像或实际 Kubernetes Pod。测试证明所列场景，不代表所有并发组合或外部服务行为均已穷尽。
