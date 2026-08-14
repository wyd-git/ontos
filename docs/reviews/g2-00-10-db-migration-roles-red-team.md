# Red-Team：G2-00-10 DB-00 Migration 与数据库角色

结论：**Go（仅限 G2-00-10 本地实现与 PostgreSQL 16 Gate）**。空库部署、并发 Runner、第二数据库 Bootstrap、权限负测和向前修复均有真实 PostgreSQL 证据。受保护 CI、生产部署身份与锁等待告警仍属于 G2-00-12/生产部署，不因本任务通过而宣称完成。

## Top Kill-Assumptions（按优先级）

### 1. 每个 Migration 真能整批提交或整批回滚（已关闭，96）

- **Claim：** Runner 的事务边界足以保证失败 Migration 不留下部分 Schema。
- **Steelman：** 每个版本在显式 `BEGIN / COMMIT` 内执行，账本插入与 SQL 同事务，异常路径执行 `ROLLBACK`。
- **Fails if：** Migration 文件自己包含 `COMMIT`、`ROLLBACK` 或两阶段事务命令，提前结束 Runner 的事务，使随后错误无法撤销已提交 DDL。
- **Evidence to get this week：** 故意加入顶层 `COMMIT` 的定义测试，以及创建表后除零失败的 PostgreSQL Integration。
- **Kill criterion：** 顶层事务控制能进入执行，或失败后测试表/账本行仍存在。
- **Cheapest test：** `SELECT 1; COMMIT;` 定义和 `CREATE TABLE; SELECT 1/0` Migration。
- **处理：** Loader 新增顶层 SQL 词法检查，拒绝 `BEGIN/COMMIT/END/ABORT/ROLLBACK/SAVEPOINT/RELEASE/START TRANSACTION/PREPARE TRANSACTION`，同时跳过注释、引号和 Dollar-quoted Procedure Body；真实失败测试证明对象和账本都回滚。**CLOSED**。

### 2. 两个 Runner 与“集群角色已存在”不会造成重复 Bootstrap（已关闭，94）

- **Claim：** Hash 账本和 Advisory Lock 能让重复/并发执行得到一个 Apply、一个 no-op。
- **Steelman：** 取得锁后重新读取账本，比只依赖唯一键冲突更早、更可解释地消除竞争。
- **Fails if：** 锁只覆盖单个事务而 Runner 在版本间释放，或把集群级 `migration_owner` 已存在误当成当前数据库已有账本；第二 Runner 可能再次执行 `0001`。
- **Evidence to get this week：** 同一集群新建第二数据库，并用两个独立连接并发运行完整迁移。
- **Kill criterion：** 两个 Runner 都执行 `0001`、出现 `schema_migrations already exists`，或角色已存在的新数据库不能 Bootstrap。
- **Cheapest test：** `Promise.all` 启动两个真实 `pg.Client`。
- **处理：** 初版红队测试确实复现重复建表；锁改为覆盖完整 Runner 的 Session-level Advisory Lock，并把“账本存在”与“角色存在”分开判断。最终一边 Apply、一边 no-op，第二数据库成功。**CLOSED**。

### 3. Runtime 的低权限不是只看角色表面属性（已关闭，92）

- **Claim：** `api_runtime`、`worker_runtime`、`read_only_ops` 无法获得 Owner 或 DDL 能力。
- **Steelman：** 三个角色均为 `NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS`，数据库只授予 `CONNECT`。
- **Fails if：** 正式角色是其他高权限角色的成员，或 PostgreSQL 默认给未来 Function/Type 的 `PUBLIC` 权限绕过了表 ACL。
- **Evidence to get this week：** 检查 `pg_auth_members` 的父角色边，并以真实 Runtime 登录测试数据库/Schema/Extension/Object 权限和 Default Privileges。
- **Kill criterion：** 任一正式角色从属于其他角色；Runtime 可建 Schema/Role/Extension，或未显式授权即可执行 Owner Function、使用 Owner Type、读写 Owner Table。
- **Cheapest test：** 一个由 `migration_owner` 创建的 test-only Table、Sequence、Function 与 Enum。
- **处理：** Migration 拒绝四个正式角色的任何父角色 Membership；Default Privileges 全局撤销 Table/Sequence/Routine/Type 的 `PUBLIC` 权限；真实登录负测全部通过。**CLOSED**。

### 4. 版本/扩展失败确实发生在写入前（已关闭，90）

