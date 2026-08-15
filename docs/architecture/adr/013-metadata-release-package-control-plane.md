# ADR-013：Metadata、Release、Package 与管理授权控制面

- 状态：Accepted for G2-01-01
- 实现状态：G2-01-03～12 已完成 DB-01、Project/RBAC、Resource Revision、Definition/Dependency/Compatibility、Release/Package Lifecycle、Admin HTTP/OIDC、统一 Gate 与 clean-room 总验收；G2-02-01 已用 ADR-014 扩展锁合同，DB-02 Generation/Snapshot 正式表仍由后续 G2-02 任务拥有
- 日期：2026-08-14
- Owner：Tech Lead / Database / Security
- 决策范围：DB-01 候选表、不可变 Revision/Release/Package 状态、原子 Publish、零成员 Activation、管理 RBAC、锁顺序与向前恢复
- 可执行合同：`tools/metadata-control-plane/`、`tools/runtime-activation/`
- 不在范围：DB-01 Migration、Repository、HTTP/OIDC Adapter、Object Policy、Generation/Snapshot 业务表

## 1. 决策结论

G2-01 使用 PostgreSQL 作为 Metadata 控制面的唯一事实来源。Resource Revision、Release Pin、Published Release、Package Revision、Installation Change、Runtime Activation 和 Role Binding 都保留不可变历史；少量可变记录只承担 Draft 编辑、生命周期或当前 Pointer。

Release Publish 是唯一激活协调点。它在一个无外部调用的短数据库事务中同时完成：

1. 锁定 Project 发布序列、Channel、Release/Pin 和 Serving Head；
2. 重验 READY、Manifest Digest、预期控制序号与候选 Activation；
3. 将 Release 标记 Published，并把旧 Channel Release 标记 Superseded；
4. 写入 Release Serving Head 并切换 Channel；
5. 若由 Package Change 发起，同时把 Pending Change 变 Active、旧 Active Change 变 Superseded，并切换 Installation Active Pointer；
6. 递增 Project Authorization Epoch 和控制序号；
7. 任一步失败整笔回滚。

事务内禁止 S3、OIDC、HTTP、Worker、Materializer、Artifact Registry 或其他网络调用。Stage 必须在事务前取得全部验证结果；Publish 只检查数据库内的不可变引用和状态。

## 2. 两类 Pin 与零成员 Activation

ADR-007 原先的 `Release Pin` 同时被理解为全部 Metadata Revision Pin 和需要 Generation 的 Runtime Member Pin，无法正确表达 metadata-only Release。本 ADR 与修订后的 ADR-007 固定两个概念：

- **Metadata Resource Pin**：`resource_id → resource_revision_id + content_digest`，每个 Release Manifest 必须封存；
- **Runtime Member Plan Pin**：需要运行数据的 Member 计划，额外包含 Schema、Mapping、Snapshot Group 等生成约束；它是 Metadata Pins 的派生子集，不是同义词。

G2-01 尚未拥有 Generation/Snapshot 表，因此 DB-01 不创建 `runtime_activation_members`。metadata-only R1 的 Runtime Plan 为空，Publish 创建真实的零成员 A0，不创建假的 Snapshot 或 Generation。

DB-02 引入首个 Runtime Member 时必须创建拥有新 Runtime Plan 的 R2/A1；之后 R2 的纯数据刷新才可创建同 Plan 的 A2。禁止修改 R1/A0、禁止在同一 Release 的 Refresh 中加入 Member。可执行 seam 为：

```text
R1 metadata pins + empty runtime plan + A0(empty)
  → R2 new runtime plan + A1(first member)
  → R2 same plan + A2(data refresh)
  ↘ concurrent R3 publish uses the same control CAS
```

历史 R1/R2 Manifest、Pin 和 Activation 都不被重写。该模型已由 ADR-007 状态 Harness 验证；DB-02 只增量增加表和 Repository，不需要破坏 DB-01 历史事实。

