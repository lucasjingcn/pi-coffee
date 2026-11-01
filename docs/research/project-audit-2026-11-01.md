# pi-coffee 全量只读审计（2026-11-01）

- **锚定**：`main` @ `7f70ece`（`docs: document the release and publish flow`，2026-11-01 12:12 提交，仅改 README/README.zh-CN）。
  审计开始时 HEAD 为 `4cdbf58`，该 docs 提交在审计期间落到 main；`4cdbf58..7f70ece` 无源码差异。
- **只读**：除本报告文件外未修改仓库；未 commit/checkout/stash/clean，未杀进程，未重启任何 daemon。
- **方法**：6 个只读切片并行（会话内核 / Git 验收 / 进程与锁 / 接口与安全 / 脚本部署 / 测试与文档），
  加上 Lead 对 P0/P1 结论的独立复现或代码复核。每条给 `path:line`；标注证据等级：
  ✅ 已由 Lead 复现 · 🔍 已由 Lead 读码复核 · 📋 子代理报告（未由 Lead 逐条复核）。
- **并行工作区**：审计期间发现 `.agents/worktrees/p0-p1-hardening`（分支 `p0-p1-hardening`，基于 `7f70ece`，
  含未提交的 `src/audit.ts`、`src/secrets.ts` 等 P0/P1 硬化 WIP）。本报告**不包含**该分支，也未触碰它。

## 0. 结论摘要

架构主干是可靠的：验收证据绑定 worker SHA / 目标 SHA / 候选树 / 契约哈希 / epoch，`assertCurrent`
逐项复验；崩溃恢复要求 pgid + 启动时间双重归属证明；`activeCount()+reserved` 保证并发 spawn 不越限；
状态写串行 + 原子 rename + 坏主文件回退备份。**没有发现"结构性重写"级别的问题**。

真正的风险集中在五处：**容器部署（1 个 P0）**、**验收证据链的完整性边界**、**关停/清理路径的竞态与
误删**、**对外接口的隐式契约（GET 副作用、错误语义、暴露面）**、**工具链护栏（测试挂死无超时）**。

统计：**P0 ×1，P1 ×11，P2 ×32**，另有 6 条已文档化的已知限制（不计入问题）。

| 级别 | 一句话 | 位置 |
| --- | --- | --- |
| P0 | 官方 Docker 镜像缺 `procps`，容器里每次 `pi_spawn` 必失败 | `Dockerfile:15-17`、`src/worker-process.ts:16` |
| P1 | 验收命令可 `git commit` 绕过"候选树洁净"检查 | `src/integration.ts:128-138` |
| P1 | 验收定义改动只按文件名启发式识别，可绕过 review 门禁 | `src/validation-changes.ts:8-39` |
| P1 | 48h 清扫删掉仍可 resume 的未完成会话 transcript | `src/manager.ts:447-478` |
| P1 | 无 token 实例上 `GET /internal/shutdown` 可关停 daemon | `src/index.ts:137-146, 190-212` |
| P1 | 扩展 `held` 缓存与 daemon 真锁失同步，edit 静默不再 claim | `extensions/pi-coordinator.ts:157-162` |
| P1 | 关停确认只到 pi 进程组，SIGKILL 升级后工具进程逃逸仍放锁 | `src/rpc-client.ts:245-279` |
| P1 | `/dev/stderr` 等被当越界写目标，合法命令被拦 | `src/bash-paths.ts:463, 476` |
| P1 | Linux 安装/升级守卫在 sudo 下静默失效，看门狗跑旧代码 | `install.sh:11-22`、`deploy/linux/install-service.sh:70` |
| P1 | macOS 安装脚本自身无运行守卫，直接执行会停掉在跑的 worker | `deploy/macos/install-daemon.sh:68-74` |
| P1 | `npm test` 无 `--test-timeout`，单个测试漏杀的 detached 子进程让 verify 无界挂起 | `package.json:28`、`tests/worker-process.test.mjs:34` |
| P1 | `inspect.mjs` 不读 env 文件却自称与 daemon 一致，给出错误结论 | `scripts/inspect.mjs:39-43, 463` |

## 1. 基线（重要：本会话的 verify 结果不能当产品结论）

