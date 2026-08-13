# ADR-010：PostgreSQL Job、Lease 与 Transactional Outbox

- 状态：Accepted for G2-00-06
- 日期：2026-08-13
- Owner：Backend / Platform
- 决策范围：持久 Job、Lease、Attempt、Retry、Dead Letter、Transactional Outbox、同对象投递顺序与运维可见性
- 可执行合同：`tools/job-outbox/`
- Production 落点：DB-03 `action` / DB-04 `ops` 与 `audit`

## 1. 决策结论

P0 使用 PostgreSQL 实现持久 Job 与 Transactional Outbox，不引入 Redis Queue、Kafka 或 Durable Workflow Engine。两者共用数据库时间、Lease、Attempt、Fencing Token、指数退避、Dead Letter 和 append-only Audit 原语，但不实现成一个“通用队列表”：

| 维度     | Job                                                                   | Outbox                                                                         |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 目的     | 最终完成可恢复后台工作                                                | 投递已经随业务事务提交的外部事件                                               |
| 状态     | `QUEUED / RUNNING / RETRY_WAIT / SUCCEEDED / DEAD_LETTER / CANCELLED` | `PENDING / LEASED / DELIVERING / RETRY_WAIT / DELIVERED / DEAD_LETTER`         |
| 幂等边界 | Project + Job Type + Idempotency Key + Input Digest                   | Business Transaction / Action Idempotency + 不变 `eventId`                     |
| 恢复点   | 已完成的幂等 Checkpoint                                               | 无业务 Checkpoint；只保存每次投递观察                                          |
| 顺序     | Priority、Available Time、Created Time；不承诺全局 FIFO               | 每个 `(Project, Destination, objectRid)` 按 ChangeSet Sequence / Event Ordinal |
| 完成含义 | 持有有效 Lease 的 Worker 提交 Result Reference                        | Consumer 回显相同 `eventId` 和去重结果后，本地标记 Delivered                   |
| 取消     | 未成功 Job 可由授权 Operator 取消                                     | 业务已提交后不能取消事实事件；只能重试、Dead Letter 或另做 Compensation Action |

Job 的 Materialization 阶段不进入通用 Job State。`SCAN / MAP / VALIDATE / BUILD_STAGE / BUILD_INDEX / READY_FOR_ACTIVATION / CATCH_UP / ACTIVATE` 是 `job_checkpoints.name` 和领域状态；通用层只决定谁有权推进以及失败后如何恢复。Materialization 展示层可以把通用 `DEAD_LETTER` 映射为 `FAILED`，但不能创建第二套 Lease/Retry 语义。

Outbox 只承诺 **at-least-once**。若 Consumer 已处理 Event，但 Worker 在持久化确认前崩溃或超时，同一 `eventId` 会再次投递。Consumer 必须持久化去重，回报 `APPLIED` 或 `ALREADY_APPLIED`；平台不宣传 exactly-once。

## 2. 不可违反的不变量

### 2.1 数据库时间与 Lease

1. 所有领取、Heartbeat、完成、失败、回收和人工处置使用 PostgreSQL 同一语句产生的时间；Worker 本机时间不进入资格判断。
2. 每次 Claim 在数据库内递增 `fencing_token`，并创建全局唯一 `attempt_id`。
3. Heartbeat、Checkpoint、成功、失败和 Delivery Ack 必须同时匹配 Work ID、Attempt ID、Worker ID、Fencing Token、当前状态，且 `lease_expires_at > db_now`。
4. 到期边界为半开区间：`db_now == lease_expires_at` 已失效。
5. 每条记录保存 `last_observed_database_at`。若数据库时间相对该记录回退，写入 fail closed 并告警；允许短期损失活性，不允许旧 Lease 重新获得写权限。
6. Worker 看到的 Lease Handle 只有身份与 fencing 信息；`expiresAt` 即使返回也只是调度提示，不是完成授权。

