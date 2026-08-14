# Monorepo 依赖边界

- 状态：Accepted for G2-00-01
- 机器策略：[`tools/architecture/policy.json`](../../tools/architecture/policy.json)
- 检查入口：`npm run check:architecture`

## 1. 目标方向

```text
apps
  → application modules
    → domain + contracts
      ← adapters implement declared ports
```

每个 workspace 的 `package.json` 必须声明：

```json
{
  "name": "@ontos/example",
  "ontos": { "layer": "application" },
  "exports": { ".": "./src/index.ts" }
}
```

G2-00-01 不提前创建空业务包。检查器即使在零生产包时也运行；负面 Fixture 证明未来第一个包出现后，违规会成为不可合并错误。

## 2. Layer 规则

| Layer         | 可以依赖的 workspace layer                       | 额外限制                                         |
| ------------- | ------------------------------------------------ | ------------------------------------------------ |
| `app`         | application、domain、contracts、adapter          | 只允许位于 `apps/`；作为 composition root        |
| `application` | application、domain、contracts                   | 外部模块默认拒绝，显式审查后才可放行             |
| `domain`      | domain、contracts                                | 外部模块默认拒绝，保持纯业务规则                 |
| `contracts`   | 无                                               | 无 Runtime 外部依赖；不暴露 DB/HTTP/React/云类型 |
| `adapter`     | application、domain、contracts                   | 实现 Port；可以封装基础设施 SDK                  |
| `testkit`     | application、domain、contracts、adapter、testkit | 只能被测试使用，生产 Layer 不得依赖              |
| `tooling`     | 非 App layer                                     | 只用于构建和校验，生产 Layer 不得依赖            |

所有 workspace 依赖图必须无环。`application → application` 允许跨模块调用公开 Application Port，但任何环都必须通过重新划分 Port 消除。

Domain、Application 与 Contracts 使用外部模块 allowlist，而不是已知 SDK denylist；所以未被列举的新数据库、HTTP、云、框架包或 Node.js 内建模块也会失败。若确需纯函数第三方库或内建能力，必须在机器策略中按模块名显式放行，并在同一 PR 说明它为何不泄露基础设施类型。

## 3. 公共入口

- application、domain、contracts 和 adapter 包必须显式声明根 `exports`；
- G2-00 阶段禁止导出通配符或子路径；
- 消费者只能 `import "@ontos/package"`，不能导入 `/src`、`/internal` 或相对跨包路径；
- 框架 DTO 必须在 App/Adapter 边界映射成公共合同，不能从公共包泄露。

## 4. Gate 覆盖

自动测试至少证明以下输入会失败：

1. Contracts 导入 PostgreSQL/框架；
2. Domain 依赖 Adapter；
3. Workspace 形成循环；
4. 消费者深导入另一个包；
5. 相对路径跨包；
6. 生产模块依赖 Testkit；
7. 未知基础设施 SDK 绕过包名黑名单；
8. 公共包导出内部子路径。
9. 任意正式 Workspace 运行时导入冻结的 `spikes/g1` 源码。

策略后续可以通过 ADR 收紧，但不能在普通业务 PR 中静默放宽。任何例外必须说明为何不能通过公开 Port 解决，并提供删除期限。
