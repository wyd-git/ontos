# G2-00-10 DB-00 Migration 与数据库角色 Gate 验收记录

- 结论：**PASS（仅限 G2-00-10 DB-00 与 PostgreSQL 16 本地 Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-00-10-db-migration-roles`
- 起始 Commit：`8a8a5f2001aa225a5eee4be853987fcb4a0de64e`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14
- 环境：macOS 26.5.2（Build 25F84）arm64 / Docker 29.6.1

本记录对应 [G2-00-10 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-10实现-db-00-migration-与数据库角色)。最终实现 Commit 由 PR Head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                               | 实现证据                                                                        | 执行证据                                                                                       | 结果 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| 空 PostgreSQL 16 前向部署，重复 no-op，Hash/顺序可审计                 | `migrations/db-00/0001_foundation.sql`；Definition/History 校验；Migration 账本 | PostgreSQL 16.14 空库 Apply；第二次 `applied=[]`；账本逐项等于原始文件 SHA-256                 | PASS |
| 不兼容版本或缺失扩展在写入前稳定失败                                   | 只读 Preflight；`DB_VERSION_UNSUPPORTED`、`DB_REQUIRED_EXTENSION_MISSING`       | 两个负面 Preflight 后 `migration_owner` 与 `ontos_migration` 仍不存在                          | PASS |
| Runtime 非 Owner/Superuser，不能建 Schema、Role、Extension             | 四个 NOLOGIN 角色、属性/Membership 校验、Database/Public ACL                    | 真实 API/Worker/Read-only 登录均收到 PostgreSQL `42501`；Database `CREATE/TEMPORARY=false`     | PASS |
| test-only append-only/owner 表证明 Runtime 不能更新/删除或绕过默认权限 | `migration_owner` Default Privileges；test-only Table/Sequence/Function/Enum    | 默认无隐式 SELECT/INSERT/EXECUTE/USAGE；显式授权后 API/Worker 仅 SELECT/INSERT，负操作全部拒绝 | PASS |
| `read_only_ops` 不可写，Handler Host 无数据库身份                      | Read-only 仅获 ops/audit Schema USAGE；Handler Host 静态边界 Test               | Read-only 的 INSERT/UPDATE/DELETE/DDL/账本读取拒绝；Handler Host 无 `pg` Import/数据库连接配置 | PASS |
| 故障 Migration 有向前修复，不提供未经验证自动 Downgrade                | Runner 事务、禁止 Migration 自管事务、Hash 历史校验                             | 中途失败无残留；已提交缺陷由更高版本回填并加约束；历史 Hash 篡改稳定失败                       | PASS |

额外验证：同一 PostgreSQL 集群新增第二数据库后，两个独立 Runner 并发执行，最终恰好一个 Apply、一个 no-op；集群角色已存在不被误判为当前数据库已经 Bootstrap。

## 2. 冻结资产

### 2.1 Migration 协议

- 文件名 `NNNN_lower_snake_case.sql`，从 `0001` 严格连续；
- SHA-256 基于原始文件字节，已应用版本的 Version/Name/Hash 必须精确匹配；
- 顶层事务控制被拒绝，完整 Runner 使用 Session-level Advisory Lock，每个版本使用独立事务；
- SQL 与账本插入同事务，失败 Rollback；无待应用版本时 no-op；
- 仅验证 PostgreSQL Major 16，必需扩展为已安装的 `plpgsql`；
- 无自动 Down Migration；未提交错误可修正后重试，已提交语义缺陷新增更高版本 Roll Forward。

### 2.2 数据库边界

- Owner：`migration_owner`；Runtime Group Role：`api_runtime`、`worker_runtime`；只读：`read_only_ops`；全部 `NOLOGIN`；
- 四个正式角色均非 Superuser/CreateDB/CreateRole/Replication/BypassRLS，且不能从属于任何其他角色；
- Schema：`meta`、`authz`、`runtime`、`action`、`ops`、`audit`、内部 `ontos_migration`；全部由 `migration_owner` 拥有；
- Runtime 只有当前数据库 `CONNECT`，没有 `CREATE/TEMPORARY`；`migration_owner` 有受控 Schema 所需的 `CREATE`；
- API/Worker 对六个业务 Schema 有 `USAGE`，只读角色仅对 `ops/audit` 有 `USAGE`；无未来表的宽泛默认读写授权；
- `PUBLIC` 的数据库默认权限、`public` Schema 权限和 `migration_owner` 未来对象的 Table/Sequence/Routine/Type 默认权限被撤销。

## 3. Red-Team 与 Intended-vs-Implemented

[专项审查](../reviews/g2-00-10-db-migration-roles-red-team.md)在 PASS 前实际发现并修正：

1. 初版没有禁止 Migration 文件内 `COMMIT`，可能逃逸 Runner 事务；现由 Loader 在执行前拒绝顶层事务控制；
2. 初版 Transaction-level Lock 在完整 Runner 并发演练中出现重复 Bootstrap；现使用覆盖整个 Runner 的 Session-level Lock；
3. 初版把集群角色存在等同当前数据库已初始化，第二数据库会过早切换 Owner；现以账本是否存在决定 Bootstrap/角色切换；
4. 初版只检查 Runtime 不是 `migration_owner` 成员，未排除其他高权限父角色；现拒绝四个正式角色的任何父 Membership；
5. 初版 `migration_owner` 只有 CONNECT，真实 PostgreSQL 无法创建 Schema；现仅给 Owner 增加数据库 CREATE，Runtime 继续没有；
6. 初版对同名 Schema 使用 `IF NOT EXISTS`，可能接管未知对象；现首次 Migration 要求正式 Schema 不存在，冲突整批失败。

审查后没有仍未关闭、且属于 G2-00-10 范围的 Intended-vs-Implemented 偏差。

仍开放但不阻断本任务：

- `test:database` 的受保护 CI、Service Container 和长等待告警：Owner 为 Platform / Quality，Gate 为 G2-00-12；
- 生产部署身份、TLS、Secret Manager、连接池和 Membership 授予：Owner 为 Platform / Security，生产部署 Gate；
- PostgreSQL 17+ 兼容性未宣称，当前 Fail Closed。

## 4. 可复现执行

### 4.1 全仓 Gate

```text
env PATH=/Users/wangyudong/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin \
  /Users/wangyudong/.nvm/versions/node/v24.18.0/bin/node \
  /Users/wangyudong/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js run verify

