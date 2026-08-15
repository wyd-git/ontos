# ADR-017：Materialization Worker 租约、恢复与取消协议

- 状态：Accepted for G2-02-08
- 日期：2026-08-16
- Owner：Backend / Platform
- 依赖：[ADR-010](010-postgresql-job-lease-outbox.md)、[ADR-014](014-materialization-transaction-ddl-overlay-boundary.md)、[ADR-015](015-permanent-object-identity-attempt-owned-base.md)、[ADR-016](016-quality-current-provenance-confirmation.md)
- 决策范围：独立 Worker 进程、PostgreSQL Job/Attempt/Lease/Fencing/Checkpoint、Retry/Replay、Cancel、Graceful Shutdown 与进程级 Kill/Resume

## 1. 决策结论

G2-02-08 扩展 0009 已建立的唯一 `ops.materialization_jobs` 队列，不引入第二套调度器、Redis、消息队列或工作流引擎。一个 Job 固定经过以下八个内部阶段：

1. `scan`
2. `map`
3. `validate`
4. `build_stage`
5. `build_index`
6. `ready_for_activation`
7. `catch_up`
8. `activate`

Checkpoint 只表示一个阶段的完整输出已提交并可按 Digest 重新验证，不表示该 Job 已可服务。恢复时只读取最后一个完整 Checkpoint，跳过已完成阶段；半批输出仍属于旧 Attempt，不能被当作完成。

Job 同时最多有一个有效 Lease。领取、Heartbeat、Expiry、Checkpoint、Failure、Cancel 和 Terminal 都使用 PostgreSQL `clock_timestamp()` 与完整 `(project, job, attempt, worker, fencing token)` CAS。客户端时钟不参与租约判定。

## 2. 领取、排序与围栏

领取使用 `FOR UPDATE SKIP LOCKED`。排序固定为 `available_at ASC, priority DESC, created_at ASC, project_id, job_id`：先到达可领取时间的 Job 不会被持续到来的新高优先级 Job 永久饿死；同一可领取时间内才按优先级排序。

每次领取创建不可变 Attempt，并同时递增 Attempt Number 和 Fencing Token。旧 Owner、旧 Attempt 或旧 Token 即使网络恢复，也不能 Heartbeat、写阶段进度、提交 Checkpoint、失败、取消、标成功或进入后续受控 READY/Activate 事务。

Lease 上界为 300 秒。Worker 的 Heartbeat 周期必须小于 Lease 的一半；生产默认 30 秒 Lease、5 秒 Heartbeat。Heartbeat 和主循环计时器必须保持进程存活，不能因数据库连接短断而让 Node 在仍有未完成顶层任务时自行退出。

## 3. Checkpoint 与响应丢失

每个 Job 的 Checkpoint Sequence 必须从 1 连续到 8，Sequence 与 Stage Rank 必须一致。同一 Sequence 的重放只有 Stage、Output Reference 和 Output Digest 完全一致才可复用；冲突输出 fail closed。

`activate` Checkpoint 与 Cutover Started/Completed 标记在同一数据库事务写入。若事务已提交但客户端没有收到响应，Reaper 看到完整 `activate` Checkpoint 后把 Attempt/Job 收敛到 `succeeded`，不再次激活。若 Checkpoint 未提交，则下一 Attempt 从前一完整阶段恢复。

G2-02-08 只冻结通用恢复协议。`build_index`、READY Certificate 和真实 Group Cutover 的业务处理器分别归 G2-02-09、10、11；在它们接入前，`worker:start` 明确 fail closed，不能用空处理器把 Job 伪装成成功。

## 4. Retry、Dead Letter 与人工重放

失败分类固定为 `dependency|internal|lease|permanent|throttled`。`permanent` 永不自动重试；其他类别只有显式 `retryable=true` 才能重试。

默认每个 Replay Cycle 最多 5 次 Attempt。数据库按 Attempt In Cycle 计算 5、10、20、40 秒指数退避，通用函数硬上限 300 秒。达到上限或遇到永久错误进入 `dead_letter`，不会无限循环。

