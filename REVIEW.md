# 项目审查与修复记录

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
| “离线” smoke 仍启动真实 pi；继承外部设置；使用过期 dist | 使用模拟 JSONL worker，隔离配置，覆盖重试门禁与重启；脚本重新构建 | `scripts/smoke.mjs`、`smoke.sh`、`package.json` |

## 验证

- `npm run typecheck`：通过。
- `npm test`：57 项通过，0 失败、0 跳过；包含 HTTP、扩展轮询、进程超时和离线 MCP 全链路验证。
- 在继承无效 token、host、worktree、maxSessions、baseRef 等设置时，离线 smoke 通过。
- `npm audit --omit=dev`：生产依赖已知漏洞为 0。
- `git diff --check`：通过。

真实模型调用、macOS launchd 安装和远程部署没有在本次验证中执行。运行中的 daemon 和已有 stdio 代理需要重启，才能载入新构建。

## 仍值得完善的事项

1. **跨仓库文件锁隔离**：当前锁键主要是仓库相对路径，不同仓库的同名文件仍可能互相阻塞。建议在锁键中加入规范化仓库身份。
2. **配置校验**：`port`、`maxSessions`、TTL 直接由环境字符串转为数字，缺少完整范围和有限值检查；应在启动时明确拒绝无效配置。
3. **持久化错误可观测性及损坏恢复**：目前读取/保存错误仍以 best effort 处理；建议记录错误并增加备份或显式恢复，避免静默丢失状态。
4. **CI 与兼容性**：将 `npm ci`、类型检查和离线测试接入 CI，覆盖声明支持的 Node 版本；扩展当前不在主 tsconfig 的类型检查范围内，本次通过模拟运行验证其轮询路径。
5. **强隔离与恢复**：文件锁仍是建议性约束，bash 写入检测是启发式；如果需要对不可信 worker 提供保证，应采用只读验收目录和独立运行环境。daemon 重启后需要显式创建新 worker，尚无自动恢复机制。

## pi 委派记录

按本次审查的 6 个逻辑工作流统计：首次完成 1 个（16.7%），一次审查修正后完成 4 个（66.7%），接管补齐 1 个（16.7%）；放弃和未记录均为 0。

中途 daemon 重启使原 s5–s8 从运行注册表中丢失；分别由 s11、s12、s10、s13 恢复，不重复计数。本次收尾记录为 s10–s15，均已调用 `pi_finish`；已调用 `pi_report` 并排除其他历史任务，随后调用 `pi_gc` 清理了 6 个会话记录。
