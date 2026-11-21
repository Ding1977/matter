#!/usr/bin/env node
// scripts/preset-parity-check.mjs
// 装配面守卫：home 级自定义预设（`$DSH_HOME/cordis.patch.yml`）必须与官方 `standard` 预设逐行对账。
//
// 为什么需要（2026-10-17 事故）：
//   0.2.1-rc.2 升级后 3210「每一轮运行失败」，报 `unknown prompt variable "{{cwd}}" ...
//   registered variables: provider, model`。根因不在引擎、也不在我们自己的包：
//   ① 引擎 0.2.1 删掉了提示词变量 `cwd`（改由 `dsh-working-directory` 的必需上下文下发）；
//   ② home patch 里 `preset-matter` 的人设后缀仍写着 `{{cwd}}`；
//   ③ 该 preset 的插件行是照 **0.2.0** 的官方 `standard` 手抄的 —— 升级后官方已删改若干行
//      （新增 time-context / tool-schedule / tool-plugin-market，删除 subagent_codex /
//      subagent_claude_code / tool-ralph），我们这边**没有任何东西会报警**。
//   ⇒ 手抄的装配面会随每次升级静默漂移。本守卫把「漂移」从真机报错提前到收工体检。
//
// 口径（与 `ws.sh guard` 的「功能面基线守卫」并列，同属收工/体检每次都跑的一层）：
//   官方真源 = 引擎包 `<…>/dsh-web-app/presets/standard.patch.yml`（随引擎版本走，不抄进仓库）。
//   比对项：顶层插件行的 **顺序 / id / name / disabled / config 文本**。
//   豁免项：`persona` 行只比 id 与 name —— 正文本来就是本项目身份稿，允许且应当不同。
//   只比 `plugins` 子树；四元信息（id / name / description / order）不在对账范围。
//   未纳入 `--target` 的其余自定义预设：同样算差异，但**只报不红**（可能有意裁剪）。
//
// 退出码（有牙，且读不到时**不许**当绿）：
//   0 = 全绿（可附带「只报不红」的提醒）
//   1 = 漂移（红）
//   3 = 不判（home patch / 官方标准 / 目标预设读不到 —— 显式说出来，由调用方降级为提醒）
//
// 用法：
//   node scripts/preset-parity-check.mjs                 # 默认：$DSH_HOME 或 ~/.dsh-matter，target=matter
//   node scripts/preset-parity-check.mjs --home <file> --official <file> --target matter,trader
//   node scripts/preset-parity-check.mjs --json
//   node scripts/preset-parity-check.mjs --selftest      # fixture 独立验「该红必须红」
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { home: undefined, official: undefined, target: 'matter', json: false, selftest: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--home') opt.home = argv[++i];
  else if (a === '--official') opt.official = argv[++i];
  else if (a === '--target') opt.target = argv[++i];
  else if (a === '--json') opt.json = true;
  else if (a === '--selftest') opt.selftest = true;
  else if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 32).join('\n'));
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

// ── 解析：把 patch 文本读成「预设 → 插件行列表」 ─────────────────────────────
// 只做本文件需要的最小解析（不引 yaml 依赖：home patch 带 `!!js` 非标准标签，
// 通用 YAML 库对未知标签会拒；本守卫要的又只是插件行的结构文本）。
const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => line.trim() === '';
const comment = (line) => /^\s*#/.test(line);

/** 提取 `- id: preset-*` 块（块止于下一行缩进 ≤ id 行且非空非注释的行）。 */
function presetBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- id: (preset-[A-Za-z0-9_-]+)\s*$/.exec(lines[i]);
    if (m === null) continue;
    const indent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (blank(lines[j]) || comment(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) { end = j; break; }
    }
    out.push({ rowId: m[2], block: lines.slice(i, end) });
    i = end - 1;
  }
  return out;
}

/** 块内 `config.id` 的值（预设对外身份）。 */
function presetId(block) {
  for (const line of block) {
    const m = /^\s{4,}id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (m !== null) return m[1];
  }
  return undefined;
}