纯状态模型显式接收 `databaseNow`，表示 Repository 已从数据库读取的时间。Production API 不得让 Worker 通过请求参数提供这个值。

### 2.2 Job

- 入队唯一范围为 `(project_id, job_type, idempotency_key)`；相同 `input_digest` 返回原 Job，不同 Digest 返回 `IDEMPOTENCY_CONFLICT`。
- 只有 `QUEUED` 或到达 `available_at` 的 `RETRY_WAIT` 可 Claim；一个 Job 同时最多一个 Active Attempt。
- Checkpoint 按正整数 Sequence 严格递增；相同 Sequence + 相同 Name/Output Ref/Digest 为幂等返回，不同内容冲突。
- Worker Crash 不立即改变状态。Lease Reaper 在到期后结束当前 Attempt，记为 `LEASE_EXPIRED`，再按 Retry Policy 进入 `RETRY_WAIT` 或 `DEAD_LETTER`。
- 已完成 Checkpoint 在 Lease 回收和人工重放后保留；不完整输出从未成为 Checkpoint，Materializer 不得复用。
- `first_failure` 只写一次，`last_failure` 每次更新；只保存稳定 Code、Category、Retryable 和非敏感 Fingerprint，不保存 Stack、原始 Payload 或下游响应正文。
- `SUCCEEDED` 和 `CANCELLED` 是终态。`DEAD_LETTER` 只有授权 Operator 能以安全 `reason_code` 重放；重放新增 Cycle、清零本 Cycle 自动 Attempt 数，但不删除历史 Attempt、Failure、Checkpoint 或 Audit。

### 2.3 Outbox 事务与幂等

- `outbox_events` 必须与 Overlay、Current Projection、ChangeSet 和 `COMMITTED` ActionExecution 在同一 PostgreSQL 事务写入。不能在 Commit 后由 API 再补 Event。
- API 响应在 Commit 后丢失时，同一 Action Idempotency Key / Business Transaction Digest 返回原 ActionExecution 和原 Event 集合，不新增 Event。
- `event_id` 从首次 Commit 后永不改变。人工重放继续使用原 `event_id`，使“第一次已处理但 Ack 丢失”的 Consumer 能识别重复。
- Event 保存授权后最小 Payload 的 Digest/Schema Version 和受控 Payload Reference；完整 Object、Secret、自由文本错误和未授权字段不能进入 Payload、Attempt、Log 或 Audit。
- Event Definition 的幂等比较使用结构化 Canonical Serialization / Digest，不能用未转义 delimiter 拼接字段。

### 2.4 同对象顺序

顺序域是 `(project_id, destination_id, object_rid)`。这样每个 Consumer 观察同一 Object 的顺序，互不相关的 Consumer 或 Object 不相互阻塞；P0 不提供跨 Object 或跨 Destination 的全局顺序。

顺序位置是 `(change_set_sequence, event_ordinal)`：

- 一个业务事务可为同一 Object / Destination / ChangeSet 创建多个 Event，使用不同 `event_ordinal`；
- `outbox_stream_heads` 在业务事务中按顺序域加行锁，新的 ChangeSet Sequence 必须大于已提交 Head；后续事务不能补写更早或相同 Sequence；
- Claim 只选择没有未投递前驱的 Event；同一顺序域同时最多一个 `LEASED / DELIVERING` Event；
- Earlier Event 进入 `DEAD_LETTER` 时，Later Event 继续阻塞。P0 不提供“跳过毒事件”；必须重放成功或通过明确的新 Compensation Action 处理，不能静默打破顺序。

## 3. PostgreSQL 翻译合同

G2-00-06 不提前创建业务 Migration，但 DB-03/04 必须保持以下表义，不能用另一套状态机替换。

### 3.1 表与所有者

