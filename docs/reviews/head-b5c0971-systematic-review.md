# HEAD 版本级系统审查

审查目标：`b5c0971aeb35d30280ebed05c3905014bead88db`（HEAD，2026-10-19）。

**结论：不通过。全量范围检查已完成，存在必须修复的身份一致性和成果发布缺陷。**

清单的 337 项均已有明确检查或排除记录，无 pending 项。报告按根因整理 21 项问题，其中 H06 为有模式复现支持的可预测部署风险，未宣称实际 Pod 失败；其余问题有 HEAD 运行复现及源码对照。通过原有测试、构建和浏览器正常路径，不能消除这些边界缺陷。

本次按工作区当前 `code-design-review` Skill 执行只读审查。范围为该提交全部 337 个已跟踪文件，覆盖源码、配置、构建、数据库脚本及相关测试，并核对文档、静态资源与第三方资源的集成。逐文件状态见 [覆盖清单](head-b5c0971-coverage.md)。第三方源码、生成快照和截图另列排除项，不计作人工全文审阅。

工作区存在此前未提交的修复和用户更新的 Skill/Reference。本次使用 `git archive HEAD` 导出的独立快照审查与验证。已有补丁不属于审查目标，也不作为 HEAD 验证结果；本阶段没有修改项目源码、配置、依赖或真实 `.issue-pilot`。

## 覆盖与方法

逐文件清单记录 221 项全文审阅、104 项测试结构/断言审阅、2 项结构化检查、4 项历史证据集成、1 项许可集成，以及 5 项明确排除。排除的是 2 张文档图片、1 个生成 schema snapshot 的内容和 2 个未改动 vendored 内容；后两类仍检查了引用、来源或生成集成。

| 范围 | 文件数 | 完成方法 |
| --- | ---: | --- |
| 自有源模块 | 124 | 后端与 Web 全文审阅，追踪调用、规则 owner、状态和失败边界 |
| 测试及 fixture | 114 | 10 个全文（含全部 6 个 helper/setup）；104 个逐文件全部声明/断言及捕获调用对照，结合源码和全量执行 |
| 迁移 | 60 | 59 个 SQL 全文，journal 结构化及数据库运行验证 |
| 配置/构建、文档 | 11 + 11 | 全文，核对配置、部署、脚本、资源加载与当前 owning code |
| 样式/静态资源 | 7 | 6 个全文；未改动第三方 SVG 只审来源/许可/集成 |
| 依赖锁、历史证据、许可 | 1 + 4 + 1 | 全条目版本/结构、引用与发布集成检查，排除第三方实现内容 |
| 其他排除 | 4 | 2 张图片、生成 snapshot 内容、vendored 提示词内容；范围明示于清单 |

测试方法不是抽取少量用例：全部 108 个测试文件的测试声明和断言均已对照，全部 6 个 helper/setup 均全文读取。**不声称人工逐行检查了测试文件中的每一行 fixture 数据，也不声称取得分支/语句 100% 覆盖。**

已完成后端自有源码各 owner 的全文检查，包括 domain/db/configuration/http/agent/capabilities/workspace/outputs/process/MCP；59 个已发布迁移 SQL 均已逐条读取。迁移 journal 的 59 个 tag 与 SQL 一一对应，序号连续、时间递增；隔离空数据库迁移后 integrity 为 `ok`，FK 开启且无 FK violations。全部 240 个 TS/TSX/MJS 模块完成 AST 解析与本地依赖图检查，未发现解析错误和静态运行时导入环；此项不代表所有模块的语义审阅已完成。

快照、原始清单、脚本和临时证据位于 `/tmp/issue-pilot-head-review.vgU3FH`。报告中的源码行号均指上述 HEAD，不指含补丁的工作区。

