# DB-01 Metadata Migration 运行手册

- 状态：Active for G2-01-03
- 适用版本：PostgreSQL 16
- Migration：`0001_foundation.sql` → `0002_metadata_control_plane.sql`
- Owner：Database / Platform

## 1. 这次迁移会产生什么

DB-01 在 DB-00 的 `meta` 和 `authz` Schema 中创建 18 张控制面表：

- `meta`：Project、Resource/Revision/Dependency、Validation Report、Release/Pin/Activation/Channel/Serving Head、Package/Revision/Installation/Change 和 Artifact Reference；
- `authz`：Principal、Role Binding 和 Authorization Epoch；
- 所有对象继续由 `migration_owner` 拥有；API 只有显式表级和列级权限，Worker/Ops 只读必要记录。

DB-01 不创建 Snapshot、Generation、Current、Policy Compilation、Action 或 Audit 业务表。这些属于后续 Gate。

## 2. 执行前

1. 使用可连接目标数据库、且首次 Bootstrap 时能创建正式 Group Role 的部署身份；
2. 确认 PostgreSQL Major 为 16，`plpgsql` 已安装；
3. 备份和 PITR 是生产部署 Gate 的额外条件，本任务的临时容器测试不等于生产备份证明；
4. 不要修改已在目标数据库账本中出现的 Migration 文件。

## 3. 执行与核对

在已配置数据库连接的部署环境执行：

```text
npm run db:migrate
```

Runner 在固定 Advisory Lock 下按版本单独事务执行，DDL 与账本写入同事务。成功后核对：

```sql
SELECT version, name, sha256, applied_at, applied_by, applied_role, server_version_num
FROM ontos_migration.schema_migrations
ORDER BY version;
```

预期有且仅有连续的 `0001 foundation` 和 `0002 metadata_control_plane`；重复执行不应新增账本行。Runtime 账号不应能运行这条账本查询。

仓库级验证命令：

```text
npm run test:database:unit
npm run test:database
```

`test:database` 使用一次性 PostgreSQL 16 容器，不连接、清空或复用开发数据卷。

## 4. 失败与恢复

- Preflight 失败：数据库不应出现新 Role、Schema 或账本；修正版本、扩展或部署身份后重试。
- `0002` 未提交前失败：整个 Migration 回滚，不应留下部分表、Trigger 或 `0002` 账本行；修正同一未提交文件后重试。
- `0002` 已提交后发现语义缺陷：不改 Hash，不做自动 Down Migration；新增 `0003_*` 或更高版本向前修复。
- 账本 Hash、名称或顺序与仓库不一致：Runner 以 `DB_MIGRATION_HISTORY_DIVERGED` 停止；先确认目标库和仓库版本，不要跳过检查。

## 5. 权限故障判断

- API 可以 `SELECT/INSERT` DB-01 表，只能更新明确列；命名、外部身份、Manifest、Pin 和已发布载荷不能被改写。
- Worker 只读 `meta` 与 `authz.authorization_epochs`，不能读 Principal/Binding，不能写 Metadata。
- Ops 只读 `meta`，不能读 `authz`。
- 任何 Runtime 账号若能 `DELETE`、`TRUNCATE`、`ALTER`、`REFERENCES` 或 `SET ROLE migration_owner`，都是阻断上线的权限回归。
