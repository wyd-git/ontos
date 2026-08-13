# G2 工具链基线

- 状态：Accepted for G2-00
- 日期：2026-08-13
- Owner：G2-00-01

## 决策

| 能力              | 固定版本 | 选择理由                                                            |
| ----------------- | -------: | ------------------------------------------------------------------- |
| Node.js           |  24.18.0 | 当前 LTS；不使用仍处于 Current 阶段的 Node 26                       |
| npm               |  11.16.0 | Node 24.18.0 随附版本；支持 workspaces，减少额外包管理器依赖        |
| TypeScript        |    6.0.3 | 当前 `typescript-eslint` 支持 `<6.1`；不采用尚未兼容的 TypeScript 7 |
| ESLint            |   10.8.1 | 当前受支持主版本                                                    |
| typescript-eslint |   8.67.0 | 同时支持 ESLint 10 和 TypeScript 6.0.x                              |
| Prettier          |    3.9.6 | 只承担确定性格式检查，不承载语义规则                                |

版本同时记录在 `package.json`、`.node-version` 和 `.nvmrc`。`preinstall` 会拒绝不同 Node/npm 版本，避免“本机能装”但 CI 使用另一套解析结果。

## 为什么使用 npm workspaces

- npm 与选定 Node LTS 同时交付，无需额外 bootstrap 二进制；
- G2-00 只需要单仓库依赖、确定性 lockfile 和根命令，不需要远程构建缓存；
- 如果后续规模证明 npm workspaces 无法满足性能或发布需要，必须通过 ADR 迁移，且保留同名根命令和 lockfile 审计。

## 升级规则

1. Node 只升级到官方 Active/Maintenance LTS；不以 Current 版本作为生产基线。
2. TypeScript、ESLint 和 typescript-eslint 必须先验证 peer range，再作为一个变更集升级。
3. 升级 PR 必须包含 clean `npm ci`、`npm run verify` 和 lockfile diff。
4. 工具升级不得顺便改变公共合同或业务行为。

## 官方依据

- [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- [TypeScript 6.0 Release Notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [ESLint Version Support](https://eslint.org/version-support/)