## 已完成的 HEAD 验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 原后端脚本所选文件 | 83 个文件、390 项通过，退出 0 | `evidence/backend.log` |
| 脚本遗漏的根目录测试 | `tests/tool-runtime.test.ts` 3 项通过，退出 0；后端合计已执行 84 个文件、393 项 | `evidence/root-test.log`、`test-discovery.json` |
| 原前端套件 | 24 个文件、212 项通过，退出 0 | `evidence/web.log` |
| Typecheck、Build | 均退出 0 | `evidence/typecheck.log`、`build.log` |
| npm 生产依赖/全部依赖审计 | 均退出 0，漏洞计数均为 0 | `evidence/audit-production.json`、`audit-all.json` |
| Python `pip check` | 退出 0 | `evidence/python-dependencies.log` |
| 安装依赖与 HEAD 锁文件一致性 | 478 个已安装条目均一致，71 个 optional 条目未安装；无非 optional 缺失/版本差异 | `evidence/dependency-consistency.json` |
| 浏览器 harness 状态 | playwright-core 与镜像均 ready，最终无残留应用测试容器 | `evidence/browser-status-final.log` |
| 真实 Chromium 检查 | 桌面/移动页面、工单打开、真实 Monaco、临时源文件自动保存、设置页、许可资源 200；无 pageerror/非 favicon HTTP 错误 | `evidence/browser/browser-result.json` |
| 隔离浏览器服务清理 | 核对拥有的 PID 后停止，临时状态目录已删除 | `evidence/browser-cleanup.json` |
| 现有部署可用健康 | `/health` 200、API/Web supervisor active；不能证明部署版本等于 HEAD，未重启 | `evidence/available-health.json` |
| 独立后端补充探针 | 105 项，73 通过、32 失败 | `evidence/probes.log` |
| 独立前端补充探针 | 28 项，9 通过、19 失败；首次配置错误未计入结果 | `evidence/web-probes-retry.log` |
| 33,000 条工单边界探针 | 复现列表 500；数据库前后 integrity/FK 正常 | `evidence/schema-and-scale.json` |
| 个人模型请求头探针 | 已构造请求同时携带个人 Authorization 和自定义 Operator token；无外网请求 | `evidence/personal-model-headers.json` |

浏览器检查使用独立构建输出 `web-build` 和临时状态；首次隔离服务误指默认 dist 路径而未启动，修正到既有产物后完成了表中的检查，不计作应用缺陷。浏览器截图保存在临时证据目录的 `evidence/browser/`。

补充探针从现有回归用例独立改写导入后运行，位于快照外；它们不是 HEAD 自带测试。失败数不等于独立缺陷数，部分断言针对新增的取消接口，不能仅凭这类失败认定 HEAD 现有接口违约。取消问题以实际 `publish_output` 路径和源码提交顺序为证据。前端部分探针在较早的 UI 状态断言即失败，尚未到达其后续异步竞态断言；以下不把未到达的行为写成已复现。两项仓库身份探针要求身份变化自动重载，但实际目录是全局公开数据，本报告不据此单列跨身份数据泄露；保留的是 H20 中真实到达断言的旧列表覆盖新列表问题。

## 已确认问题与部署风险

### H01：默认身份在排队后重新选择，初选主体与重授权主体失配

- **级别：阻断 / P1。** 位置：`src/http/route-context.ts:32`，关联 `src/http/user-routes.ts`、`src/mcp/server.ts:55`。
- **证据：** 每次 `requireCurrentUser` 对无显式 header 的请求重新选择最早的 active 用户，没有固定本次请求初选 subject。原探针返回 200；补充记录确认等待后默认身份已是 B，但凭证仍写入初选且已失活的 A，而非 B（`identity-write-target.json`）。MCP 内部 `/api/me` 分派也转而返回下一名 active 用户。
- **影响与触发：** 无显式身份 header、请求等待 scope/reservation 或 MCP 内部分派时，用户集合发生变化，重授权可能切换身份。已有用户角色检查并不能防止该身份混淆。
- **最小修复与取舍：** 在请求首次选择时固定 subject；等待后重新读取该 subject 的 active/role，失效即拒绝。MCP 将已固定 subject 显式传给内部 HTTP 请求。保留等待后的重授权，不缓存旧角色。
- **验证：** 固定初选、并行首次查询、等待期间停用、角色变化、凭证确实未写入其他用户，以及 MCP 内部请求的一致身份。

### H02：成果在最后校验失败前已经覆盖旧交付，取消也可越过发布边界

