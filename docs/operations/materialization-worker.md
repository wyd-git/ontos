# Materialization Worker 运行手册

## 当前启用边界

G2-02-08 已完成独立 Worker Runtime、数据库租约和进程恢复协议，但生产阶段处理器仍由 G2-02-09～11 顺序接入。当前直接执行 `npm run worker:start` 会以 exit code 78 fail closed；在 Index、Certificate 和真实 Cutover 组合完成前，不得绕过这一保护启动生产调度。

进程级验收使用同一正式 Runtime 与 `worker_runtime` 登录，只把确定性 Stage/Fault Adapter 从测试入口注入；它不是内存队列，也不会在生产入口注册。

## 配置

| 变量                                           |  默认 | 约束                                                 |
| ---------------------------------------------- | ----: | ---------------------------------------------------- |
| `ONTOS_DATABASE_URL`                           |    无 | 必填；只能是继承 `worker_runtime` 的非特权登录       |
| `ONTOS_WORKER_INSTANCE_ID`                     |    无 | 必填；36 字符 Ontos ID                               |
| `ONTOS_WORKER_LEASE_SECONDS`                   |    30 | 1～300                                               |
| `ONTOS_WORKER_HEARTBEAT_MILLISECONDS`          |  5000 | 100～60000，且小于 Lease 的一半                      |
| `ONTOS_WORKER_IDLE_POLL_MILLISECONDS`          |   250 | 25～30000                                            |
| `ONTOS_WORKER_DEPENDENCY_BACKOFF_MILLISECONDS` |  1000 | 100～60000；仅用于进程依赖重连，Job 退避由数据库决定 |
| `ONTOS_WORKER_SHUTDOWN_GRACE_MILLISECONDS`     | 15000 | 1000～120000                                         |
| `ONTOS_WORKER_DATABASE_POOL_MAXIMUM`           |     4 | 1～16                                                |

进程环境中不得出现 Admin/Worker Bearer Token、OIDC Client Secret、Migration Database URL 或 DDL Executor Database URL。Worker 不需要 S3 任意 Endpoint、用户 Token 或客户端路径；后续 Stage Adapter 只能消费服务器冻结的受管对象引用。

## 启动前检查

1. 用 Migration Owner 执行 `npm run db:migrate`，确认账本连续到 `0013` 且重复执行为 no-op。
2. 创建专用 LOGIN，只 `GRANT worker_runtime TO <login>`；不要授予表 Owner、Schema CREATE 或其他 Runtime Role。
3. 用该 URL 启动时，Worker 会再次检查 Current/Session Role、危险 Role Attribute、Migration Usage、Schema CREATE 和 Serving Pointer 写权限；任一不符合即关闭 Pool 并拒绝启动。
4. 09～11 完成前保持生产调度禁用；不要用测试 Fixture Entry 代替生产 Composition Root。

## 状态诊断

运维只用 `read_only_ops` 查询 `ops.materialization_job_status`。重点字段：

- `state/current_stage/attempt_count/attempts_in_cycle`
- `lease_expires_at/available_at`
- `first_failure_code/last_failure_code` 与分类
- `replay_cycle/replay_count`
- `cancel_requested/cutover_completed_at`

该 View 不暴露 Fingerprint、Error Sample、Idempotency Key、输入行、PK、Object Key、SQL 或 Token。不要为了诊断直接查询/修改底表。

## 常见处置

### Worker 进程死亡

不要手改 Lease。等待数据库时间超过 `lease_expires_at`；任一健康 Worker 在 Claim 前会执行有界 Reaper。Job 将进入 `retry_wait`，或在已有完整 Activate Checkpoint 时直接收敛为 `succeeded`。

### 临时依赖故障

确认 `last_failure_category` 为 dependency/lease/throttled，观察 `available_at`。默认 5/10/20/40 秒后重试，第 5 次失败进入 Dead Letter。不要把 `available_at` 提前；测试 Harness 的加速只用于受控 CI。

### Dead Letter

先修复根因，再通过受授权的 Admin 用例发起 Manual Replay，并提供固定 Reason。Replay 保留所有 Attempt、Checkpoint 和 Failure 历史。不要 DELETE Attempt/Staging 或直接 UPDATE Job。

### 取消

通过受授权 Admin 用例请求取消。运行中会在下一安全阶段边界收敛；若返回 `MATERIALIZATION_JOB_NOT_CANCELLABLE`，说明 Cutover 已开始，应读取最终 Job/Activation 结果，不重复发起切换。

### 优雅下线

发送 SIGTERM，等待 Shutdown Grace。进程会停止领取新 Job，并让当前阶段在安全点进入 Retry。超时后部署层可终止 PID；数据库 Lease/Fence 仍是恢复权威。

## 禁止操作

- 不直接 UPDATE/DELETE/TRUNCATE Job、Attempt、Checkpoint、Staging 或 Serving Pointer；
- 不向 Worker 注入 Migration/DDL/API/OIDC 凭据；
- 不修改任何已应用的 0001～0013 来修复线上状态，只能新增向前 Migration；
- 不把测试用的 Availability 加速、Stage Fixture 或固定故障开关带入部署；
- 不把 G2-02-08 PASS 解释为 Index、Certificate、Cutover、GC 或完整产品已完成。