- `node v22.23.3`；`src/` 26 文件 9175 行；74 个 `tests/*.test.mjs`；30 个 MCP tool；HTTP 路由 `/mcp`、`/metrics`、`/dashboard`、`/internal/*`。
- `npm audit --omit=dev`：0 个已知漏洞。
- **本会话的 `npm run verify` 挂死**（30 分钟无进展，两个测试文件进程 + 各一个 `node -e setInterval` 子进程常驻）。
  根因见 P1-11：本机 Agent 沙箱拒绝 exec `/bin/ps`（`spawn EPERM`），依赖 `ps` 的 fixture 在 `try` 之外抛错 →
  子进程漏杀 → node:test 的 event loop 永不排空；而 `node --test` 未配超时。
- 排除这两个文件后重跑：350 项、312 通过、38 失败。其中 20 项失败是 `cannot snapshot pi credentials`（沙箱拒绝写
  `~/.pi` 的锁文件）、2 项 `spawn EPERM`、其余为连锁失败。**这些都是本会话沙箱效应，不代表产品回归**；
  用户终端/CI 上预期通过（上次记录 359/359）。真正的产品缺陷用单独探针复现，见下。
- 运行时证据（只读）：`git worktree list` 显示主树 + `.agents/worktrees/p0-p1-hardening`；无遗留 `pi/` 分支被本审计改动。

## 2. P0

### P0-1 官方 Docker 镜像里 `pi_spawn` 必然失败（缺 `procps`）

- **位置**：`Dockerfile:15-17`（运行镜像只装 `bash ca-certificates git ripgrep`）、`src/worker-process.ts:16`
  （`execFile('ps', ['-p', pid, '-o', 'lstart=', '-o', 'pgid='])`）、`:36`（探测失败即 throw）、
  `src/manager.ts:1394`（spawn 路径 `client.start()` 之后**必经** `captureWorkerProcess`）、`:1607`（resume 同样）、
  `src/manager.ts:1398-1401`（失败即杀子进程、`status=error`）。
- **证据**：`docker run --rm docker.1ms.run/library/debian:bookworm-slim sh -c 'command -v ps'` → **无输出（NO_PS）** ✅。
  `node:22-bookworm-slim` 基于 debian bookworm-slim 并只加 Node；Dockerfile 未补 `procps`，因此镜像内无 `ps`
  （本机拉 `node:22-bookworm-slim` 因网络受限失败，按 base 镜像推断，属高置信）。
- **影响**：按 README（"only host requirement is Docker"）用 `docker compose up` 部署时，daemon 能起、健康检查能过
  （`docker-compose.yml:22-25` 只探 HTTP），但每个 `pi_spawn`/`pi_resume` 都在 worker 启动后回滚报错。
  CI 只 build/push 镜像（`.github/workflows/release.yml:40-43`），从不运行容器，因此没有覆盖。
- **建议**：运行镜像 `apt-get install -y procps`；或把 `probe()` 改成不依赖 `ps`（Linux 读 `/proc/<pid>/stat` 的
  `starttime` 与 `pgrp`，macOS 才回退 `ps`）；`scripts/doctor.mjs` 增加 `ps` 检查；CI 增加一次容器内 smoke。
- **级别依据**：功能完全不可用 + 用户唯一文档化部署路径，评 P0。若镜像实测其实带 `ps`，降为 P2"未声明的运行时依赖"。
  验证方法：`docker run --rm node:22-bookworm-slim sh -c 'command -v ps'`。

## 3. P1

### P1-1 验收命令可用一次 `git commit` 绕过"候选树洁净"检查

- **位置**：`src/integration.ts:133`（执行验收命令）→ `:135`（`isWorktreeClean(candidate)`）→ `:137-138`（失败映射）；
  `candidateTree` 在 `:128` 由 `git write-tree` 先算好。
- **问题**：`clean` 只看工作区，不看树是否变过。验收命令改文件**并提交**后 `git status` 是干净的 → `passed=true`，
  但断言是在被篡改的树上成立，而记录/合并的是命令执行前的树。
- **复现** ✅：`node /tmp/audit-exp/run.mjs`（E1）→ `passed:true, failure:null, candidateTree == mergedHeadTree`，
  而 `repoItem:"changed"`、断言在 `tampered` 上通过。
- **测试缺口**：`tests/integration-gate.test.mjs:108` 只测了**不提交**的改动。
- **建议**：执行前后都比较 `write-tree`/`HEAD`，或执行后 `git status --porcelain` + `rev-parse HEAD` 必须等于
  `candidateTree` 对应的提交；不一致直接判失败。

