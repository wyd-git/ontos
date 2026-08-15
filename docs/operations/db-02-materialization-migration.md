# DB-02 Materialization Migration Runbook

## 1. 范围与不变量

DB-02 是逻辑交付波次，不是第二个数据库或迁移账本。唯一顺序始终是：

```text
migrations/db-00/0001 ... 0006  已发布历史，禁止修改/改名
migrations/db-00/0007 ... 0009  DB-02 首批正式结构
ontos_migration.schema_migrations 唯一账本
```

正式对象 Owner 必须是 `migration_owner`。`api_runtime`、`worker_runtime`、`read_only_ops` 不得成为其成员，也不得获得数据库 CREATE、DDL、Migration Ledger 或事实 DELETE 权限。

## 2. 上线前检查

1. 确认 PostgreSQL 16、`plpgsql`、可恢复备份/PITR 和当前应用兼容版本。
2. 导出并保存 `ontos_migration.schema_migrations` 的 `version/name/sha256`；0001～0006 必须与发布制品逐字一致。
3. 检查不存在未知领先版本、缺号、Hash 漂移或同名异 Hash；任一命中立即停止。
4. 确认 Runtime 登录不是 `migration_owner` 成员，数据库与 Schema Owner 没有漂移。
5. 迁移不要求删除 R1/A0，也不要求停用已发布 Channel；若计划中出现历史行 UPDATE，停止执行。

标准入口只使用：

```text
npm run db:migrate
```

Runner 会先执行版本/扩展/角色预检，再取得全局 Advisory Lock；两个 Runner 同时启动时，一个完成，另一个得到 no-op。

## 3. 成功后检查

- Ledger 恰好连续到 0009，重复运行返回 no-op；
- 0001～0006 的 name/hash 不变；
- 所有 `meta`/`runtime`/`ops` 新对象 Owner 为 `migration_owner`；
- 历史 `member_count=0` Activation 的所有原列、值和 Digest 不变；
- Runtime 角色不能读 Ledger、DDL、DELETE、TRUNCATE 或 `SET ROLE migration_owner`；
- `read_only_ops` 只能读取 `ops.materialization_job_status`、`ops.gc_status` 和 `ops.runtime_inventory_status`；
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
- 0007～0009 只证明 Schema/权限/最小 Fencing 薄切片；不要据此开启 CSV、真实 Materializer、Cutover 或 GC 流量。
