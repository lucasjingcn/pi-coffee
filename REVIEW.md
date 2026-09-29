# 项目审查、修复与升级记录

审查日期：2026-09-28。覆盖 MCP/HTTP 接口、Git 操作、RPC 子进程、协调器状态、文件锁、消息投递、扩展和测试脚本。

## 已修复

| 问题 | 修复后的行为 | 主要位置 |
| --- | --- | --- |
| Git 合并失败但没有冲突标记时误报成功；提交失败被当作没有改动 | 依据 Git 退出结果报告；真实提交错误向调用者传播 | `src/worktree.ts` |
| 差异列表遗漏未提交的已跟踪文件；状态列被 trim；特殊文件名解析错误 | 包含已提交、暂存、未暂存及未跟踪文件，使用 NUL 分隔解析路径 | `src/worktree.ts` |
| 强制把已检出的分支附加到第二个 worktree | 遵守 Git 分支独占检出约束 | `src/worktree.ts` |
| RPC 启动失败、退出或停止后请求仍等待；事件监听泄漏；重复 command id 覆盖旧请求 | 终止时立即拒绝等待请求并清理资源，拒绝重复 id 和重复启动 | `src/rpc-client.ts` |
| 等待 get_state 时错过 agent_settled；管道失败后留下活进程 | 提前订阅完成事件，终止不可用子进程 | `src/rpc-client.ts` |
| 并发 spawn 越过上限；启动阶段又重复计算槽位 | 同步预留容量，在注册 runtime 时转移槽位 | `src/manager.ts` |
| 验收文件同属 codex 导致冲突漏检；失败任务停止时释放新任务的锁 | 显式检查冲突，每个任务的验收锁只释放一次 | `src/manager.ts` |
| base ref 在创建 worktree 后才解析，可能和实际基线不一致 | 先解析 SHA，再以同一 SHA 创建 worktree，解析失败直接报错 | `src/manager.ts` |
| 重启恢复失效锁、丢失未停止任务的成果记录；关闭时未刷盘 | 清除失效锁，保存运行任务快照，以原子替换串行写盘，关闭前刷新 | `src/manager.ts` |
| 验收路径可以越界、覆盖 Git 元数据或跟随符号链接写出 worktree | 写入前检查路径和实际文件类型；失败清理保留已有分支 | `src/acceptance.ts`、`src/manager.ts` |
| stdio 代理重试所有错误，可能重复执行有副作用的操作 | 仅对明确发生在建立连接之前的错误重试 | `src/stdio-proxy.ts` |
| 无效/不对应的回复及 EOF 最后一行导致请求丢失 | 校验 JSON-RPC 回复，返回对应 id 的错误，处理 EOF 缓冲区 | `src/stdio-proxy.ts` |
| 广播被一个 worker 读过后其他 worker 收不到；立即投递后轮询又重复注入 | 按接收者记录已读，成功立即投递后确认，失败保持未读，串行轮询 | `src/mailbox.ts`、`src/manager.ts`、`src/index.ts`、`extensions/pi-coordinator.ts` |
| 非法 Host 可触发请求处理器异常；内部非法 JSON 返回 500；MCP 在鉴权前解析正文 | 请求 URL 使用固定解析基址，坏输入返回 400，先鉴权再解析 | `src/index.ts` |
| 执行命令超时只杀 shell，子进程和输出管道可能继续占用请求；输出累积无上限 | POSIX 下终止独立进程组并关闭管道，运行时限制保留输出 | `src/manager.ts` |
| 引号内 JavaScript 的 `=> new`、`=> setTimeout` 被当作重定向，产生 `/new`、`/setTimeout` bogus 锁；`sed` 替换脚本被当作文件 | 按 shell 引号、注释和 heredoc 边界识别实际写入操作数；真实同名文件仍申请锁并检查冲突 | `src/bash-paths.ts`、`extensions/pi-coordinator.ts` |
| “离线” smoke 仍启动真实 pi；继承外部设置；使用过期 dist | 使用模拟 JSONL worker，隔离配置，覆盖重试门禁与重启；脚本重新构建 | `scripts/smoke.mjs`、`smoke.sh`、`package.json` |