/** 块内 `plugins:` 子树（去掉注释行与尾部空行）。 */
function pluginLines(block) {
  const start = block.findIndex((line) => /^\s*plugins:\s*$/.test(line));
  if (start < 0) return undefined;
  const pluginsIndent = indentOf(block[start]);
  const out = [];
  for (let j = start + 1; j < block.length; j++) {
    const line = block[j];
    if (!blank(line) && !comment(line) && indentOf(line) <= pluginsIndent) break;
    if (!comment(line)) out.push(line);
  }
  while (out.length > 0 && blank(out[out.length - 1])) out.pop();
  return out;
}

/** 插件顶层行（缩进 = 子树首行缩进）→ [{ id, text, baseIndent }] */
function pluginRows(subtree) {
  if (subtree === undefined || subtree.length === 0) return undefined;
  const first = subtree.find((line) => !blank(line));
  if (first === undefined) return undefined;
  const indent = indentOf(first);
  const starts = [];
  for (let i = 0; i < subtree.length; i++) {
    if (indentOf(subtree[i]) !== indent) continue;
    if (!/^- id:\s*\S+\s*$/.test(subtree[i].trim())) continue;
    starts.push(i);
  }
  return starts.map((start, k) => {
    const text = subtree.slice(start, k + 1 < starts.length ? starts[k + 1] : subtree.length);
    while (text.length > 0 && blank(text[text.length - 1])) text.pop();
    const id = /^- id:\s*(\S+)\s*$/.exec(text[0].trim())[1];
    return { id, text, baseIndent: indent };
  });
}

/** 只取「本行自己的」键（缩进 = 行首 +2），避免误抓 group 内嵌套行。 */
function ownField(row, name) {
  const want = row.baseIndent + 2;
  for (const line of row.text) {
    if (indentOf(line) !== want) continue;
    const m = new RegExp(`^\\s*${name}:\\s*(.*)$`).exec(line);
    if (m !== null) return m[1].trim();
  }
  return undefined;
}

/** config 段文本（含 group 的嵌套行；persona 之外的行按它比对）。 */
function configText(row) {
  const want = row.baseIndent + 2;
  const start = row.text.findIndex((line) => indentOf(line) === want && /^\s*config:\s*$/.test(line));
  if (start < 0) return '';
  return row.text.slice(start).map((line) => line.replace(/\s+$/, '')).join('\n');
}

const fingerprint = (row) => ({
  id: row.id,
  name: ownField(row, 'name'),
  disabled: ownField(row, 'disabled'),
  // persona 正文是身份稿，不比；其余（含 group 嵌套行、plan-mode section 文本）逐字比
  config: row.id === 'persona' ? '' : configText(row),
});

function readPresets(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const map = new Map();
  for (const { block } of presetBlocks(lines)) {
    const id = presetId(block);
    if (id === undefined || map.has(id)) continue;
    const rows = pluginRows(pluginLines(block));
    if (rows === undefined) continue;
    map.set(id, { rows: rows.map(fingerprint) });
  }
  return map;
}

// ── 对账 ─────────────────────────────────────────────────────────────────────
function compare(officialRows, customRows) {
  const diffs = [];
  const offIds = officialRows.map((r) => r.id);
  const cusIds = customRows.map((r) => r.id);
  const offSet = new Set(offIds);
  const cusSet = new Set(cusIds);
  const missing = offIds.filter((id) => !cusSet.has(id));
  const extra = cusIds.filter((id) => !offSet.has(id));
  if (missing.length > 0) diffs.push(`缺行：${missing.join(', ')}`);
  if (extra.length > 0) diffs.push(`多行：${extra.join(', ')}`);
  if (missing.length === 0 && extra.length === 0 && offIds.join('\n') !== cusIds.join('\n')) {
    const firstBad = offIds.findIndex((id, i) => id !== cusIds[i]);
    diffs.push(`行序不一致（第 ${firstBad + 1} 行起：官方 ${offIds[firstBad]} ≠ 本文件 ${cusIds[firstBad]}）`);
  }
  const offById = new Map(officialRows.map((r) => [r.id, r]));
  const cusById = new Map(customRows.map((r) => [r.id, r]));
  for (const id of offIds) {
    if (!cusSet.has(id)) continue;
    const a = offById.get(id);
    const b = cusById.get(id);
    if (a.name !== b.name) diffs.push(`${id}：name 不一致（官方 ${a.name} ≠ 本文件 ${b.name}）`);
    if (a.disabled !== b.disabled) diffs.push(`${id}：disabled 不一致（官方 ${a.disabled ?? '无'} ≠ 本文件 ${b.disabled ?? '无'}）`);
    if (a.config !== b.config) {
      const al = a.config.split('\n');
      const bl = b.config.split('\n');
      const at = al.findIndex((line, i) => line !== bl[i]);
      const idx = at < 0 ? Math.min(al.length, bl.length) : at;
      diffs.push(`${id}：config 漂移（首个差异在第 ${idx + 1} 行：官方「${(al[idx] ?? '').trim()}」≠ 本文件「${(bl[idx] ?? '').trim()}」）`);
    }
  }
  return diffs;
}