| Schema / Table                    | Owner                                            | 可变性与关键约束                                             |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `ops.jobs`                        | materialization / worker application port        | 条件状态更新；唯一 `(project_id, job_type, idempotency_key)` |
| `ops.job_attempts`                | materialization                                  | Attempt 生命周期更新；Work/Attempt 唯一，历史不删除          |
| `ops.job_checkpoints`             | materialization                                  | Insert-only；唯一 `(job_id, sequence)`                       |
| `action.outbox_events`            | action-runtime 写事实；audit-outbox 推进投递状态 | Event 内容不可变，Delivery 列条件更新；`event_id` 唯一       |
| `action.outbox_stream_heads`      | action-runtime                                   | 每顺序域一行；业务 Commit 内 `FOR UPDATE`                    |
| `action.outbox_delivery_attempts` | audit-outbox                                     | Attempt 生命周期更新；保留 Send/Ack 观察与 Consumer 去重结果 |
| `audit.audit_events`              | audit port                                       | Insert-only；应用身份不能 Update/Delete                      |

`jobs` 与 `outbox_events` 的约束必须保证：只有运行/投递中状态有完整 Lease 列，其他状态 Lease 列全为 null；Attempt Counter 和 Fencing Token 单调递增；Delivered Event 必须有 `delivered_at` 与 Consumer Disposition。

### 3.2 Claim

每个 Repository 语句只取一次数据库时间：

```sql
WITH db_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS now_at
), candidate AS (
  SELECT j.id
  FROM ops.jobs j, db_clock c
  WHERE j.state IN ('QUEUED', 'RETRY_WAIT')
    AND j.available_at <= c.now_at
    AND j.last_observed_database_at <= c.now_at
  ORDER BY j.priority DESC, j.available_at, j.created_at, j.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE ops.jobs j
SET state = 'RUNNING',
    lease_owner = :worker_id,
    lease_attempt_id = :attempt_id,
    lease_fencing_token = j.next_fencing_token,
    next_fencing_token = j.next_fencing_token + 1,
    lease_expires_at = c.now_at + :server_lease_duration,
    heartbeat_at = c.now_at,
    last_observed_database_at = c.now_at
FROM candidate x, db_clock c
WHERE j.id = x.id
  AND j.state IN ('QUEUED', 'RETRY_WAIT')
RETURNING j.*;
```

同一数据库事务还要插入 Attempt 与 Audit；任一步失败全部回滚。Outbox Claim 使用相同 Claim/CAS 原语，但 Candidate 额外要求：

```sql
NOT EXISTS (
  SELECT 1
  FROM action.outbox_events earlier
  WHERE earlier.project_id = event.project_id
    AND earlier.destination_id = event.destination_id
    AND earlier.object_rid = event.object_rid
    AND (earlier.change_set_sequence, earlier.event_ordinal)
        < (event.change_set_sequence, event.event_ordinal)
    AND earlier.state <> 'DELIVERED'
)
```

对应索引至少覆盖 Eligible State / Available At，以及顺序域 + Sequence / Ordinal / State。真实索引、批量大小和 Query Plan 必须由 DB-03/04 的 PostgreSQL 16 Integration 与负载测试确定，不能从纯模型推断性能。

### 3.3 Heartbeat 与完成 CAS

Heartbeat 和终态更新都必须包含以下条件，且不能拆成“先查后改”：

```sql
WHERE id = :work_id
  AND state = :expected_in_flight_state
  AND lease_owner = :worker_id
  AND lease_attempt_id = :attempt_id
  AND lease_fencing_token = :fencing_token
  AND lease_expires_at > db_clock.now_at
  AND last_observed_database_at <= db_clock.now_at
```

受影响行数为 0 时返回稳定 Lease/State 冲突，不把 Worker 结果写入。Job Result、Attempt Outcome、Job State 和 Audit 在同一事务提交；Outbox Ack、Attempt Consumer Observation、Event `DELIVERED` 与 Audit 同样在一个事务提交。

## 4. Retry、Dead Letter 与人工处置

Policy 使用 `maximum_attempts_per_cycle`，包含第一次执行。例如 5 表示首次 + 最多 4 次自动重试。Attempt N 失败后的基础退避为：

