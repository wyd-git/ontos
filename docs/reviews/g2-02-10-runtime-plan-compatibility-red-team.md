# G2-02-10 Runtime Plan 与兼容证书 Red Team

- 日期：2026-08-16
- 方法：钢人化承重主张，再按影响 × 出错可能性 × 最低测试成本排序
- 结论：**G2-02-10 可 PASS；只放行 G2-02-11。真实 Cutover、Serving Head、GC、HTTP 和总验收仍为 OPEN**

## Top Kill-Assumptions（按优先级）

### 1. 当前证书不会在权威事实变化后重新生效

- **Claim：** Compatibility Certificate 是特定 Generation、Release Plan、当前 Inventory、Index/Capacity Admission 与审批状态的一次性证明。
- **钢人：** Current View 每次查询都重新连接 Generation、Quality、Report、Job、Inventory、Admission 和 Approval，并重算 Certificate Digest。
- **Fails if：** Inventory Revision 变化使证书暂时失效，但后续同 Revision/Plan 的新 Admission 又让旧证书自动匹配，造成“失效后复活”。
- **Evidence：** 证书持久绑定 exact `capacity_admission_id` 与 `index_admission_id`；真实 PostgreSQL 先推进 Inventory 使旧集合归零，再创建新 Admission/证书，断言只有新证书有效。
- **Kill criterion：** 任一旧证书能通过后来新增或替换的 Admission 恢复 Current 状态，立即 FAIL，不进入 Cutover。
- **Cheapest test：** 同一 Generation 连续创建两个 Inventory Revision 与两组 Admission，只查询旧 Certificate ID 是否重新出现。
- **状态：CLOSED。** 这是复审中实际发现并修复的高影响缺口。

### 2. 首成员能从 Staging 启动物化，且多成员不会部分 READY

- **Claim：** 已密封 Runtime Plan 的 Staging Release 可以接收首轮受管 Snapshot；Snapshot Group 中 Object 和 Base Link 必须完整，全部证书齐全后才能 READY。
- **钢人：** Ingress 通过 Plan Member 而不是任意 Release ID 解析上传目标；Plan 编译器检查服务器 Group Definition 全量成员，Release READY Guard 再按 Group 比较期望数与当前证书数。
- **Fails if：** Ingress 只接受 Ready/Published，导致“没有 Snapshot 就没有 Certificate、没有 Certificate 就不能 Ready、没有 Ready 又不能上传”的循环依赖；或单个证书就能把多 Member Release 标为 READY。
- **Evidence：** Commit-bound Gate 实际发现旧 Ingress Ready-only 死锁并触发修复；真实 OIDC/HTTP/PostgreSQL/S3 向量现在从 Staging Plan 创建上传会话。另有两 Object + Base Link Stage、100k/1m 两 Member 容量向量、late Member 拒绝和证书不足时保持 Staging。
- **Kill criterion：** Staging Plan 无法开始首轮上传，或 Draft/无 Plan 可上传，或缺任一 Member/混用 Group Version 仍能 READY，立即 FAIL。
- **Cheapest test：** 用 Staging/Ready/Draft 三个 Release 请求同一受管上传入口，并在两 Member Release 只签一个证书后执行 `staging → ready`。
- **状态：CLOSED。** 正式 Pointer 移动仍由 G2-02-11 验证。

### 3. 可信签发入口不能被“可信调用方”喂入伪事实

- **Claim：** API 只能提交 Certificate ID、Project、Generation 和目标 Release 身份，不能选择兼容结论或证据。
- **钢人：** 四参数 `SECURITY DEFINER` 函数重读权威表，旧七参数函数被 DROP；Runtime 角色没有证书表 INSERT/UPDATE 权限。
- **Fails if：** 旧函数仍可解析、直接 INSERT 可用，或调用方能提交 `exact_pin`、Validator/Evidence Digest 绕过重算。
- **Evidence：** 七参数调用返回函数不存在；跨 Project、直接表写和伪造字段均拒绝；证书 Digest 由数据库规范串计算。
- **Kill criterion：** Runtime 身份可控制 decision/validator/evidence、直写证书或跨 Project 签发，立即 FAIL 并撤销 Runtime 凭据。
- **Cheapest test：** 以 `api_runtime` 分别调用七参数函数和直接 INSERT，再用另一个 Project Generation 调四参数函数。
- **状态：CLOSED。**