// ── 输入解析 ─────────────────────────────────────────────────────────────────
function resolveInputs() {
  // home patch 候选序：显式 --home > $DSH_HOME > ~/.dsh-matter > ~/.dsh。
  // 为什么要多级：agent 会话里的 DSH_HOME 可能是 App home（`~/.dsh`，没有 home 级 patch），
  // 而 3210 的装配住在 `~/.dsh-matter` —— 不 fallback 就会把「没东西可查」误报成「不判」。
  // 显式 --home 具有权威性（selftest / fixture 依赖它）；仅环境与默认序做 fallback。
  // 候选既可能是目录（取其中 cordis.patch.yml），也可能直接是文件（备份/夹具，名字不一定以 .yml 结尾）
  const asPatch = (h) => (fs.existsSync(h) && fs.statSync(h).isFile() ? h : path.join(h, 'cordis.patch.yml'));
  const candidates = (opt.home === undefined ? [process.env.DSH_HOME, path.join(HOME, '.dsh-matter'), path.join(HOME, '.dsh')] : [opt.home])
    .filter(Boolean)
    .map(asPatch);
  const homePatch = opt.home === undefined ? (candidates.find((p) => fs.existsSync(p)) ?? candidates[0]) : candidates[0];
  const officialCandidates = [
    opt.official,
    process.env.DSH_WEB_APP_STANDARD,
    path.join(path.dirname(homePatch), 'profiles/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'),
    path.join(HOME, 'dsh-local/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'),
    path.join(REPO, 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'),
  ].filter(Boolean);
  return { homePatch, official: officialCandidates.find((p) => fs.existsSync(p)) };
}

const targets = opt.target.split(',').map((s) => s.trim()).filter(Boolean);

// ── selftest：fixture 独立验「该红必须红、不判不绿」 ─────────────────────────
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-parity-'));
  const preset = (rows, presetId = 't') => [
    '- insert:',
    '    - id: preset-t',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${presetId}`,
    '        name: T',
    '        plugins:',
    ...rows.flatMap((r) => [
      `          - id: ${r.id}`,
      `            name: '@deepseek-ai/${r.id}'`,
      ...(r.extra ?? []),
    ]),
    '',
  ].join('\n');
  const persona = (prefix) => ['            config:', `              prefix: ${prefix}`];
  const official = preset([
    { id: 'persona', extra: persona('You are a coding agent powered by the {{model}} model.') },
    { id: 'agent-instructions' },
    { id: 'time-context' },
    { id: 'tool-bash', extra: ["            disabled: !!js process.platform === 'win32'"] },
  ], 'standard');
  const cases = [
    {
      name: '一致（persona 正文不同也应绿）',
      home: preset([
        { id: 'persona', extra: persona('你是本项目主 agent。') },
        { id: 'agent-instructions' },
        { id: 'time-context' },
        { id: 'tool-bash', extra: ["            disabled: !!js process.platform === 'win32'"] },
      ]),
      want: 0,
    },
    {
      name: '缺行 → 红',
      home: preset([
        { id: 'persona', extra: persona('x') },
        { id: 'agent-instructions' },
        { id: 'tool-bash', extra: ["            disabled: !!js process.platform === 'win32'"] },
      ]),
      want: 1,
    },
    {
      name: '多行 → 红',
      home: preset([
        { id: 'persona', extra: persona('x') },
        { id: 'agent-instructions' },
        { id: 'time-context' },
        { id: 'tool-bash', extra: ["            disabled: !!js process.platform === 'win32'"] },
        { id: 'tool-ralph' },
      ]),
      want: 1,
    },
    {
      name: '禁用态漂移 → 红',
      home: preset([
        { id: 'persona', extra: persona('x') },
        { id: 'agent-instructions' },
        { id: 'time-context' },
        { id: 'tool-bash' },
      ]),
      want: 1,
    },
  ];
  const officialFile = path.join(dir, 'official.yml');
  fs.writeFileSync(officialFile, official);
  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const homeFile = path.join(dir, `home-${i}.yml`);
    fs.writeFileSync(homeFile, c.home);
    const code = runChild(homeFile, officialFile);
    const ok = code === c.want;
    console.log(`${ok ? '✓' : '✗'} ${c.name}（want ${c.want} got ${code}）`);
    if (!ok) bad++;
  }
  const code = runChild(path.join(dir, 'missing.yml'), officialFile);
  const ok = code === 3;
  console.log(`${ok ? '✓' : '✗'} 输入读不到 → 不判（want 3 got ${code}）`);
  if (!ok) bad++;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad === 0 ? 'selftest 全绿' : `selftest 失败 ${bad} 项`);
  process.exit(bad === 0 ? 0 : 1);
}

function runChild(home, official) {
  const res = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, '--home', home, '--official', official, '--target', 't'],
    { encoding: 'utf8' },
  );
  return res.status === null ? -1 : res.status;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (opt.selftest) selftest();

const { homePatch, official } = resolveInputs();
const cannot = [];
if (!fs.existsSync(homePatch)) cannot.push(`home patch 读不到：${homePatch}`);
if (official === undefined) cannot.push('官方 standard 预设读不到（引擎包 dsh-web-app/presets/standard.patch.yml）');
if (cannot.length > 0) {
  console.log(`不判：${cannot.join('；')}（读不到不等于没问题）`);
  process.exit(3);
}

const homePresets = readPresets(homePatch);
const officialStandard = readPresets(official).get('standard');
if (officialStandard === undefined) {
  console.log(`不判：官方标准里没有 standard 预设（${official}）`);
  process.exit(3);
}

const report = { official, homePatch, targets: [], drifts: [], warnings: [] };
for (const id of targets) {
  const custom = homePresets.get(id);
  if (custom === undefined) {
    cannot.push(`目标预设读不到：${id}`);
    continue;
  }
  const diffs = compare(officialStandard.rows, custom.rows);
  report.targets.push({ id, rows: custom.rows.length, diffs });
  if (diffs.length > 0) report.drifts.push({ id, diffs });
}
// 「只报不红」：其余自定义预设也报漂移，但不置红（可能有意裁剪，未纳入对账）
for (const [id, custom] of homePresets) {
  if (targets.includes(id)) continue;
  const diffs = compare(officialStandard.rows, custom.rows);
  if (diffs.length > 0) report.warnings.push({ id, diffs });
}

if (opt.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const t of report.targets) {
    console.log(t.diffs.length === 0
      ? `✓ ${t.id}：${t.rows} 个插件行与官方 standard 逐行一致（persona 正文豁免）`
      : `✗ ${t.id}：与官方 standard 漂移 ${t.diffs.length} 处`);
    for (const d of t.diffs) console.log(`    · ${d}`);
  }
  for (const w of report.warnings) {
    console.log(`! ${w.id}：未纳入对账，但与官方 standard 漂移 ${w.diffs.length} 处（只报不红）`);
    for (const d of w.diffs) console.log(`    · ${d}`);
  }
  if (cannot.length > 0) console.log(`不判：${cannot.join('；')}`);
}

process.exit(cannot.length > 0 ? 3 : report.drifts.length > 0 ? 1 : 0);
