# G2-00-12 强制 CI 与供应链 Gate

- 状态：Frozen for G2-00-12
- 本地与 CI 唯一入口：`npm run verify`
- GitHub Required Check：`Foundation Gate`
- 机器报告：`generated/ci-report/report.json`

## 1. 单一执行路径

GitHub Actions 不重新拼装命令，只在固定 Node/npm 环境执行 `npm run verify`。本地和 CI 使用同一个 Node 编排器、同一顺序、同一失败语义：

1. `npm ci`：验证 Lockfile 并做确定性安装；
2. Format、Lint、Typecheck；
3. Unit、Contract Golden/Diff、Architecture Dependency、Testkit Provenance；
4. Secret/Private Key Scan；
5. License Manifest、CycloneDX SBOM、Vulnerability Policy；
6. 固定 PostgreSQL 16 镜像的 DB-00 Integration；
7. PG/OIDC/S3/OTEL 本地生产边界环境 `up → smoke → down`。

编排器 Fail Fast，但任何已启动的环境必须在 `finally` 清理，并且无论成功或失败都写报告。`generated/` 不提交 Git，由 CI 作为 Artifact 上传。

## 2. 报告合同

`report.json` 至少包含：

- Schema Version、最终 PASS/FAIL、Commit、Dirty 状态、开始/结束时间、总耗时；
- OS/Arch、Node、npm、Docker、Docker Compose 版本；
- 每个 Gate 的命令、Exit Code、开始时间、耗时和安全截断后的输出尾部；
- 实际 PostgreSQL `server_version_num` 与固定镜像引用；
- G1/Testkit Fixture Hash、`package-lock.json` Hash；
- Secret、License、SBOM、Vulnerability Artifact 的路径、Hash 和计数；
- 失败 Gate 和未执行 Gate，不能用缺失字段伪装成 PASS。

同时生成简短的 `summary.md`，供 GitHub Job Summary 和人工审查使用。原始供应链机器输出保存在同一目录。

## 3. Secret 与私钥策略

Scanner 只扫描 Git 跟踪文件，不读取 `.git`、`node_modules` 或本机未提交配置。阻断规则包括：

- PEM/OpenSSH/PGP Private Key Header；
- GitHub、AWS、Google、Slack 等高置信 Token 格式；
- 名称包含 `password/secret/token/private_key/access_key` 的长字符串赋值。

公开、一次性的本地示例值不以明文 Allowlist 维护，而以精确 SHA-256 值列入策略；只有相同公开样例被允许，任意变体仍被拦截。报告只显示规则、路径和行号，不回显 Secret 内容。

故意失败 Fixture 以分段文本保存，测试时只在临时目录重组，因此正常仓库扫描不会包含一段“真的私钥头”。

## 4. License、SBOM 与漏洞策略

### 4.1 License

License Manifest 从 `package-lock.json` 生成，覆盖全部外部 Runtime/Dev/Optional 依赖，记录 Name、Version、License、Resolved、Integrity 和 Scope。Workspace Link 不伪装成第三方依赖。

Foundation 当前 Allowlist：`0BSD`、`Apache-2.0`、`BSD-2-Clause`、`BSD-3-Clause`、`BlueOak-1.0.0`、`ISC`、`MIT`。外部依赖缺失 License 或出现未批准 SPDX Expression 时阻断；变更 Allowlist 必须由 Platform/Security 在独立审查中说明原因。

### 4.2 SBOM

使用固定 npm 11.16.0 的 `npm sbom --sbom-format cyclonedx` 生成 CycloneDX JSON。Gate 校验 `bomFormat`、Spec Version、Component 和 Dependency 数量后保存 Artifact 与 SHA-256，不把生成时的随机 Serial/Timestamp 当成源码稳定摘要。

### 4.3 Vulnerability

使用 `npm audit --json` 查询 npm 官方 Advisory Service。用户已明确授权提交依赖名称、版本、依赖树以及 Node/npm/平台元数据。

- `critical`、`high`：默认阻断；
- `moderate`、`low`、`info`：报告但不阻断 Foundation；
- 网络失败、非 JSON、未知 Severity 或缺失元数据：Fail Closed；
- 不允许命令行 `--force`、静默 `|| true` 或删除报告。

临时 Waiver 必须精确匹配 Package、Severity 和 Advisory URL 集，并记录 Owner、Reason、创建日期、到期日期；最长 30 天。过期、不完整或覆盖范围大于当前 Finding 的 Waiver 本身就是阻断错误。当前基线没有漏洞，也没有 Waiver。

## 5. 故意失败协议

| 风险               | 故意失败输入                                                    | PASS 条件                                          |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------- |
| Contract 破坏      | 删除属性、Required 新增、类型/枚举/未知字段策略变化             | Compatibility Test 明确返回 Breaking Code          |
| 越层导入           | Domain → Adapter、Production → Testkit、Workspace → `spikes/g1` | Architecture Check 返回阻断 Violation              |
| 角色越权           | 在一次性 PostgreSQL 中临时把 Runtime 加入 `migration_owner`     | DB Role Gate 检出父 Membership；恢复后继续其他测试 |
| Secret/Private Key | 临时重组 Private Key Header 和真实形态 Token                    | Scanner 非零并且报告不回显内容                     |

这些是“验证 Gate 能失败”的测试，不是在 CI 中提交永远失败的分支。

## 6. GitHub Actions 与分支保护

- 事件：`pull_request` 与 `push` 到 `main`；不使用 `pull_request_target`；
- Runner：GitHub 托管 `ubuntu-24.04`；Job Timeout 30 分钟；
- `GITHUB_TOKEN`：仅 `contents: read`；Checkout 不持久化凭据；
- 只使用 GitHub 官方 `checkout`、`setup-node`、`upload-artifact`，并固定完整 Commit SHA；
- Workflow 的唯一执行命令为 `npm run verify`；Artifact Upload 使用 `always()`；
- Main Branch Protection 要求 `Foundation Gate` 且分支必须最新，禁止 Force Push/Delete，Admin 也受保护。

目标配置由 `security/main-branch-protection.json` 机器冻结；套餐开通后由 Repository Owner 执行 `npm run github-protection:apply`，再用 `npm run github-protection:verify` 独立读取复查。脚本要求 PR、Strict `Foundation Gate`、Admin Enforced、无常驻 Bypass、禁止 Force Push/Delete；任一字段漂移都非零退出。

紧急情况不配置常驻 Bypass Actor。若确需绕过，Repository Owner 必须临时修改保护，GitHub Security Log 记录操作者与时间；随后立即恢复，并在 `docs/evidence/emergency-bypass/` 提交 Incident、原因、受影响 Commit、执行人、批准人、恢复时间和补跑结果。没有这两层记录的绕过视为未授权变更。

## 7. 官方依据

- [GitHub Actions Secure Use](https://docs.github.com/en/actions/reference/security/secure-use)：最小 Token 权限、避免 `pull_request_target`、Action 固定完整 SHA；
- [Protected Branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)：Required Status Checks 与管理员保护；
- [Workflow Artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)：跨 Job/运行保存 Gate Artifact；
- [npm sbom](https://docs.npmjs.com/cli/v11/commands/npm-sbom/)：CycloneDX/SPDX 输出；
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)：依赖树提交、Severity 与 Exit Code 语义。
