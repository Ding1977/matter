# `scripts/gates/` —— 判据实现层（L2）

> 本层规则（**乙/丙规则**，2026-11-07 起生效，正文就地写在这里）：
> - **甲**：判据脚本一律落本目录，文件名即判据 id（`<id>.ts` 或 `<id>.mjs`）。
> - **乙**：每个判据必须有**可被 `--tier gateselfcheck` 调度**的自检，且含**反向对照**。
>   **只有 spec 文件不算。** 新载体的自检格由 `scripts/lib/selfcheck-ids.mjs` 从 registry 的
>   **active 非 legacy 条目**自动派生（格 id = `<id>-selftest`，入口 = `<id>.ts --selftest`），
>   新增判据即自动进档，不用往白名单里手写。
>   ⚠️ 口径是「非 legacy」**不是** `kind:"spec"`：实测 `registry.json` 里字面 `kind:"spec"` 是 **0 条**，
>   24 条新载体全是 `kind` 缺省。照字面写会派生 0 格、机制整段空转。
>   ⚠️ 这条是 ISS-857 改的：原措辞「必须有同名 `.spec.ts`（或自带 `--selftest`）」把
>   「写了 spec」当成了「自检被调度」。实测洞的规模是 **22** 条自检（不是 44 ——
>   `--list` 新增 44 格 = 22 check + 22 selfcheck，那 22 个 check 格本来就在跑）。
>   gateselfcheck 的 52 条 id 全是旧树 legacy 格。**写了没人跑 = 没写。**
> - **丙**：**2026-11-07 之后的判据必须落本目录**；`scripts/` 根只允许存量（逐条登记在
>   `scripts/gates/legacy-allowlist.json`，上限 65 条、只减不增）。存量不强制搬（搬会打断
>   `guard-baselines.sh` 的登记路径），但**新增一律不许放根**。
>
> 有牙的判据：`scripts/gates/verify-gates-registry.mjs`（判据 A 孤儿 / 判据 B 放错层）。
>
> ⚠️ 历史注记：本行原写「权威依据：`docs/architecture-overview.md` §3.6.4」。实测该文档
> 章节只到 §3.5，**§3.6 从未存在**（`grep -cE '^#+ *3\.6' docs/architecture-overview.md` = 0）。
> 规则正文一直只散在 `docs/memory/` 的报告里，等于**判据在引用一个不存在的权威**。
> 2026-11-09（ISS-757）把规则正文搬到本文件，代码注释的引用改为指向本文件。

## 一、这层放什么

**判据实现**——一个判据一个脚本，脚本本身就是那条规则的机器形态：

- 判据脚本，一脚本一判据（例：`check-*.mjs`、`lint-*` 的继任者）。
- 每个判据脚本必须带 `--selftest`，且自检里要有**反向对照**（造一个必红样本，证明它真会红）。
  只有正向自检的门禁等于没有门禁：它绿的时候你分不清是"没问题"还是"判据坏了"。
- 判据只**读**、只**报告**，用退出码表达结论：`0` 干净 / `1` 违规 / `2` 判不了（INTERNAL）。

## 二、这层放什么（明确**不**放）

| 不属于这层 | 归属 | 为什么 |
|---|---|---|
| 调度器 `run-gates.mjs`（L3） | `scripts/` 根 | 调度是**唯一**的一个；放进本层会诱导每个判据自带调度逻辑，回到"多层调度"的老路 |
| 运维/开发脚本 `ws.sh`、`restart-*.sh`、`watchdog-*.sh`、`sync-*.sh`、`prod-guard.sh`、`dev-instance.sh` | `scripts/` 根 | 它们不是判据，不产出"干净/违规"结论 |
| 基线数据 `scripts/baseline/*.json` | `scripts/baseline/` | 数据与判据分开：基线是**被判的对象**，混放会让"改基线"和"改判据"分不清 |
| 判据共用的库（`*-lib.mjs`、`lint-common.mjs`） | 暂无定论 | 本层不接受"库"静默混入；真需要时先报架构决策，不自行增层 |

## 三、命名

`<域名>-<对象>.mjs`，全小写连字符：

- 域名 = 判据管的领域：`lint` / `check` / `gate` / `assembly` / `pm` / `design` / `md`。
- 对象 = 被judged的东西：`scripts` / `layer` / `token` / `baseline` / `code`。
- 反例：`new-gate.mjs`（域名对象都不明确）、`verify2.mjs`、`tmp-check.mjs`。

后缀语义固定：`*.test.mjs` = 该判据的单测（不是判据本身）。

## 四、存量政策

**旧文件一律不动。**