DB-01 中每个不可变 `releases` 行就是一个实际 Release Revision 事实；Foundation `ReleaseBinding` 的 `releaseRevisionId` 与该行的 `releaseId` 使用显式一对一映射。它不表示隐式“最新 Revision”，也不生成第二个未持久化身份。若未来需要稳定 Release Container 与多个 Release Revision，必须通过新 ADR、合同版本和前向 Migration 引入真实二层身份。

## 3. DB-01 候选表设计

本节冻结 G2-01-03 的列级语义，不在 G2-01-01 创建任何表。除特殊说明外，ID 是应用生成 UUID，时间是 `timestamptz`，Digest 是带算法版本的有界文本，所有外键默认 `ON DELETE RESTRICT`。

### 3.1 `meta` Schema

| 表                             | 主键、外键与唯一约束                                                                                                           | 可变性                                                                              | 显式 Runtime Grant                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `projects`                     | PK `project_id`；UQ `api_name`；`publication_sequence bigint`、生命周期与时间列                                                | API Name/ID 不变；只允许受控状态与序号更新                                          | API `SELECT, INSERT` + 指定状态/序号列 `UPDATE`；Worker `SELECT`；Ops `SELECT` |
| `resources`                    | PK `resource_id`；FK Project；UQ `(project_id, namespace, api_name)`；固定 `family`                                            | 名称墓碑不删除；Family/API Name 不变，只迁移生命周期                                | API `SELECT, INSERT` + 生命周期列 `UPDATE`；Worker/Ops `SELECT`                |
| `resource_revisions`           | PK `revision_id`；FK Resource、可空 Parent；UQ `(resource_id, revision_number)`、`(resource_id, content_digest)`；`etag`       | Draft 可改内容/Digest/Etag；Validated 后内容、作者、Parent、Digest 不变，只前移状态 | API `SELECT, INSERT` + Draft/状态指定列 `UPDATE`；Worker/Ops `SELECT`          |
| `resource_dependencies`        | PK `dependency_id`；FK Source Revision、Target Revision；UQ `(source_revision_id, target_revision_id, dependency_type)`        | Extractor 插入后不可更新/删除                                                       | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `validation_reports`           | PK `report_id`；FK 可空 Revision/Release，二者恰一；UQ `(subject_type, subject_id, subject_digest, validator_version)`         | Append-only；Issue JSON 受合同 Parser 约束                                          | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `releases`                     | PK `release_id`；FK Project、可空 `rollback_of_release_id`；UQ `(project_id, release_number)`、`(project_id, manifest_digest)` | Draft 可准备；STAGING 后 Manifest/Pin 不变；生命周期只前移                          | API `SELECT, INSERT` + 指定状态/发布时间列 `UPDATE`；Worker/Ops `SELECT`       |
| `release_pins`                 | PK `(release_id, resource_id)`；FK Release/Resource/Revision；UQ `(release_id, pin_order)`；保存 Revision Digest               | Release 进入 STAGING 后不可改；Published 后不可删                                   | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `runtime_activations`          | PK `activation_id`；FK Release；UQ `(release_id, activation_digest)`；DB-01 约束 `member_count = 0`                            | READY 创建后不可变；DB-01 不伪造 Member                                             | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `release_channels`             | PK `(project_id, channel_name)`；FK Project/Release/Activation，复合约束保证 Release/Activation 同 Project                     | 只允许 Publish 事务 CAS 更新 Pointer                                                | API `SELECT, INSERT` + Pointer 列 `UPDATE`；Worker/Ops `SELECT`                |
| `release_serving_heads`        | PK `release_id`；FK Release/Activation；Activation 必须属于同 Release（由复合 FK/受控写函数保证）                              | 只允许 Publish/后续 Refresh 事务 CAS 更新                                           | API `SELECT, INSERT` + Activation/序号列 `UPDATE`；Worker/Ops `SELECT`         |
| `packages`                     | PK `package_id`；UQ `(namespace, api_name)`                                                                                    | 稳定身份；名称墓碑不复用                                                            | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `package_revisions`            | PK `package_revision_id`；FK Package；UQ `(package_id, version)`、`manifest_digest`                                            | 创建后不可更新/删除                                                                 | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |
| `package_installations`        | PK `installation_id`；FK Project、Package、可空 Active Package Revision/Release；UQ `(project_id, package_id)`                 | 只有 Publish 事务可切 Active Pointer；Pending 不可见为 Active                       | API `SELECT, INSERT` + Active Pointer 列 `UPDATE`；Worker/Ops `SELECT`         |
| `package_installation_changes` | PK `change_id`；FK Installation、Target Package Revision/Release；UQ `(installation_id, request_key)`                          | 目标不可变；状态只 `PENDING→ACTIVE/FAILED`、`ACTIVE→SUPERSEDED`                     | API `SELECT, INSERT` + 状态列 `UPDATE`；Worker/Ops `SELECT`                    |
| `artifact_references`          | PK `artifact_reference_id`；UQ `(digest, media_type, source_kind, source_id)`；不保存任意路径                                  | Append-only 引用；对象存储上传不在 Publish 事务                                     | API `SELECT, INSERT`；Worker/Ops `SELECT`                                      |

