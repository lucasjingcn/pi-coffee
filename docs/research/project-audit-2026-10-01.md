# pi-coffee 项目检查与修复（2026-10-01）

目标：提交上一轮 DSH 对比吸收改动，检查 pi-coffee 的会话生命周期、RPC、内部 API、持久化、Git 验收与合并、配置和启动链路；修复已复现的问题并提交。实际编辑与最终验证来自 `/Users/lucas/code/pi-coffee` 的 `main`。

## 已修复

| 范围 | 问题与修复 | 回归证据 |
| --- | --- | --- |
| 会话锁 | 异常退出遗留验收锁；现在释放一次，旧会话再次退出或停止不会释放新会话的锁 | coordinator-races |
| 会话状态 | 停止期间仍接受指令、正常停止误记错误、启动完成可复活已停止会话；先阻止新工作并保留终态 | coordinator-races |
| UI 问答 | 已退出或完成的 worker 可假成功接收答案；现在明确拒绝并清除失效问题 | coordinator-races |
| 内部 API | 错误类型的消息、看板或确认数据可污染待持久化状态；在变更前验证端点输入并返回 400 | http-inputs，实际临时 HTTP daemon 与 state.json |
| 看板 | worker GET 查询忽略 key；现在读取查询参数并按键过滤 | http-inputs |
| RPC 输入 | null JSONL 可崩溃，success 非布尔与 command 不匹配可被接受；现在检查记录形状与关联响应 | rpc-inputs，真实子进程上的离线协议夹具 |
| RPC 请求 | 超时 ID 可复用并收到旧响应，自动 ID 可与显式 ID 碰撞；现在 ID 单次使用，非法 ID 立即拒绝 | rpc-inputs、rpc-lifecycle、rpc-races |
| RPC 启动 | 未就绪子进程遗留、探针超出启动预算；失败时终止子进程并清空待处理请求，探针受总截止时间约束 | rpc-inputs |
| RPC 计时 | 大有限启动预算溢出 Node 定时器；探针计时限制在 get_state 的 20 秒上限 | rpc-inputs，修复前复现失败 |
| Docker | 健康探针缺少 token、自定义端口与 Compose 映射不一致；使用统一认证探针和可配置映射 | startup-audit；Compose 实际解析 9000→9000 |
| 状态脚本 | 不读取配置、不带 token，401 显示假空列表；现在认证、验证响应并在失败时退出非零 | startup-audit |
| 安装预检 | 配置优先级与 daemon 不同，临时 shell 凭据误当作后台凭据；统一优先级并增加 --background 持久化检查 | startup-audit；安装入口与双语文档同步 |
| 服务模板 | 特殊路径破坏 systemd 参数或 plist XML；转义百分号、引用参数、禁用固定命令的变量展开并编码 XML | service-paths，临时 HOME 与模拟服务命令；本机 plist 解析 |

systemd 的固定命令使用 `:` 前缀禁用环境变量展开，依据 [官方命令行文档](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml) 与 [配置解析源码](https://github.com/systemd/systemd/blob/main/src/core/load-fragment.c)。

## 验证范围

最终 `npm run verify` 退出 0：类型检查、扩展类型检查、构建、198/198 测试和 playbook 一致性检查全部通过；其中包含 credential-free 的端到端离线 smoke。另执行 shell 语法检查、`git diff --check` 和 Compose 的真实配置解析。

这些证据证明本地合同与回归场景；没有执行真实 Docker 容器构建/运行、真实 systemd/launchd 安装或 Windows 运行验收。没有推送、部署、更改默认模型或重启共享 daemon。

## pi-coffee 工作记录

- s3 实现 RPC 修复，主会话审查一次后补充输入预算检查。25 项实际合并候选测试通过，逐条 pi_review 通过，再经 pi_merge 并入本地 main。主会话随后独立复现并修复大预算计时问题。
- s4 完成只读启动检查，主会话核对证据并实施 Docker、状态与预检修复。
- s1/s2 因中断未交付报告，按 abandoned 关闭。s5 服务模板补丁也在中断后保留；主会话审查、修正并直接验收采用，未宣称它通过 pi_verify/pi_merge，历史会话按 abandoned 关闭。
- 所有本次 worker 已关闭。部分中断 worker 与主会话成本缺失，不计算总成本或节省率。

## Git 记录

| 提交 | 内容 |
| --- | --- |
| c418fb0 | Add candidate-bound requirement and validation review gates（上一轮吸收改动） |
| 8d8c8cf | Fix worker shutdown reservations and reject invalid internal payloads |
| feb834d | Honor board key filters from worker query requests |
| e250093 | Fix authenticated health checks and background configuration preflight |
| e375df7 | Harden RPC parsing, request correlation and startup cleanup（worker 提交，已合并） |
| 73186fd | Merge e375df7803117479847c118938e8bb815acd3215 into main |
| 6c112b9 | Bound readiness probe timers for large startup budgets |

服务模板与本记录在最后一个提交中提交。所有记录均为本地 Git 工作。
