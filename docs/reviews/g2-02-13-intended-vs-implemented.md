# G2-02-13 Intended-vs-Implemented 复审

- 日期：2026-08-17
- 方法：从 PRD/任务包的产品意图反向跟踪到 HTTP、Application、PostgreSQL、Worker、S3 与 CI 的实际路径
- 结论：**PASS**（G2-02-13 无未记录偏差，无 P1/P2 范围偷渡；G2-02-14 义务仍保留）

## 意图与实现对照

| 产品意图                      | 实际实现                                                                                  | 可执行证据                                       | 偏差 |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| 管理用户能从真实 HTTP 进入    | `apps/api` 提供受限 Materialization Admin 路由，复用 OIDC Adapter 和 ManagementAuthorizer | Admin 单测 + OIDC/PostgreSQL 真库测试 + 生产闭环 | 无   |
| 大文件不经过 JSON 管理面      | Session 创建后使用有界字节上传路由，Finalize 对 S3 实体重算 Digest                        | 真实 SeaweedFS Versioning 闭环                   | 无   |
| 身份与数据执行分离            | HTTP 层验 Bearer；Application 只见 Identity/Decision；Worker 不接收用户 Token             | Worker 配置禁止 Bearer/OIDC/Migration/DDL 凭据   | 无   |
| 生产 Worker 真正跑八阶段      | 正式 Composition Root 组合 S3、PG Repository、Base、Quality、Capacity 和 Cutover          | `materialization-production.json` 绑定八阶段顺序 | 无   |
| Staging 不得提前可见          | 数据先进 Attempt-owned Staging，Owner Activate 前 Serving Pointer=0                       | 真库 Staging 可见性测试 + 组合闭环               | 无   |
| DDL 必须隔离                  | Worker 只创建受信 Request，独立 NOINHERIT LOGIN 执行确定 Plan                             | 生产 DDL 真库 Gate                               | 无   |
| 容量必须 fail closed          | 库存不完整时通过窄 SECURITY DEFINER 查询读取并拒绝，未扩大 Worker 表权限                  | Capacity 单测/真库 Smoke + Mutation Guard        | 无   |
| 两个领域不得靠分支实现        | Commerce/Work Management 共用同一 Schema/Mapping/CSV 编译和执行路径                       | Testkit 审计：2 领域/6 成员                      | 无   |
| 历史 Gate 不得被新脚本绕过    | 单一 `npm run verify` 顺序执行 G2-00/G2-01/G2-02 共 31 Gate                               | 同一 Report/Manifest 验证 Gate 恰好一次 PASS     | 无   |
| 只实现 Materialization Kernel | Baseline Diff 白名单 + Query/Policy/Action/Overlay/UI/SDK 黑名单                          | Scope Mutation 加入 Query 路径后必定 FAIL        | 无   |

## 实现中发现并关闭的偏差

1. 生产阶段执行器首版没有等待部分异步 Repository 返回，可把未完成工作误记为阶段成功；已统一 `await` 并保留错误分类。
2. Worker 最小权限无法直接读容量内部表；没有扩权，而是增加窄的 SECURITY DEFINER 查询函数并锁定 `search_path`。
3. Activation 是不可变事实，首版 Publish 却使用了 `FOR SHARE`，导致 API 需要不应有的 UPDATE 权；已去掉无意义行锁，不放宽权限。
4. SQL 边界返回的 Member Key 类型与 TypeScript 合同不一致；已在 SQL 边界显式 `::text`，没有在上层容错掩盖。
5. 仅有分散真库测试不能证明组合根可用；已增加同一场景的 PG/S3/OIDC/API/Worker/DDL 八阶段闭环。

## 保留差距（不是 G2-02-13 偏差）

- 100k Object / 1m Link 目前有真库容量证据和稳定流式 Fixture，但尚未在全新环境中走完 HTTP/S3/Worker 的单场景总时间；属于 G2-02-14。
- 整个进程/容器组重启、Migration no-op 和状态 Hash 不变属于 G2-02-14。
- W0/W1 已有对抗 Port，生产仍只接受 zero-overlay；真实 Overlay 集成属于 G2-04。

本复审没有用“已有类/函数”代替可执行路径，也没有把后续 Gate 义务提前标 PASS。