### 3.2 `authz` Schema

| 表                     | 主键、外键与唯一约束                                                                               | 可变性                                                  | 显式 Runtime Grant                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `principals`           | PK `principal_id`；UQ `(oidc_issuer, oidc_subject)`                                                | 外部身份映射不改；禁用是单向状态变化                    | API `SELECT, INSERT` + 禁用列 `UPDATE`；Worker/Ops 无权限                    |
| `role_bindings`        | PK `binding_id`；FK Project/Principal、可空 Resource；活动有效键以受控 Unique/Exclusion 保证不重复 | Active 只可变 Revoked；重新授予必须新行，不复活旧行     | API `SELECT, INSERT` + Revoked 列 `UPDATE`；Worker/Ops 无权限                |
| `authorization_epochs` | PK/FK `project_id`；`epoch bigint >= 1`                                                            | 任何有效授权或可见性变化在同事务单调 `+1`，不能设回旧值 | API `SELECT, INSERT, UPDATE(epoch, changed_at)`；Worker `SELECT`；Ops 无权限 |

所有表由 `migration_owner` 拥有。三类非 Owner 角色均无 `DELETE`、`TRUNCATE`、`ALTER`、`REFERENCES` 或隐式 Default Table Privilege。`api_runtime` 的列级 UPDATE 仍需 G2-01-03 用非 Owner 登录和触发器/约束负测；不能把本设计表当成数据库证明。`worker_runtime` 在 DB-01 只有发布事实读取能力，没有 Metadata/AuthZ 写权；`read_only_ops` 只读非敏感 Metadata 控制记录，不读取 Principal/Binding。

## 4. 状态机与不变量

### 4.1 Resource Revision

```text
DRAFT --validate--> VALIDATED --release publish--> PUBLISHED
  |                     |                              |
  +--patch If-Match     +--edit creates child DRAFT   +--> DEPRECATED --> ARCHIVED
                                                edit creates child DRAFT
```

- Draft Patch 必须匹配 `etag`，成功后递增 Etag、重算 Digest 并使旧验证失效；
- Validated/Published/Deprecated 的编辑创建带 Parent 的新 Draft，不修改原行；
- Published 内容、Digest、依赖、Parent、作者不可改变；非法回退稳定失败。

### 4.2 Release

```text
DRAFT → STAGING → READY → PUBLISHED → SUPERSEDED
  └──────┴──────→ FAILED (terminal)
```

STAGING 封存 Pin/Manifest。FAILED 不复活；修复必须新建 Release 或按允许路径创建新 Draft。重复发布相同 Release/Digest/Activation 返回原结果，不递增序号；不同绑定或陈旧 CAS 返回冲突。

### 4.3 Package Installation

```text
PENDING → ACTIVE → SUPERSEDED
   └────→ FAILED
```

Package Revision 和 Change 是不可变历史；Installation 是稳定身份和唯一 Active Pointer。创建 Release Draft、Validation 或 Stage 均不能提前改变 Active Pointer。Package Change 与目标 Release 必须在同一 Publish 事务激活。

### 4.4 Role Binding