- **级别：阻断 / P1。** 位置：`src/outputs/store.ts:107`，关联 `src/agent/output-tool.ts`。
- **证据：** `generate` 先 `rename(temporary, target)`，随后才读取/校验新文件元数据。注入最终 metadata 读取失败后，调用失败但旧文件内容已变成新内容；权限失败后旧交付同样未保留。实际 `publish_output` 路径在临时文件 close 期间取消仍成功发布。见 `probes.log`。
- **影响与触发：** 交付覆盖时的最终 stat/权限错误或最后窗口中的取消，造成调用方收到失败/取消语义但旧交付已被替换，违反失败保留旧成果的契约。
- **最小修复与取舍：** 在 rename 前完成临时文件的类型、权限、metadata 和最后取消检查；rename 作为提交点，其后不再执行可令发布整体失败的元数据读取。提交后到达的取消须按已提交处理，保留工作源文件。
- **验证：** open/producer/close/metadata/权限失败、排队取消、提交前取消及重复覆盖；避免把新增 store 参数的测试单独当作现有 API 的证据。

### H03：个人模型 runtime 按少数名称删认证字段，仍继承自定义 Operator 认证头

- **级别：阻断 / P2。** 位置：`src/agent/model-runtime.ts:52`。
- **证据：** JSON reviver 只删除 `apiKey` 和四类已知 header 名称。隔离 `models.json` 配置 `X-Operator-Token` 后，通过 HEAD 的个人 runtime、`PiSessionRuntime` 和 SDK 请求构造，捕获到 `operatorHeaderForwarded: true`、`personalAuthorizationForwarded: true`。探针仅在 `fetch` 边界捕获并停止，没有向真实模型服务发送请求。`operatorHeaderInModel` 为 false 不代表未发送，实际 transport 捕获才是此结论依据。
- **影响与触发：** Operator 模型配置使用自定义认证头时，个人模型请求仍混入该认证凭证。如上游据此鉴权，会混用 Operator 身份；本探针未验证真实服务最终选择哪个认证头，不将此条件性影响写成已发生的计费或越权。
- **最小修复与取舍：** 明确个人认证组与共享非敏感模型参数的边界；个人 runtime 只继承明确允许的公共头，认证组由个人凭证完整提供。继续增加猜测的 secret header 黑名单无法穷尽自定义协议；处理时需兼容确有用途的公共路由/版本头。
- **验证：** 自定义认证头、常见已过滤头、公共头、个人 key 缺失/错误，以及 SDK 最终请求中的身份凭证，不能只检查 `getAuth()`。

### H04：未分页的工单列表突破 SQLite 参数上限后整体 500

- **级别：阻断 / P2。** 位置：`src/http/issue-routes.ts:126`、`:152`；同类批量 ID 查询包括 `src/workspace/project.ts` 的只读 runtime hydration，后者未作同规模启动复现。
- **证据：** 使用独立根和 fixture 插入 33,000 条满足 scope/Workspace 数据库约束的合成工单；未逐个准备磁盘工单目录，列表路径本身也不读取这些目录。`GET /api/issues` 返回 500、`internal_error`。运行库编译选项为 `MAX_VARIABLE_NUMBER=32766`；相同参数形态的独立查询报 `SQLITE_ERROR`，确认 `too many SQL variables`。数据库前后 integrity `ok`、无 FK violations，排除结构损坏导致失败。两次列表观测约 330/351 ms，只用作复现时长，不作为通用性能基准。
- **影响与触发：** 长期保留的工单总数超过参数限制时，整个列表及依赖它的 MCP search 无法使用；无需并发或异常数据。不是单纯的“可能慢”。
- **最小修复与取舍：** 用关联查询或有界批次加载 summaries，先保持现有返回契约；若正式引入分页，需同步 Web/MCP DTO 和搜索语义。单纯截断结果会丢工单，不能作为修复。
- **验证：** 上限两侧、空列表、多个 service/assignee，确认不丢失/重复条目；进一步核对 startup hydration 的批量参数边界。

### H05：默认测试脚本遗漏根目录测试