### P1-2 验收"定义"的改动检测是纯文件名启发式，可绕过 review 门禁

- **位置**：`src/validation-changes.ts:8, 11-23, 33-39`（只认 `test/tests/spec/` 目录与 `*.test.*`、`vitest.config.*`、
  `conftest.py` 等文件名）；消费点 `src/integration.ts:171`（只有 `existingValidationChanges.length > 0` 才强制 review）。
- **问题**：worker 在 scope 内改 `package.json` 的 `scripts.test`、`Makefile`、`.github/workflows/*.yml`，或把
  coordinator 的 `acceptance_command` 调用的脚本改成 `exit 0`，`existingValidationChanges` 仍为空 → 无需 `pi_review` 即可 merge。
- **复现** ✅：`node /tmp/audit-exp/run.mjs`（E2）→ `passed:true, existingValidationChanges:[], review_required:false,
  merged:true, candidateReview:null`（`accept.sh` 被改成 `exit 0`）。
- **缓解**：README 已建议把这类路径写进 `spec.validation_paths`；但工具描述（`src/mcp-server.ts:664`）的承诺比实现强。
- **建议**：把 `package.json`/lockfile/`Makefile`/`.github/`/CI 脚本默认纳入 validation change；或在 verify 时冻结
  验收命令所调用的脚本哈希。

### P1-3 48h 会话目录清扫删掉"仍可 resume"的未完成会话 transcript（与 README 相反）

- **位置**：`src/manager.ts:447-478`（`sweepSessionDirs`：只要求 `status === "stopped"`，不看 outcome、不走 `dead()` 规则）；
  `README.md:557, 571`（"transcript of a stopped **and finished** session"、"Never reclaimed automatically: … transcript …
  of any session whose worktree or live worker branch is still there"）。
- **复现** ✅：`node /tmp/audit-probe2.mjs` →
  `removed=1 | transcriptExists=false | worktreeExists=true | branchLive=true`；
  随后 `pi_resume` 报 `session s900 has no transcript directory; re-dispatch instead of resuming`。
- **影响**：默认 `autoClean=1` 下，任何"停掉但没记 outcome"的会话 48h 后丢失唯一可 resume 的上下文（worktree 与分支还在）。
- **建议**：与 reclaim 口径统一——只删"已终局且 worktree 与分支都无法复活"的 transcript；`tests/session-retention.test.mjs`
  与 README 二者必有一错，先定契约再改测试。

### P1-4 无 token 实例上 `GET /internal/shutdown` / `/internal/drain` 可被任意本机进程或页面触发

- **位置**：`src/index.ts:137-146`（鉴权条件：只有 `config.token` 存在或 `hasProtectedSessions()` 且路径属 mutating 集合时才 401）、
  `:190-212`（`drain`/`shutdown` 分支，无 method 检查，GET 同样执行副作用）、`:69-76`（`authorized()` 在无 token 时恒真）。
- **复现** ✅（子代理在 /tmp 一次性实例实测）：`curl http://127.0.0.1:<port>/internal/shutdown` → `{"ok":true,"stopping":true,…}`
  随后连接被拒；`GET /internal/drain?action=start` → 200 且 health `draining` 变 true。
- **影响**：默认无 token + 绑 loopback 是文档行为，但"GET 有副作用"是未文档化的隐式契约；同机浏览器页面/本机任意进程
  可 `<img src="http://127.0.0.1:8787/internal/shutdown">` 之类简单 GET 关停 daemon（无需预检）。README 未覆盖此面。
- **建议**：所有 mutating 内部端点强制 POST/PATCH，GET 一律 405；`drain`/`shutdown` 加 `Origin` 校验或一次性 nonce。
- **未评 P0 的原因**：需要能访问 127.0.0.1；不构成跨主机 RCE。

### P1-5 扩展 `held` 缓存与 daemon 真锁失同步 → edit 静默不再 claim

- **位置**：`extensions/pi-coordinator.ts:157-162`（`coord_release` 只精确 `held.delete(p)`，daemon 侧
  `src/locks.ts:85-93` 按 overlap 释放）、`:219-235`（`ensureClaims` 命中 `held` 就不再发 claim）；
  外部 `pi_release`（`src/manager.ts:2318-2336`）同样让 `held` 陈旧。
