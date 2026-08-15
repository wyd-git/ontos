# G2-02-08 Materialization Worker Red Team

- 日期：2026-08-16
- 方法：先将本项钢人化为“跨对象存储与多事务 Materialization 唯一可信的恢复控制面”，再攻击双租约、饥饿、时钟漂移、半阶段 Checkpoint、响应丢失、重试风暴、取消竞态、敏感错误、权限升级和假进程证据
- 结论：**G2-02-08 可 PASS；只放行 G2-02-09。生产 Index、Certificate、真实 Cutover、GC、HTTP 与总验收仍为 OPEN**

## 1. 两个 Worker 同时认为自己拥有 Job

**攻击**：两个进程同时读到 queued，或旧进程在 Lease 过期后恢复网络并继续提交。

**证据**：Claim 在数据库行锁内递增 Attempt/Fence；所有后续函数重验五元 Lease 与数据库 Expiry。两个真实 PID 同抢时只有 1 个 leased Attempt，旧 Token 的写入返回 55000。

**结论**：CLOSED。

## 2. Priority + SKIP LOCKED 让旧 Job 永久饥饿

**攻击**：持续进入的高优先级 Job 永远排在旧低优先级 Job 前。

**证据**：排序最终冻结为 Availability 第一键、Priority 第二键；真库先入低优先级、后入高优先级时仍先领取旧 Job。锁住的第一行不会阻塞后续 eligible 行。

**结论**：CLOSED for current single queue。

## 3. Checkpoint 先于输出，恢复把半成品当完成

**攻击**：阶段只写了一半就落 Checkpoint，新 Attempt 跳过剩余工作。

**证据**：Application 只有在 Stage Executor 返回完整 Output Reference/Digest 后才调用 Checkpoint；数据库要求 Stage/Sequence 连续且与完整 Lease 匹配。前置 Kill 保持上一 Sequence，后置 Kill只多一个完整 Sequence。

**结论**：CLOSED for protocol。09～11 的业务输出完整性仍由各自 Stage Adapter Gate 证明。

## 4. 任一阶段崩溃只能人工清库

**攻击**：SCAN 到 ACTIVATE 的某个窗口留下无法判断的状态，需要 DELETE Staging 或改 Pointer。

**证据**：八阶段前后共 16 个真实 SIGKILL，在同一 Job 上连续恢复；最终恰好 8 个 Checkpoint、16 个 Attempt、3 个 Replay，无手工修改业务事实，Digest 等于 clean control。

**结论**：CLOSED。

## 5. ACTIVATE 已提交但响应丢失导致第二次激活

**攻击**：数据库提交成功，进程在收到响应前死亡；下一 Worker 重新执行 Activate。

**证据**：Activate Checkpoint 与 Cutover 标记同事务。后置 SIGKILL 后 Reaper 看到 Sequence 8，直接把 Attempt/Job 收敛为 succeeded；下一 Claim 不会再取得该 Job。

**结论**：CLOSED for generic activation checkpoint。真实 Group CAS 仍 OPEN to G2-02-11。

## 6. 依赖故障形成热循环或永久错误无限重试

**攻击**：S3/DB 短断每 25ms 重跑全 Job，或合同错误一直消耗资源。

**证据**：数据库保存 Availability，指数退避 5/10/20/40 秒，默认第 5 次进入 Dead Letter；永久错误第一次即终止。人工 Replay 重置 Cycle 但保留所有历史。真实连接终止和受控 S3 Dependency Port 均能恢复。

**结论**：CLOSED for Worker protocol。完整真实 S3/API 串联仍 OPEN to G2-02-14。

## 7. Cancel 穿过 Cutover 或留下未知终态

**攻击**：Cancel 与阶段提交竞态，Job 一半 cancelled 一半 activated。

**证据**：运行中只持久请求，Worker 在下一阶段边界一次取消；Activate 事务写入 Cutover 标记后所有 Cancel 稳定返回不可取消。Graceful 与 Kill 都由同一 Lease/Terminal 协议收敛。

**结论**：CLOSED。

## 8. 错误样本成为 PK、文件 Key 或 SQL 泄露通道

**攻击**：Worker 把底层 Error/行内容直接塞进 Job 或日志 Label。

**证据**：类型与数据库双层只接受固定 Code、分类、SHA-256 Fingerprint；最多 50 项和 32 KiB。进程观察事件只有 outcome/stage，不含 Job ID、PK、Object Key、SQL 或 Cause。

**结论**：CLOSED。

## 9. Worker 借处理数据获得 Owner/DDL/OIDC 权限

**攻击**：连接串切换 Role、登录为 Superuser，或旧 API 列授权绕过 Enqueue。

**证据**：启动预检 Current/Session Role、危险 Role Attribute、Membership、Database/Schema CREATE、Migration Usage 与 Serving Write。API Raw Job INSERT 真库 42501；Worker 配置拒绝 Bearer/OIDC/Migration/DDL Secret。

**结论**：CLOSED。

## 10. “进程恢复”其实只调用同一个 Domain 函数

**攻击**：测试没有真实 PID/连接/数据库提交，无法覆盖 SIGKILL 和 Pool 生命周期。

**证据**：Harness 用 Node `spawn` 启动独立进程，实际 SIGKILL/SIGTERM，真实 PostgreSQL Login/Pool/Lease/Commit。连接终止测试曾真实发现 `unref()` 导致 code 13 退出，并在代码中修复。

**结论**：CLOSED。

## 11. 风险排序

| 排名 | 失败模式                     | 影响 | 可能性 | 当前状态                                      |
| ---: | ---------------------------- | ---: | -----: | --------------------------------------------- |
|    1 | 旧 Fence 写入 READY/Activate |    5 |      3 | CLOSED by DB CAS + process test               |
|    2 | Activate 响应丢失后重复切换  |    5 |      3 | CLOSED for generic checkpoint；真实 CAS 在 11 |
|    3 | 半阶段被 Checkpoint          |    5 |      3 | CLOSED for protocol；业务 Adapter 逐项接入    |
|    4 | Worker 持有 Owner/DDL        |    5 |      2 | CLOSED by startup/privilege matrix            |
|    5 | 永久错误重试风暴             |    4 |      4 | CLOSED by DB backoff/max/dead letter          |
|    6 | Node 在连接短断时自行退出    |    4 |      3 | CLOSED after real failure discovery           |
|    7 | Error Sample 泄密            |    4 |      2 | CLOSED by dual parser + bounded schema        |

## 12. 放行边界

未发现需要改变 PRD 或 G2-02 产品目标的停止条件。放行范围仅为 **G2-02-09 Index Plan、容量准入与受信 DDL 执行**。

不得把本项解释为生产 Materialization 已经可以启动：`worker:start` 在 09～11 的业务处理器接入前继续 fail closed；不得跳过 Index、Certificate、Cutover、GC、Admin HTTP 或 clean-room，也不得宣称 Query/UI 已可用。