check:toolchain     PASS — node 24.18.0 / npm 11.16.0
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 179/179
check:architecture  PASS — 2 packages / 16 source files
check:contracts     PASS — 11 Foundation / 16 stable error codes / 5 deferred families / 30 Golden cases
```

### 4.2 真实 PostgreSQL Gate

```text
npm run test:database

image  postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8
result PASS — 1 top-level integration / ephemeral container / 约 1.4 秒
```

一个 Top-level Integration 内含：写前失败、空库 Apply、no-op、账本、角色属性/Membership、Schema/Database ACL、Default Privileges、三个真实 Runtime Login、DDL/DML 负测、中途失败回滚、向前修复、历史篡改、第二数据库与双 Runner 并发。容器使用 `--rm` 和随机名称，结束时强制清理，不连接或删除 `ontos-g2-local` 数据卷。

### 4.3 冻结摘要

```text
3e19e7f90229ead042c52255802bcd0bd0d243eb12f3b0f92087dc7ed4a6187e  migrations/db-00/0001_foundation.sql
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b  package-lock.json
08d53bce46f493516ea8873507957be518ac27b714086516beb1a9cf8af94631  tools/database + migrations/db-00 sorted manifest digest
```

`package-lock.json` 未变化。任何 Migration、Runner、Preflight、权限 SQL 或 Integration 行为变化都必须重新生成 Evidence。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-11～13 仍未完成。
- DB-00 没有创建 Object、Link、Action、Job、Outbox、Audit Event 等 DB-01+ 业务表，也没有 Repository。
- Test-only append-only 表、登录角色和修复 Migration 只存在一次性 Integration 容器，不进入正式 Migration。
- 当前不包含生产 Secret、TLS、连接池、HA、备份/PITR、容量、锁等待 SLO 或部署审批。
- 当前不宣称 PostgreSQL 17+ 兼容，也不提供自动 Schema Downgrade。
- 本地 `test:database` 尚未等于不可绕过的远端分支保护；该接线属于 G2-00-12。