- **复现** ✅：`node --import tsx /tmp/audit/held.mjs` →
  `after claim: ['src/a.ts'] / after release: [] / edit src/a.ts -> allow ; extra /internal/claim calls = 0 ; daemonLocks= []`。
- **影响**：README 的核心不变量"worker 写前先 claim"被静默破坏；此时另一个 worker 可 claim 同一路径并发写。
- **建议**：release 按 overlap 同步清 `held`，或取值时仍向 daemon 确认。

### P1-6 关停确认只到 pi 自身的进程组，SIGKILL 升级后工具进程逃逸仍放锁

- **位置**：`src/rpc-client.ts:245-279`（`alive()` 只 `kill(-pid, 0)`；`wait()` 只要求该组空 + 根进程退出，随后
  `shutdownConfirmed = true`）、`:118-119` 的注释与 `:276` 的报错文案承诺"worker and tool process exit"；
  pi 的 bash tool 以 `detached: true` 起子进程（`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:65`），
  清理钩子只挂在 SIGTERM/SIGHUP（`dist/modes/rpc/rpc-mode.js:275-288`）。
- **复现** ✅：`node /tmp/audit/pg.mjs` → `after SIGKILL(pi group): groupAlive=false piExited=true toolAlive=true`。
  即 `shutdownConfirmed=true` → `src/manager.ts:2238-2243` 释放 scope 锁/可选删 worktree，而工具仍在写。
- **建议**：关停后对"本 session 的 worktree"做孤儿进程扫描（pgid 记录/进程树），或要求 pi 侧保留工具 pid 账本；
  在确认失败时保留锁。

### P1-7 bash 写入识别把 `/dev/stderr|/dev/stdout|/dev/tty|/dev/fd/N` 当越界写目标

- **位置**：`src/bash-paths.ts:463`（`DISCARD_DEVICES = new Set(["/dev/null"])`）、`:476`；拒绝点
  `extensions/pi-coordinator.ts:259-260`。
- **复现** ✅：`node --import tsx /tmp/audit/wp.mjs` → `ls 2> /dev/stderr` = BLOCK、`echo hi > /dev/fd/2` = BLOCK，
  `printf x > /dev/null` = ALLOW。
- **影响**：这些是自身 fd 的重定向，不是"worktree 外写"；`38a1d02` 修 `/dev/null` 时只补了一个 sink。常见命令被拦。
- **建议**：把 `/dev/stdout`、`/dev/stderr`、`/dev/tty`、`/dev/fd/*`、`/proc/self/fd/*` 一并列入 sink，并补测试。

### P1-8 Linux 安装/升级守卫在 sudo 下静默失效，用户以为升级完成、实际跑旧代码

- **位置**：`install.sh:11-22`（Linux 分支用 `systemctl --user is-active`，`sudo` 下连不上用户总线 → 2>/dev/null 吞掉 →
  守卫恒过）、`deploy/linux/install-service.sh:70`（root 分支 `systemctl enable --now` 写 `/etc/systemd/system`；
  对已 active 的 unit，`start` 是 no-op）、`install.sh:97`（收尾 `check-health` 探到的是**旧进程** → 报 healthy）。
- **影响**：升级后不要重启；旧 daemon 继续加载旧 dist。
- **建议**：安装/升级脚本统一 `restart`（或先 `stop` 再 `start`），并校验新进程启动时间/构建哈希；守卫同时覆盖
  systemd 系统级 unit（`systemctl is-active`）与 `--user`。

### P1-9 macOS 安装脚本自身没有运行守卫，按脚本头说明直接执行会停掉正在跑的 worker

- **位置**：`deploy/macos/install-daemon.sh:1-3`（提示"Run from the project root: ./deploy/macos/install-daemon.sh"）、
  `:68`（`launchctl bootout` → SIGTERM → `src/index.ts:421` → `coord.stopAll()` 停掉所有 worker）。
  运行守卫只在 `install.sh:11-16`，`install-daemon.sh` 自身没有。
- **建议**：安装脚本自己先检测 daemon 是否在运行并拒绝（或提供 `--force`），与 `install.sh` 共用同一守卫函数。

### P1-10 `inspect.mjs` 不读 env 文件却声称与 daemon 的数据目录解析一致

- **位置**：`scripts/inspect.mjs:39-43`（声称 "dataDir resolution matches the daemon"）、`:463`（只读 `envValue`，
  不 import `scripts/lib/env.mjs`）、`:182-188`（state.json 缺失被当 "fresh boot, not a finding"）。
