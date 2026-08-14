# G2-01-08 Release Lifecycle 验收记录

- 结论：**PASS（仅限 G2-01-08 Release Validate / Stage / Publish / Rollback）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-08-release-lifecycle`
- 起始 Commit：`7b6cd500ca20021d094a82ffb99887081f3b4b5c`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-08 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-08实现-release-validatestagepublish-与-rollback)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain` 新增完整 Release Gate：项目一致、Pin/Revision/Digest/Validation Report 一致、Dependency Closure、服务器 Published Baseline Compatibility 和稳定有界 Issue；
- `@ontos/metadata-application` 新增严格的 Create、Validate、Stage、Publish、Rollback Use Case；身份仍是闭合的 Verified Foundation Identity，Editor 可准备 Release，只有 Owner 的 `release.publish` 可激活；
- `@ontos/metadata-postgres` 新增正式 Release Store：服务器生成 Manifest/Digest、分配安全 Release Number、保存 Release Validation Report、Stage 封存 Channel CAS、原子创建零成员 Activation、切换 Serving Head/Channel、发布 Pin Revision、递增 Project Sequence/Epoch；
- `0005_release_lifecycle_guards.sql` 在不增加第 19 张业务表的前提下增加 Stage CAS 事实、状态/报告守卫、Activation/Channel/Serving Head 一致性 Constraint Trigger 和最小列级权限；
- Rollback 复制历史 Pins 创建新 Release Draft，再走同一 Validate/Stage/Publish 路径；不会倒拨 Channel、修改旧 Release/Pin/Revision 或复用旧 Activation；
- Foundation `ReleaseBinding` 由真实数据库事实构造并再次经过 Parser。DB-01 中一个不可变 Release 行就是一个 Release Revision 事实，因此 `releaseRevisionId = releaseId` 是显式一对一映射，不是读取“最新 Revision”的占位值。

Release Pins 在 Draft 创建事务中一次性写入且随后数据库不可变，强于“Stage 后封存”的最低要求；修订 Pin 集需要创建新 Release Draft。Stage 仍负责封存 Validation Context、目标 Channel 的旧 Release/Activation/Control Sequence 和 Manifest 证据。

## 2. 原子 Publish 写入与锁序

正式 Repository 固定使用：

```text
Project Control + Authorization Epoch
  → Project/Channel advisory domain
  → Channel row (if present)
  → Release
  → Pins + pinned Resource/Revision rows
  → Serving Head
```

Publish 事务内没有 HTTP、OIDC、S3、Worker、Materializer 或其他网络调用。通过全部重验后，在同一个 PostgreSQL 事务中：

1. 创建 `member_count = 0` 的不可变 Runtime Activation；
2. 插入该 Release 的 Serving Head；
3. 把仍为 Validated 的 pinned Revisions 前移到 Published；
4. 发布 Candidate Release，并把旧 Channel Release 前移到 Superseded；
5. 对 Channel 做预期旧 Pointer / Control Sequence CAS；
6. 递增 Project Publication Sequence；
7. 递增 Authorization Epoch；
8. 返回由实际 Release、Activation 和 Manifest Digest 构造的 Release Binding。

相同已发布 Release 的提交重试在任何序号检查前读取并返回原 Binding，不重复增加 Activation、Channel Sequence、Project Sequence 或 Epoch；但事务内仍重新确认调用 Principal 当前是 Active Project Owner。

## 3. 故障、并发与历史证据

真实 PostgreSQL 16 Integration 对七个 SQL 边界逐一抛出故障：

```text
after_activation
after_serving_head
after_revisions
after_release
after_channel
after_project
after_epoch
```

每次故障后都逐字段比较事务前后快照：旧 Channel Release/Activation/Sequence、Project Publication Sequence、Authorization Epoch 完全不变；Candidate 保持 READY；pinned Revision 保持 VALIDATED；Pin 数量不变；Candidate Activation 与 Serving Head 均为零。数据库 Deferred Constraint 另行拒绝脱离 Publish 事务提交的孤儿 Activation。

两个 READY Release 在同一旧 Channel Sequence 上并发 Publish，只有一个成功；另一个稳定返回 `CONCURRENT_MODIFICATION`。另一个 Channel 发布同一 Candidate Revision 后，即使目标 Channel 未移动，Project Sequence/Revision State 改变也会让旧 Stage Context 失效，Publish 不会只凭历史成功报告放行。

Rollback 验证新 Release ID、Manifest、Activation 和 Channel Sequence；历史 Release Manifest Digest、Pin 的 Resource/Revision/Family/Digest/Order 及其状态快照在 Rollback 前后逐字段相同。

## 4. Intended-vs-Implemented 审查后修正

- 初始表没有记录 Stage 面向哪个 Channel 及其旧 Pointer，无法证明并发 CAS；新增 `target_channel_name` 与封存的 Release/Activation/Control Sequence；
- 初版 Publish 只检查“Stage 报告存在”，未证明 Revision 状态或其他 Channel Publish 后上下文仍相同；现在重新计算完整 Context Digest，并绑定 Project Publication Sequence；
- Application 授权与事务之间存在撤权竞态；Publish 在锁住 Authorization Epoch 后再次确认 Active Project Owner，合法撤权与发布形成确定串行顺序；
- 公开 Report 最多 1,000 项；Gate 现在稳定截断并保留同严重度 Summary，不能因大 Pin 集导致 Parser/Store 失败或丢掉阻断结论；
- Channel Pointer 可以被直接更新而忘记 Supersede 旧 Release；数据库 Channel Guard 现在要求旧 Release 在同一事务最终为 Superseded；
- Foundation 同时要求 Release/Release Revision ID，而 DB-01 只有一个不可变 Release 版本事实；本 Gate 明确并测试一对一映射，不伪造第二个未持久化 ID。

详细矩阵见 [G2-01-08 Red-Team](../reviews/g2-01-08-release-lifecycle-red-team.md)。

## 5. 可复现执行

```text
npm run test:unit
Release Domain/Application tests, including 512-Pin bounded-report case: PASS

npm run test:database
PostgreSQL 16.14
3 top-level integrations / 3 pass / 0 fail
DB-01 migration + G2-01-04～07 + G2-01-08 Release path: PASS
intentional.role_escalation=blocked
```

全仓 `npm run verify` 和远端 Foundation Gate 结果在 PR Check 绑定最终 Head Commit 后记录。

### 全仓 Gate

```text
Foundation Gate: PASS — 16/16
unit:                  267/267
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 30 source files
scope evidence:        PASS — 5 DB migrations / 21 evidence records / no app or UI
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 3/3 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

本地报告在提交前运行，因此 Commit 字段仍是起始 Commit；最终实现 Commit 与远端 Gate 由 PR Head/Check 绑定。

## 6. 审查后边界

- Package Installation Change 与 Release Publish 的同事务 Pointer 切换属于 G2-01-09；当前 Release Store 没有假装激活 Package；
- 真实 HTTP/OIDC、Body 限制、ETag/Error Mapping 属于 G2-01-10；当前交付的是受统一 Authorizer 保护的 Application/Repository，而不是公开网络入口；
- DB-01 Activation 必须是零成员；Generation/Snapshot/Runtime Member 属于 DB-02，不创建假数据；
- Rollback 仍执行当前完整 Compatibility Gate；若历史版本相对当前版本为 Breaking/Conditional，它会被阻断，而不是用“回滚”名称绕过兼容与迁移要求；
- 当前 G2-01 进度为 **8/12**；下一工作项是 G2-01-09，剩余 **4 项**。