```text
min(maximumBackoff, initialBackoff × 2^(N-1))
```

Job 默认 5 Attempts、5 秒起步、5 分钟上限、30 秒 Lease；Outbox 默认 8 Attempts、1 秒起步、15 分钟上限、30 秒 Lease。G2-00-06 模型使用确定性无 Jitter 的公式；DB-03/04 若并发压测证明同步重试尖峰不可接受，必须先更新 ADR、模型和向量，再加入有界确定性 Jitter，不能只在 Adapter 偷改。

非 Retryable Failure 立即 Dead Letter。自动次数用尽也进入 Dead Letter。人工重放：

1. 必须通过后续统一 Policy Gateway 验证专用 Ops 权限；纯模型只验证显式 Operator ID；
2. `reason_code` 只能是 2–64 位大写安全 Code，不接收会把 Secret/PII 写进 Audit 的自由文本；Ticket Reference 由受控独立字段承载；
3. 保留 Event/Job ID、全部 Attempt、First/Last Failure、Checkpoint 与原 Dead Letter Audit；
4. 增加 Replay Cycle，清零本 Cycle 自动 Attempt 数，Total Attempts 永不回退；
5. Outbox 重放不会撤销已提交 Action，也不生成新的 Event ID。

## 5. 外部投递协议与故障窗口

Worker 在数据库把 Event 从 `LEASED` 改成 `DELIVERING` 并提交 Attempt 观察后，才调用 Consumer。请求至少包含 `eventId`、Event Type、Payload Schema Version、Correlation ID 和授权 Payload；Consumer Ack 必须回显相同 `eventId`、自身 `consumerId` 与：

- `APPLIED`：首次应用并持久化去重键；
- `ALREADY_APPLIED`：此前已应用，本次没有重复业务效果。

两者都使 Outbox Event 进入 `DELIVERED`。Timeout、连接中断或 Ack 持久化失败都视为“可能已经发生”，进入 Retry；不能根据超时推断 Consumer 未执行。

| 故障点                                  | 数据库事实                        | 恢复行为                                            |
| --------------------------------------- | --------------------------------- | --------------------------------------------------- |
| Action Commit 前                        | 无业务修改、无 Outbox Event       | 同一 Idempotency Key 可安全重试                     |
| Action Commit 后、API 响应前            | 业务修改和原 Event 已存在         | 返回原 ActionExecution/Event，不重复提交            |
| Job Checkpoint 前 Worker Crash          | Checkpoint 不存在                 | Lease 到期后从上一个已完成 Checkpoint 恢复          |
| Job Checkpoint 后 Worker Crash          | Checkpoint 已提交                 | 新 Attempt 读取并复用该完成点                       |
| Outbox Send 前 Worker Crash             | Event 未确认                      | Lease 到期后重投；可能只造成无效重试                |
| Consumer 已处理、Ack/DB Update 前 Crash | Event 仍未确认                    | 重投相同 `eventId`；Consumer 返回 `ALREADY_APPLIED` |
| Earlier Event Dead Letter               | Later Event 仍 Pending 但 blocked | Health 告警；授权人工重放或 Compensation            |

## 6. 可观测性与审计

每个 Job/Event 至少可查询：State、Created/Committed At、Available At、State Changed At、Lease Owner/Expiry、Fencing Token、Replay Cycle/Count、Attempts In Cycle/Total、First/Last Failure Code、Correlation ID。Outbox 额外记录 Destination、Object RID、ChangeSet Sequence、Event Ordinal、Send Observation、Ack Event ID、Consumer ID/Disposition 和 Delivered At。

运行指标至少包括：Eligible/Running/Retry Wait/Dead Letter 数、Claim Rate、Lease Expiry、Attempt Duration、Retry Count、Outbox Oldest Undelivered Lag、Blocked Streams、Consumer Timeout 与 `ALREADY_APPLIED` 数。Metric Label 不得包含 Object RID、Event ID、Actor、Email、错误正文或其他高基数/敏感值。

