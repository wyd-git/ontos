# G2-03-07 Intended vs Implemented Review

- Review：G2-03-07 typed Query AST 与参数化 PostgreSQL Compiler
- 日期：2026-08-20
- 方法：以冻结任务包、Runtime Read Contract、ADR-020/021/024/025 为意图源，逐项对照生产代码、单元测试和真实 PostgreSQL 机器证据
- 结论：**PASS**

## 1. 意图源

本次审查不从实现反推需求，承重意图按以下优先级读取：

1. `docs/delivery/g2-03-query-policy-task-pack.md` 的 G2-03-07 Why/What/Acceptance；
2. `docs/architecture/g2-03-runtime-read-contract.md` 的 AST、错误、Property 与 Query 上限；
3. ADR-020 的 Policy-in-SQL、Execution Context 和消费者边界；
4. ADR-021/024 的持久事实、Policy Gateway 与撤权边界；
5. ADR-025 对本 Gate 的包责任、SQL、资源和范围冻结。

## 2. 逐项差距审查

| 冻结意图                                      | 实际实现                                                                                                | 证据                                              | 结论 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---- |
| AST/合同上限在 SQL 前拒绝                     | Contract Parser 后才建立 typed logical plan；未知字段、类型欺骗、深度/数量/文本上限均 fail closed       | Parser 负测、复杂度超限测试                       | PASS |
| 复用公共 Value Codec                          | Integer/Decimal/Date/Timestamp/Enum/Boolean/String/String Array 走 `@ontos/value-codec`                 | Value Canonicalization 与主键测试                 | PASS |
| 客户值不拼 SQL                                | 固定 Renderer 只把客户值、Policy 常量、ID、Limit 和 Mask Display 放入 `$n` 参数                         | 注入向量、Statement 参数类型和真实性品牌测试      | PASS |
| Client + Policy 同 SQL、先于 Sort/Limit/Count | Object/Link Row Policy、Property Guard、Client Predicate 都进入 `WHERE`                                 | Renderer 结构断言与真实 SQL Shape                 | PASS |
| Property allow/mask/deny 不泄露               | Filter/Sort/Search 必须 `canEverAllow`，mask/deny 不能参与；Projection 原值只在 allow CASE              | masked Property 读/查负测                         | PASS |
| Query Hash 规范且语义敏感                     | 规范 AST、绑定、Select/Sort/Page 进入 Hash；可交换顺序稳定，操作变化改变                                | Hash 等价/非等价向量                              | PASS |
| Timeout/Row/Byte/Complexity/Abort 可回收      | 只读事务、本地 Timeout、Row/Byte 检查、Abort 销毁连接、不自动重试                                       | Fake Pool 资源测试 + PostgreSQL Timeout/Pool 恢复 | PASS |
| 固定 Get/List/Policy/Count/Link 候选使用索引  | 100k Object/1m Link clean-room 的 5 个 SQL 均无 Current 顺序扫描；List/Policy/Count 命中 Published Plan | `g2-03-07-query-compiler.json`                    | PASS |
| 不运行 G1 生产代码                            | 三个 Query 包无 `spikes/g1` Import；G1 仅作为制品 Provenance                                            | Source Scan 与机器制品字段                        | PASS |

## 3. 发现并关闭的实现偏差

- 原单元集没有显式把加权复杂度推过上限；已增加大量 `link_exists` 的稳定拒绝测试；
- 原单元集覆盖 one-hop 产品候选的三代绑定，但未单独证明 Policy `link_exists` 的精确 Link/Target Revision 与 Generation；已增加 Renderer 绑定测试；
- Evidence 现在不仅相信布尔 `PASS`，还检查 5 个场景唯一出现、每个计划有索引、Current 顺序扫描为 0、指定场景命中 Published Index、Timeout 后无后台 SQL；
- 历史 G2-00/G2-02/G2-03-01～06 Scope 已前向接纳三个新生产包和本 Gate 证据文件，避免旧 Gate 在 Full CI 中把合法前向实现误判为越界。
- 首次 Ready PR 暴露出 clean checkout 在 `npm ci` 前静态加载 Query Evidence、因工作区包尚未链接而启动失败；Runner 已改为在 `lockfile-install` 后动态加载，并增加 Bootstrap Boundary 回归测试。该失败发生在产品 Gate 执行前，不是 Query 实现失败。

没有发现需要修改 0001～0027、绕过 Policy Gateway、在 Route 拼 SQL或提前建设 UI 的阻断性偏差。

## 4. 明确保留的差距

以下是计划内后续，不是本 Gate 的隐藏完成项：

- G2-03-08：真实 Execution Context Resolver、Query Lease、Runtime Metadata、公共 Object Get；
- G2-03-09：完整 Search/Count、签名 Cursor、10k/100k 查询性能资格；
- G2-03-10：Link 一/二跳正式用例；
- G2-03-11～13：统一 Runtime Read Application Port、HTTP/Generated Client 与只读 Web；
- G2-03-14：并发 Cutover/撤权/GC/Endurance 总压测。

特别说明：本 Gate 的 clean-room 使用 100k Object/1m Link 数据证明 SQL Shape 和索引可用，但不把这一点夸大为 G2-03-09 的分页、Cursor、Unicode Search 或完整 SLO 已关闭。

## 5. 放行结论

G2-03-07 的承重需求均有生产实现和可重复证据，停止条件未触发。放行 **G2-03-08 only**；仍禁止直接进入 Runtime HTTP、Search/Cursor 完成态或产品 UI。