- **复现** ✅：`printf 'PI_COFFEE_DATA_DIR=/tmp/audit-data\n' > /tmp/e && PI_COFFEE_ENV_FILE=/tmp/e node scripts/inspect.mjs`
  → 仍然输出 `dataDir: /Users/lucasjing/.pi-coffee`。
- **影响**：诊断工具给出与 daemon 不同的结论（可能把"读错目录"报成"干净/缺文件"）。
- **建议**：与 daemon 共用 `loadEnvFile`，并在输出里打印实际生效的 env 文件路径。

### P1-11 `npm test` 无 `--test-timeout`，测试漏杀 detached 子进程会让 verify 无界挂起

- **位置**：`package.json:28`（`node --test --test-concurrency=4 tests/*.test.mjs`，无超时）；
  `tests/worker-process.test.mjs:34-35`（`await captureWorkerProcess()` 在唯一没有 `try/finally` 的清理路径上）、
  `tests/worker-restart-safety.test.mjs:21-22`（`captureWorkerProcess` 在 `try` **之前**）。
- **复现** ✅（本会话两次）：`npm run verify` 在 `worker-process` / `worker-restart-safety` 两个文件挂 30 分钟不退出，
  各留一个 `node -e setInterval` 子进程；`sample` 显示主线程停在 `kevent`（无 JS 在跑）→ 句柄未释放。
  单跑同样两个文件（有外部超时）则在 1s 内报完并退出。
- **影响**：本地无界；CI 靠 `verify.yml:17` 的 30 分钟 job timeout 兜底，报错形态是"job timeout"，无法归因。
- **建议**：`node --test --test-timeout=60000 --test-force-exit`；两个测试把 `captureWorkerProcess` 放进 `try`/`finally`；
  `ps` 探测失败时走"跳过该用例 + 明确原因"，而不是 throw。

## 4. P2（按主题分组）

**清理 / 资源回收**

| # | 问题 | 位置 | 等级 |
| --- | --- | --- | --- |
| 1 | 启动清扫绕过 worktree/transcript TTL：重启即删刚完成（60min TTL 内）worker 的 worktree，随后 `pi_diff/pi_exec` 失败 | `src/manager.ts:326-352` ✅ | 已复现 |
| 2 | `drain`/`/internal/shutdown` 的 active 计数不含在途 spawn 的 `reserved` → "active=0 是安全重启点"不成立 | `src/manager.ts:1841-1854, 1193` 🔍 | 已复核代码 |
| 3 | SIGTERM 撞上同仓库 `pi_verify/pi_merge` 时 `stop` 被 repo guard 拒绝 → exit 1 且 worker 仍活着 | `src/manager.ts:2253, 2290-2304` 🔍 | 已复核代码 |
| 4 | spawn 失败残留 `pi/<id>` 分支；gc 候选只来自会话元数据 → 永不回收 | `src/worktree.ts:197-200`、`src/manager.ts:1326, 789` ✅ | 已复现（E4） |
| 5 | spawn 中 `vault.save` 失败遗留 worktree + branch（同类失败在 acceptance 分支会清理） | `src/manager.ts:1373-1379` 🔍 | 已复核代码 |
| 6 | claim 不校验 status：停止窗口内的 claim 可泄漏锁 | `src/manager.ts:2310-2316` 🔍 | 已复核代码 |
| 7 | `pi_message` 的 `delivered` 在注入结果未知时就置 true | `src/manager.ts:2403-2406` 🔍 | 已复核代码 |

**证据与新鲜度**

| # | 问题 | 位置 | 证据 |
| --- | --- | --- | --- |
| 8 | 代码新鲜度只比 `dist/manager.js` 的 mtime，内容变了（`cp -p`/镜像回填）仍判"未变化" | `src/code-version.ts:48-50` | ✅ E3 |
| 9 | merge 已落地并写 integration 后，被 post-merge hook 弄脏的目标树让任务无法收口且无回滚 | `src/worktree.ts:410-421`、`src/manager.ts:2172-2180` | ✅ run6 |
| 10 | `/internal/sessions`、`/internal/status` 只剥两个 hash，仍返回 `verification.result.stdout/stderr` 全文与 `workerProcess` 身份 | `src/index.ts:85-90, 183-188` | 🔍 |
| 11 | `/metrics` 的 `pi_coffee_spawns_total` 把持久化历史算成 "since the coordinator started"（counter 语义错误） | `src/metrics.ts:174-176, 291` | ✅ 子代理实测 |
| 12 | `pi_spawn` 与 `pi_review` 的 requirement id 一个 trim 一个不 trim → review 报 unknown requirement | `src/mcp-server.ts:207` vs `:668` | 🔍 |

