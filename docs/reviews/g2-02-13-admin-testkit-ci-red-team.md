# G2-02-13 Admin / Testkit / CI Red Team

- 日期：2026-08-17
- 方法：钢人化产品闭环主张，再按影响 × 可能性 × 最低验证成本排序攻击
- 结论：**PASS**（G2-02-13 未发现未关闭 P1/P2；仅放行 G2-02-14 clean-room 总验收）

## Top Kill-Assumptions

### 1. 八阶段“返回了 Promise”不等于真的完成

- **Claim：** Worker 只有在阶段数据与 Checkpoint 真正落库后才推进。
- **Fails if：** Stage Executor 漏 `await`，未拒绝的 Promise 被当成成功。
- **Evidence：** 生产组合根已修正所有异步阶段；真实 Job 必须以固定顺序产生 8 个 Completed Stage，少一个则 Evidence FAIL。
- **状态：CLOSED（实际发现并返工）。**

### 2. HTTP 身份可能泄漏到 Application 或 Worker

- **Claim：** 只有 API Adapter 处理 Bearer/JWKS，下游仅见 Foundation Identity 与授权结果。
- **Fails if：** Worker 环境接受 Bearer/OIDC Secret，或 Application 用原始 Claim 自行推导权限。
- **Evidence：** Worker 配置对 Bearer、OIDC Client Secret、Migration/DDL URL fail closed；真 OIDC 与角色/跨 Project 负测试已进入统一 Gate。
- **状态：CLOSED。**

### 3. 分散组件通过可能掩盖组合根不可用

- **Claim：** 从 OIDC 到 Serving Head 是一条可运行路径。
- **Fails if：** API、S3、Worker、DDL 与 PostgreSQL 各自通过，但凭据/类型/事务接缝不匹配。
- **Evidence：** 同一测试起真 PostgreSQL 16、版本化 S3、OIDC、Admin Runtime、生产 Worker 和独立 DDL LOGIN，在 Owner Activate 前确认 Pointer=0，最后 Publish/Serving 成功。
- **状态：CLOSED。**

### 4. 最小权限可能被“为了跑通”暗中放宽

- **Claim：** API/Worker 在窄角色下完成闭环，DDL 仍隔离。
- **Fails if：** 给 Worker 直接表权限，给 API UPDATE 不可变 Activation，或复用 Migration Owner。
- **Evidence：** 容量读取通过窄 SECURITY DEFINER 函数；Publish 移除不需要的行锁；DDL 使用 NOINHERIT 专用 LOGIN。权限矩阵反向尝试表写入、Pointer 写入与 Role 提升均失败。
- **状态：CLOSED（实际发现并返工）。**

### 5. 大上传与错误响应可能穿透信任边界

- **Claim：** 大文件不进 JSON，错误不暴露内部定位信息。
- **Fails if：** 未知字段/深嵌套绕过限制，或 SQL/Object Key/PK/原始行进入 Envelope。
- **Evidence：** Body/字符串/数组/深度的边界值和超限值均有路由测试；字节上传独立；生产错误映射和敏感词负测试已执行。
- **状态：CLOSED。**

### 6. Testkit 可能只是另一套手写 Demo

- **Claim：** 两领域 Fixture 走正式 Parser/Compiler，大数据可复现且不撑爆磁盘。
- **Fails if：** 为领域写分支，或提交 1m 行固定文件而不验证生成语义。
- **Evidence：** 6 个 Member 逐一走正式 Mapping Compiler/CSV Scanner；100k/1m 按稳定算法流式计算 Digest，不写大文件；Provenance 绑定源文件 Hash。
- **状态：CLOSED。**

### 7. 新 Gate 可能绕过旧 Gate 或偷实现 Query

- **Claim：** 只有一个统一入口，范围可机器拒绝。
- **Fails if：** Materialization 专用脚本不跑 Foundation/Metadata，或在同一 PR 中引入 Query/Policy/Action/Overlay/UI/SDK。
- **Evidence：** `npm run verify` 固定 31 Gate；G2-02-12 baseline diff 白名单和禁止前缀同时检查；Scope 测试故意加入 `packages/query/` 即 FAIL。
- **状态：CLOSED。**

## 仍未评估（明确属于后续 Gate）

- 全新 Clone/空卷的单命令总验收、整体重启和状态 Hash：G2-02-14。
- 100k Object / 1m Link 的 HTTP/S3/Worker 端到端 <30 分钟与 20 次 Cutover 分布：G2-02-14。
- 真实 PostgreSQL Overlay Store 和 AC-03：G2-04；当前生产只允许受信 zero-overlay。

## 决策

所有 G2-02-13 承重假设都有正式路径、真实依赖或机器范围证据；发现的异步未等待、权限过度需求和组合根缺口均已关闭。放行 **G2-02-14 clean-room Materialization 总验收**，不放行 Query、Policy、Action、Overlay 或 UI。
