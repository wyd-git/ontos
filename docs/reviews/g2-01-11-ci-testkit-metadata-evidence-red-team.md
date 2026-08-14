# Red-Team：G2-01-11 统一 CI、Testkit 与 Metadata Evidence

- 日期：2026-08-15
- 审查对象：统一 Gate、Foundation 范围、负向 Fixture、两 Package Provenance、报告与 Evidence Manifest
- 方法：Intended → Enforcement Point → Adversarial Fixture → Residual Risk
- 结论：**Go for G2-01-12**；删除 Foundation 防线、把 API 测试藏入总数、用说明文字代替负测、漂移 Fixture 和修改历史 Evidence 伪造通过均已被可执行检查关闭。

## 1. 承重假设与攻击结果

### 1.1 “支持 Metadata”可能被实现成删除 Foundation 精确范围

实际策略仍对 Workspace、Migration 和表做精确集合比较，只新增已实现的 Metadata/Package/API 范围。DB-02 Migration、Runtime Object 表、Action 表和 UI 反例均失败。**CLOSED**。

### 1.2 API/OIDC 可能只因被普通 Unit 或 DB Suite 顺带执行而显得存在

Admin API Unit 与真实 OIDC/HTTP/PostgreSQL 是两个独立 Gate；普通 Metadata PostgreSQL Suite 也独立。报告缺任一命名 Gate 都不能生成 PASS Manifest。**CLOSED**。

### 1.3 “有负向测试”的文字清单可能与真实代码脱节

机器 Catalog 固定 7 个 ID、Source、唯一 Marker 和执行类别；审计器验证精确 ID 集、Source 内容和 `package.json` 路由。Catalog 自身有缺 Case/缺 Marker 反例。**CLOSED**。

### 1.4 两个领域 Fixture 可能手工维护、悄悄带入下游能力或丢失 G1 来源

确定性 Builder 重新生成两份语义 JSON，生产 Package Parser/Integrity 再验；Provenance 绑定 G1 Source/Target Hash，测试拒绝 Action、Policy、View、Migration、Raw SQL 和 Secret。Compatibility Vector 单独绑定。**CLOSED**。

### 1.5 新 Gate 可能依赖可任意修改的旧 PASS 文档

G2-01 Policy 固定全部 13 份 G2-00 Evidence 的字节 SHA-256；修改内容即使仍写着 PASS 也会失败。单元攻击已证明。**CLOSED**。

### 1.6 脏工作树报告可能被描述成 clean-room

Manifest 同时要求 Report/Acceptance/Gate 全绿并读取 Git Dirty；Dirty 只能得到 `WORKTREE_PASS`。G2-01-12 将在独立 Clone 验证 `CLEAN_ROOM_PASS` 和 Commit 相等。**CLOSED for classification；clean-room execution belongs to 12**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim           | 精确执行点                            | 反例/证据                           | 结果 |
| ------------------------ | ------------------------------------- | ----------------------------------- | ---- |
| 保留全部 Foundation Gate | `tools/ci/run.ts` 原 Gate + 新 Gate   | 21 名称受 Policy 固定               | PASS |
| 新范围不开放下游模块     | Foundation Exact Sets                 | DB-02/Runtime/Action/UI 反例        | PASS |
| 七类风险能真正阻断       | Negative Catalog + Test Marker        | 缺 Case/Marker/Routing 失败         | PASS |
| 两领域输入可重建         | Metadata Fixture Builder + Provenance | Source/Target/Digest 漂移失败       | PASS |
| 报告可追溯               | Commit/Env/PG/Input Hash/Test Count   | 缺 Gate 或坏 Digest 失败            | PASS |
| 历史不能被改写           | Protected G2-00 SHA-256               | 修改旧 Evidence 失败                | PASS |
| 本地/远端不分叉          | Workflow 唯一 `npm run verify`        | Required Check 仍为 Foundation Gate | PASS |

## 3. 尚未关闭的边界

- 当前正向场景分布在多个真实测试，G2-01-12 必须增加一个从空库经真实 HTTP 连续执行的总场景；
- G2-01-12 必须证明重启、Rollback 和第二次 Migration 前后 Published Revision/Release/Package Hash 不变；
- 独立 Reviewer 仍须从干净 Clone 复核 Scope、Manifest 和 Intended-vs-Implemented，而不是引用本工作树报告；
- 生产 OIDC 可用性、备份/PITR、HA 和 DB-02 Materialization 不因 CI 变强而自动完成。

因此结论是 **Go for G2-01-12**，不是 G2-01 总 PASS。最后一步若无法形成真实 HTTP 总场景或干净 Clone Manifest，必须停止在 11/12，不能靠汇总文档宣布完成。