- **级别：重要 / P2。** 位置：`package.json:15`，关联 `tests/tool-runtime.test.ts:1` 和 CI 的 `npm test`。
- **证据：** 默认 shell 展开 `tests/**/*.test.ts` 只选中 83 个一层子目录文件；HEAD 实际有 84 个后端测试文件，唯一遗漏是根目录的 `tests/tool-runtime.test.ts`。该文件 3 项已单独补跑通过。见 `test-discovery.json`、`root-test.log`。
- **影响与触发：** process 工具命令白名单、环境和临时 HOME 清理的回归不会被默认 CI 后端命令发现，且未来根目录测试会继续遗漏。
- **最小修复与取舍：** 对 glob 加 shell 引号，让 Node 自己递归展开，例如 `node --experimental-strip-types --test 'tests/**/*.test.ts'`。已在当前 Node 用根目录/子目录两份临时测试验证可同时发现；也可使用显式完整文件清单。需保持 CI 与本地发现规则一致。
- **验证：** 对比实际执行文件与 HEAD 清单，包含根目录和多层子目录；3 项补跑通过只说明当前用例通过，不修复 CI 覆盖缺口。

### H06：Kubernetes 的 fsGroup 缓存卷权限与项目命令 broker 的要求冲突

- **级别：重要 / P2；可预测的部署集成失败，实际 Pod 未验证。** 位置：`deploy/issue-pilot.yaml:83` 的缓存挂载及 Pod fsGroup；`src/workspace/project-tools.ts:70`；`issue-pilot.config.ts:58`。
- **证据：** 清单将缓存卷根直接挂为 `.npm`、`.m2/repository`，Kubernetes fsGroup 赋予卷组写入权限；broker 却要求缓存目录由当前 UID 拥有且无 group/other 写入。隔离 fixture 在私有 0700 缓存下 Node/Maven 均成功；仅将缓存改为模拟 fsGroup 的 2775 后，两者均在执行命令前报 `insecure_project_tool_cache`。见 `evidence/project-cache-mode.json`。这是文件权限与 HEAD broker 的运行复现，并非实际 Kubelet/Pod 的启动记录。
- **影响与触发：** 按当前清单首次部署、使用默认缓存路径时，应用健康可能正常，但项目测试/构建 wrapper 因缓存安全校验不能执行。现有测试将缓存创建为 0700，未覆盖部署卷权限；`/health` 也不验证该链路。
- **最小修复与取舍：** 将卷挂到缓存父目录，以应用 UID 在其下创建私有子目录，并让根配置指向这些子目录；或提供明确、可验证的初始化 owner/mode 流程。保留缓存安全校验，不为通过部署而直接允许任意组写目录。
- **验证：** 实际目标集群中记录 UID/GID/mode，并运行一次 broker Node/Maven 命令；检查重建 Pod、空卷、已有缓存与只读 HOME。当前环境未启动实际 Pod，此验证仍欠缺。

### H07：无效个人凭证输入会先关闭已有会话

- **级别：阻断 / P2。位置：** `src/http/user-routes.ts:49`、`:71`。
- **证据、触发与影响：** `changeUser` 先逐个 closeSession，回调才解析完整 model/git/production 组。无效凭证组探针收到拒绝，但 `closedSessions` 已有工单 ID；用户输入错误也打断空闲会话，且数据库未改变。
- **最小修复与取舍：** 在已重授权、读取最新旧值的受管范围内 prepare 并校验全部组，再关闭会话和 apply。不能把依赖旧凭证的校验简单移到排队前；真正 apply/DB 失败后的关闭属于不同失败阶段。
- **验证：** 每个无效组、混合有效/无效组均不关闭会话、不写 DB；有效修改仍预约相关 Issue，运行中拒绝。

### H08：密码被通用文本 parser 改写

- **级别：阻断 / P2。位置：** `src/capabilities/registry.ts:34`、`:51`、`:164`、`:176`、`:185`；关联 `src/configuration/credentials.ts:81`。
- **证据、触发与影响：** 密码走 `requiredText/optionalText` 后被 trim。配置 replace/preserve 和 MySQL driver 边界探针均确认，带首尾空白的非空密码失去原字节，合法凭证无法认证；没有证据表明会正确回退，也不应增加身份回退。
- **最小修复与取舍：** 密码按 opaque 字符串校验长度并保留原值；地址、标识与其他认证格式各按协议处理，避免全局取消所有 trim。
- **验证：** 多种原生密码的替换、保留、再次解析及 driver/HTTP 实际入参；覆盖空值与显著空白，不输出真实密码。

### H09：RabbitMQ 队列名被 trim，dot segment 可改变请求目标