Role Binding 只有 `ACTIVE → REVOKED`。语义相同的替换是幂等 No-op；角色、Scope 或 Principal 变化必须撤销旧行并插入新行，同时递增 Project Epoch。失败时 Binding 与 Epoch 全旧或全新，不能出现新授权配旧 Epoch。

## 5. Publish 事务、锁顺序与并发

所有会同时触碰这些控制记录的事务采用全局单调顺序：

```text
PROJECT_CONTROL
  → RELEASE_CHANNEL
  → RELEASE
  → RELEASE_PINS
  → SNAPSHOT_GROUP
  → OBJECT_TYPE_CUTOVER
  → GENERATION_INVENTORY
  → SERVING_HEADS
```

Publish 使用 Project、Channel、Release、Pins、Serving Heads；DB-02 Snapshot Cutover 使用 Project、Channel、Snapshot Group、按稳定键排序的 Object Type、Generation Inventory、Serving Heads。Cutover 必须锁 Channel，因为 Refresh 会在目标 Release 仍为活动 Channel 时同步移动它；旧的三锁计划遗漏该写集合，现由 ADR-014 修正。事务可以跳过不需要的锁，但禁止逆序或重复取得低等级锁。Project `publication_sequence`/控制 CAS 处理 Publish 与 Refresh 的计划陈旧；`inventory_revision`/`state_revision` 分别保护物理库存和 GC 引用快照；锁处理提交期间的并发写。

状态 Harness 对 Publish 的 Release、Serving Head、Channel、Package、Epoch 边界逐一注入失败，并证明调用者持有的已提交状态未改变。G2-01-08/09 的真实 PostgreSQL 16 Integration 已分别覆盖 Release Publish 和 Package Prepare/Publish 事务的全部故障注入点；连接中断与长时间容量仍由最终运维 Gate 持续验证。

## 6. 最小管理授权与 G2-03 边界

HTTP/OIDC Adapter 负责 Token 签名、Issuer、Audience、时间和 Scope 验证，并映射为有界 Foundation Identity。Application Use Case 只接收该 Identity 和统一 `ManagementAuthorizer`，不接收 Bearer Token、JWT、任意 Claims Map 或测试身份 Header。

管理授权请求只有 Principal、Project、可选 Resource 和 Permission。角色矩阵：

| 角色               | G2-01 管理权限                                     |
| ------------------ | -------------------------------------------------- |
| Owner              | Metadata 读写、Release Publish、Package、Role 管理 |
| Editor             | Metadata 读写                                      |
| Viewer             | Metadata 只读                                      |
| Executor / Auditor | 不隐式获得管理权限；只保留稳定角色值               |

Resource Binding 是 Project 权限的可选收窄层：有效权限为 Project Permission 与 Resource Permission 的交集，绝不能扩大 Project 没有的能力。Epoch 不可确认时沿用 ADR-012 fail-closed。

G2-03 才拥有 OIDC Claim Mapping 业务规则、Delegation、Object/Property/Link/Action Policy、编译产物和全入口 Policy Gateway。G2-01 的 Authorizer Port 必须可被 G2-03 Gateway 包裹或替换，Endpoint 不得复制角色判断。

## 7. 失败恢复与 Roll Forward

- Publish 失败：数据库回滚，Release 保持 READY、Channel/Serving Head/Installation/Epoch 保持旧值；修复原因后以同一幂等请求重试；
- 并发冲突：重新读取控制序号、Release 和 Channel 后重做计划，不覆盖新状态；
- Validation/Stage 失败：保存绑定当前 Digest 的报告；不可恢复的 Release 进入 FAILED，新建 Release 修复；
- 已发布语义错误：Rollback 复制历史 Pins 形成新 Release，经完整 Validate/Stage/Publish；不倒拨 Pointer、不修改历史；
- DB-01 已部署错误：只增加更高版本 Migration；不修改已应用 Migration Hash；
- DB-02 新增 Generation/Member：以新 Release 增加新 Runtime Plan；已有 Plan 的纯数据变化以新 Activation Refresh，不改历史 Pin。

