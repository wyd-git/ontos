# G2-02-08 PostgreSQL Job/Lease Worker Evidence

- 日期：2026-08-16
- 结论：**PASS**（只代表通用 Worker/Lease/Kill-Resume 协议；不代表 Index/容量、Certificate、真实 Group Cutover、GC、完整 Admin HTTP 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-08](../delivery/g2-02-materialization-task-pack.md#g2-02-08实现-postgresql-joblease-worker-与-killresume)
- 架构决策：[ADR-017](../architecture/adr/017-materialization-worker-recovery.md)
- 专项红队：[G2-02-08 Red Team](../reviews/g2-02-08-materialization-worker-red-team.md)

## 1. 实际交付

| 组件                                   | 责任                                                                                       | 明确不做                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `MaterializationWorker`                | 固定八阶段、最后完整 Checkpoint 恢复、控制读取、失败分类、安全取消、Terminal               | 不接触 PostgreSQL、S3、OIDC 或环境变量   |
| `PostgresMaterializationJobRepository` | 只调用固定 SECURITY DEFINER 函数；完整 Lease/Fence 参数；稳定错误映射                      | 不执行 Migration、DDL、Raw Serving 写    |
| `apps/worker`                          | Worker-only 配置、运行身份预检、Heartbeat、依赖退避、信号处理、连接池生命周期              | 09～11 前不组合空的生产阶段处理器        |
| Migration `0013`                       | 单队列升级、DB 时间租约、Attempt/Checkpoint/Retry/Replay/Cancel/样本、状态视图与最小 Grant | 不修改 0001～0012，不创建第二套 Job 系统 |
| 进程级 Harness                         | 两个真实 Worker PID、16 点 SIGKILL、连接终止、Graceful、Cancel、Retry/Dead Letter          | 不把内存 Repository 当生产边界证据       |

## 2. Acceptance 对照

| 要求                                 | 实现与可执行证据                                                                                                                    | 结论 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 双 Worker 只有一个 Lease；无永久饥饿 | 两个真实 PID 同时抢同一 Job，数据库仅 1 个 leased Attempt；`available_at` 优先排序使旧可领取 Job 不被新高优先级流量永久越过         | PASS |
| DB 时间与全写入围栏                  | Claim/Heartbeat/Control/Checkpoint/Fail/Cancel/Succeed 都用一次数据库时间和五元 Lease CAS；旧 Attempt/Token 真库返回 55000          | PASS |
| 八阶段前后 Kill/Resume               | `scan` 到 `activate` 每阶段前后各 SIGKILL，共 16 点；恢复只从最后完整 Checkpoint 继续                                               | PASS |
| 响应丢失、重复领取和连接短断         | 重复 Enqueue 只保留 1 Job；`activate` Checkpoint 后 Kill 由 Reaper 收敛成功；PostgreSQL 主动终止真实 Worker 连接后无半阶段/重复结果 | PASS |
| Retry/Terminal/人工重放              | 默认 5 Attempt/Cycle，5/10/20/40 秒，永久错误一次 Dead Letter；16 点矩阵产生 3 次可审计 Replay 且保留 16 个 Attempt                 | PASS |
| 安全取消与 Cutover 边界              | 运行中请求在阶段边界取消；Graceful 停在最后 Checkpoint；`activate` Checkpoint 提交后取消稳定拒绝                                    | PASS |
| 样本有界且脱敏                       | Application 拒绝 51 项；数据库再次拒绝 51 项/32 KiB 外形；持久行只有 Reason/Classification/Fingerprint                              | PASS |
| Worker 最小权限                      | 启动校验真实登录角色与危险属性；API Raw Job INSERT 42501；Worker 无 Migration/DDL/Serving Pointer 任意写                            | PASS |
| 真进程而非 Domain 调用               | 测试使用 Node `spawn` 启动/终止真实 PID、真实 Pool、真实 PostgreSQL 16 已提交结果                                                   | PASS |

## 3. Intended-vs-Implemented 复审与实际返工

1. 0013 首版历史 Checkpoint 回填被不可变 Trigger 拒绝；修成只在受控 Migration 回填期间禁用该 Trigger，随后立即恢复。
2. 旧质量/Base Fixture 直接写 Terminal 时未清空 Heartbeat 或未提供成功 Digest；没有放宽新约束，而是修正 Fixture 为真实 Terminal 外形。
3. 旧 API 是列级 Job INSERT，单独撤销表级授权可能残留；最终显式撤销原 6 列并加入真实 42501 负测。
4. 首版领取按 Priority 第一键，持续高优先级流量可能饿死旧 Job；改为 `available_at` 第一键、同一时间再按 Priority。
5. 首版 Heartbeat Timer `unref()`，数据库连接断开且阶段等待时 Node 会 code 13 自行退出；真实连接终止测试发现后改为运行计时器必须托住进程。
6. Heartbeat 内部 Abort 最初可能被记成 `WORKER_SHUTDOWN`；现在只让外部 SIGINT/SIGTERM 使用该 Code，Fence/Dependency 保留原分类。
7. Worker 登录预检最初只看角色 Membership；现在同时拒绝 Current Role 切换、Superuser/CreateDB/CreateRole/Replication/BypassRLS、Database/Schema CREATE 与 Serving 写。
8. Error Sample 最初只按 Attempt FK，未在键上证明属于同一 Job；0013 增加 `(project,attempt,job)` 唯一事实与复合 FK。

以上修正没有扩展 Query、Action、UI、Index、Certificate、Cutover 或 GC 产品范围。

## 4. 可复现验证

```text
npm run test:materialization-worker
PASS — 14 tests：八阶段、续跑、取消、失败分类、Graceful、Heartbeat/Fence、配置与样本边界

npm run test:materialization-worker:postgres
PASS — 1 process-level scenario：16 kill points / 16 attempts / 3 replays
       graceful=PASS cancel=PASS retry=PASS permanent=PASS
       db_connection_outage=PASS，最终 Digest 与 clean control 相同

npm run test:database
PASS — PostgreSQL 16 全量 DB-00/DB-01/DB-02 升级、并发迁移、逐迁移回滚、旧功能与权限回归

npm run verify  (isolated Ubuntu 24 / 8C16G staged worktree)
PASS — 26/26 gates、400 tests、0 failures、304890 ms
       包含 100k Object / 1m Link Mapping、10k Object / 100k Link PostgreSQL Base、
       真实 PostgreSQL/S3/OIDC/HTTP、16 点 Worker Kill/Resume 与生产边界 up/smoke/down
```

上述统一 Gate 是隔离机器上的 staged worktree 结果，不冒充最终 Commit 证据。最终 PR Head 仍必须由 GitHub Required Check 绑定同一 Commit；本文不用工作树内的单项测试代替合并 Gate。

## 5. 非结论与下一项

- `build_index` 还没有接入受信 DDL Executor/容量 Inventory，属于 G2-02-09；
- READY 仍缺 Compatibility Certificate，属于 G2-02-10；
- `activate` 当前只验证通用事务恢复点，真实 Group/Head/CAS Cutover 属于 G2-02-11；
- Staging/Artifact GC、正式 Admin HTTP 与最终 S3/OIDC/API/Worker clean-room 分别属于 12、13、14；
- `worker:start` 在 09～11 完成生产处理器组合前故意以 78 fail closed，进程级测试通过内部正式 Runtime 注入确定性故障处理器，不把空处理器发布为生产能力。

因此下一唯一允许的工作项是 **G2-02-09：Index Plan、容量准入与受信 DDL 执行**。