**锁 / 写入识别 / 进程**

| # | 问题 | 位置 | 证据 |
| --- | --- | --- | --- |
| 13 | `cp/mv/dd/install/truncate/rsync/sh -c` 等字面量写入不识别（含写 `.git/config`） | `src/bash-paths.ts:469-511` | ✅ 实测 |
| 14 | 手动 claimant 用绝对路径 claim 落进不同键空间，静默不生效 | `src/manager.ts:2310-2316`、`src/locks.ts:115-118` | ✅ 实测 |
| 15 | `lockKey` 只做词法归一化不 realpath：symlink 前缀/大小写不敏感文件系统上同一文件不冲突 | `src/locks.ts:115-118` | ✅ 实测（词法层） |
| 16 | 词法扫描把 `->` 拆成重定向，产生伪锁（如 `%s`） | `src/bash-paths.ts:165-171` | ✅ 实测 |
| 17 | RPC stdout 行缓冲无上限（stderr 有 200k 上限） | `src/rpc-client.ts:297-311` vs `:133-136` | 🔍 |
| 18 | stdio-proxy 逐行并发处理 + 重试窗口，daemon 重启期间请求可能乱序（重试白名单本身正确，不会重放已执行副作用） | `src/stdio-proxy.ts:148-155` | 🔍 |
| 19 | worker agent dir 把全局 `skills/prompts/themes/extensions` 以 symlink 挂入，bash 动态路径可写到全局配置 | `src/worker-agent-dir.ts:183-188` | 🔍 |

**部署 / 运维 / 文档**

| # | 问题 | 位置 | 证据 |
| --- | --- | --- | --- |
| 20 | 运行镜像无 `USER`，容器内 root；bind mount 宿主仓库后 worker 以 root 改写宿主文件 | `Dockerfile:12-47` | 🔍 |
| 21 | `npm install -g @earendil-works/pi-coding-agent` 无版本，镜像里的 pi 与验证过的 1.4.0 不一致（且 `npm ci --omit=dev` 丢掉 devDependency pin） | `Dockerfile:20, 24` | 🔍 |
| 22 | compose 端口映射两侧都用宿主 `${PI_COFFEE_PORT}`，宿主改端口时容器内仍监听 8787 → 发布端口无人监听，健康检查却通过 | `docker-compose.yml:10`、`Dockerfile:34-36` | 📋 子代理实测 |
| 23 | `start.mjs` 用 `override: true` 让 env 文件覆盖 shell 导出变量，与 README 推荐的 `PI_COFFEE_HOST=… ./run.sh` 冲突 | `scripts/start.mjs:8`、`README.md:451` | 📋 |
| 24 | `install.sh` 先 `mcp remove` 再 `mcp add`，add 失败即删除用户原本可用的注册且无回退 | `install.sh:66-76` | 📋 |
| 25 | `check-health.mjs` 不认 `PI_COFFEE_URL`（status/upgrade/dsh 文档都优先它），可能为客户端连不上的端点报 healthy | `scripts/check-health.mjs:6-8` | 📋 |
| 26 | CI Windows job 只跑 `startup-platform` 一个测试文件；release workflow 对任意 `v*` tag 出 release 且覆盖 `:latest`，不校验 tag 与 `package.json` 版本一致 | `.github/workflows/verify.yml:36-48`、`release.yml:3-6` | 📋 |
| 27 | CHANGELOG 声明 359 项测试，仓库实为 357 个 `test(`（`grep -rh "^\s*test(" tests/*.test.mjs | wc -l`） | `CHANGELOG.md:36` | ✅ |
| 28 | README 环境变量表漏 `PI_COFFEE_WORKTREE_FINAL_TTL_MIN` 与 `PI_COFFEE_EXTENSION` | `README.md:600-625` | ✅ |
| 29 | `/metrics`、`/dashboard` 拒绝 HEAD（405），探活/监控会误判端点不存在 | `src/index.ts:321-322`、`src/dashboard.ts:590-592` | ✅ |
| 30 | >32MiB body 直接 `req.destroy()`，承诺的 400 永远发不出去（客户端拿 ECONNRESET，无日志） | `src/index.ts:40-42, 346-372` | ✅ 子代理实测 |
| 31 | master token 比较用 `===`（dashboard 用 `timingSafeEqual`），同一 secret 两套策略 | `src/index.ts:69-76` vs `src/dashboard.ts:111-130` | 🔍 |
| 32 | worker 越权/跨 scope 违约返回 500 并回显内部错误原文（应为 403） | `src/index.ts:303, 273-274` | 🔍 |

