# G2-03-07 typed Query AST 与参数化 PostgreSQL Compiler Evidence

- Gate：G2-03-07
- 日期：2026-08-20
- Owner：Query / PostgreSQL / Security（accountable: `wyd-git`）
- 结论：**PASS**

## 1. 本项真正关闭了什么

G2-03-07 把已经冻结的 Runtime Read 合同和生产 Policy Gateway Context 接到了唯一正式查询编译边界：

```text
strict public Query AST
→ Release-bound Schema Registry
→ public Value Codec
→ normalized typed plan / Query Hash / complexity budget
→ client + Object/Property/Link Policy predicates
→ fixed parameterized PostgreSQL SQL
→ bounded read-only Executor
```

实现位于三个生产包：

- `@ontos/query-domain`：Parser 调用、Schema Registry、Value Codec、Normalizer、Hash、Complexity、Policy logical plan；
- `@ontos/query-application`：将精确 `PolicyGatewayContext` 降为查询上下文并定义 Compiler/Executor Port；
- `@ontos/query-postgres`：固定 Renderer、参数绑定、只读事务、Timeout/Abort/Row/Byte 边界。

这不是 HTTP Endpoint 或 UI Demo。它是后续 Object Get/Search/Link 公共用例共同复用的生产查询内核。

## 2. 合同与安全证据

| 断言                   | 实现证据                                                                           | 自动化证据                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AST 在执行前严格校验   | `packages/query-domain/src/compiler.ts` 只接受 `@ontos/contracts` Parser 结果      | `tools/query-compiler/compiler.test.ts` 覆盖未知字段、浮点/指数欺骗、文本和主键非法输入 |
| 所有值类型化、规范化   | `packages/query-domain/src/value.ts` 复用 `@ontos/value-codec`                     | Canonical Query Hash、Integer/Decimal/Enum/String Array 向量                            |
| 复杂度有硬上限         | `QUERY_COMPLEXITY_MAXIMUM_UNITS` 与加权 Analyzer 在 logical plan 注册前执行        | 100 个受信 `link_exists` 规则稳定返回 `QUERY_COMPLEXITY_EXCEEDED`                       |
| Policy 不在内存后过滤  | Renderer 将 Client、Row Policy、Property Guard 放入同一 `WHERE`                    | SQL 结构测试与真实 `EXPLAIN ANALYZE`                                                    |
| mask/deny 无过滤侧信道 | 受限字段不能 Filter/Sort/Search；Projection 只在 allow 分支读取原值                | masked Property 正负测试与 SQL CASE 结构测试                                            |
| 不接受任意 SQL         | Logical Plan 与 Statement 均有进程内真实性品牌；Renderer 无 Raw Fragment Port      | 伪造 Plan/Statement 均 fail closed                                                      |
| Current 绑定精确       | 每条语句绑定 Project、Generation、Resource、Revision、Active                       | Get/List/Count/Link 与 Policy `link_exists` 精确绑定测试                                |
| 资源可回收             | `REPEATABLE READ READ ONLY`、`force_custom_plan`、本地 Timeout、Abort 销毁活动连接 | Timeout、Abort、Row/Byte 上限及 Pool 恢复测试                                           |

Query Hash 包含 Compiler Version、操作、Project/Release/Revision/Generation 语义、规范 AST、Select、Sort 与 Page Size；对对象 Key 顺序、可交换逻辑顺序和 `in` 集合顺序稳定，对比较操作等语义变化改变。Policy Context 使用独立 `policyContextHash` 绑定，未把规则正文混入 Query Hash。

## 3. 真实 PostgreSQL 16 证据

`tools/materialization-clean-room/postgres-s3-worker-clean-room.test.ts` 在同一干净 Checkout 中先建立 G2-02 的 100,000 Object / 1,000,000 Link Current 数据和 Published Index Plan，再运行 `tools/query-compiler/postgres-evidence.ts`。在开启只读快照前，Evidence 对 Object/Link Current 执行显式 `ANALYZE`，避免刚完成批量写入时自动统计尚未刷新导致规划随机波动；不关闭顺序扫描、不强制索引、不修改 Planner Cost。机器制品为 `generated/ci-report/g2-03-07-query-compiler.json`，并与当次 Commit、Fixture Digest 和 `cleanCheckout=true` 绑定。

固定 Corpus 的结果：

| 场景                   | 结果 | 计划证据                                                                         |
| ---------------------- | ---- | -------------------------------------------------------------------------------- |
| Get                    | PASS | `object_current_canonical_pk_uq`，Current 顺序扫描 0                             |
| List                   | PASS | 命中 G2-02 Published Index Plan，Current 顺序扫描 0                              |
| Policy Filter          | PASS | Policy 与 Client Predicate 同 SQL，命中 Published Index Plan，Current 顺序扫描 0 |
| Count                  | PASS | Policy 在 Count 前执行，命中 Published Index Plan，Current 顺序扫描 0            |
| one-hop Link candidate | PASS | `link_current_source_traversal_idx` 与 Object Current 索引，Current 顺序扫描 0   |

额外真实边界：PostgreSQL `server_version_num=160014`；1ms Statement Timeout 返回服务端取消码，随后 Pool 可继续 `SELECT 1`；`pg_stat_activity` 中没有遗留后台长查询。SQL 计划完整保存在机器制品中，不把一次共享 Runner 的时延误报为后续 G2-03-09 的正式查询 SLO。

## 4. Provenance 与范围约束

- Fixture 只来自 `packages/testkit/src/materialization.ts`，Digest 由 Evidence Gate 精确校验；
- 机器制品记录 G1 原始参考路径，但生产包对 `spikes/g1` 的 Import 数为 0；
- 没有新 Migration、表、Role 或 Grant；没有修改既有 0001～0027；
- 没有 Runtime HTTP、Generated Client 调用或 Web 页面；
- 没有实现 Query Lease 生命周期、公共 Object Get Response、签名 Cursor、二跳 Link 或完整 Search SLO。

以上未实现项分别属于 G2-03-08～13，不能由本 Evidence 外推。

## 5. 可重复 Gate

```bash
npm run test:query-compiler
npm run test:materialization-clean-room
npm run check:g2-03-07-evidence
npm run verify
```

`g2-03-07-query-evidence` 必须在 `materialization-clean-room` 后运行，读取同次真实 PostgreSQL 制品。Preflight 明确跳过二者，不能生成 G2-03-07 完成资格；只有 Full Gate 才能生成 `g2-03-07-evidence-manifest.json`。

## 6. 下一步

G2-03-07 PASS 后只放行 G2-03-08：实现真实 Release/Activation Execution Context Resolver、Query Lease、策略感知 Runtime Metadata 与公共 Object Get Application Use Case。不得直接跳到 Search/Cursor、HTTP 产品面或 UI。
