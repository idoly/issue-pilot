# 工单沙盒消融实验

该实验独立运行，生成脱敏样例并使用内存 Pi session，不读取工单数据库、真实仓库、附件或对话，不修改线上工具权限，不启动或重启应用。首轮记录见[实验结果](SANDBOX_EXPERIMENT_RESULTS.md)。

入口是 `npm run experiment:sandbox`，执行器为 `scripts/experiments/sandbox.ts`，固定样例与答案为 `tasks.ts`。实验参数及预算集中在实验脚本中；这些不是正式应用配置。

## 比较方式

| 组别 | 工具 | 要回答的问题 |
| --- | --- | --- |
| A | 只读、分页的样例文件读取 | 当前只读工具模式的任务完成能力 |
| B | 相同读取工具 + 容器 Shell | 自由编程是否提高完成率、减少模型轮次 |
| C | B + SDK 原生 codemode（可选） | 编排是否进一步提高效率 |

八个任务覆盖简单配置读取、CSV 汇总、大结果聚合、跨服务筛选、日志关联、退款关联、trace 排序和临时代码复现。数据完全生成，所有组使用相同输入和精确 JSON 答案；每次运行使用独立 session，B/C 使用独立容器。按 trial 轮换 A/B/C 顺序。默认每组每任务重复 3 次，共 72 次；模型、thinking level 和预算保持一致。C 允许模型自主选择是否使用 codemode，属于“开放该能力”的实验，不保证每次使用。

同一读取工具每次最多返回 50 KiB ASCII 字符，与现有 Pi 读取工具的 50 KiB 输出窗口近似对齐；它使用字符 offset，不能视为完整 Pi read 行分页实现。实验初次 pilot 使用过 8 KB 窗口，已中止且不纳入对照结论。

第一版容器有 Node.js 和 Unix 工具，无网络、Python 或动态安装依赖。它测量开放脚本执行的初步价值，不能代表完整生产调查能力。A 是当前工具模式的近似基线，未重放正式工单；样例答案可以从文件手工推导，也可以用程序验证。实验不调用 DMS/SLS 或真实 MCP，不衡量真实资源连接延迟。

## 运行

需要 Linux、可用的 rootless Podman，以及本地已有 `docker.io/library/node:26-bookworm-slim` 镜像。运行不自动拉取镜像。实际 image ID 与版本写入报告，跨机器比较时必须一致。

```bash
# 隔离负向检查 + 固定程序的宿主/容器开销，不调用模型
npm run experiment:sandbox

# 小规模端到端检查
npm run experiment:sandbox -- --model provider/model --trials 1 --tasks simple-config,csv-total

# 完整对照
npm run experiment:sandbox -- --model provider/model --trials 3
```

模型使用现有 Pi 模型配置的进程私有副本，凭证不进入容器或结果文件。工具只接触生成样例。没有选择模型时，报告明确标注模型实验未运行，不能把固定程序结果当成模型能力提升。

报告按原子替换保存，失败样本额外保留有界的最终回答和工具错误文本；只使用生成数据，不记录模型凭证。报告位置由命令输出，位于独立 `/tmp/issue-pilot-ablation-report-*` 目录，JSON 文件为 `0600`；每次模型任务结束保存一次。样例目录最终清理，报告保留。容器 label 为 `io.issue-pilot.component=sandbox-experiment`。`SIGINT`/`SIGTERM` 请求中止当前会话并清理容器；进程被 SIGKILL 或主机崩溃后需要 Operator 检查该 label 的遗留容器。

## 隔离和预算

容器非 root、root filesystem 只读、capabilities 全部移除、no-new-privileges；不挂载宿主 home、应用目录、容器引擎 socket 或其他工单。唯一宿主挂载是生成样例 `/evidence:ro`。`/work` 与 `/tmp` 为有容量上限的独立 tmpfs；网络为 none。内存 512 MiB、CPU 1、进程 64；单命令 30 秒、输出 256 KiB。模型任务最多 180 秒；达到 12 个 assistant turns 后请求中止（SDK 可能额外记录一条 aborted turn），读取/Shell 调用预算为 30 次。超时、取消或输出超限会移除整个容器，避免只杀 exec 客户端而遗留子进程。

负向检查覆盖宿主/其他工单 canary 不可见、容器引擎 socket 不可见、宿主变量不注入、样例与根目录不可写、可写工作目录、非 root、权限/网络状态，以及取消/超时/输出超限后容器不存在。检查内存与 PID limit 配置，但不通过耗尽资源验证极限，也不证明内核逃逸防护。默认 Podman seccomp 未被关闭。正式接入还需真实工单挂载、并发隔离、成果导出和恢复验证。

宿主性能对照只执行仓库固定程序，绝不运行模型生成的宿主命令。交替执行 10 次宿主与容器命令，分别记录容器启动、热 exec 的原始耗时、中位数与 p95。宿主与镜像 Node 版本分别记录；跨运行比较需核对版本差异。

## 如何判断

先看所有隔离检查是否通过，再看模型任务的精确正确率、模型轮次、工具调用数、token、费用与耗时。失败、超时与错误 JSON 计为未完成，不能从分母剔除；人工介入固定为零，因为实验禁止人工提供解题帮助。八个样例不足以证明生产正确率，报告以探索性结果解释。

初步采用条件：复杂任务正确率相对 A 提升至少 15 个百分点，或在相同正确率下明显减少轮次/token；同时简单任务额外开销可接受。B/C 差异不明显时保留 codemode 可选。若每次 exec 的固定开销占比过高，再评估容器内长驻执行进程；实验前不增加 RPC 层。

下一阶段再加入真实问题脱敏回放、资源代理调用、Python/依赖安装、成果完整性验证与更强隔离。durable 存储迁移独立评估，不属于本实验。
