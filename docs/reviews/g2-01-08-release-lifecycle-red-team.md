# Red-Team：G2-01-08 Release Lifecycle

- 日期：2026-08-15
- 审查对象：Release Gate、Manifest、Stage CAS、PostgreSQL Publish、零成员 Activation、Rollback 与 Foundation Binding
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-09**；G2-01-08 范围内的客户端基线替换、Stage 后事实漂移、部分发布、同 Channel Lost Update、授权撤销竞态、孤儿 Activation 和历史回写已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 没有封存目标 Channel 的旧 Pointer，Stage 报告无法成为发布计划

原始 `releases` 表只有 Project、Manifest 和 State；若 Publish 才接收任意 Channel，Compatibility 的 Published Baseline 与真正切换的 Channel 可能不同，两个 READY Release 也没有受信旧 Pointer 做 CAS。增量 Migration 现在保存固定 `target_channel_name`、Stage 时的旧 Release/Activation/Control Sequence 和 Validation Context Digest。首发用明确的 `0 + NULL Pointer`，后续发布必须逐字段相同。**CLOSED**。

### 1.2 “成功报告存在”不等于 Publish 时事实仍与 Stage 相同

初版 Publish 能检查报告 Digest 与 Pin 当前仍可复用，但另一个 Channel 可能把同一 Revision 从 Validated 前移到 Published，或其他 Project Publish 改变控制世界；历史报告仍存在。现在 Stage Context 包含 Project Publication Sequence、Channel Pointer、Pin/Revision/Resource 状态、Digest、当前 Revision Report、Dependency Edge、Baseline Pins 与 Compatibility 结论。Publish 锁住相关行后重新计算，必须与封存 Digest 完全相同。跨 Channel 反例稳定冲突。**CLOSED**。

### 1.3 Application 授权通过后、事务开始前可以并发撤销 Owner

只在 Application 调用异步 Authorizer 会形成 TOCTOU：撤权事务可能在检查后提交，旧 Owner 随后仍发布。Publish Repository 先锁 Project Control 与 Authorization Epoch，再从受信 Principal/Role Binding 事实确认 Active Project Owner。合法 Role 变更同样先锁 Epoch，因此只有“发布先提交”或“撤权先提交并拒绝发布”两种完整顺序。Editor 即使绕过 Application 直接调用 Store 也被拒绝。**CLOSED**。

### 1.4 逐步 SQL 看起来正确，但任一中间异常可能留下撕裂世界

真实 `api_runtime` 连接在一个短事务内执行 Activation、Serving Head、Revision、Release、Channel、Project 和 Epoch 写入。七个边界逐一抛错并比较提交前后快照；所有 Candidate 写入回滚，旧 Channel/Serving 世界不变。Deferred Constraint Trigger 额外拒绝独立提交的孤儿 Activation，并要求 Published Release、Head 和 Channel 最终一致。**CLOSED**。

### 1.5 Channel 更新可以绕过旧 Release Supersede

只验证新 Channel 指向 Published Release，会允许直接把 Pointer 移走而让旧 Release 仍标记 Published。Channel Update Guard 现在在最终事务状态中要求旧 Release 已 Superseded；Serving Head 和历史 Activation 保留不变。**CLOSED**。

### 1.6 大 Pin 集可能产生超过合同上限的 Finding/Issue

公开 Validation/Compatibility Report 各最多 1,000 项。未做边界处理时，合法的 512-Pin 候选可能让 Parser 抛错而没有稳定 Gate 结论。实现现在先用完整 Finding 决定严重度，再输出最多 999 个稳定明细和一个同严重度 Truncation Summary；512-Pin 多错误场景保持 `valid=false` 且严格为 1,000 Issues。**CLOSED**。

### 1.7 Release Binding 的 Release Revision ID 没有第二张持久表

DB-01 的 Release 行本身已经是带 Pin Manifest 的不可变版本事实；再生成一个未持久化 UUID会制造伪事实。当前明确采用一对一映射 `releaseRevisionId = releaseId`，Binding 仍同时携带两个语义字段并经过 Foundation Parser；后续如引入稳定 Release Container，必须用 ADR/新 Migration 改成真实二层身份，不能静默改变。**CLOSED for DB-01**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                             | 精确执行点                                          | 反例测试                                                      | 结果 |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------- | ---- |
| Pin 集项目一致、已验证、Digest/Report 精确 | Release Gate + Pin insert/update guards             | Cross Project、非 reusable state、Digest/Report mismatch      | PASS |
| Pin 集依赖闭合                             | Candidate exact Revision closure                    | pinned Link 缺 exact target Revision                          | PASS |
| Baseline 由服务器当前 Channel 选择         | locked Channel → Published Release Pins             | Application 命令无 baseline/content/finding 输入              | PASS |
| Stage 后事实变化不能发布                   | sealed Context Digest + publish-time recomputation  | 跨 Channel 发布改变 Revision/Project Sequence                 | PASS |
| Publish 无部分提交                         | one PostgreSQL transaction + seven fault points     | 每个 SQL 边界抛错后逐字段快照相同                             | PASS |
| 同 Channel 并发只有一个成功                | Project lock + Channel advisory lock/row lock + CAS | 两个 READY Release 使用同一旧 Sequence                        | PASS |
| 相同 Publish 重试幂等                      | published/current Binding fast path                 | 原 expected Sequence 重试不增加任何 Sequence/Activation       | PASS |
| 撤权与发布无 TOCTOU                        | locked Epoch + transactional Active Owner recheck   | Editor direct Store 调用；授权检查后事务内复核                | PASS |
| DB-01 不伪造 Runtime Member                | Activation `member_count = 0` DB Check              | 非零成员与孤儿 Activation 均失败                              | PASS |
| Rollback 只向前增加事实                    | copy historical Pins → new Draft → normal publish   | 新 ID/Manifest/Activation；历史 Digest/Pin/Revision 不变      | PASS |
| Binding 返回实际事实                       | DB row/head → `parseReleaseBinding`                 | Release/Revision 一对一、Activation/Digest 与数据库逐字段相同 | PASS |
| 报告容量不改变阻断结论                     | full evaluation + bounded public envelope           | 512 Pins / >1,000 Issues                                      | PASS |

## 3. What I Couldn't Assess

- G2-01-09 尚未把 Package Installation/Change/Package Revision Pointer 纳入同一个 Release Publish 事务；当前故障矩阵不宣称 Package 已原子激活。
- G2-01-10 尚未提供真实 HTTP/OIDC 入口、请求体限制、If-Match 和 Error Envelope；Application 身份边界不等于网络入口完成。
- G2-02 才会引入非零 Runtime Member、Generation、Snapshot 与 Refresh；本次只证明真实的 metadata-only A0。
- 本次用 PostgreSQL 行锁与 512-Pin 合同边界验证正确性，没有形成大 Package 的延迟 SLO；Package 展开与性能由 G2-01-09/12 补证。
- Rollback 不绕过当前 Compatibility Gate；紧急 Breaking Rollback 是否需要显式受审批准，是未来产品策略，不在本 Gate 自行放宽。