- **级别：阻断 / P2。位置：** `src/capabilities/rabbitmq.ts:6`、`:18`、`:25`。
- **证据、触发与影响：** 带显著空白的队列名被换成另一个名字；`.`/`..` 通过现有检查后进入 WHATWG URL 规范化。补充 HTTP 探针确认未拒绝这些名字，原本的队列路径可能退到集合/上级路径，不能当作同一只读目标。
- **最小修复与取舍：** 保留字面队列名；对传输无法忠实表示的 dot segment 明确拒绝，不能悄悄查询其他路径。若支持特殊名称需用 RabbitMQ 实际协议验证，不能仅增加一次 encodeURIComponent。
- **验证：** 显著/纯空白、斜线、百分号、Unicode、`.`/`..` 的最终 HTTP pathname；普通读取和 bindings 不变。

### H10：MySQL 同名结果列静默丢值，导出也会生成错误列

- **级别：阻断 / P2。位置：** `src/capabilities/mysql.ts:27`、`:30`、`:46`、`:49`、`:85`。
- **证据、触发与影响：** `rowsAsArray: false` 加以列名索引的对象无法表示重复列。JOIN/重复 alias 的 metadata 探针未被拒绝，两个同名列共用同一对象值；CSV/JSONL 不能保留两份原始值。空结果 metadata 也未检查歧义。
- **最小修复与取舍：** 在 fields 阶段明确拒绝重复列并要求唯一 alias，可保持现有对象结果契约；若改成位置数组需同步查询、导出和消费者，范围更大。不得用自动丢列满足“完整结果”。
- **验证：** 有/无行的重复 metadata、唯一 alias、查询及两类导出；失败时旧交付保留。当前使用 driver 适配探针，未连接真实 MySQL 服务。

### H11：二次清理异常会覆盖主异常，rollback 失败还可能丢失

- **级别：重要 / P2。位置：** `src/capabilities/mysql.ts:98`、`:101`；`src/agent/engine.ts:418`。
- **证据、触发与影响：** 查询失败后 rollback catch 被忽略，finally end 再失败会取代查询异常；session stop 与个人 Git cleanup 同时失败时，finally 也只留下后者。四组 MySQL 复合故障与 session/Git 双故障探针复现，导致恢复诊断缺少首个失败原因。
- **最小修复与取舍：** 各 owner 按原有顺序尝试必要清理，收集并保留主/清理异常；单错保持原语义，复合错聚合。保留取消优先语义，不在 HTTP 响应暴露私有原始异常；无需跨领域通用异常框架。
- **验证：** 主错、单清理错、双错、rollback+close、取消与清理并发，以及重试/关闭后资源确实释放。

### H12：未限定的 origin/main 会被同名 tag 影响

- **级别：阻断 / P2。位置：** `src/workspace/git.ts:303`、`:366`。
- **证据、触发与影响：** bare store 含合法 `refs/tags/origin/main` 时，短 ref 解析发生歧义。真实临时 Git 探针中只读准备得到错误 commit，开发准备报 ambiguous object name，未按配置远程分支工作。
- **最小修复与取舍：** 使用完整 remote ref 并验证 commit 类型，再传明确 commit/ref 给 worktree；不删除合法 tag，不猜测修复已保存的历史分支。
- **验证：** 同名 tag/其他命名空间遮蔽、正常 fetch、新 dev 分支、本地恢复无远程访问及原有历史分支保留。

### H13：共享 checkout 复用检查遗漏 ignored 文件

- **级别：阻断 / P2。位置：** `src/workspace/git.ts:329`；对照 `src/workspace/state.ts` 的启动校验。
- **证据、触发与影响：** 已有共享 checkout 内写入匹配 .gitignore 的文件后，复用仍成功。启动校验会检查 ignored，运行期复用仅普通 porcelain，规则不一致，可能把变化的共享目录继续提供给其他 Issue。
- **最小修复与取舍：** 复用时也检查完整 untracked/ignored 状态和已有归属规则，发现异常拒绝并保留证据。不要自动 clean/reset；小范围对齐验证比重写 Git 管理层更合适。
- **验证：** 普通 untracked、ignored、tracked 改动、错误 HEAD/common-dir，确认原文件保留；正常 immutable 复用仍成功。

### H14：损坏的本地 ref 被伪装为分支缺失

