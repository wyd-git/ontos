# G2-00-01 工具链与依赖边界验收记录

- 结论：**PASS（仅限 G2-00-01）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-01-toolchain-boundaries`
- 基线 Commit：`b7b8b2eaebaa03d45657269a2aa22a0911547a78`
- 环境：macOS 26.5.2 / Darwin arm64
- 工具：Node.js 24.18.0 / npm 11.16.0
- Lockfile SHA-256：`0629ffc5f9478f5631dfe7771ee3fd747c51f15dc4ea0603c65b37a903106d2f`

本记录对应 [G2-00-01 WWA](../delivery/g2-00-foundation-task-pack.md#G2-00-01固定工具链仓库骨架和依赖边界)。最终实现 Commit 由 Draft PR 的 head 记录，避免在被哈希的 Commit 内写入自身哈希。

## 1. 验收映射

| WWA 声明                                                         | 实现证据                                                                                            | 执行证据                                                         | 结果 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- |
| Node 与包管理器由仓库锁定；clean install 不改 lockfile           | `package.json:7-18`、`.nvmrc`、`.node-version`、`.npmrc`、`tools/toolchain/check-versions.mjs:7-48` | `npm run bootstrap` 成功；执行前后 lockfile SHA-256 相同         | PASS |
| 根命令覆盖 bootstrap、format、lint、typecheck、unit test、verify | `package.json:16-27`                                                                                | `npm run verify` 全链通过                                        | PASS |
| Contracts 不依赖数据库、HTTP、React、云 SDK 或应用包             | `tools/architecture/policy.json`、`tools/architecture/check-workspace.ts:229-352`                   | PostgreSQL 外部依赖与 Contracts → App Fixture 均被拒绝           | PASS |
| 跨层导入和循环依赖自动失败                                       | `tools/architecture/check-workspace.ts:229-380`                                                     | Domain → Adapter、Application 循环 Fixture 均被拒绝              | PASS |
| 公共包不泄露框架类型；消费者不能深导入内部路径                   | `tools/architecture/check-workspace.ts:196-227,280-355`                                             | 未知 `mysql2` SDK、导出子路径、深导入及相对跨包 Fixture 均被拒绝 | PASS |
| 不包含业务 Endpoint、Repository 或数据库表                       | 本 PR 文件清单                                                                                      | 只有根工程配置、架构检查工具、测试和说明文档                     | PASS |

## 2. 可复现执行

```text
$ npm run bootstrap
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 91 packages

$ npm run verify
toolchain: PASS (node 24.18.0, npm 11.16.0)
format: PASS
lint: PASS
typecheck: PASS
unit: 13 passed, 0 failed
architecture: PASS (0 production workspace packages)
```

锁文件在 `npm run bootstrap` 前后的摘要均为：

```text
0629ffc5f9478f5631dfe7771ee3fd747c51f15dc4ea0603c65b37a903106d2f  package-lock.json
```

架构测试的合法 Fixture 包含 6 个 workspace；其余 Fixture 分别证明外部 SDK、Contracts → App、Domain → Adapter、循环、深导入、导出子路径、相对跨包和 Production → Testkit 会失败。

## 3. Intended-vs-Implemented 审查

审查中发现并关闭一项重要偏差：

- **原意：** Domain/Application 不得引入数据库、HTTP、React、云或 Telemetry 基础设施 SDK。
- **原实现：** 只拒绝已列出的包名；开发者可以用未列举的 SDK 绕过，污染核心模块及所有下游消费者。
- **修复：** `contracts`、`domain`、`application` 改为外部 Runtime 依赖与源码导入默认拒绝；确需第三方库或 Node.js 内建能力时必须在中央策略中显式放行。`mysql2` 负面 Fixture 证明未知 SDK 也会失败。
- **状态：** CLOSED；未发现仍开放且跨越架构边界的文档/实现偏差。

## 4. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-02～13 尚未完成。
- 当前不创建空业务包，所以仓库扫描显示 0 个 production workspace；第一个真实包出现后会自动纳入同一 Gate。
- GitHub 强制 CI 与分支保护属于 G2-00-12；本任务只提供可复用的本地根命令和可执行规则。
- 本任务未验证 PostgreSQL、OIDC、S3、OTEL、业务 API、Runtime、页面或生产容量。
