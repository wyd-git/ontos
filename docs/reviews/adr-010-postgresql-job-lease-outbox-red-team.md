# Red-Team：ADR-010 PostgreSQL Job、Lease 与 Outbox

- 日期：2026-08-13
- 审查对象：[ADR-010](../architecture/adr/010-postgresql-job-lease-outbox.md)
- 方法：`strategy-red-team` 后接 `intended-vs-implemented`
- 结论：**G2-00-06 的纯状态合同可接受；Production PostgreSQL 原子性、并发 Claim、Consumer 去重与运维权限仍由 DB-03/04 和后续 Gate 阻断**

## Top Kill-Assumptions（排序）

### 1. Production Repository 的每条推进路径都会执行完整 Lease CAS（100）

- **Claim：** Database Clock + Attempt ID + Worker ID + Fencing Token 能阻止 Crash 后恢复的旧 Worker 提交结果。
- **Steelman：** 状态模型把 Lease 验证集中在一处，完成、Checkpoint、Heartbeat、失败和 Ack 都先验证；到期边界也明确为 `databaseNow >= expiresAt` 失效。
- **Fails if：** DB-03/04 任一 SQL 只按 Work ID 或 `lease_owner` 更新，先查后改，忽略 Fencing Token/Attempt/Expiry，或把 Worker 时间传入 WHERE；旧进程可覆盖新 Attempt。
- **Evidence to get this week：** 对真实 Repository 的每条 Update 做并发故障测试：Worker A 过期、Worker B Reclaim、A 再提交，验证受影响行数为 0，Attempt/Result/Audit 不变化。
- **Kill criterion：** 任一 Job Completion、Checkpoint、Outbox Ack/Failure 或 Heartbeat 路径不能引用同一完整 CAS；对应业务模块不得接入。
- **Cheapest test：** 当前模型用旧 Lease、错误 Worker、错误 Fence、精确到期时间和数据库时间回退做单元反例；DB-03/04 复用相同向量跑 PostgreSQL。
- **处理：** `shared.ts:141-202` 集中时间与 Lease Gate；`job.ts:231-345` 和 `outbox.ts:325-444` 调用同一 Gate。纯模型已 CLOSED，SQL Translation 仍 OPEN（DB-03/04）。

### 2. “业务提交与 Outbox 同事务”不会在 Adapter 层被拆开（100）

- **Claim：** Action Commit 后不会永久丢 Event，Commit 后响应丢失也不会产生第二次业务效果。
- **Steelman：** ADR 将 Overlay、Projection、ChangeSet、COMMITTED ActionExecution 与 Event 固定为同一事务；模型在写入任何 Event 前验证完整 Batch，并按 Business Transaction Digest 返回原集合。
- **Fails if：** HTTP Handler Commit 后再调用另一个 Repository 补 Event，Transaction Manager 不跨模块共享连接，或 Idempotency Retry 重新生成 `eventId`。
- **Evidence to get this week：** DB-03 在事务每个阶段 `pg_terminate_backend` / 抛错；逐项验证没有“业务有、Event 无”或“Event 有、业务无”。Commit 后丢响应再用原 Key 请求，ActionExecution/Event 数量不变。
- **Kill criterion：** 任一故障点产生部分 Overlay/ChangeSet/Outbox，或相同 Digest 返回不同 Event Set。
- **Cheapest test：** `outbox.test.ts:18-111` 当前验证批次全有/全无、Commit 后响应丢失和 Event Array 重排；下一步只需把向量搬到真实事务。
- **处理：** 纯模型范围 CLOSED；真实跨模块 Transaction OPEN（DB-03）。

### 3. 同对象顺序在并发写入和 Dead Letter 下仍成立（90）

- **Claim：** 每个 `(Project, Destination, objectRid)` 的 Consumer 严格按 ChangeSet Sequence / Event Ordinal 观察事件。
- **Steelman：** 模型拒绝后来的更早/相同 Sequence，Claim 检查全部未投递前驱，一个 Dead Letter 会阻塞 Later Event；不同 Object 仍可并行。
- **Fails if：** Production Insert 没有锁 `outbox_stream_heads`，两个事务都认为自己是新 Head；Claim 的 `NOT EXISTS` 缺少 Destination/Object/State 条件；Dead Letter 被过滤出 predecessor；或批量 Claim 同时拿到一个 Stream 的多条 Event。
- **Evidence to get this week：** DB-03 用 20 个连接乱序提交同一 Object / 不同 Object，故意 Dead Letter 第一个 Event，验证唯一 Head、无 late insert、每 Stream 一个 in-flight、其他 Stream 不受阻。
- **Kill criterion：** Consumer 观察到 Sequence 回退；Earlier Dead Letter 后 Later 被 Claim；或不同 Object 因错误全局锁而无法并行。
- **Cheapest test：** `outbox.test.ts:47-142` 固定反例，加 `properties.test.ts:70-124` 每轮 200 组乱序输入。
- **处理：** 审查前模型允许后续事务插入更早 Sequence，也允许另一事务补同 Sequence；现由 `outbox.ts:185-195` 拒绝并有对应反例。真实 Stream Head Lock 仍 OPEN（DB-03）。