- **级别：重要 / P2。位置：** `src/workspace/git.ts:313`、`:364`。
- **证据、触发与影响：** show-ref/rev-parse 的失败被折叠成 false 或 working_branch_not_found。真实 Git 探针对坏 ref 内容和不存在的 object，在开发准备入口均得到 missing，丢失恢复诊断。代码对照显示，snapshot 中被归一化为该 missing 的故障还可能被关联工单逻辑当作没有快照；此下游影响未单独运行复现。
- **最小修复与取舍：** 区分确实不存在与无效 ref/object/IO 故障，保留稳定可诊断原因；不因此创建替代分支或远程 fallback。增加的是必要错误语义，不是自动修复。
- **验证：** 不存在、内容损坏、丢失 object、权限/命令故障，核对 refs 和工作目录未被改写。

### H15：blame 在判断 regular file 前打开 FIFO，可无限等待

- **级别：阻断 / P2。位置：** `src/workspace/source-browser.ts:323`。
- **证据、触发与影响：** resolvePath 后直接 readFile；目录返回原始 EISDIR，FIFO 探针等待约两秒仍未拒绝，只能由 fixture 写入端解除。Git 命令超时尚未开始，无法约束此等待。开发工作区可被普通原生脚本创建这类文件。
- **最小修复与取舍：** 读取前以 regular-file 规则拒绝其他类型；若处理并发替换，使用非阻塞 open/fstat 后读取同一 handle。保持 Source 的稳定错误和路径策略，不把特殊文件当文本。
- **验证：** 目录、FIFO、symlink/越界 alias、普通 UTF-8、空文件/末尾行；不遗留阻塞请求或文件句柄。

### H16：Git 文本用 U+FFFD 判断解码失败，拒绝合法文本

- **级别：阻断 / P2。位置：** `src/workspace/source-browser.ts:566`；关联 `src/process.ts` 的 stdout 解码。
- **证据、触发与影响：** Git 内容中合法的 Unicode replacement character 被当成二进制；真实 Git diff 探针报 source_file_binary。stdout 已经转为字符串，无法据该字符判断它是原字节编码还是解码替换。
- **最小修复与取舍：** 在 I/O 边界保留字节或提供严格 UTF-8 解码，再做 binary 判定；维持普通命令默认行为、取消及输出预算，不能只删除字符检查而放过坏字节。
- **验证：** 合法 U+FFFD、跨 chunk UTF-8、多字节/坏字节、NUL、HEAD/index blob 及其他命令不回归。

### H17：暂存比较的 DTO 版本标签与实际内容不符

- **级别：重要 / P3。位置：** `src/workspace/source-browser.ts:460`、`:463`；`src/web/src/data/client.ts:105`。
- **证据、触发与影响：** staged 比较 before 取 HEAD 却标 index，after 取 index 却标 working-tree。真实 Git 探针确认内容正确、标签错误。当前 CodeBrowser 主要按 staged 参数显示，所以不把它夸大为当前 UI 比较了错误内容。
- **最小修复与取舍：** 明确 head/index/working-tree 闭合类型并标注实际来源；复用公开 DTO 类型减少两侧重复维护。兼容既有消费者，避免无关拆分。
- **验证：** HEAD、index、worktree 三种不同内容，分别核对内容与标签；含新增、删除、重命名及 client 解码。

### H18：多个 Web 异步任务未绑定完整身份/生命周期世代

- **级别：阻断 / P2。位置：** `src/web/src/app/agent-configuration.ts:38`、`CapabilityConfigurationDialog.tsx:25`、`IssueWorkspace.tsx:85`、`IssueQueue.tsx:141`。
- **证据、触发与影响：** 编辑器以 subject 相等判断旧任务，在 A→B→A 后接受旧成功/失败；旧 capability save 会调用已卸载实例的 onClose，关闭新对话框；Issue-only generation 不覆盖身份/卸载。补充探针分别确认旧错误/状态进入新上下文、当前编辑器被关闭、卸载后仍导航等行为。
- **最小修复与取舍：** 复用现有 generation/AbortController 模式，在身份变化及卸载时失效；每个 await 后再核对上下文，区分全局已提交事实的资源刷新和局部编辑状态。不能只比较 subject 字符串，也不需要另造整套异步框架。
- **验证：** A→B→A、角色变化、旧成功/失败晚到、新编辑/保存进行中、卸载后完成。原 19 项失败中有前置状态断言失败，未到达的后续断言不计作额外复现。

