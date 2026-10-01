# DSH Model Fusion 与 pi-coffee：源码比较与已吸收改进

审查日期：2026-10-01（Asia/Shanghai）。DSH 源码下载到 `/Users/lucas/code/dsh-model-fusion`，
仓库 [aa2246740/dsh-model-fusion](https://github.com/aa2246740/dsh-model-fusion)，版本 0.2.5，
固定提交 `fa801662ceb11c3c92e544e83ca12e8f5936cd50`。
pi-coffee 基线为本地 main `7f5c8bc60bd4a984b7b041238de33c6578be301e`；开始时干净，
只有一个工作树，main 与当时本地 origin/main 一致。本次改动保留为未提交文件。

## 比较结论

按源码机制，Fusion 更成熟的部分是 DSH 内的双模型交接、逐项需求审查和 Lead 工具权限隔离；
pi-coffee 更完整的部分是跨 MCP 客户端的多个 worker 协作、独立 worktree，以及对实际合并候选的验证。
两者没有相同任务、相同模型、相同质量与成本口径的直接对照实验，不能据此给最终代码质量排名。

| 维度 | DSH Model Fusion | pi-coffee 基线与本次结果 |
| --- | --- | --- |
| 产品形态 | DSH 模型选择器中的 Fusion；Lead 写 brief、审查，Sidekick 实现并连续返工 | 通用 MCP 服务；主协调者安排独立 worker，也能直接完成小修改 |
| 协调与整合 | 按 work order/report/snapshot 管理双模型生命周期 | 多 worktree、范围 claim、信箱、黑板、阻塞问题、worker/target 精确候选；更贴合并行仓库开发 |
| 主代理权限 | 工具目录与 DSH 沙盒限制 Lead 写入，达到明确接管条件才开放 | 主协调者保有实现能力；worker claim 是协调机制，不能称 OS 沙盒。没有移植强制只读主代理 |
| 需求审查 | 用户引用约束和逐项 met/evidence | 基线只有 goal/contracts；已补 coordinator-authored requirements 和逐项结构化证据 |
| 既有测试 | 检测原始非空行删除/改写，接受理由需提到文件名 | 已补 Git 字节变更证据、逐文件明确批准；保守地包含纯追加，不依赖行内容启发式 |
| 审查时效 | review ticket 绑定 work order/report/snapshot 摘要 | 保留 SHA/tree/epoch 门禁，再绑定一次验收唯一 ID 与完整任务/验收合同摘要 |
| 费用证据 | 公开小样本 benchmark，缓存策略及保活 | 有 worker/主协调者费用覆盖口径；没有证明质量或节省率的独立对照 |
| 可移植性 | 当前针对 DSH 0.2.0-rc.2；作者注明 Linux 未验证、Windows ACL 部分隔离 | 通用 MCP 客户端，当前测试含跨平台安装和生命周期；任意 shell 写入仍不能完整隔离 |

DSH 的关键源码：

- [需求、测试改写、审查与接管](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/src/host/coordinator.ts)：
  `rewrittenTests` 在 178–202 行，用户约束在 1178–1188 行，逐项审查在 1511–1529 行。
- [review ticket](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/src/review/ticket.ts)：绑定报告主体和工作单摘要。
- [验收执行](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/src/host/native-checks.ts)：冻结定义与 baseline 处理。

这些机制有实际价值，但字符长度或“理由中提到文件名”不证明审查结论正确。
本次采用独立实现，没有复制 DSH 源码或引入 DSH 依赖；双方项目许可均为 Apache-2.0。

## 公开基准的复核与局限

直接汇总下载源码中的 results-r4/results.jsonl 和 results-r5/results.jsonl，按作者 report.py 的
grade.resolved、costUsd、wallSeconds 及污染排除规则核对：

| 条件 | 做对 | 会话日志按 API 价格估算 | 尝试总耗时 |
| --- | --- | --- | --- |
| Astra 单独，round 4 | 9/18 | $39.17 | 1.58 小时 |
| Astra + Flash Fusion，round 5 | 11/18 | $18.07 | 8.28 小时 |
| Astra + Grok Fusion，round 5 | 13/18 | $41.27 | 3.44 小时 |

与作者 [EVIDENCE.md](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/docs/EVIDENCE.md)
一致。样本只有 9 个公开 Python issue、各两次；Astra 对照来自前一天另一轮，当前发布版本也不同于评测版本。
Flash 组合没有在相同样本上显示更差正确率，但耗时约为 Astra 单独的 5.2 倍；Grok 组合不更便宜。
报告的质量容差规则不能作为我们降低质量标准的授权。与 Devin 的干净交集只有 4 题，更不能建立系统排名。

成本还有可定位的覆盖缺口：
[benchmark/rebench/run.py](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/benchmark/rebench/run.py#L141)
按 assistant/message 统计 usage；
[native-keepalive.ts](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/src/host/native-keepalive.ts#L167)
说明保活输出不进入 Session；
[native-usage.ts](https://github.com/aa2246740/dsh-model-fusion/blob/fa801662ceb11c3c92e544e83ca12e8f5936cd50/src/host/native-usage.ts#L67)
把辅助调用另记到 SQLite。现有 benchmark 没有读这个辅助账本。
因此有依据怀疑 headline 漏计保活等辅助请求，但不能从源码确定该轮漏计的实际金额。
“便宜 54%”应理解为作者会话日志口径的估算，不能当完整费用或 pi-coffee 对照证据。

## 已落实的吸收

1. `spec.requirements: [{id,text}]` 随任务传给 worker。需要合并的任务必须通过 `pi_review`
   给每项提交 `{id,met:true,evidence}`。漏项、重复、未知 ID、未达成、空证据均拒绝。
   主协调者负责保留用户要求；工具没有原生用户会话上下文，不能自动证明用户原话的来源。
2. `pi_verify.existingValidationChanges` 用准确 Git 路径列出修改、删除、重命名的既有测试/配置。
   新增测试排除；所有既有改动含追加都要求 `{path,approved:true,reason}`。
   常规测试目录、test/spec 文件和常见框架配置自动识别；`package.json`、`pyproject.toml`、CI 脚本等
   用 `spec.validation_paths` 显式补充。批准前必须审查原始覆盖和用户授权的行为变更。
3. `pi_review` 必须携带准确的 `verification_id`。验收 ID、worker/target SHA、candidateTree、
   daemon epoch 和任务/验收合同摘要共同限制旧审查重用。新指令、执行命令、提交和重新验收清掉审核。
   审查记录持久化供审计；重启不会复活合并许可。受保护的 coordinator acceptance 文件仍不能改。

本次真实使用 worker 时，新会话还消费了其他旧任务的历史全局广播，导致额外回复。
已修复 protected worker 的 inbox 与即时 fanout：屏蔽不带 scope 身份的 `*` 广播，明确收件人消息继续有效，
旧 unprotected 会话保留兼容行为。没有删掉历史记录或重启共享 daemon。

核心代码：[candidate-review.ts](../../src/candidate-review.ts)、[validation-changes.ts](../../src/validation-changes.ts)、
[integration.ts](../../src/integration.ts)、[manager.ts](../../src/manager.ts)、[mcp-server.ts](../../src/mcp-server.ts)、
[state-store.ts](../../src/state-store.ts)。中英文 README 与权威编排技能同步更新。

## 验收与实际 pi-coffee 使用

- 先增加真实 Git integration 回归，确认缺少逐项 review 时旧实现仍允许 merge；再实现门禁。
  广播问题也先以回归复现。最终 `npm run verify` 退出 0：主代码类型检查、扩展类型检查、
  176/176 测试、权威技能/运行时提示/安装器一致性检查通过。另一个只读审查者检查完整 diff、
  新 helper、MCP capability 与持久化恢复，未发现必须修复的实现缺陷。
- pi worker `s32`，purpose=implementation，用已配置的 deepseek/deepseek-flash 完成独立
  `validation-changes.ts` 与测试；主协调者读全量源文件、修正目录/分隔符归一化，并在当前工作树验证。
  主协调者直接完成候选审查协议、MCP、持久化、集成门禁、广播修复及文档。另有两份独立只读源码审查。
- pi_report 对 s32 的 worker 费用记录为 USD 0.05384136，主协调者费用缺失，不能作为总费用或节省率。
  因用户未授权仓库提交，没有执行该 worker 的 pi_commit/pi_verify/pi_merge；采纳的是已审查的未提交补丁。
  pi_finish 用 abandoned 关闭该未进入正式候选整合的工作流，并明确记录补丁采纳与原因；
  不把它报作经 pi_merge 完成的成功，也不表示本地补丁测试失败。工作树保留。
- 这些测试证明本地程序行为，不证明两个系统的模型质量、真实账单收益或已安装客户端效果。
  当前改动未提交、未推送、未部署、未重启共享 daemon；DSH 只下载并静态审查，未安装或发起模型请求。

## 后续候选与未移植原因

受控 scope 扩展值得后续独立实现：只加路径、worker 静止、重新检查锁和验收保护、记录理由并使旧证据失效。
验收程序预检可用显式程序列表实现，避免猜测任意 shell 的语义。两项均非这批审查合同的必要依赖。
缓存保活依赖 DSH 请求钩子且会额外请求模型，本次未移植；不自动切模型、削减上下文、放宽验收或降低质量。
baseline no-new-failures 需要可信失败 ID 与启动前快照，不能用它容忍任务要求必须通过的测试失败。