### 4. Consumer 的 `eventId` 去重是持久业务约束，不是日志字段（90）

- **Claim：** Outbox 的 at-least-once 不会让外部业务效果重复。
- **Steelman：** Worker 不把 Timeout 当作未执行；重投原 `eventId`，Consumer Ack 回报 `APPLIED / ALREADY_APPLIED`，Attempt 保留 `SENT_NO_ACK` 和 Ack 观察。
- **Fails if：** Consumer 先产生副作用、后写去重键；去重只在进程内存；Ack 不回显 Event ID；或 Worker 在超时后生成新 Event ID。
- **Evidence to get this week：** 建立真实幂等测试 Consumer，在“副作用已提交、Ack 前断连”点注入故障，重投后业务计数仍为 1 且返回 `ALREADY_APPLIED`。
- **Kill criterion：** 两次相同 `eventId` 造成两次外部效果，或平台无法从 Attempt 看出重复被 Consumer 消解。
- **Cheapest test：** `outbox.test.ts:183-206` 和 `243-272` 已证明协议状态；DB-03 增加一个小 PostgreSQL-backed Consumer 即可验证真实原子去重。
- **处理：** 协议/模型 CLOSED；真实 Consumer OPEN（DB-03）。

### 5. PostgreSQL-only Queue 在目标积压下不会因 Head-of-line、锁或同步重试失去可运营性（72）

- **Claim：** P0 不引入额外 Queue 基础设施仍能满足内部 Alpha 的 Worker 负载。
- **Steelman：** `SKIP LOCKED` 允许不同 Job/Object 并行，索引范围有限，Outbox 只在真正要求顺序的 Stream 内阻塞。
- **Fails if：** Eligibility/Predecessor 查询退化为大范围扫描，热门 Object Stream 锁等待过高，大量同刻失败按无 Jitter 退避形成重试尖峰，Dead Letter Stream 长期无人处置。
- **Evidence to get this week：** DB-03/04 保存 `EXPLAIN (ANALYZE, BUFFERS)`、Claim P95、锁等待、Outbox Lag、表/索引膨胀；G2-07 做目标并发与依赖中断恢复负载。
- **Kill criterion：** 在已定义目标负载下 Claim P95/积压恢复不达 Gate，或必须弱化同对象顺序才能通过；此时重新评估 Partition/Jitter/外部 Queue，不偷偷放宽语义。
- **Cheapest test：** 先在 PostgreSQL 16 插入 100k Pending/Delivered 混合 Event，以 8 个 Worker Claim；再将一个 Destination 中断 5 分钟并恢复。
- **处理：** 当前只冻结确定性基础退避和索引形状，不伪造性能结论；OPEN（DB-03/04、G2-07）。

## Intended vs. Implemented 审查