Audit 与状态改变同事务写入，记录稳定 Event Type、Work ID、Attempt ID、Actor Type/ID、Correlation ID、数据库时间和安全 Code。Job Result Reference、Payload、自由文本 Failure/Reason、Secret 和 Consumer Response Body 不进入 Audit。

## 7. 验证与下游 Gate

`tools/job-outbox/` 是无数据库依赖的可执行状态合同，当前证明：

- Job 入队幂等、Claim、Heartbeat、Checkpoint、Crash/Reclaim、Retry、Dead Letter、Replay 与 stale Lease fencing；
- Outbox 事务批次先全量验证再提交、commit-before-response 幂等、同对象顺序、Dead Letter 阻塞、at-least-once、Consumer Dedupe Observation 和 Action Delivery Status；
- 固定 Seed 属性测试验证退避单调上限、Crash 后 fencing、任意输入顺序下的同对象 Sequence 和 Attempt 上限。

该模型不是 Production Repository，也不宣称已经验证 PostgreSQL 的锁竞争、Query Plan 或权限。对应 Gate：

- DB-03：Action / ChangeSet / Outbox 同事务、Stream Head 并发、Commit 故障注入、真实 Consumer Dedupe；
- DB-04：Job / Attempt / Checkpoint / Audit Migration、并发 Worker、Crash/Heartbeat/Reaper 和权限；
- G2-00-08：人工处置与 Health 入口通过统一 Policy；
- G2-07：目标并发与积压下测 Claim P95、Outbox Lag、锁等待、表膨胀与 Vacuum。

任一真实 PostgreSQL Gate 无法保持本 ADR 安全不变量时，停止对应业务集成并修改 ADR/模型；不能用“测试里可行”替代数据库证据。

## 8. 被拒绝的方案

### 8.1 一个泛型 Queue 表承载全部语义

拒绝。Job 的 Checkpoint/Cancel 与 Outbox 的事务事实/顺序/Ack 窗口不同，共表会把领域状态塞进可选列并模糊完成含义。

### 8.2 Worker 本机时间判断 Lease

拒绝。机器时钟漂移会让两个 Worker 同时认为自己拥有 Lease。资格和到期全部由数据库时间与条件更新决定。

### 8.3 只用 `lease_owner`，不使用 Fencing Token

拒绝。同一 Worker ID 重启或旧进程恢复后可能误用新 Lease；递增 Fencing Token + Attempt ID 才能隔离代际。

### 8.4 Outbox Commit 后异步补写

拒绝。进程可能在业务 Commit 与 Event Insert 之间崩溃，造成永久丢事件。Event 必须在业务事务内写入。

### 8.5 把 Outbox 宣称为 exactly-once

拒绝。外部 Consumer 与 PostgreSQL 不共享事务，Ack 丢失无法区分“未处理”和“已处理”。P0 明示至少一次并要求 Consumer 持久去重。

### 8.6 Dead Letter 后跳过 Earlier Event

拒绝。Later Event 越过 Earlier Event 会违反同对象顺序。若业务确实允许跳过，必须新增有审计的显式产品语义，而不是 Worker 私下修改状态。

## 9. 本任务明确不实现

- 不创建 DB-03/04 Migration、Repository、Worker Process、Materializer 或外部 Consumer；
- 不实现完整 Action Idempotency、Payload Schema Registry、Policy Gateway、Admin Health UI 或 Compensation Action；
- 不承诺全局 FIFO、exactly-once、跨区域队列或无限积压；
- 不引入 Kafka、Redis、Temporal 等基础设施；达到明确扩容条件后另做 ADR；
- 不用纯模型测试冒充真实 PostgreSQL 并发、崩溃、权限和性能证据。

G2-00-06 冻结后，后续 Migration 与 Worker 必须翻译这些相同状态、不变量、错误和故障窗口，不能重新发明另一套“看起来差不多”的队列。