### H19：旧评论提交成功会清空期间输入的新草稿

- **级别：阻断 / P2。位置：** `src/web/src/app/IssueWorkspace.tsx:120`、`:129`。
- **证据、触发与影响：** 发布期间 TextArea 仍允许编辑，成功后却无条件 setCommentBody("")。同一身份、同一 Issue 的补充探针确认较新评论草稿丢失，与身份世代问题不同。
- **最小修复与取舍：** 捕获提交时的草稿，只清除仍与提交值相同的输入；借鉴已有个人生产凭证的提交值比较。保留继续输入能力，失败不恢复覆盖新草稿。
- **验证：** 等待中继续输入、旧成功/失败、相同/不同草稿、刷新失败、Issue/身份变化。

### H20：队列/仓库列表和创建对话框的旧请求可覆盖新状态

- **级别：阻断 / P2。位置：** `src/web/src/app/IssueQueue.tsx:61`、`:124`、`:156`；`RepositoryManagement.tsx:34`。
- **证据、触发与影响：** create 成功未使早先 listRequest 失效；对话框重开也未隔离 related-candidates 请求。改进的隔离探针等待创建成功并关闭对话框后才完成旧列表，确认新条目消失；另已确认旧候选成功/失败进入重开的对话框。仓库列表探针也在创建后的新列表已显示时完成旧初始 load，确认新结果被旧结果覆盖。对应日志 `queue-stale-list.log` 与原前端探针。
- **最小修复与取舍：** 创建提交后使旧列表失效并保留/重载权威列表；为每次对话框打开设置独立请求世代。与 H18 的身份/卸载世代配合，不把所有不同任务塞进一个全局计数。
- **验证：** 旧列表在创建前后到达、失败、关闭重开、多个刷新及关联候选；不丢已创建条目、不重复提交。

### H21：合法长文件名能创建和读取，却无法保存

- **级别：阻断 / P2。位置：** `src/workspace/source-browser.ts:178`。
- **证据、触发与影响：** 临时名在原 basename 后追加 UUID 后缀。244 UTF-8 字节文件名通过同一 SourceBrowser 创建和读取，保存却报 ENAMETOOLONG；旧内容仍在。见 `source-long-name.json`，这是现有 API 的真实文件系统复现。
- **最小修复与取舍：** 临时文件采用固定短前缀加 UUID，保留同目录原子 rename、原权限和失败清理；不为容纳内部后缀而拒绝原本合法的源文件名。
- **验证：** 长 ASCII/Unicode 名、接近文件系统边界的名字、正常保存、冲突和失败清理。

## 设计、性能与测试判断

**保留的设计。** domain 闭合角色/workMode 与独立 isAdmin、配置投影与 credential owner、单全局 Agent 配置、明确的 scope/lifecycle/inspection/reservation/repository 队列，以及 Git/文件/DB 各自 prepare/rollback/finalize 都有实际职责。原生查询的 execute 再校验保护可变 Pi hook；外部 MCP 交由 Pi 发现/注册/重连/关闭，应用保留 DB、传输、凭证与预算边界。SLS 的验证、worker 入口、官方 SDK 分页和净化错误码按不同变化原因分开，不能仅因四个文件而合并。Monaco lazy/worker、model dispose、预览取消与对象 URL 释放、Markdown 净化/有界缓存均有可观察用途。

**过度设计。** 未发现需要整体替换的框架层。CommandExecutor/ToolRuntime、MCP connector、SDK factory、GeneratedDirectoryOperations 等位于进程、网络、协议或可注入故障边界，测试确实使用这些变化点。没有依据删除这些接口或为了行数拆分 CodeBrowser/ConfigurationView。部分部署/脚本测试把当前文本布局和“不得出现 initContainers”等实现选择写死，维护 H06 时应优先验证所需行为与权限，而非维持所有字符串断言。

**简化过头。** 真正问题集中在以少数 header 名称猜认证组、短 Git ref、通用 trim 改密码、相同 subject 代替世代、finally 代替多错保留，以及 rename 后才做可能失败的最后检查。这里应把规则归还明确 owner；增加局部 helper/闭合 DTO 类型有实际收益，另造统一配置/异常/异步执行框架则没有证据支持。

