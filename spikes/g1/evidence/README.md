# Evidence

每次运行创建一个带 UTC 时间和 Spike 名称的目录：

```text
evidence/raw/2026-08-13T030000Z-spike-a/
├── environment.json
├── command.txt
├── result.json
├── explain/
└── test-output.txt
```

`evidence/raw` 默认不提交。可评审的摘要使用 `evidence/<spike>-summary.md`，并记录原始目录 Hash。

本轮最终入口：

- [G1 可行性报告](../docs/g1-feasibility-report.md)
- [最终证据清单](final-evidence-manifest.md)
- [Spike A](spike-a-summary.md) / [Spike B](spike-b-summary.md) / [Spike C](spike-c-summary.md) / [Spike D](spike-d-summary.md)

结果状态：

- PASS：所有硬门槛通过；
- FAIL：至少一个硬门槛失败；
- INVALID：环境、数据量或证据不符合章程，不能下结论。