| 已记录意图                                                           | 审查前实际                                                              | 安全/一致性边界                                             | 修正与证据                                                                                                  | 状态                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 所有 Worker 推进使用 DB Time + 完整 Lease                            | 模型已有统一 Lease Gate，但时间溢出和未来 Available Time 最初未完整检查 | unsafe timestamp 可绕开有序比较或产生永不到期记录           | `shared.ts:141-202` 增加 safe addition；`job.test.ts:31-49` 固定非有限/溢出反例                             | CLOSED（模型）/ OPEN（DB-03/04）      |
| Job Failure Audit 区分 Worker 与 System Reaper                       | 最初所有 Retry/Dead Letter Audit 都标为 `SYSTEM`                        | 事故调查无法区分业务 Worker 报错与 Lease Reaper             | Failure Transition 显式接收 Actor Type；Worker 与 Reaper 各自写入                                           | CLOSED                                |
| Audit 不含自由文本 Secret/PII                                        | 最初把 Job Result Reference 和人工 `reason` 原文写入 Audit Detail       | 路径、Ticket 文本或误贴 Secret 可永久进入 append-only Audit | Result 只写 `resultRecorded=true`；`shared.ts:221-228` 限制安全大写 Reason Code；负例 `job.test.ts:128-151` | CLOSED                                |
| Business Transaction Idempotency 不受 Event 数组顺序或字段分隔符影响 | 最初用控制字符 delimiter 拼接字段                                       | 合法字段可能构造签名碰撞；同一集合重排被误判不同            | `outbox.ts:837-859` 改为结构化 JSON 行、确定性排序；`outbox.test.ts:96-111`                                 | CLOSED                                |
| 同 Stream 不允许 late predecessor 或另一事务补同 Sequence            | 初版只拒绝完全相同 `(Sequence, Ordinal)`                                | 已 Claim/Delivered 的高序号可能早于后来补入事件，破坏顺序   | `outbox.ts:185-195` 拒绝已有 Sequence `>=` 新 Sequence；`outbox.test.ts:59-93`                              | CLOSED                                |
| ChangeSet Sequence 可落 PostgreSQL `bigint`                          | 初版只拒绝负 BigInt                                                     | 超过 signed bigint 的模型值无法迁移                         | `shared.ts:3` 上界 + Outbox 边界校验；`outbox.test.ts:47-56`                                                | CLOSED                                |
| Consumer Dedupe 可观察                                               | 初版设计即保存 Ack Event ID、Consumer ID 和 `APPLIED/ALREADY_APPLIED`   | 没有该字段时平台无法区分成功与重复消解                      | `outbox.ts:376-427`；故障窗口 `outbox.test.ts:183-206`                                                      | CLOSED（模型）/ OPEN（真实 Consumer） |
| Outbox 与业务事实同 PostgreSQL 事务                                  | 当前只有内存模型，没有 Action/Overlay Migration/Repository              | 纯函数不能证明进程 Crash 时的数据库原子性                   | ADR-010 §2.3 / §3；模型先完整验证 Batch；真实故障注入归 DB-03                                               | OPEN（DB-03）                         |
| 人工重放受统一 Policy 保护                                           | 模型要求 Operator ID/Reason Code，但没有身份或授权模块                  | 任意能调用 Repository 的身份可能重放外部副作用              | ADR 明确 Policy Gateway；G2-00-08 和 Ops API 必须加可引用的授权点                                           | OPEN（G2-00-08 / Ops）                |

没有发现仍未修正、且属于 G2-00-06 纯状态模型范围的 Intended-vs-Implemented 漂移。当前所有 OPEN 项都被 ADR 明确标为后续 Production Gate，不能在 G2-00-06 Evidence 中写成已完成。

## What's Well-Reasoned

- Job 与 Outbox 只共享正确的原语，没有把 Checkpoint、Cancel、业务事务和外部 Ack 塞进一个泛型状态。
- Lease 同时包含 Attempt、Worker 和递增 Fence；精确到期边界与数据库时间回退都 fail closed。
- Job 的完成 Checkpoint 和不完整输出被区分，Crash 后可以恢复而不会把半成品当成成功阶段。
- Outbox 明确承认不可消除的 Send/Ack 窗口，用不变 `eventId` 和 Consumer 原子去重解决业务重复，而不是更名为 exactly-once。
- Dead Letter 不删除 First Failure/Attempt/Audit；人工重放复用 ID 并开启新 Cycle，既可恢复又保留事故证据。
- 同对象顺序按 Destination 分流，避免一个下游故障拖住无关 Consumer；不同 Object 也不被全局 FIFO 串行化。

## What I Couldn't Assess

- DB-03/04 Migration 的真实 CHECK/UNIQUE/FK、权限、事务连接传递和 `SKIP LOCKED` Query Plan；
- PostgreSQL 时钟显著回退时的实际告警与恢复操作；
- Action Payload Redaction、Schema Registry 与 Object/Property Policy 是否在 Event 创建前执行；
- 真实 Consumer 是否能把业务副作用和 `eventId` 去重键放在同一持久事务；
- Admin Health / Ops API 的授权、双人审批、Ticket Reference 和批量人工处置体验；
- 目标积压、热门 Object、Destination 长时间中断、Vacuum 与表膨胀下的容量和延迟；
- 备份恢复后可能重投的 Outbox 范围以及 Consumer 去重记录的保留期对齐。

下一步先保存本任务 clean-room Evidence。Production 工作进入 DB-03/04 时，优先做前三项真实 PostgreSQL 故障/并发测试；任何一项失败都修改 ADR 和状态模型，不以 Adapter 特例绕过。