**规则变化推演。** 若调整当前已有的只读 SQL 规则，应在 `src/capabilities/sql.ts` 及直接行为测试集中修改，由 MySQL/DMS 入口继续复用；不在各路由和工具复制另一份黑名单。H08 的密码语义也应在配置解析 owner 统一修正，让保存和执行复用；前端当前 serializer 已保留密码原值，无需重写所有表单。相反，Git 工作区回滚与旧生成目录清理的失败语义不同，不能仅因都有 rename/remove 就合成一个事务框架。以上是维护影响推演，不是已实施变更或运行验证。

**性能证据。** H04 是已复现的规模正确性边界，不仅是延迟风险。另对 HEAD SSE writer 的 `queue.shift()`（`src/http/sse.ts:48`）做受控 blocked/drain microbenchmark：20k/40k/80k 积压各 3 次，中位数约 91/84/422 ms，80k 样本范围约 333–1730 ms。样本波动较大，不能据此给出稳定增长指数或认定生产瓶颈；可先稳定基准，再考虑局部游标/批次压缩并回归顺序、backpressure、断连。没有实施或宣称性能提升。完整 DMS/MySQL 结果与 Source 内容仍可较大；未进行耗尽主机/容器内存的压力实验，也不建议静默截断。

**依赖与冗余。** 所有锁条目和可安装条目版本一致性已检查，npm 审计为零已知漏洞，Python 依赖检查通过；这不等于第三方实现无缺陷。核对了 worker URL、Vite/Monaco worker、素材/许可发布、Pi 显式资源和 stdio 启动等动态入口。历史实验文件没有发现当前运行时/构建引用，但用途是历史证据，保留；已发布 SQL/journal 不删除或改写。未声称静态分析找到了所有潜在无用路径，未做依赖升级、删除或安装。

**测试覆盖与缺口。** 原有测试对并发预约、单例启动、FK/迁移回滚、文件 quarantine、Git 失败恢复、SDK Codemode/MCP 生命周期和原生 XLSX 普通脚本有实质验证。缺口由本次复现具体暴露：默认身份等待、发布前最后窗口、自定义认证头、同名结果列、SQL 参数规模、FIFO/合法特殊文本、长文件名、跨身份/关闭重开的异步完成，以及部署卷权限。Monaco 单元测试使用适配 mock；本次另以真实 Chromium 检查了加载与保存。没有接入真实生产模型、MySQL、DMS、SLS，也未构建并启动 Node 26 应用镜像或实际 Kubernetes Pod；部署/外部协议结论按此限度表述。

## 最小改进顺序与保留情况

1. 先修 H01 的请求主体固定/等待后重授权与 H02 的成果提交点；各自补原行为回归，禁止通过身份 fallback 或失败后自动覆盖来绕过。
2. 修认证与证据准确性：H03、H08、H09、H10、H12–H16；修输入准备顺序 H07 和复合故障保留 H11。保留现有协议与工作区 owner，不重写 SDK 或迁移历史。
3. 按现有资源/组件边界修 H18–H20，补 A→B→A、晚到响应、卸载和新草稿场景；修 H17 DTO 与 H21 临时命名。
4. 将 H05 的完整测试发现并入 CI，并在实际部署环境验收 H06。修复后执行 focused tests、完整发现后的后端/前端套件、typecheck/build/diff 检查；改动协议/容器时再做相应 audit/浏览器/部署验收。本报告未执行这些修复。

保护检查：337 个 HEAD 快照文件 SHA-256 与导出清单全部一致。341 项原工作区基线中，339 项一致；用户的 Skill/Reference 与较早基线不同，本轮未写入它们，保留当前版本，不回退。除本次审查报告/覆盖清单外，未写入项目源码、配置、依赖或真实 state。现有部署只作健康读取，未重启、提交、推送、发布或修复现场；隔离浏览器服务及临时状态均已清理。

本结论针对所列 HEAD 和方法边界：适用模块范围已完成，不代表所有输入组合、所有第三方实现和实际部署环境均已证明安全。确认的阻断缺陷足以作出“不通过”，无需用尚未执行的真实生产测试来代替已有结论。