## 5. 已知限制（已文档化，不算 bug）

1. 文件锁是建议性协调，不是 OS 沙箱；bash 写入只认 redirect/`tee`/`sed -i` 字面量（`README.md:543-547, 532`）。
2. `state.json` 备份可能落后一次保存；无掉电持久化保证；单 daemon 假设（`README.md:667-668`）。
3. Windows 无自动孤儿进程回收（`src/worker-process.ts:50-56`，`README.md:800`）。
4. shutdown 未证实的 orphan 保留锁并占用并发槽（fail-closed 设计）。
5. 默认无 token、绑 loopback（`README.md:672-675`）——本报告 P1-4 指出的是"GET 有副作用"，不是"无 token"本身。
6. 文本日志默认不过滤（仅 `PI_COFFEE_LOG_FORMAT=json` redact，`tests/log-json.test.mjs:210` 明确断言）；
   现有 16 个 `logLine` 调用点未传 token/命令全文。

## 6. 建议的修复顺序

1. **P0-1** 容器 `procps`（或去掉 `ps` 依赖）+ doctor 检查 + 一次容器内 spawn smoke。这是唯一"部署即不可用"的问题。
2. **P1-1/P1-2** 证据链两处：候选树前后比对；validation 定义默认纳入。它们决定"绿是否可信"。
3. **P1-3/P1-11/P1-8/P1-9** 清理与安装路径：48h transcript、测试超时/漏杀、Linux/macOS 升级守卫。都是"静默破坏"类。
4. **P1-4/P1-5/P1-6/P1-7** 接口与锁：GET 副作用、`held` 同步、工具逃逸、`/dev/*` 误判。
5. **P1-10** 诊断工具与 daemon 共用 env 解析。
6. P2 按"部署/运维 → 证据 → 锁/进程"的批次修，每批配一个回归测试。

## 7. 未覆盖与不确定

- 本机网络受限，未拉取 `node:22-bookworm-slim` 本体；P0-1 的镜像内行为由 base 镜像（debian bookworm-slim，实测无 `ps`）
  与 Dockerfile 推断，建议用 `docker run --rm node:22-bookworm-slim sh -c 'command -v ps'` 一锤定音。
- 未运行容器、未做真实模型调用、未触发 CI；`release.yml`/`verify.yml` 的远端行为未验证。
- 本会话沙箱导致 `npm run verify` 挂起且 38 项假红，**不能**作为"主干红了"的证据；产品缺陷均用独立探针复现。
- 子代理报告中标 📋 的条目未由 Lead 逐条复现（时间为 05:00 内），但都有 `path:line`，可按需复核。
- 覆盖度：6 个切片合计读了 `src/` 全部 26 个文件与 `scripts/`、`deploy/`、CI 配置；74 个测试文件抽查约 12 个
  （其余按"测试能否真失败"抽查结论为：未发现普遍性假绿）。

## 8. 修复落地（2026-11-01）

本报告的 **P0 与全部 11 个 P1** 已修复并合入 `main`：

- 分支 `audit-p0-p1-fixes`（base `7f70ece`），提交 `efe6ac2`，合并提交 `0984509`。
- 每项都有回归测试；P1-1、P1-2 额外用"回退源码后新测试必须失败"证明测试确实能抓到修复前的行为。
- 合并后在 `main` 上跑完整 `npm run verify`：368/368 通过（typecheck、扩展类型、构建、离线测试、playbook 一致性），0 失败 0 跳过。
- 未处理：第 4 节的 P2 清单保持原状；`P1-6` 的逃逸检测依赖 `ps`（`doctor` 现在会检查），无法读取进程表时保留原行为并在注释中说明。
- 并行工作区 `.agents/worktrees/p0-p1-hardening` 与本分支无关，未合并、未触碰。
