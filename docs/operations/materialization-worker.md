# Materialization Worker 运行手册

## 当前启用边界

G2-02-13 已启用正式 Worker Composition Root。`npm run worker:start` 会用 `worker_runtime` 登录、受管版本化 S3、Base/Quality/Capacity Repository 和真实 Cutover 处理器，顺序执行 Scan、Map、Validate、Build Stage、Build Index、Ready for Activation、Catch-up 和 Activate。

Worker 只消费服务器固结的 Snapshot/Mapping/Plan 事实；不处理用户 Bearer/Claims，不执行任意 SQL，也不持有 Migration Owner 或 DDL Executor 凭据。生产目前只接受受信 zero-overlay，真实 Overlay 属于 G2-04。

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
| `ONTOS_S3_ENDPOINT`                            |    无 | 必填；只能由受信部署配置提供                         |
| `ONTOS_S3_REGION`                              |    无 | 必填                                                 |
| `ONTOS_S3_BUCKET`                              |    无 | 必填；Bucket 必须已开启 Versioning                   |
| `ONTOS_S3_ACCESS_KEY_ID`                       |    无 | 必填；仅限受管 Bucket                                |
| `ONTOS_S3_SECRET_ACCESS_KEY`                   |    无 | 必填；不得写入日志                                   |
| `ONTOS_S3_FORCE_PATH_STYLE`                    | false | `true` / `false`                                     |
| `ONTOS_S3_MAX_ATTEMPTS`                        |     2 | 1～5                                                 |

进程环境中不得出现 Admin/Worker Bearer Token、OIDC Client Secret、Migration Database URL 或 DDL Executor Database URL。S3 Endpoint 和凭据是受信部署配置，不能来自 Job、HTTP Body 或 Snapshot 内容；Worker 只按数据库中固结的受管对象引用读取。

## 启动前检查

1. 用 Migration Owner 执行 `npm run db:migrate`，确认账本连续到 `0018` 且重复执行为 no-op。
2. 创建专用 LOGIN，只 `GRANT worker_runtime TO <login>`；不要授予表 Owner、Schema CREATE 或其他 Runtime Role。
3. 用该 URL 启动时，Worker 会再次检查 Current/Session Role、危险 Role Attribute、Migration Usage、Schema CREATE 和 Serving Pointer 写权限；任一不符合即关闭 Pool 并拒绝启动。
4. 用受管 S3 凭据校验 Bucket Versioning；未开启 Versioning 时 Worker 必须拒绝启动。
5. 就绪后进程输出 `{"kind":"ready","pipeline":"production"}`；不要用测试 Fixture Executor 代替生产 Composition Root。

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
- 不修改任何已应用的 0001～0018 来修复线上状态，只能新增向前 Migration；
- 不把测试用的 Availability 加速、Stage Fixture 或固定故障开关带入部署；
- 不把 G2-02-13 PASS 解释为 clean-room、100k/1m 端到端、Query、Overlay 或完整产品已完成。