这套路径只向前增加事实或移动受控 Pointer，不依赖 Down Migration，也不需要重写已经被 API、SDK、Job 或审计引用的身份。

## 8. 被拒绝的方案

| 方案                                       | 拒绝原因                                                   |
| ------------------------------------------ | ---------------------------------------------------------- |
| Release Draft 创建时更新 Package 当前版本  | 会产生“Package 已升级、Channel 仍服务旧 Release”的撕裂状态 |
| Publish 后后台最终一致修复 Package Pointer | 违反一个用户动作对应一个可观察激活点，故障窗口不可界定     |
| 为 G2-01 创建空 Generation/空 Snapshot     | 伪造不属于本 Gate 的运行事实，DB-02 仍需重写               |
| 在同一 Release Refresh 中加入首个 Member   | 改变不可变 Runtime Plan，破坏历史 Release 语义             |
| Endpoint 直接读取 JWT Group 决策           | 形成第二套授权入口，G2-03 无法统一撤权与策略               |
| Publish 事务调用 S3/Worker/Materializer    | 长事务、不可原子回滚且把可用性依赖带入激活路径             |
| 用数据库 Owner 身份运行 API                | 绕过最小权限和 Published 事实保护                          |

## 9. 可执行证据与尚未证明内容

`tools/metadata-control-plane/` 已验证：

- 四类状态机的合法/非法转换、Etag 冲突和不可变子 Revision；
- Package Pending 到 Release Publish 的原子激活、重复请求和陈旧 CAS；
- 五个 Publish 故障点全回滚；
- 全局锁顺序和逆序拒绝；
- Foundation Identity 严格边界、角色矩阵与 Resource 权限交集；
- Role Binding 替换、Epoch 原子递增、幂等 No-op 和禁止旧行复活；
- DB-01 Publish 为纯状态函数，不存在外部调用 Port。

`tools/runtime-activation/` 已验证 R1/A0 → R2/A1 → R2/A2 与并发 R3 的兼容 seam，并保持历史 Manifest/Plan/Activation 不变。

`migrations/db-00/0002_metadata_control_plane.sql`、`0003_resource_revision_guards.sql`、`0004_dependency_validation_guards.sql`、`0005_release_lifecycle_guards.sql`、`0006_package_lifecycle_guards.sql` 和真实 PostgreSQL 16 Integration 已验证 DB-01 的 18 张表、Owner/Grant、唯一约束、初始/前向状态、Published 事实不可变、验证/Stage 上下文不可变、服务器提取边一致性、Release/Activation/Channel/Installation 最终一致、无隐式 Worker/Ops 写权、并发 Migration 与故障后向前修复。Project/RBAC/Epoch、Resource/Draft Revision、Definition Validator、Dependency Graph、Compatibility、Release 与 Package Lifecycle 已有正式 Domain/Application/Repository 实现；详细见 [G2-01-04 Evidence](../../evidence/g2-01-04-project-rbac-epoch.md)、[G2-01-05 Evidence](../../evidence/g2-01-05-resource-revision-lifecycle.md)、[G2-01-06 Evidence](../../evidence/g2-01-06-definition-validation-dependency-graph.md)、[G2-01-07 Evidence](../../evidence/g2-01-07-compatibility-engine.md)、[G2-01-08 Evidence](../../evidence/g2-01-08-release-lifecycle.md) 和 [G2-01-09 Evidence](../../evidence/g2-01-09-package-lifecycle.md)。

G2-01-10 已实现真实签名 OIDC、受限 HTTP Parser、强 ETag、HMAC Cursor、Foundation Error Envelope 和 `api_runtime` Composition Root；Bearer 与原始 Claims 不越过入口。Release Publish 已使用服务器选择的 Published Baseline、不可变 Validation Report、Stage CAS 和真实短 PostgreSQL 事务；Package 展开、兼容报告、Pending Change 和 Installation/Package Revision/Channel 三者原子切换已由 G2-01-09 落地。数据库 Trigger 保住最终行级不变量，HTTP Handler 不替代 Application Authorizer 或 Repository 事务。
