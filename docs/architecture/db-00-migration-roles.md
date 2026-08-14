# DB-00：Migration、数据库角色与逻辑 Schema

- 状态：Accepted for G2-00-10
- 日期：2026-08-14
- Owner：Database / Platform
- 决策范围：Migration 协议、集群角色、逻辑 Schema、默认权限、版本/扩展前置检查与向前修复
- 不在范围：DB-01 及之后的业务表、业务索引、Repository SQL、生产 Secret 与连接池部署

## 1. 决策结论

DB-00 是后续数据库实现的最小安全底座，不是业务数据模型。它只创建：

1. 四个无登录数据库角色：`migration_owner`、`api_runtime`、`worker_runtime`、`read_only_ops`；
2. 六个业务逻辑 Schema：`meta`、`authz`、`runtime`、`action`、`ops`、`audit`；
3. 一个仅供迁移器使用的内部 Schema `ontos_migration`，以及 append-only Migration 账本；
4. 默认权限和数据库/Schema 边界；
5. 只向前执行、Hash 可审计、失败整批回滚的 Migration Runner。

DB-00 不创建 Object、Link、Action、Job、Outbox、Audit Event 等业务表。后续 DB Wave 必须用独立 Migration 显式创建表和授予对象权限，不能把业务能力偷渡进本任务。

## 2. Migration 协议

### 2.1 文件与顺序

- 正式文件位于 `migrations/db-00/`，名称必须匹配 `NNNN_lower_snake_case.sql`；
- 版本从 `0001` 开始严格连续，同一版本只允许一个文件；
- Runner 按原始文件字节计算小写 SHA-256，不做换行或格式归一化；
- 已应用记录的 `version`、`name`、`sha256` 必须与仓库完全一致；数据库领先、缺号、改名或 Hash 改变均以 `DB_MIGRATION_HISTORY_DIVERGED` 失败；
- 已全部应用时重复运行是 no-op，不追加账本记录。

账本 `ontos_migration.schema_migrations` 至少保存版本、名称、SHA-256、执行时间、真实连接身份、执行角色与 PostgreSQL `server_version_num`。Runtime 角色不拥有、不可读写该表。

### 2.2 事务与并发

每个待应用 Migration 独占一个事务：

1. Preflight 后取得固定 Session-level Advisory Lock，并由 `finally` 显式释放；连接异常关闭时 PostgreSQL 自动释放；
2. 锁覆盖本次 Runner 的完整 Migration 集合；每个版本仍使用独立的 `BEGIN / COMMIT`，且取得锁后重新读取并校验完整账本，避免两个 Runner 同时判断“尚未应用”；
3. 已有迁移账本时，`SET LOCAL ROLE migration_owner` 后执行 SQL；首次 Migration 在同一事务内创建并校验角色，然后切换到 `migration_owner`；角色已在同集群其他数据库存在不等于当前数据库已 Bootstrap；
4. SQL 成功后在同一事务插入账本记录并 `COMMIT`；
5. SQL 或账本写入失败则 `ROLLBACK`，不留下半套 Schema 或伪造的已应用状态。

Runner 不提供自动 Down Migration。已经部署但语义错误的 Migration 只能新增更高版本的修复 Migration；从未成功提交的 Migration 可以修正原文件后重试，因为数据库中没有它的账本记录或部分写入。

### 2.3 写入前置检查

Runner 在首次 `BEGIN`、取得锁或执行任何 DDL 之前完成只读 Preflight：

- 仅接受已经明确验证的 PostgreSQL Major；当前仅为 16，其他版本返回 `DB_VERSION_UNSUPPORTED`；
- 必需扩展必须已安装且可用；当前只依赖发行版内建的 `plpgsql`，缺失时返回 `DB_REQUIRED_EXTENSION_MISSING`；
- 首次 Bootstrap 必须由具备 `CREATEROLE` 或 Superuser 能力的部署身份执行，否则返回 `DB_MIGRATION_PRIVILEGE_REQUIRED`；
- 正式角色已经存在但属性不符合本文件时，整次 Migration 失败，不静默接管高权限或可登录角色。

以上错误必须使用稳定 Code；CLI 不打印连接串、密码、完整 SQL 或数据库原始错误正文。

## 3. 角色模型

四个正式角色都是 `NOLOGIN` Group/Owner Role。真实生产登录身份由部署系统单独创建并授予相应成员关系；仓库不提交生产密码。

| 角色              | 用途                                  | Owner | Superuser / Create DB / Create Role / Replication / Bypass RLS | 可登录 |
| ----------------- | ------------------------------------- | ----- | -------------------------------------------------------------- | ------ |
| `migration_owner` | 拥有 DB-00 Schema、账本和后续迁移对象 | 是    | 全部否                                                         | 否     |
| `api_runtime`     | API 进程的最小对象权限集合            | 否    | 全部否                                                         | 否     |
| `worker_runtime`  | Worker 进程的最小对象权限集合         | 否    | 全部否                                                         | 否     |
| `read_only_ops`   | 受控运维查询的只读权限集合            | 否    | 全部否                                                         | 否     |

不可违反的边界：

- 四个正式角色都不能从属于任何其他数据库角色；Runtime 与只读角色不能 `SET ROLE migration_owner`；部署身份成为 `migration_owner` 的成员是相反方向的受控关系；
- Runtime 与只读角色不能创建 Schema、Role、Database 或 Extension；
- `migration_owner` 不作为 API、Worker 或 Handler Host 的运行身份；
- Handler Host 没有数据库角色、连接串或数据库 Client，所有能力继续通过受限 Host Context 调用；
- G2-00-10 的测试登录角色只存在于一次性 Integration 数据库，不进入正式 Migration。