人工重放只能从 `dead_letter` 发起，绑定 Operator Principal、固定 Reason、时间、Replay Cycle 和 Replay Count；历史 Attempt、Failure 与 Checkpoint 不删除。已经开始 Cutover 的 Job 不允许人工重放。

## 5. Cancel 与 Graceful Shutdown

运行中 Cancel 只设置持久请求；Worker 在阶段边界读取后，把当前 Attempt 和 Job 一次提交为 `cancelled`。阶段执行中可以完成当前不可分割输出，但不能开始下一个阶段。尚未运行的 queued/retry/dead-letter Job 可直接取消。

一旦 `activate` Checkpoint 事务开始并写入 Cutover 标记，Cancel 返回 `MATERIALIZATION_JOB_NOT_CANCELLABLE`，调用方必须读取最终事务结果，不能制造中间态。

SIGINT/SIGTERM 触发 Abort，当前阶段在安全点退出并以 `WORKER_SHUTDOWN` 进入 Retry；Heartbeat 自身的 `JOB_FENCED` 或 `DEPENDENCY_UNAVAILABLE` 保持原分类，不能伪装成运维停机。超过 Shutdown Grace 的部署层可以终止 PID，随后仍按 Lease Expiry 接管。

## 6. 错误、指标与权限

Job 只保存固定 Code、分类和不可逆 Fingerprint。每个 Attempt 最多 50 个样本，JSON 总字节不超过 32 KiB；单项只有 Reason Code、分类和 Fingerprint，不保存原 PK、行内容、列值、文件 Key、Token、SQL 或底层异常文本。

`apps/worker` 只接受 Worker 数据库 URL、Instance ID 和有界运行参数。若环境中出现 Bearer、OIDC Client Secret、Migration URL 或 DDL Executor URL，启动拒绝。连接后必须证明：

- 登录是 `worker_runtime` 成员且没有切换 Current Role；
- 不是 Superuser、CreateDB、CreateRole、Replication 或 BypassRLS；
- 不是 `api_runtime`/`migration_owner` 成员；
- 没有 Database/Schema CREATE、Migration Schema Usage 或 Serving Activation 任意写权限。

API 不能再按旧列授权直接 INSERT Job，只能调用幂等 Enqueue；Worker 不能执行 DDL、读取 Migration 账本、持有 OIDC/Bearer 或直接修改 Serving Pointer。

## 7. 停止条件与后续所有权

出现以下任一情况，本任务 FAIL：两个进程同时拥有有效 Lease；旧 Token 能写任何进度；任一 Kill 点需要手工删表/改 Pointer；永久错误无限重试；Cutover 后可取消；错误样本泄露业务值；或 Worker 必须持有 Owner/Migration/OIDC 凭据。

G2-02-09 接入受信 Index Plan/容量处理器，G2-02-10 接入 Certificate/READY，G2-02-11 接入真实 Group Cutover，G2-02-13 接入正式 Admin Job 入口，G2-02-14 完成空环境 S3/OIDC/API/Worker 总验收。本 ADR 不把这些后续能力标为已完成。

## 8. 实现结果

Migration `0013`、`MaterializationWorker`、PostgreSQL Repository 和独立 `apps/worker` Runtime 已按本决策落地。真实 PostgreSQL 16 测试启动两个真实 Worker PID，在八个阶段前后共执行 16 个 SIGKILL；最终产生 8 个唯一 Checkpoint、16 个 Attempt、3 次保留历史的人工重放，并与无故障运行得到相同最终 Digest。

同一真实测试还覆盖了优雅停机、安全取消、Cutover 后拒绝取消、临时依赖重试、永久错误 Dead Letter、51 个样本数据库拒绝、API Raw Job INSERT 拒绝、旧围栏写拒绝和 PostgreSQL 主动终止 Worker 连接后的恢复。

详细 Acceptance 对照、返工和非结论见 [G2-02-08 Evidence](../../evidence/g2-02-08-materialization-worker.md) 与 [G2-02-08 Red Team](../../reviews/g2-02-08-materialization-worker-red-team.md)。
