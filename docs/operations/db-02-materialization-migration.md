# DB-02 Materialization Migration Runbook

## 1. 范围与不变量

DB-02 是逻辑交付波次，不是第二个数据库或迁移账本。唯一顺序始终是：

```text
migrations/db-00/0001 ... 0006  已发布历史，禁止修改/改名
migrations/db-00/0007 ... 0018  DB-02 当前正式结构
ontos_migration.schema_migrations 唯一账本
```

正式对象 Owner 必须是 `migration_owner`。`api_runtime`、`worker_runtime`、`read_only_ops` 不得成为其成员，也不得获得数据库 CREATE、DDL、Migration Ledger 或事实 DELETE 权限。

## 2. 上线前检查

1. 确认 PostgreSQL 16、`plpgsql`、可恢复备份/PITR 和当前应用兼容版本。
2. 导出并保存 `ontos_migration.schema_migrations` 的 `version/name/sha256`；所有已应用版本（最高可到 0018）必须与发布制品逐字一致。
3. 检查不存在未知领先版本、缺号、Hash 漂移或同名异 Hash；任一命中立即停止。
4. 确认 Runtime 登录不是 `migration_owner` 成员，数据库与 Schema Owner 没有漂移。
5. 迁移不要求删除 R1/A0，也不要求停用已发布 Channel；若计划中出现历史行 UPDATE，停止执行。

标准入口只使用：

```text
npm run db:migrate
```

Runner 会先执行版本/扩展/角色预检，再取得全局 Advisory Lock；两个 Runner 同时启动时，一个完成，另一个得到 no-op。

## 3. 成功后检查

- Ledger 恰好连续到 0018，重复运行返回 no-op；
- 0001～0006 的 name/hash 不变；
- 所有 `meta`/`runtime`/`ops` 新对象 Owner 为 `migration_owner`；
- 历史 `member_count=0` Activation 的所有原列、值和 Digest 不变；
- Runtime 角色不能读 Ledger、DDL、DELETE、TRUNCATE 或 `SET ROLE migration_owner`；
- `read_only_ops` 只能读取登记的脱敏状态 View，不能读 Object Identity、Base 或 Attempt Staging；
- `worker_runtime` 可调用受控 Identity/Lookup/Stage/Promote 函数且可读构建 Staging，但不能直接 INSERT/UPDATE/DELETE Identity、Base 或 Staging；
- `runtime.link_base` / `runtime.link_current` 已有不为空的 Source/Target Object Type Resource 和类型化 Identity 外键；
- Generation 可在 `building` 状态空着 Report/Digest 创建，但只能通过受控 Quality Finalize 一次绑定；
- API/Worker 不能直写 Current、Provenance、Report、Rejected Set、Head Candidate、Quality Binding 或 Confirmation；
- Worker Candidate Reader 必须绑定精确 Project/Generation/Resource/Revision 和有界游标；API 只能调用 Owner 确认函数；
- Generation 进入 `ready` 前必须有可用 Quality Binding、zero-overlay=0、Current/Report 行数一致和完整 Object Property Provenance；
- API 只能调用幂等 Job Enqueue/Cancel/Replay，原 6 列直接 Job INSERT 已撤销；Worker 只能用完整 Lease/Fence 调用 Heartbeat/Checkpoint/Fail/Terminal；
- Job Error Sample 最多 50 项/32 KiB，只含固定 Code/Classification/Fingerprint；
- Index Admission 必须绑定真实 Release/Pin/Published Object Type；Pending/Failed Inventory 不能被视为完整；
- `projection-ddl-executor` 使用独立非 Runtime 登录，只消费已持久 Request UUID；API/Worker 不能读 Request 或执行 DDL；
- Build 前后容量准入绑定 Source Forecast、Inventory Revision 和实际 Physical Measurement；Catalog 下界不得小于实测；
- Runtime Plan 只能在 Release Stage 事务中从 Published Pins、完整 Snapshot Group Definition 和当前 Index Admission 派生；历史 R1/A0 不变；
- Compatibility Certificate 只能通过四参数受信函数签发；Current View 必须动态重验成功 Job、质量、Snapshot/Mapping、当前 Inventory、exact Admission 和审批有效期；
- data-bearing Release 只有每个 Group 的全部 Member 都有同 Group Version 当前证书时才能进入 READY；
- Materialization Admin 只能通过 0018 登记的受控函数/View 查询、启动、取消、确认、激活、容量审批和 GC；不得为 API/Worker 增加内部表直读/直写权限；
- 运行 `npm run test:database` 的等价发布环境 Smoke。

## 4. 失败处理

每个 SQL 文件由 Runner 包在独立事务中。文件中途失败时，该版本的表、Trigger、Grant 和 Ledger 行应全部不存在；修复环境原因后可重跑同一未提交版本。

禁止 Down Migration、手工删 Ledger、修改已应用文件或用 `CASCADE` 清理。处理规则：

| 状态                                       | 处理                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| 当前版本事务失败、Ledger 未写入            | 保留错误证据，修复环境或尚未发布的 Migration 源，再从同一版本重跑 |
| 版本已提交后发现语义错误                   | 保持原文件和 Hash；新增更高版本 Forward Fix                       |
| DB 领先、缺号或 Hash 漂移                  | 停止应用；核对制品/环境，不以手工 UPDATE Ledger 绕过              |
| A0、历史 Release/Activation 被改写         | 触发安全停止；从备份恢复并重新审查 Migration，不继续 G2-02        |
| Runtime 角色获得 Owner/DDL/直写 Fencing 表 | 立即撤流量和凭据，Forward Fix 权限，并重新跑真实 LOGIN 负测       |

## 5. 部署纪律

- Migration Runner 与 Projection DDL Executor 是部署级受信进程，不复用 API/Worker 连接池或凭据。
- 业务进程不得拼接 SQL、Identifier 或直接写 Migration Ledger。
- 生产变更只向前追加；PR 合并后不得为了“修测试”改写已发布 Migration。
- 0007～0018 已支持 Snapshot/Ingress/Job 事实、确定 Identity、Attempt-owned Base、不可见的 Quality-qualified Current、通用 Worker 恢复、Index/DDL、容量准入、Runtime Plan、动态兼容证书、原子 Cutover、mark-plan-commit GC 和最小 Admin 边界；`worker:start` 已使用正式八阶段组合根，但对外部署仍要求 G2-02-14 clean-room 总验收。
- Worker 的部署、故障和 Manual Replay 纪律见 [Materialization Worker 运行手册](materialization-worker.md)。
