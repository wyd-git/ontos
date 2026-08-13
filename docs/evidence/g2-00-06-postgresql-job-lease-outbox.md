# G2-00-06 PostgreSQL Job、Lease 与 Outbox 验收记录

- 结论：**PASS（仅限 G2-00-06 纯状态合同）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-06-job-lease-outbox`
- 起始 Commit：`601452488d0a60397c629a8b849d41b0f4fc18ce`
- 工具：Node.js 24.18.0 / npm 11.16.0 / fast-check 4.9.0
- 环境：macOS 26.5.2（Build 25F84）arm64

本记录对应 [G2-00-06 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-06adr-010-postgresql-joblease-与-outbox)。最终实现 Commit 由 Draft PR head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                            | 实现证据                                                                       | 执行证据                                                    | 结果                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------- |
| Job / Outbox 共用原语和差异状态明确分离                             | `shared.ts`、`job.ts`、`outbox.ts`；ADR-010 §1–2                               | 独立 Job / Outbox 场景与 Invariant 检查                     | PASS                  |
| Claim 使用数据库时间、条件更新 / `SKIP LOCKED`，不信任 Worker Clock | `assertDatabaseTime`、`observeDatabaseTime`、完整 Lease Gate；ADR-010 §3.2–3.3 | 到期边界、错误 Worker/Fence、时间回退、safe addition 反例   | PASS（模型/SQL 合同） |
| Crash、Reclaim、重复 Attempt、Commit 后响应丢失、下游超时           | Job / Outbox 场景测试                                                          | 24 个专项 top-level tests                                   | PASS                  |
| Outbox at-least-once、同对象顺序、Consumer `eventId` 去重可观察     | Delivery Attempt、Stream Predecessor、Consumer Disposition                     | `SENT_NO_ACK` → 重投 → `ALREADY_APPLIED`；乱序属性测试      | PASS                  |
| Retry 上限、Backoff、Dead Letter、人工重放与 Audit 稳定             | Shared Policy、Replay Cycle、First/Last Failure、Audit Record                  | 退避/Attempt 上限属性测试；Dead Letter 阻塞/重放反例        | PASS                  |
| 无有效 Lease 的 Worker 不能完成 Job/Event                           | `assertValidLease` 与每个推进入口                                              | stale/expired/mismatched Lease 反例；Crash fencing 属性测试 | PASS                  |

“数据库时间、条件更新 / `SKIP LOCKED`”在本任务中的 PASS 表示状态合同和 SQL Translation 已冻结，不表示 Production Migration 已存在。真实 PostgreSQL 原子性与并发仍由 DB-03/04 Gate 验证。

## 2. 冻结的状态合同

### 2.1 Shared Lease / Attempt / Retry

- Lease Handle：Work Kind/ID、Attempt ID、Worker ID、递增 Fencing Token；
- 数据库时间：非负 safe integer 模拟 PostgreSQL 时间；相对记录回退时 fail closed；
- 有效期：`databaseNow < expiresAt`，精确相等已到期；
- Policy：Maximum Attempts Per Cycle 包含第一次；指数退避有固定上限；
- Failure：只含稳定 Code、Category、Retryable、非敏感 Fingerprint；
- Audit：连续 Sequence、Actor Type/ID、Correlation、数据库时间和安全 Detail；
- 人工 Reason 仅允许 2–64 位大写 Code，不允许自由文本进入 append-only Audit。

默认值：

| 类型   | Attempts / Cycle | Initial Backoff | Maximum Backoff | Lease |
| ------ | ---------------: | --------------: | --------------: | ----: |
| Job    |                5 |             5 s |           5 min |  30 s |
| Outbox |                8 |             1 s |          15 min |  30 s |

### 2.2 Job

- `QUEUED → RUNNING → SUCCEEDED`；Failure 进入 `RETRY_WAIT / DEAD_LETTER`；支持授权 `CANCELLED`；
- `(Project, Job Type, Idempotency Key)` 唯一，相同 Input Digest 返回原 Job，不同 Digest 冲突；
- Claim 创建唯一 Attempt 并增加 Fence；一个 Job 同时最多一个 Active Attempt；
- Checkpoint Sequence 严格增加，相同 Sequence/内容幂等，不同内容冲突；
- Crash 由 Lease Reaper 结束 Attempt，Checkpoint 保留，新 Worker 读取最后完成点；
- First Failure 不覆盖，Last Failure 更新；Replay 新开 Cycle，不删除历史。

### 2.3 Outbox

- Business Transaction 先完整验证 Event Batch，再原子加入模型；相同 Digest/Event Set 返回原 Event，Commit 后响应丢失不会复制；
- Event 状态为 `PENDING / LEASED / DELIVERING / RETRY_WAIT / DELIVERED / DEAD_LETTER`；
- 顺序域为 `(Project, Destination, objectRid)`，位置为 `(ChangeSet Sequence, Event Ordinal)`；
- 后续事务不能插入更早 Sequence，也不能补写已经提交的相同 Sequence；
- Claim 只选择无未投递前驱的 Event；Earlier Dead Letter 阻塞 Later，同一 Stream 最多一个 in-flight；
- Send 后 Timeout/Crash 保留 `SENT_NO_ACK`，重投原 `eventId`；Ack 必须回显 Event/Consumer 并报告 `APPLIED / ALREADY_APPLIED`；
- Action Delivery Status 与 Business Execution 正交：`NOT_APPLICABLE / PENDING / PARTIAL / COMPLETE / DEAD_LETTER`。

## 3. Red-Team 与 Intended-vs-Implemented 结果

[专项审查](../reviews/adr-010-postgresql-job-lease-outbox-red-team.md)在 Accepted 前关闭了以下当前范围偏差：

- 初版 Outbox 允许后续事务插入更早 Sequence 或补同 Sequence，现统一拒绝；
- Event Set Idempotency Signature 初版使用 delimiter 拼接，现使用结构化编码与确定性排序；
- Job Result Reference 和人工自由文本 Reason 初版进入 Audit，现只保留安全标志 / Reason Code；
- Worker 主动 Failure 的 Audit 初版错误标为 `SYSTEM`，现区分 Worker 与 Lease Reaper；
- Job/Outbox 时间加法初版没有 safe-integer overflow Gate，现失败前不产生部分 Claim；
- ChangeSet Sequence 初版没有 PostgreSQL signed `bigint` 上界，现边界一致；
- 内部 Job/Stream Key 初版使用 delimiter，现使用结构化无歧义编码。

修正后没有仍未关闭、且属于 G2-00-06 纯模型范围的 Intended-vs-Implemented 漂移。Production Transaction、真实 `SKIP LOCKED`、Stream Head Lock、Consumer 持久去重、Policy 和负载结论仍明确 OPEN。

## 4. 可复现执行

### 4.1 Clean install

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm ci
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 136 packages
```

