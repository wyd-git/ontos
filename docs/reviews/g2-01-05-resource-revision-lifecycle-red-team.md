# Red-Team：G2-01-05 Resource 与 Draft Revision 生命周期

- 日期：2026-08-14
- 审查对象：Resource/Revision Domain、Application Use Case、PostgreSQL Repository、`0003` 向前加固与真实并发 Integration
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-06**；G2-01-05 范围内的身份、并发、历史不可变和归档偏差已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 Published Revision 后仍可追加 Dependency

攻击者可利用 `api_runtime` 的 Dependency INSERT 权，在 Source Revision 已 Published 后新增边。受害者是依赖 Release Pin 解释固定闭包的 Runtime/SDK：Revision Content/Hash 不变，但其依赖语义被改写。原 `0002` 只阻止 Dependency UPDATE/DELETE/TRUNCATE，没阻止后续 INSERT。新 `0003` Trigger 在 INSERT 时锁定 Source Revision，仅允许 Draft；与 Publish 并发时两者串行，Publish 先提交则 INSERT 稳定失败。**CLOSED**。

### 1.2 Revision Number 转成文本后意外参与 ORDER BY

Repository 为避免 JavaScript 数值精度丢失，在 SELECT 中输出 `revision_number::text`。SQL `ORDER BY revision_number` 优先解析为这个文本输出别名，产生 `1, 10, 100...` 顺序，Keyset 边界重复。limit=17 的真实 101 行测试直接抓到 106 个返回项。现在 `ORDER BY revision.revision_number, revision.revision_id` 显式使用原始 `bigint` 列，逐页结果恢复 1..101 且无重复。**CLOSED**。

### 1.3 Archived Resource 下的旧 Draft 仍可 Patch

如果只校验 Revision=`draft`，Resource Archive 之前已存在的 Draft 仍能改写，与“归档只保留历史”冲突。现在 Patch、Child Draft 和向 Validated/Published 前移均先锁 Resource、后锁 Revision，要求 Resource Active；`0003` UPDATE Trigger 同时阻止绕过 Repository 的 Draft 改写。Repository 与直接 SQL 负测均通过。**CLOSED**。

### 1.4 Adapter 若盲信上游 Canonical Preimage 会存下错配 Hash

Application 会产生规范内容，但 Port 仍可被其他组合代码调用。Adapter 现在重新运行 Family Parser 和 Canonicalizer，并比对上游 Preimage；回读时再次从 JSONB 重算 SHA-256 并与存储 Digest 比对。调用者不能通过伪造 Digest/Preimage 让内容与 Hash 分离。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                                           | 精确执行点                                                                                | 反例测试                                                                                | 结果 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| Resource 长期身份稳定，Archive 不释放名称                | DB `(project_id, namespace, api_name)` UQ；Resource 身份字段 UPDATE Trigger 不可变        | Archive 后同 Namespace/API Name 创建返回 `ALREADY_EXISTS`                               | PASS |
| 客户不能指定 Resource/Revision/Author/Digest             | Application 严格 Command 不包含这些字段；UUID/Actor/Hash 仅在可信层生成                   | 额外 `resourceId` 被拒绝；初始与子 Draft Author 等于已验证 Principal                    | PASS |
| Resource + Initial Draft 全有或全无                      | 两个 INSERT 同一 PostgreSQL 事务                                                          | Revision PK 故意冲突后 Resource 行数为 0                                                | PASS |
| Draft Patch 必须命中 Etag，不覆盖并发写                  | Resource→Revision `FOR UPDATE`；锁内比对 Etag，实际变更精确 `+1`                          | 100 路同 Etag：1 success / 99 `CONCURRENT_MODIFICATION`，最终 Etag=2                    | PASS |
| 内容 Hash 不受 JSON Key 顺序影响                         | 严格 Family Parser → Canonical JSON → Adapter SHA-256；回读重算                           | 100 轮属性测试；不同 Resource 的逆序 Key 内容 Digest 相同                               | PASS |
| Validated/Published/Deprecated 编辑只产生子 Draft        | Domain 父状态守卫；DB Insert Trigger 要求 Parent 已存在、可编辑、序号更早                 | 三种父状态均创建新 Draft；原 Published 对象回读不变；Archived 父拒绝                    | PASS |
| Published Content/Hash/Parent/Author/Dependencies 不可变 | Application 无 Published Patch；DB 列权限+事实 Trigger+Dependency Insert Trigger          | Published Patch，Parent/Author SQL UPDATE，Published Dependency INSERT 分别返回稳定拒绝 | PASS |
| 父链无环且并发序号不丢失                                 | Resource 行串行分配 `MAX(revision_number)+1`；Parent 只可指向已存在的更小序号且后续不可改 | 100 并发 Child 得到 100 唯一 ID/序号；101 行完整；全部 Parent 指向根 Revision           | PASS |
| 列表不依赖数据库自然顺序                                 | Resource 使用 C Collation 复合 Keyset；Revision 使用原始 bigint + UUID Keyset             | limit=1/17 逐页读取；对“文本别名排序”回归用例无重复/遗漏                                | PASS |

## 3. What I Couldn't Assess

- G2-01-06 尚未实现服务器 Dependency Extractor、实际 Validation Report 与图闭包；本次只证明一旦 Dependency 在 Draft 期插入，后续不能被改写或追加。
- G2-01-08 尚未把 Validated→Published 放入 Release Publish 原子事务；本次只提供且测试前向 Repository 状态边界，不宣称 Release 可发布。
- G2-01-10 尚未实现 HTTP `If-Match`、Cursor 签名/编码、请求体定额和 Error Envelope；当前验收点是其下方的 Application/Repository。
- 100 路并发是 PostgreSQL 16 本机容器的正确性证明，不是吞吐量、多 AZ、连接代理或生产容量基准。
- Keyset 顺序是确定的，但多页读取未绑定长事务 Snapshot；并发插入在 Cursor 之后的记录可出现在后续页。
