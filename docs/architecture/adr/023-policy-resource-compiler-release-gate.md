# ADR-023：Policy Resource、确定性 Compiler、Artifact 与 Release Gate

- 状态：Accepted for G2-03-05
- 日期：2026-08-19
- 决策范围：`contracts`、`metadata-*`、`policy-*`、`object-store-s3` 与 Migration `0026`
- 上游：[ADR-020](020-query-policy-identity-consumer-boundary.md)、[ADR-021](021-query-policy-persistence-boundary.md)、[ADR-022](022-runtime-identity-claim-mapping-delegation.md)

## 1. 决策

G2-03-05 激活 `policy` Resource Family，但不创建 Query/Gateway/UI。一个 Policy 只有同时满足以下链路才可随 Release 进入 READY 或 PUBLISHED：

```text
严格 Policy Resource
  → 同一 Registry 的 Direct / Package Parser
  → 精确 Revision Dependency 与同 Project/Release Closure
  → policy-g2-03-v1 Validation
  → 有界、无副作用的 policy-compiler-g2-03-05-v1
  → 内容寻址 IR + Test Report Artifact
  → 不可变 authz.policy_compilations 事实
  → Stage 与 Publish 同一编译身份复验
```

`0022`～`0024` 已拥有不可变 Compilation、Artifact Reference 和受控写入函数，因此 `0026` 只激活正式依赖和 Release 约束，不创建第二套 Policy 真相。

## 2. Policy Resource 与依赖

Policy Resource 只包含 `schemaVersion`、有序唯一 Rules 和有序唯一 Test Vectors。客户端不能提交 `compiled`、SQL、Identifier、Artifact Digest、Compiler Version、网络地址或可执行模块。

每个 Rule Target 必须直接携带精确 Resource/Revision UUID。`link_exists` 还必须携带精确 Link Type 和 Target Object Type Resource/Revision UUID；API Name 只是被服务器核对的稳定语义名，不参与“查最新”。Policy Dependency Extractor 由 Direct 和 Package 路径共享，并产生：

- `policy_object_target`；
- `policy_property_target`；
- `policy_link_target`；
- `policy_action_target`。

Validator 核对同 Project、可复用 Revision、Resource ID、Family、API Name、Property 存在性及 Release 闭包。Property Predicate 只能读取目标 Object Type 中 `filterable=true` 的 Property。Action Type 尚未激活时，Action Target 因找不到可复用的同闭包 Revision而 fail closed，不会被当成 Allow。

## 3. Compiler 与 IR

Compiler 是纯 Domain 函数，只接受已经解析的 Policy、精确 Release/Dependency Snapshot 和由 Runtime Identity Mapping 推导的受信 Actor Attribute Schema。它不接收数据库连接、时钟、Locale、Timezone、网络、SQL Renderer 或任意 Function。

IR 固定使用 Foundation `PolicyArtifact`，并额外绑定 Dependency Context Digest 与受信 Actor Attribute Schema。Artifact Digest 对去掉自引用 Digest 后的完整规范 JSON 计算 SHA-256。排序使用 Unicode code unit；相同输入跨 Locale、Timezone 和进程必须产生相同字节。

允许的 Predicate 只有常量、类型比较、`is_null`、有界 `all/any/not`、Request Time 和一次一跳 `link_exists`。缺失值使用三值逻辑；`not(missing)` 仍未知，绝不转成 Allow。Raw SQL、原始 Identifier、外部网络、递归、非确定当前时间、未知 Actor Attribute、非索引 Property 和无界集合在编译前拒绝。

决策固定为：显式 Deny 优先，Property 的 Mask 次之，显式 Allow 再次；无匹配 Rule 一律 Deny。Link、Action、Object 和 Property 均没有隐式 Allow。

## 4. Test 与 Artifact Store

Policy Contract 必须包含 Allow、Deny、Null、Missing，以及适用时的 Link invisible、Property Mask/Deny 向量。Compiler 对每个向量运行正式 Evaluator，并生成逐向量稳定结果；任一不一致产生 Failed Report，不能生成可供 Release 使用的 Passed Compilation。

IR 与 Test Report 使用 SHA-256 内容寻址键写入版本化 S3：

```text
policy/ir/<64-hex>.json
policy/test/<64-hex>.json
```

每次写入和读取都复算 Digest；Digest 不匹配、对象缺失、Media Type 错误或 S3 不可用均 fail closed。PostgreSQL 只保存已有 `artifact_references` 与 `policy_compilations` 目录事实，不保存对象存储凭据或第二份 Artifact Body。

## 5. Release Gate

Release Stage/Publish 对每个 Policy Pin 要求唯一的当前 Compiler Passed Compilation，并精确匹配 Project、Release、Policy Resource/Revision、Policy Content Digest、Compiler Version、Artifact/Test Digest 和向量计数。Compilation 身份进入 Stage Validation Context Digest；Stage 后新增、替换或缺失结果都会导致 Publish 并发复验失败。

Migration `0026` 同时提供数据库防线：Policy Validation 必须有正式依赖，依赖目标 Family 正确且同 Project；Release 进入 Staging/Ready/Published 时每个 Policy Pin 必须存在精确 Passed Compilation。应用层和数据库层都不允许只凭客户端布尔值越过 Gate。

## 6. 兼容性

Published Revision/Compilation/Artifact 均不可原地替换。Policy 兼容比较按 Rule/Target 的 Allow、Mask、Deny 变化识别：

- 新增 Allow 或删除 Deny/Mask：权限放宽，阻止自动 READY；
- 删除 Allow 或新增 Deny/Mask：权限收紧，允许在新 Revision 中发布并给出明确影响；
- 同一 Rule 的 Target/Predicate/Effect 混合变化：需人工迁移判断，阻止自动 READY；
- 字节相同：兼容。

## 7. 被否决的方案

- 在 Endpoint/SQL 中硬编码权限：没有不可变 Policy/Artifact/Test 绑定；
- 为 G2-03-05 新建第二张 Policy Artifact 主表：与 `0022` 的事实冲突；
- 只存 API Name 后运行时查“最新 Revision”：不能复现历史 Release；
- 把 Missing 当 False 后允许 `not` 反转：会形成缺数据扩权；
- 让 Package 使用较宽松 Parser：同一 Policy 可因入口不同而改变语义；
- Stage 时临时编译但不持久化测试身份：Publish 无法证明复验的是同一结果；
- 在本项实现 Gateway、Query SQL 或 UI：这些分别属于 G2-03-06、07 和 13。

## 8. 后续

G2-03-05 只证明“Policy 可以被可信发布”。G2-03-06 才负责加载精确 Artifact、组合 Identity/Epoch、缓存与 5 秒撤权；G2-03-07 才把 Policy IR 编译进参数化 Query SQL。