- **Claim：** 未验证 PostgreSQL Major 或缺失必需扩展不会产生角色、Schema 或账本。
- **Steelman：** Preflight 只查询 `server_version_num`、角色/数据库属性和 `pg_available_extensions`，之后才取得锁并开始事务。
- **Fails if：** Runner 先建账本再检查环境，或把“扩展可用但未安装”当成已满足。
- **Evidence to get this week：** 强制不支持的 Major 与不存在扩展，随后查询角色和 Schema 是否仍不存在。
- **Kill criterion：** 稳定错误不匹配，或任一失败路径留下 `migration_owner`/`ontos_migration`。
- **Cheapest test：** 在同一个空 PostgreSQL 16 容器先执行两个负面 Preflight。
- **处理：** `DB_VERSION_UNSUPPORTED` 与 `DB_REQUIRED_EXTENSION_MISSING` 均在任何写入前返回，数据库保持空白。**CLOSED**。

### 5. “只向前”不是把失败留给人工猜测（已关闭，87）

- **Claim：** 不提供自动 Down Migration 仍能处理执行失败和已提交语义缺陷。
- **Steelman：** 未提交失败可以修正原版本后重试；已提交历史保持 Hash 不变，通过更高版本 Roll Forward。
- **Fails if：** 中途失败留下半套对象，或修复只能改写已应用 SQL/账本 Hash。
- **Evidence to get this week：** 一次未提交故障、一次已提交可空列缺陷、一个更高版本回填并加 `NOT NULL`、一次历史文件篡改。
- **Kill criterion：** 失败对象残留；修复需要删除历史；篡改已应用文件仍 no-op。
- **Cheapest test：** 三个 test-only Migration 文件和账本 Hash 对照。
- **处理：** 失败版本完全回滚；后续 `0002`/`0003` 保留各自 Hash 并完成约束修复；历史篡改稳定失败。**CLOSED**。

## Intended vs. Implemented

| 文档化意图                                                      | 实现证据                                                                                     | 攻击者 / 受影响边界                       | 结论 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | ---- |
| 文件连续、原始字节 Hash、历史不可改                             | `tools/database/definitions.ts:7-118`；`migrator.ts:67-83`；Integration `145-169`、`345-378` | 错误部署包 / 数据库历史                   | PASS |
| Runner 拥有事务边界，并发只应用一次                             | `definitions.ts:125-240`；`migrator.ts:31-108`；Integration `121-143`                        | 两个部署进程 / Schema 与账本              | PASS |
| 不支持版本、缺扩展在写前稳定失败                                | `preflight.ts:37-134`；Integration `56-68`、`106-119`                                        | 错误运行环境 / 目标数据库                 | PASS |
| Runtime 不是 Owner/高权限角色，不通过 Membership 或默认权限绕过 | `migrations/db-00/0001_foundation.sql:1-106`；Integration `172-289`、`401-451`               | API/Worker/运维身份 / DDL、事实与迁移账本 | PASS |
| `read_only_ops` 不能写                                          | Integration `428-451`                                                                        | 运维查询身份 / test-only append-only 表   | PASS |
| Handler Host 没有数据库 Client 或身份                           | `tools/database/handler-boundary.test.ts:7-40`；既有 Handler Host 环境隔离测试               | Handler Artifact / 数据库                 | PASS |
| 故障按 Roll Forward 恢复，不自动降级                            | Integration `292-399`；Loader 历史校验 `definitions.ts:91-119`                               | 错误 Migration / 已提交 Schema            | PASS |

没有发现仍未关闭、且属于 G2-00-10 范围的 Intended-vs-Implemented 偏差。

## What's Well-Reasoned

- DB-00 只创建角色、Schema 和账本，不提前创建 DB-01 业务表，范围边界清晰。
- Runtime 默认只获得数据库 `CONNECT` 和指定 Schema `USAGE`；未来对象必须逐表显式授权，适合 append-only、owner-only 与状态表的不同权限。
- Handler Host 继续通过受限 Context 工作，没有为了方便执行 Action 而获得数据库旁路。
- 一次性固定镜像 Integration 不复用开发者数据卷，既验证真实 PostgreSQL，又不会破坏现有本地环境。

## What I Couldn't Assess

- G2-00-12 尚未把 `test:database` 设为受保护 CI 必跑项，也未演练 CI Service Container；Owner：Platform / Quality，Gate：G2-00-12。
- 生产部署身份、Secret Manager、TLS、连接池和 `migration_owner` Membership 的实际授予流程不在本仓库环境内；Owner：Platform / Security，进入生产部署 Gate 前验证。
- Session-level Advisory Lock 当前依赖部署作业超时/告警发现长时间持锁的活连接；进程崩溃或连接断开由 PostgreSQL 自动释放，但生产锁等待 SLO 与告警属于 G2-00-12 运维接线。
- PostgreSQL 17+ 被明确拒绝，而非声称兼容；升级时必须新增版本矩阵并重跑本 Gate。
