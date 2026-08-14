# Red-Team：G2-01-12 Clean-room Metadata 总验收

- 日期：2026-08-15
- 审查对象：空库迁移、OIDC/HTTP/PostgreSQL 连续链路、Release/Package 故障与恢复、Evidence Manifest、G2-01 范围
- 方法：Intended → Enforcement Point → Adversarial Execution → Recoverability → Residual Risk
- 结论：**PASS — G2-01 Metadata Gate 可合并，且只能进入 G2-02 任务包**

## 1. 承重假设与攻击结果

### 1.1 “总闭环”可能只是一组互不相关的单元测试

新 Gate 在一个 Node Test 生命周期内启动空 PostgreSQL、OIDC 和 HTTP Server，后一步使用前一步生成的 Project/Resource/Release/Package/Pointer 身份；中途重启 API 而不重建数据。**CLOSED**。

### 1.2 SQL 故障可能只验证 HTTP 500，没有验证部分发布

故障前读取完整 Candidate/Channel 快照，在 Pointer 更新位置注入真实 PostgreSQL 异常，再对 Release、Revision、Activation、Serving Head 和 Channel 做字节级比较；移除故障后同一 Release 才能成功。**CLOSED**。

### 1.3 Rollback 可能偷换为直接指回旧版

验收要求 Rollback 返回新 Release ID，经 Validate/Stage/Publish 生成新的单调 Channel Sequence，而 Active Package Revision 回到历史 Package Revision。**CLOSED**。

### 1.4 历史不可变可能只验证应用层返回值

验收直接从 PostgreSQL 重读 Published Revision、Release Pins/Manifest 和 Package Manifest/Digest，在 Rollback、进程重启、二次 Migration 之后重新规范化并 Hash。四次组合 SHA-256 必须相同。**CLOSED**。

### 1.5 Resource Binding 可能变成 Project Viewer 的提权通道

攻击用 Project Viewer + Resource Owner 组合执行 Draft 写入，结果仍被拒绝；Editor Publish、错 Audience Token、无权 Resource 枚举和 DB Role 提权也有同次真实链路反例。**CLOSED**。

### 1.6 PASS 文档可能与实际总场景脱节

G2-01 Evidence Policy 固定 12 份 Evidence 和 22 个 Gate。Manifest 还要求 `metadata-clean-room.json.status=PASS`，内嵌场景、安全、Migration、Package/Release 结果和四组历史 Hash；缺失 Artifact 的单元反例必须 FAIL。**CLOSED**。

### 1.7 为了总验收可能偷偷实现下游产品

Foundation Exact Scope 仍拒绝 DB-02、`runtime.object_current`、Action 表和 `apps/web/*.tsx`；新场景只使用零成员 Activation，conditional 改动因 Materialization 缺失而阻断，没有伪造 Snapshot/Generation/Query/Policy Runtime/Action/UI/SDK。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim     | 执行点                                    | 反例/恢复证据                               | 结果 |
| ------------------ | ----------------------------------------- | ------------------------------------------- | ---- |
| 空环境可启动       | 6 个 Migration + pinned PostgreSQL        | 第二次 Migration no-op                      | PASS |
| 真实管理入口       | OIDC → HTTP → Application → PostgreSQL    | invalid audience 在 Principal 前拒绝        | PASS |
| Publish 原子       | PostgreSQL Publish Transaction            | Channel SQL fault 后快照不变                | PASS |
| 兼容性 fail closed | Production Compatibility Engine           | breaking/conditional 不能 Stage             | PASS |
| Package 不部分替换 | Package Change + Release Publish          | breaking upgrade 无 Release/无 Pointer 改变 | PASS |
| Rollback 不改历史  | New Release + historical Package Revision | 新 Release ID/新 Channel Sequence           | PASS |
| 进程无隐藏状态     | Restart API over same DB                  | 重启后历史 Hash 一致                        | PASS |
| Runtime 最小权限   | `api_runtime` grants                      | role escalation/ledger access denied        | PASS |
| 证据不可自封       | 22 gates + nested clean-room artifact     | missing-artifact unit attack                | PASS |
| 范围不漂移         | Foundation Exact Scope                    | DB-02/Runtime/Action/UI counterexamples     | PASS |

## 3. Independent execution 结果

实现 Commit `307ba085244b1c949fab5624867c5acecb94c64d` 在与开发工作树分离的全新 Clone 中完成独立执行，结果如下：

1. 初始 Clone 没有 `.env`、`node_modules`、历史 Generated Artifact 或未跟踪文件；
2. `npm ci` 锁文件安装通过，从空卷执行 `npm run verify` 得到 22/22 Gate、294 Tests、38,888 ms；
3. `metadata-evidence-manifest.json` 为 `PASS / CLEAN_ROOM_PASS / cleanCheckout=true`，Commit 与 Clone Head 精确相等；
4. 总场景为 24 步，PostgreSQL 16.14，Clean-room 历史组合 Hash 在 Rollback/Restart/二次 Migration 前后都为 `sha256:8910a88ffbecad776782d9654086bdf22a8baf98a18dd462da1d5f6c4dc0faed`；
5. 运行后 Git 仍 clean，项目容器为 0，最后 Reset 只删除 `ontos-g2-local` 的 3 个测试卷。

独立性来自无本机工作树状态的新 Clone 和可重放机器证据，不宣称有另一名人类 Reviewer。最终 PR Head 还必须由 GitHub `Foundation Gate` 在远端 clean checkout 用同一 `npm run verify` 复核；该 Required Check 不通过就不合并。

## 4. 保留风险

- OIDC Discovery/JWKS Rotation 的生产可用性属于 G2-06/G2-07；
- Principal 发现和邀请的管理 UX 属于 G2-05；
- Backup/PITR/HA 属于 G2-06/G2-07；
- DB-02 只能添加 Materialization 结构，不得重写 G2-01 历史身份。

上述风险均有 Owner 和下一 Gate，不要求扩展 G2-01。独立执行已关闭 11/12 时保留的最后阻断条件；当前结论为 **12/12 PASS**。