`scripts/` 根的存量脚本按「脚本 + 每脚本若干格」登记在 `scripts/gates/registry.json` 的 `kind:"legacy"` 条目里，
格数与来源由 `node scripts/run-gates.mjs --list` 现算（不在此手写）。
搬迁任何一个被登记的脚本 = 打断登记路径 = 该脚本的格整片变红，且没有任何判据能证明搬迁是等价的。
所以：

1. **存量留在 `scripts/` 根**，一条都不搬。
2. **新增判据必须落在本层**，并在 `scripts/gates/registry.json` 登记（`kind:"spec"`，`.ts` + 同名 `.spec.ts` + 至少一档）——否则 `verify-gate-registry.ts` 判红。
3. 存量判据带判据形态（`--selftest` / `rule:` / `{rule,metric,mode}`）的，登记在
   `scripts/gates/legacy-allowlist.json` 里逐条给出理由；理由空 ⇒ 判红。
4. 允许清单**只减不增**：`maxEntries` 是上限，加一条必须同时调高它（`git diff` 里看得见的一行，无法悄悄加）。

## 五、本判据自身的登记

`verify-gates-registry.mjs` 本身住在这一层，按它自己的判据 A 也必须出现在调度器登记里。
**已登记**：`run-gates.mjs` 的 standalone 条目 `gates-registry`（三档都跑），读现表用
`node scripts/run-gates.mjs --list`。

没有给自己开豁免口子——豁免清单里查不到它。

## 六、`status` 的语义与「退役一条判据」（ISS-853）

**`status` 不是标注字段，它是派生的开关。** 改它之前先读这一节。

### 一句话

**`status: "active"` 才会派生格。改 `"deprecated"` 就停跑。**

```js
// scripts/lib/registry-derive.mjs:259
return entries
  .filter((e) => e.status === "active")
  .flatMap(...)
```

⚠️ 这条是用「只留 active」实现的，所以**全仓 `grep "deprecated"` 会查不到任何判据逻辑** ——
`grep` 不到 ≠ 没有。2026-11-16 我据此误判过「status 被调度器无视」，写了一份要动调度器 + 元判据的方案（ISS-853 初版），是错的。

### 退役的四步（最少动作）

1. `scripts/gates/registry.json` 该条 `status` 改 `"deprecated"`
2. **`note` 必填**退役理由 —— 不写会红（见下表 `verify-gate-coverage` 一行）
3. **`tiers` 保留不清空** —— 清空会被 `verify-gate-registry` 判「登记了但永远不跑」
4. **脚本与 `.spec.ts` 保留不删** —— 删了触发悬空检查；且历史文档可能引用它们

### 谁会因为这个字段改变行为（6 个消费者，逐个查过）

| 消费者 | 对 `deprecated` 的反应 | 后果 |
|---|---|---|
| `scripts/lib/registry-derive.mjs:259` | `.filter(status === "active")` ⇒ **不派生格** | 停跑（这就是退役本身） |
| `scripts/gates/verify-gate-registry.ts` | **不读 status**；只查 `tiers` 非空 / `.ts` 在盘 / `.spec.ts` 存在 | 保留 tiers 与文件即通过 |
| **`scripts/gates/verify-gate-coverage.ts:303`** | **要求 `note` 非空**；脚本还在 ⇒ 进 `stale` 提示**（不红）** | ⚠️ **不写 note 即红** |
| `scripts/gates/lint-criteria-teeth.mjs:114` | `if (g.status && g.status !== 'active') continue` | 跳过（预期） |
| `scripts/gates/verify-freeze.mjs` | 只在**注释**里提到 registry，非真读 | 无关 |

### 「脚本还在」的提示不要消除

`verify-gate-coverage` 的注释原文：

> 「退役本就该删脚本 ⇒『deprecated + 脚本已删』是**正常终态**，判红等于逼人留住尸体。而『deprecated + 脚本还在』才是没清干净的残渣，提示可清理（**不红**）。两者都不是错，所以这一支不产生 findings —— 但它必须出声，不能静默 continue。」

⇒ 「可清理」是判据在诚实地说「还有残渣」，**不是缺陷**。

### 改 registry 时该跑哪些判据

**不要只跑自己想到的那两条。** 先列全消费者：

```bash
grep -rln "registry.json" scripts/gates/ scripts/lib/ | grep -v spec
```

然后逐条问「它会怎么反应」。2026-11-16 我只跑了 `--tier next` 与 `--only verify-gate-registry`，
漏了 `verify-gate-coverage` 的 note 硬约束 —— 这正是本节存在的理由。