## 验证

- `npm ci` 和 `npm run verify`：通过；verify 同时检查主代码和真实 pi API 扩展类型，再构建并执行离线测试。
- Node 22.19.0 与 Node 24.21.0：完整 verify 各通过 85 项测试，0 失败、0 跳过；包含 HTTP、扩展轮询、进程超时、离线 MCP 全链路、bogus 锁、跨仓库锁及持久化恢复验证。
- 失败路径补验：实际非法配置在创建状态目录前退出；扩展注入临时类型错误时 verify 立即失败；真实 daemon 关闭写盘失败记录日志并以状态码 1 退出。
- bogus 锁补验：单/双引号 JavaScript、注释、heredoc 不产生假锁；重定向、多个 `tee` 目标、`sed -i` 仍提取真实文件，真实 `new` 文件冲突仍会阻止调用。实际安装的 pi 扩展加载器可成功加载新增模块。
- 在继承无效 token、host、worktree、maxSessions、baseRef 等设置时，离线 smoke 通过。
- `npm audit --omit=dev`：生产依赖已知漏洞为 0。
- `git diff --check`：通过。

真实模型调用、macOS launchd 安装和远程部署没有在本次验证中执行。运行中的 daemon 和已有 stdio 代理需要重启，才能载入新构建。

bogus 锁修复位于 worker 扩展：新启动 worker 会读取新代码，已启动 worker 需重新创建才能载入；收尾检查锁表为空，无 `/new`、`/setTimeout` 遗留锁。

## 仍值得完善的事项

2026-09-29 的本机复核与待实施改进见 [可靠性与成本证据改进方案](docs/plans/reliability-and-cost-evidence.md)。上文历史测试通过记录不代表当前 macOS 本机验证通过；初次 92 项中 1 项超时测试失败，修复后本机 137 项全部通过，诊断与验收标准见方案。

**强隔离与 worker 恢复**：文件锁仍是建议性约束。已修复引号内 JavaScript 产生 `/new`、`/setTimeout` 锁的误报，但 bash 写入检测只覆盖可识别的字面量目标，变量展开、命令替换和其他写文件程序仍不保证覆盖；如果需要对不可信 worker 提供保证，应采用只读验收目录和独立运行环境。daemon 重启后需要显式创建新 worker，尚无自动恢复机制。

## 本次升级完善

原列表 #1–#4 已转为具体升级项：

| 项目 | 升级后的行为 | 主要位置 |
| --- | --- | --- |
| #2 配置校验 | 启动前校验端口、并发上限、提示阈值、TTL 和布尔设置；覆盖值优先；有效 dataDir 决定默认 worktree 目录 | `src/config.ts` |
| #1 跨仓库锁 | 以规范化 Git common directory 隔离仓库；同仓库的符号链接和 linked worktree 共用锁；验收锁和释放逻辑也按仓库隔离；手动 claim/release 支持 repo | `src/lock-repo.ts`、`src/locks.ts`、`src/manager.ts`、MCP/HTTP 接口 |
| #3 持久化观测与恢复 | 完整验证状态后加载；保留上一份有效快照；主文件损坏可从备份恢复，无法恢复则明确失败；后台写盘错误可见，关闭失败返回非零状态 | `src/state-store.ts`、`src/manager.ts`、`src/index.ts` |
| #4 CI/verify | 统一 verify 覆盖主代码、真实 pi API 扩展类型和离线测试；push/PR CI 使用 Node 22.19.0 与 24；移除机器绝对路径 | `package.json`、`tsconfig.ext.json`、`.github/workflows/verify.yml` |