### 4. “质量通过”确实来自成功 Job 和正确 Snapshot/Mapping

- **Claim：** READY Generation 与 Quality Binding 不能单独证明可服务；Report 必须来自同 Group Version 的成功 Job，且 Snapshot/Mapping Digest 与行数匹配。
- **钢人：** 签发函数和 Current View都连接 Snapshot、Mapping Revision、Quality Binding、Report、Job 与 Confirmation，且 Overlay 必须为零。
- **Fails if：** 复制一套通过的 Quality/Current 行到失败 Generation，就能获得证书；或 Snapshot Digest 改变后旧证书仍有效。
- **Evidence：** 真实 Job 经 Worker Claim 后永久失败到 `dead_letter`；测试再构造 READY Generation、Report、Current 与 passed Quality，签发仍映射为 `RUNTIME_GENERATION_INCOMPATIBLE`。Snapshot Digest 变更被数据库拒绝。
- **Kill criterion：** 非 `succeeded` Job、错误 Snapshot/Mapping Digest、错误 Report 行数或非零 Overlay 任一可签发，立即 FAIL。
- **Cheapest test：** 复制成功 Quality 行但把 Report 绑定 dead-letter Job；这是当前已执行反例。
- **状态：CLOSED。**

### 5. 跨 Release 复用不会退化为跨定义误用

- **Claim：** 内容兼容的受支持 Release 可复用同一 Generation，不兼容 Revision 必须分别构建。
- **钢人：** Generation 源事实和目标 Release Plan 分开重验；完全相同 Pin 为 `exact_pin`，资源身份与内容 Digest 等价才允许 `projection_equivalent`。
- **Fails if：** 为了复用只比较 API Name/Member Key，忽略 Target、Schema、Mapping 或 Index Digest；或复合 FK 过严导致合法复用永远不可能。
- **Evidence：** 两 Release、一 Generation 的真实证书集合通过；跨 Project拒绝；Metadata Compatibility 对 Snapshot Schema/Mapping 改动已从“忽略”改为 `REMATERIALIZATION_REQUIRED`。
- **Kill criterion：** 任一内容 Digest 不同仍被等价复用，或完全等价的第二 Release 无法签发，立即 FAIL。
- **Cheapest test：** 克隆 Release Pins 后只改变 Mapping Digest，必须从 `reused` 变成无可用证书；不改变内容时必须复用同 Generation。
- **状态：CLOSED。**

## What's Well-Reasoned

- Plan 派生、证书签发和 Pointer 切换被拆成三个不同责任；G2-02-10 没有借机提前写 Serving Head。
- 最危险的事实不是只写入证书一次，而是在 `current_compatibility_certificates` 中动态重验；Approval 过期、Inventory 漂移和失败 Job 都能让历史证书立刻退出当前集合。
- 真实 100k/1m 向量已升级为 Object + Base Link 两成员 Closure，避免只用单 Member Demo 证明“Group 完整”。
- 权限回归发现缺口后只增加四列 SELECT，没有用整表写权限或 Owner 身份换取测试通过。

## What I Couldn't Assess

- G2-02-10 故意没有实现 Runtime Activation、Serving Head CAS、并发 Publish/Refresh 和失败后旧代继续服务；这些不是本 Gate 的通过证据，必须在 G2-02-11 真库故障注入中评估。
- 证书 Current View 在大量 Release/Generation 历史上的长期查询成本尚无高基数基准；当前 100k/1m 数据量证明物化容量，不等于百万证书历史查询容量。若后续实测超预算，应增加可验证的派生索引/缓存，不能弱化动态失效语义。
- 真实 OIDC/Admin HTTP 还没有暴露 Refresh/Certificate 管理入口；G2-02-13/14 必须再次验证角色、错误映射、重启和 clean-room。

## 决策

五个 G2-02-10 Kill-Assumption 均有当前实现和真实反例支撑，未触发架构停止条件。Gate 可 PASS，但下一步只能进入 **G2-02-11 Snapshot Group 原子 Cutover 与数据 Refresh**；若 11 无法在不授予 Runtime 任意 Pointer 写权限的前提下完成短事务 CAS，应停止并回到 ADR，而不是把证书检查移出事务。