## 4. Schema 与对象权限

所有正式 Schema 由 `migration_owner` 拥有。首次 Migration 要求这些 Schema 尚不存在，不接管同名 Schema 或其中的未知对象。DB-00 只授予 Schema `USAGE`，不预授予未来表的读写能力：

| Schema    | `api_runtime` | `worker_runtime` | `read_only_ops` |
| --------- | ------------- | ---------------- | --------------- |
| `meta`    | USAGE         | USAGE            | 无              |
| `authz`   | USAGE         | USAGE            | 无              |
| `runtime` | USAGE         | USAGE            | 无              |
| `action`  | USAGE         | USAGE            | 无              |
| `ops`     | USAGE         | USAGE            | USAGE           |
| `audit`   | USAGE         | USAGE            | USAGE           |

`ontos_migration` 对三类非迁移角色全部不可见。`public` Schema 与当前数据库对 `PUBLIC` 的默认创建/临时对象权限被撤销；三类非迁移角色只得到显式 `CONNECT`，`migration_owner` 额外得到创建受控 Schema 所需的数据库 `CREATE`。

`migration_owner` 的 Default Privileges 对 `PUBLIC` 撤销未来 Table、Sequence、Routine 和 Type 的默认权限。DB-00 不向 Runtime 配置宽泛的 Default Table Privilege，原因是未来 append-only、owner-only、状态表和只读投影需要不同权限。每个 DB Wave 必须在创建对象的同一 Migration 中显式 `GRANT`，并用负面测试证明未授予的操作确实失败。

Default Privileges 只影响未来由目标角色创建的对象，且不会因为角色成员关系自动套用其他角色的默认值；这是后续 Migration 必须始终以 `migration_owner` 创建对象的原因。PostgreSQL 对 Function 默认授予 `PUBLIC EXECUTE`，因此全局撤销必须在对象出现前完成。依据见 [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html) 与 [Privileges](https://www.postgresql.org/docs/16/ddl-priv.html)。

## 5. 错误合同

| Code                              | 含义                                         |
| --------------------------------- | -------------------------------------------- |
| `DB_VERSION_UNSUPPORTED`          | PostgreSQL Major 未经当前版本验证            |
| `DB_REQUIRED_EXTENSION_MISSING`   | 必需扩展未安装或不可用                       |
| `DB_MIGRATION_PRIVILEGE_REQUIRED` | 首次 Bootstrap 身份不能安全创建正式角色      |
| `DB_MIGRATION_DEFINITION_INVALID` | 本地 Migration 文件名、顺序或定义非法        |
| `DB_MIGRATION_HISTORY_DIVERGED`   | 数据库账本与当前仓库名称、顺序或 Hash 不一致 |
| `DB_MIGRATION_EXECUTION_FAILED`   | Migration 事务执行失败且已回滚               |

底层 `SQLSTATE` 可以进入受控内部诊断，但不替代稳定 Code，也不直接进入公开错误正文。

## 6. 可执行验收

一次性 PostgreSQL 16 Integration 必须证明：

1. 空库部署成功，第二次运行 no-op，账本顺序与文件 Hash 一致；
2. PostgreSQL Major 或必需扩展不满足时，在数据库写入前失败；
3. 四个正式角色属性、Membership、数据库与 Schema 权限符合本文件；
4. 由 `migration_owner` 创建 test-only owner 表后，Runtime 没有通过 Default Privilege 获得隐式访问；
5. 对 test-only append-only 表显式授予 `SELECT/INSERT` 后，API/Worker 可插入但不能 `UPDATE/DELETE/TRUNCATE/ALTER`，`read_only_ops` 只能 `SELECT`；
6. API/Worker/只读测试登录身份均不能创建 Schema、Role、Extension，不能切换为 `migration_owner`；
7. 故意在中途失败的 Migration 不留下对象或账本行；随后通过更高版本 Migration 完成向前修复，历史版本与 Hash 均保留；
8. Handler Host 的启动与能力目录不包含数据库身份或数据库 Client。

Integration 使用固定 PostgreSQL 16 镜像创建一次性容器，不复用或清空开发者现有的 `ontos-g2-local` 数据卷。正式自动化进入 CI 属于 G2-00-12；G2-00-10 先提供可重复的本地命令和 Evidence。

## 7. 运维边界

- 首次部署身份需要创建集群角色；完成 Bootstrap 后，日常 Migration 应使用可 `SET ROLE migration_owner` 的受控部署身份；
- 自动回滚数据库 Schema 不在承诺内。应用回退必须先确认旧程序与新 Schema 兼容，否则采用 Roll Forward；
- DB-00 不解决生产 TLS、Secret Manager、连接池、HA、备份/PITR 或跨区域恢复；
- PostgreSQL `CREATE EXTENSION` 对部分 trusted extension 允许非 Superuser 执行，因此不能只检查 `rolsuper`，还必须撤销 Runtime 的数据库 `CREATE` 权限。依据见 [CREATE EXTENSION](https://www.postgresql.org/docs/16/sql-createextension.html)；并发锁采用覆盖完整 Runner、异常断开即释放的 Session-level Advisory Lock，依据见 [Advisory Lock Functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)。