开发与部署说明同步到 `README.md`。备份可能落后主文件一次保存；本次未加入断电持久性保证或多 daemon 共写保护。远程 GitHub Actions 运行需提交推送后触发，本次执行的是本地验证。

## pi 委派记录

按本次审查的 6 个逻辑工作流统计：首次完成 1 个（16.7%），一次审查修正后完成 4 个（66.7%），接管补齐 1 个（16.7%）；放弃和未记录均为 0。

中途 daemon 重启使原 s5–s8 从运行注册表中丢失；分别由 s11、s12、s10、s13 恢复，不重复计数。本次收尾记录为 s10–s15，均已调用 `pi_finish`；已调用 `pi_report` 并排除其他历史任务，随后调用 `pi_gc` 清理了 6 个会话记录。

bogus 锁补修单独统计：委派 1 项（s16），首次完成 0%，一次审查修正后完成 100%，接管和放弃均为 0%；独立验收、合并后全量测试通过，已调用 `pi_finish`、`pi_report` 和 `pi_gc`。

本次 #1–#4 升级单独统计：委派 4 项（s17–s20），首次完成 1 项（25%），一次审查修正后完成 3 项（75%），接管、放弃和未记录均为 0。配置集成补充了忽略 undefined 覆盖的小修正，关闭失败处理及独立接口/持久化/退出验收由协调者补齐；全部独立复核后合入，已调用 `pi_finish`、`pi_report` 和 `pi_gc`，仅保留主工作区。

## 已合并分支的 GC 升级

`pi_gc` 默认检查已完成任务的运行及历史记录，使用规范化 Git common directory 合并仓库别名。只有分支提交已包含在仓库 HEAD 中，且未被工作区、活动会话、脏工作区或未完成任务占用时，才执行非强制分支删除。非法分支名及 Git 检查失败保留并报告；历史仓库目录已删除时逐项报告，不中止其他仓库清理。自动工作区清理保留分支，分支回收由 GC 完成，显式 stop 的删除选项仍独立保留。

协调者验收覆盖真实 Git 合并、未合并、工作区占用、脏文件、非法分支名、仓库别名、Git 检查失败和 upstream 不一致。主工作区 `npm run verify` 92 项通过；恢复会话通过 `pi_exec` 干净安装依赖并验证 93 项（多 1 项临时恢复验收）。已删除此前 5 个已合并分支以及 s21/s23 分支和工作区，最终只剩 master 主工作区。

本次实现任务 1 项：s21 第二轮中途 daemon 重启，协调者接管（100%）；s23 是独立验证及收尾恢复记录，已用 `pi_finish(taken_over)` 关闭，调用 `pi_report`、`pi_gc`。s21 历史记录仍为 unrecorded：重启后 `pi_finish` 返回 unknown session，故在这里及 s23 的 note 中保留关联证据，不重复计数。当前 daemon 尚需重启以加载最后的逐仓库错误处理修正。

## 2026-09-29 可靠性与费用证据升级

具体范围与完成记录见 [现行改进方案](docs/plans/reliability-and-cost-evidence.md)。候选验收、合并和成功结果改为有版本证据的强制门禁；协调故障不再放行写操作，检测直接/符号链接越界；默认使用非登录 shell，CI 增加 macOS；成本统计覆盖活跃与历史、失败及返工，缺失为未知，主代理记录保留来源与币种；编排正文只维护一份。

本机 Node 24.19.0 `npm run verify`：137 项通过、0 失败、0 跳过；类型、离线 MCP 全链路和编排一致性检查通过。真实 pi 0.87.1 无提示词 RPC 启动通过。GitHub 四组 Linux/macOS × Node 22.19/24 的实际状态应查看该次推送的 Actions，不以矩阵文件存在替代运行结果。未执行收费模型编码或远程部署；文件锁不构成 OS 沙箱，费用覆盖声明不自动证明主代理所有调用已完整登记。
