# Red-Team：G2-01-09 Package Lifecycle

- 日期：2026-08-15
- 审查对象：Package 预检、展开、安装输入、兼容升级、Pending Change、Release Publish 激活和 Rollback
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-10**；G2-01-09 范围内的伪造已校验输入、资源归属冲突、部分安装、部分激活、条件兼容冒充 READY、版本复用和历史回写已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 Repository 信任 `PreparedPackageCandidate` 类型

TypeScript 类型和 `Object.freeze` 不是跨进程安全边界；直接调用 Repository 可伪造 Manifest/Content/Canonical Preimage 的组合。Store 现在从最小原始字段重建 Candidate，重跑严格 Parser、Family Registry、Dependency Extractor 和 Digest，并将结果与 Application 传入的 Integrity Fact 对比。修改已准备 Content 的反例在写库前返回 `INVALID_INPUT`。**CLOSED**。

### 1.2 两个 Package 可以宣称同一 Resource

Package Identity 唯一约束只保护 Package Namespace/API Name，不防止其 Manifest 抢占其他 Package 的 Resource ID 或 Resource Namespace/API Name。准备事务现在在 Project 锁内同时检查所有 Active 与 Pending Package Manifest；与其他 Package 有任一归属重叠就拒绝。两个不同 Namespace 的正向 Package 及重叠 Resource ID 的第三 Package 在真实库验证。**CLOSED**。

### 1.3 Package 兼容报告可能超过公开合同上限

完整比较必须先得出最严重结论，但合同最多允许 1,000 Findings。Package 编排现在保留前 999 个稳定 Finding，最后一项为与完整 Outcome 同严重度的截断摘要，然后再过合同 Parser。截断不能把阻断结论变成 Compatible。**CLOSED**。

### 1.4 只在 Installation SQL 后注入故障不能证明整个 Publish 原子

Package 激活复用 Release Publish，因此只测 `after_installations` 会遗漏 Activation、Serving Head、Revision、Release、Channel、Project 和 Epoch 边界。现在同一 Pending Package Release 在八个 Publish 故障点逐一失败，每次都比较旧世界快照，最后再成功发布。**CLOSED**。

### 1.5 安装输入可被误用为 Secret/Database 注入通道

G2-01 没有 Secret Reference 合同和专用 Secret Store，所以即使 Value 符合不透明字符串约束，`password`/`secret`/`token`/`credential`/`databaseUrl` 等定义也会让用户把密钥持久化到 Metadata。预检现在稳定拒绝这些输入名，直到拥有 Gate 提供引用型语义。**CLOSED for G2-01**。

### 1.6 “两 Package 共存”测试没有真实 Dependency

只比较 Resource 行不能证明 Link 展开不污染其他 Package。第二 Package 现在包含真实 Link Revision，数据库中精确存在 `link_source` 和 `link_target` 两条 Package 内边。审查中首次将 Link 指向了第一 Package 的旧 Revision，后续升级被 Release Gate 正确拦截；用例随后改为自闭合依赖，不改动产品逻辑。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                      | 精确执行点                                       | 反例测试                                               | 结果 |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ---- |
| Manifest/Resource/Input Digest 可信 | Domain canonical preimage + Repository reparse   | bad Digest、forged prepared candidate                  | PASS |
| 禁止未拥有 Capability               | closed scanner + shared Family Registry          | SQL、Migration、Path、Address、Secret、deferred Family | PASS |
| Install 全有或全无                  | one PostgreSQL transaction                       | 五个 prepare fault point                               | PASS |
| Upgrade 先兼容后写入                | locked active baseline + server report           | breaking 与 conditional 均无 Release/Change            | PASS |
| Pending 不是 Active                 | Installation guard + Release Publish             | Publish 前 Pointer 不变                                | PASS |
| 三 Pointer 同事务切换               | Release/Channel/Installation/Change transaction  | 八个 publish fault point                               | PASS |
| 同 Project 多 Package 隔离          | active/pending ownership collision check         | 两 Namespace 正向、重叠 Resource ID 反向               | PASS |
| 版本和请求幂等                      | immutable version + request/input Digest         | same retry、different content same version             | PASS |
| Rollback 只向前增加事实             | historical manifest reconstruction + new Release | 新 Release/Change，旧 Manifest/Pin 逐字段不变          | PASS |
| 不依赖 Spike Runtime                | production dependency graph + provenance audit   | production 包无 `spikes/g1`/`@ontos/testkit` import    | PASS |

## 3. What I Couldn't Assess

- G2-01-10 尚未证明真实 HTTP/OIDC、Body/Depth/String Limit、If-Match、Error Envelope 和进程重启；当前身份从 Application 边界开始。
- G2-01-11 尚未把两个 metadata-only Package 的派生过程、API/OIDC 测试和 G2-01 报告整体升级到统一 CI Manifest；当前 Provenance 依赖已冻结 G1 Package 源和 Testkit 审计。
- Artifact 只登记 Digest；Function/Action 执行、签名、分发和 Runtime 属于后续 Gate。
- 当前正确性测试包含两个小型 Package，没有把 512 Resource 上限宣称为生产延迟 SLO；容量数据在 G2-01-12 和后续运维 Gate 继续补证。

因此结论是 **Go for G2-01-10**，不是 G2-01 总 PASS，也不是可公网部署的完整产品。