执行前后 `package-lock.json` SHA-256 均为：

```text
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b
```

### 4.2 全仓 Gate

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run verify

check:toolchain     PASS
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 119/119
check:architecture  PASS — 1 package / 7 source files
```

G2-00-06 专项为 24/24 top-level tests，其中 4 个 fast-check Property 使用固定 Seed `20260813` 各执行 200 次，覆盖 Backoff 单调/上限、Job Crash Fencing、同对象任意输入顺序和 Outbox Attempt 上限。

### 4.3 Artifact Digest

对 `tools/job-outbox/` 全部 6 个文件按路径排序后逐文件 SHA-256，再对清单 SHA-256：

```text
11975949b11bac8135b9adec9bd886da233cf23dac697500407e717c0f2d3cab
```

后续任何状态、Policy、测试或错误边界变更都必须重新生成 Evidence，不得沿用本结论。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-07～13 仍未完成。
- 当前没有 DB-03/04 Production Migration、Repository、Worker Process、Materializer 或外部 Consumer。
- ADR 中的 `clock_timestamp()`、CAS、`FOR UPDATE SKIP LOCKED` 与 Stream Head 是强制 Translation Contract，不是已执行 SQL 证据。
- 当前没有证明 PostgreSQL 锁竞争、Claim Query Plan、Outbox 积压恢复、Vacuum、表膨胀或目标性能。
- 当前没有证明真实 Consumer 能把外部业务效果和 `eventId` 去重键原子持久化。
- 当前没有完整 Action Idempotency、Payload Redaction、Policy Gateway、Admin Health UI、Compensation Action 或 Ops Runbook。
- Outbox 明确为 at-least-once，不提供 exactly-once、跨 Object 全局顺序或跨区域 Queue。

这些限制不阻止 G2-00-06 状态合同 Accepted，但分别阻断 DB-03、DB-04、G2-00-08、G2-07 和最终生产放行。
