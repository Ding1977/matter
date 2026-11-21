#!/usr/bin/env node
/**
 * Agent Teams 补丁器 —— 给 DSH 运行时的两个官方包补三件事（ISS-634）
 *
 *   1. spawn_teammate 透传 agentPreset / agentOptions（teammate 可带预设装配）
 *   2. remove_teammate + TeamService.stopTeammate（成员可回收）
 *   3. 名额计数只数 active / provisioning（回收后能腾出名额）
 *
 * 为什么是补丁而不是 fork：
 *   引擎侧（dsh-subagent@0.2.1-rc.2）的 SubagentStartRequest 早已支持
 *   agentPreset / agentOptions / toolFilter / persona；缺的只是官方插件没把它们
 *   暴露到工具面。fork 两个包（~2500 行）换 10 处补丁，不划算。
 *
 * 用法：
 *   node scripts/patches/team-tools.mjs --check    # 只报告状态，不改盘
 *   node scripts/patches/team-tools.mjs            # 幂等应用（缺失才打）
 *   node scripts/patches/team-tools.mjs --revert   # 从备份回滚
 *
 * 关键纪律（2026-10-21 实测踩过）：
 *   **替换成功 ≠ 行为正确。** 第一版把 stopTeammate 插进了 TeamRoster 而不是
 *   TeamService（两层都有 interrupt，锚点撞了），语法合法、模块能加载，但工具
 *   调用时报 undefined。所以应用完必须跑行为断言，不能只看「已写入」。
 *
 * 运行时根目录可用环境变量覆盖：DSH_RUNTIME_ROOT（默认 <dsh>）
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME = process.env.DSH_RUNTIME_ROOT ?? '<dsh>'
const NM = join(RUNTIME, 'node_modules/@deepseek-ai')
const AT_PKG = 'dsh-experimental-agent-team'
const TT_PKG = 'dsh-experimental-tool-agent-team'
const AT = join(NM, AT_PKG, 'lib/index.js')
const TT = join(NM, TT_PKG, 'lib/index.js')
const REMOTES = join(NM, 'dsh-api-remotes/lib/client.js')
// 0.2.1 及更早的**手写 JSON-schema 传输面**（0.2.2 起由 zod 运行时派生，已消失）。
// 本补丁只打 zod 面；若目标版本仍带这个面，说明锚点集与版本不匹配，须在写入前拦下。
const LEGACY_SCHEMA_FACES = [
  ['host typert JSON-schema phase', join(NM, 'dsh-api-session-controller/lib/typert.host.js')],
  ['remote typert JSON-schema phase', join(NM, 'dsh-api-session-controller/lib/typert.remote-client.js')],
]
const LEGACY_SCHEMA_HEAD = '"phase":{"type":"string","enum":["failed","provisioning","active"'
// 备份目录必须跟运行时根**同源**：临时沙箱自测（DSH_RUNTIME_ROOT=/tmp/...）若共用
// 真实备份，--revert 会把真实运行时的原始文件拷进沙箱，往返验证就成了假绿。
const BACKUP = process.env.DSH_PATCH_BACKUP
  ?? (process.env.DSH_RUNTIME_ROOT === void 0
    ? join(process.env.HOME ?? '/tmp', '.dsh-matter/team-patch-backup')
    : join(RUNTIME, '.team-patch-backup'))

/**
 * 一处补丁。
 * - `probe`：判定「已应用」的片段；`count` 是它应有的出现次数（缺省 1）
 * - `old`：未应用时的锚点。字符串 = 单一前态；**数组 = 多种历史前态都算未应用**，
 *   与 `next` 等长数组一一对应（ISS-636：同一行代码有两个历史形态时用）
 * - `next`：替换文本
 */
const EDITS = [
  // ── 补丁 1：预设透传 ───────────────────────────────────────────
  {
    id: 'preset.spawn-request',
    file: AT,
    probe: `					...request.agentPreset !== void 0 ? { agentPreset: request.agentPreset } : {},`,
    old: `				request: {
					prompt: request.prompt,
					parent: root
				},`,
    next: `				request: {
					prompt: request.prompt,
					parent: root,
					...request.agentPreset !== void 0 ? { agentPreset: request.agentPreset } : {},
					...request.agentOptions !== void 0 ? { agentOptions: request.agentOptions } : {}
				},`,
  },
  {
    id: 'preset.tool-param',
    file: TT,
    probe: `				agentPreset: {
					type: "string",
					description: "Optional agent preset id mounted for this teammate only`,
    old: `				context: {
					type: "string",
					enum: ["fresh", "fork"],
					description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh."
				}
			},`,
    next: `				context: {
					type: "string",
					enum: ["fresh", "fork"],
					description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh."
				},
				agentPreset: {
					type: "string",
					description: "Optional agent preset id mounted for this teammate only (e.g. reviewer). Requires context=fresh (the spawn provider). The child gets that preset's persona and tool surface."
				}
			},`,
  },
  {
    id: 'preset.tool-pass',
    file: TT,
    probe: `					...args.agentPreset !== void 0 ? { agentPreset: args.agentPreset } : {},`,
    old: `					provider: context === "fork" ? config.forkProvider : config.freshProvider,
					signal: exec.signal`,
    next: `					provider: context === "fork" ? config.forkProvider : config.freshProvider,
					...args.agentPreset !== void 0 ? { agentPreset: args.agentPreset } : {},
					signal: exec.signal`,
  },

  // ── 补丁 2：成员回收 ──────────────────────────────────────────
  {
    id: 'remove.schema-phase',
    file: AT,
    probe: `		"active",
		"failed",
		"removed"
	]),`,
    old: `	phase: z$1.enum([
		"provisioning",
		"active",
		"failed"
	]),`,
    next: `	phase: z$1.enum([
		"provisioning",
		"active",
		"failed",
		"removed"
	]),`,
    count: 2,
  },
  {
    id: 'remove.transition',
    file: AT,
    probe: `				const removal = prior.phase === "active" && member.phase === "removed";`,
    old: `				if (prior.phase !== "provisioning" || member.phase === "provisioning") throw new Error(\`teammate "\${member.name}" has an invalid \${prior.phase} -> \${member.phase} transition\`);`,
    next: `				const removal = prior.phase === "active" && member.phase === "removed";
				if (!removal && (prior.phase !== "provisioning" || member.phase === "provisioning")) throw new Error(\`teammate "\${member.name}" has an invalid \${prior.phase} -> \${member.phase} transition\`);`,
  },
  {
    id: 'remove.status-map',
    file: AT,
    // ISS-636：这条补丁原本把 removed 折成 failed（1497 的权宜之计），本单改为保留。
    // 同一行代码只能有一个 owner —— 不能新加一个 id 去改同一行：a) 在没打过 1497 的
    // 原始树上，旧 id 会先把它改成中间态，新 id 的锚点就永远配不上；b) check() 读的是
    // 落盘原文，新 id 的 probe 与 old 都配不上最终态，会永久报锚点失配。
    // 所以用 old/next 等长数组表达两种历史前态 → 同一个最终态。
    probe: `member.phase === "removed" ? "removed" :`,
    old: [
      // 前态 A：1497 已打过的中间态（removed 被折成 failed）
      `member.phase === "removed" ? "failed" :`,
      // 前态 B：1497 之前的原始整行（没有 removed 分支）
      `				status: member.phase === "failed" ? "failed" : member.phase === "provisioning" ? "provisioning" : availability(live),`,
    ],
    next: [
      `member.phase === "removed" ? "removed" :`,
      `				status: member.phase === "failed" ? "failed" : member.phase === "removed" ? "removed" : member.phase === "provisioning" ? "provisioning" : availability(live),`,
    ],
  },

  {
    id: 'remove.slot-count',
    file: AT,
    probe: `			const occupied = state.members.filter((member) => member.phase === "active" || member.phase === "provisioning").length;`,
    old: `			if (state.members.length >= this.maxMembers) throw new TeamError(\`Team member limit \${this.maxMembers} reached\`, "TEAM_MEMBER_LIMIT");`,
    next: `			const occupied = state.members.filter((member) => member.phase === "active" || member.phase === "provisioning").length;
			if (occupied >= this.maxMembers) throw new TeamError(\`Team member limit \${this.maxMembers} reached\`, "TEAM_MEMBER_LIMIT");`,
  },
  {
    id: 'remove.roster-method',
    file: AT,
    probe: `	async stopTeammate(caller, targetName) {
		const membership = this.membership(caller);`,
    old: `		this.ctx.subagents.interrupt(target.id, {
			kind: "ancestor",
			agent: caller
		});
		return { previousStatus };
	}`,
    next: `		this.ctx.subagents.interrupt(target.id, {
			kind: "ancestor",
			agent: caller
		});
		return { previousStatus };
	}
	/**
	* Remove one durable teammate: stop its child Session and free its roster slot.
	* @param caller - exact live Lead Agent.
	* @param targetName - durable teammate name.
	* @returns the removed member identity and resulting phase.
	*/
	async stopTeammate(caller, targetName) {
		const membership = this.membership(caller);
		if (membership.role !== "lead") throw new TeamError("only the Team Lead can remove teammates", "TEAM_LEAD_REQUIRED");
		const state = this.journal.state(membership.root);
		const target = resolveActiveMember(membership.root, state, targetName);
		if (target.id === membership.root.id) throw new TeamError("the Team Lead cannot remove itself", "TEAM_INVALID_TARGET");
		await this.stopTeammates(membership.root, [target.id]);
		await this.journal.transact(membership.root.id, async () => {
			const current = this.journal.state(membership.root).members.find((member) => member.id === target.id);
			if (current === void 0 || current.phase !== "active") return;
			await this.journal.appendAndFlush(membership.root, "team/member", {
				version: 2,
				teamId: TeamId(membership.root.id),
				member: { ...current, phase: "removed", error: "removed by lead" }
			});
		});
		return { name: target.name, id: target.id, status: "removed" };
	}`,
  },
  {
    id: 'remove.service-forward',
    file: AT,
    probe: `	/** Remove one durable teammate: stop its Session and free its roster slot. */`,
    old: `	interrupt(caller, targetName) {
		return this.roster.interrupt(caller, targetName);
	}`,
    next: `	interrupt(caller, targetName) {
		return this.roster.interrupt(caller, targetName);
	}
	/** Remove one durable teammate: stop its Session and free its roster slot. */
	async stopTeammate(caller, targetName) {
		return await this.roster.stopTeammate(caller, targetName);
	}`,
  },
  {
    id: 'remove.tool',
    file: TT,
    probe: `			name: "remove_teammate",`,
    old: `		register(scoped.tools.register(defineTool({
			name: "team_task_create",`,
    next: `		register(scoped.tools.register(defineTool({
			name: "remove_teammate",
			description: "Remove one durable teammate: stops its child Session and frees its roster slot. Team Lead only. The member keeps its durable history but can no longer receive messages; its row stays in list_agents marked failed with a 'removed by lead' diagnostic.",
			parameters: { target: {
				type: "string",
				required: true,
				description: "Teammate target returned by list_agents."
			} },
			output: jsonOutput({
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					id: { type: "string", required: true },
					status: { type: "string", required: true }
				}
			}),
			async execute(args, exec) {
				return await ctx.agentTeams.stopTeammate(callingAgent(exec.agent, "remove_teammate"), args.target);
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_create",`,
  },

  // ── 补丁 3：API 传输层 schema（ISS-634 实锤：漏了这两套 ⇒ 会话历史加载失败） ──
  //   症状：failed to project session ... members[1].phase Invalid option: expected one of
  //   "provisioning"|"active"|"failed"。Team 服务自己的 schema 改了不够 ——
  //   host/remote API 的 typert 序列化 schema 是**另一套**，不放行 "removed" 就整段投影失败。
  {
    id: 'transport.host-phase',
    file: join(NM, 'dsh-api-session-controller/lib/typert.host.js'),
    probe: 'z.literal("active"), z.literal("removed")',
    old: 'z.union([z.literal("failed"), z.literal("provisioning"), z.literal("active")])',
    next: 'z.union([z.literal("failed"), z.literal("provisioning"), z.literal("active"), z.literal("removed")])',
    count: 5,
  },
  {
    id: 'transport.client-phase',
    file: join(NM, 'dsh-api-session-controller/lib/typert.remote-client.js'),
    probe: 'z.literal("active"), z.literal("removed")',
    old: 'z.union([z.literal("failed"), z.literal("provisioning"), z.literal("active")])',
    next: 'z.union([z.literal("failed"), z.literal("provisioning"), z.literal("active"), z.literal("removed")])',
    count: 5,
  },
  // ── 补丁 4：Web 名册把 removed 当未知状态（ISS-634 自查发现） ──
  //   症状：被回收的成员在 Team 名册里没有状态文案、没有圆点、还能点开（点开是空会话）。
  {
    id: 'ui.removed-status',
    file: join(NM, 'dsh-experimental-client-ui-agent-team/lib/client.js'),
    probe: `case "removed": return "memberStatus.failed";`,
    old: `\t\t\t\tcase "failed": return "memberStatus.failed";
\t\t\t}
\t\t}`,
    next: `\t\t\t\tcase "failed": return "memberStatus.failed";
\t\t\t\tcase "removed": return "memberStatus.failed";
\t\t\t}
\t\t}`,
  },
  {
    id: 'ui.removed-dot',
    file: join(NM, 'dsh-experimental-client-ui-agent-team/lib/client.js'),
    probe: `case "removed": return "error";`,
    old: `\t\t\t\tcase "failed": return "error";
\t\t\t}`,
    next: `\t\t\t\tcase "failed": return "error";
\t\t\t\tcase "removed": return "error";
\t\t\t}`,
  },

  // ════════════════════════════════════════════════════════════════════
  // ISS-636：三处可观测与边界缺口
  // ════════════════════════════════════════════════════════════════════

  // ── 缺口 ①：返回体不回显 agentPreset（spawn_teammate / list_agents 都看不到） ──
  //   后果：Lead 无法核对自己到底给了哪个预设；ISS-627 的「传了静默丢弃」因此不可观测。
  {
    id: 'echo.member-view-schema',
    file: TT,
    // 工具侧 schema 是 additionalProperties:false ⇒ 不声明就一定会被裁掉。
    // 边界收窄到 model 行：单看 agentPreset 行会与 spawn 参数声明撞形
    probe: `\t\tagentPreset: { type: "string" },\n\t\tmodel: { type: "string" },`,
    old: `\t\tcontext: {
\t\t\ttype: "string",
\t\t\tenum: ["fresh", "fork"]
\t\t},
\t\tmodel: { type: "string" },`,
    next: `\t\tcontext: {
\t\t\ttype: "string",
\t\t\tenum: ["fresh", "fork"]
\t\t},
\t\tagentPreset: { type: "string" },
\t\tmodel: { type: "string" },`,
  },
  {
    id: 'echo.member-view-fn',
    file: AT,
    // 服务侧 memberView：从子会话头读预设。sessions.get() 对已回收会话返回 undefined
    // ⇒ 必须 optional-chain，且缺省时**不写该键**（写 null 会被 output schema 拒）。
    // 必须带 context 行：3 tab 前缀是 4 tab（TeamRoster.list）的子串，单行 probe 会命中 2 处
    probe: `\t\t\tcontext: member.context,\n\t\t\t...this.ctx.sessions.get(member.id)?.header.agentPreset === void 0 ? {} : { agentPreset: this.ctx.sessions.get(member.id).header.agentPreset },`,
    old: `\t\t\tcontext: member.context,
\t\t\t...live?.options.model === void 0 ? {} : { model: live.options.model },
\t\t\tdiagnostics: []`,
    next: `\t\t\tcontext: member.context,
\t\t\t...this.ctx.sessions.get(member.id)?.header.agentPreset === void 0 ? {} : { agentPreset: this.ctx.sessions.get(member.id).header.agentPreset },
\t\t\t...live?.options.model === void 0 ? {} : { model: live.options.model },
\t\t\tdiagnostics: []`,
  },
  {
    id: 'echo.roster-list',
    file: AT,
    // 服务侧 TeamRoster.list 的 teammate 分支：同上。
    // 窄锚点（只碰 model 那两行），不跨到 status 行 —— status 由 remove.status-map 拥有。
    probe: `\t\t\t\t...this.ctx.sessions.get(member.id)?.header.agentPreset === void 0 ? {} : { agentPreset: this.ctx.sessions.get(member.id).header.agentPreset },`,
    old: `\t\t\t\t...model === void 0 ? {} : { model },`,
    next: `\t\t\t\t...this.ctx.sessions.get(member.id)?.header.agentPreset === void 0 ? {} : { agentPreset: this.ctx.sessions.get(member.id).header.agentPreset },
\t\t\t\t...model === void 0 ? {} : { model },`,
  },

  // ── 缺口 ②：spawn_teammate 参数拼错静默降级成 Lead 预设（提权） ──
  //   ISS-627 实测：传 agentPreset 给 teammate 被静默丢弃 ⇒ 子进程继承 Lead 的通用
  //   工具面（含 write/edit）。参数拼错（agentPresett）走的是同一条路：schema 不校验
  //   未知键、defineTool 只校验声明过的属性 ⇒ 越权静默发生。只碰这一个工具，不动全局
  //   additionalProperties（老板已拍板：影响面不可控，另单评估）。
  {
    id: 'strict.spawn-args',
    file: TT,
    probe: `\t\t\t\tassertKnownArgs("spawn_teammate", args, SPAWN_ARGS);`,
    old: `\t\t\tasync execute(args, exec) {
\t\t\t\tconst agent = callingAgent(exec.agent, "spawn_teammate");`,
    next: `\t\t\tasync execute(args, exec) {
\t\t\t\tassertKnownArgs("spawn_teammate", args, SPAWN_ARGS);
\t\t\t\tconst agent = callingAgent(exec.agent, "spawn_teammate");`,
  },
  {
    id: 'strict.spawn-args-helper',
    file: TT,
    probe: `function assertKnownArgs(toolName, args, accepted) {`,
    old: `/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */`,
    next: `/**
* Accepted arguments of one tool whose parameter schema keeps unknown keys open.
* A misspelled optional argument must fail loudly: silently dropping it can grant
* a teammate the Lead's default tool surface instead of the requested preset.
*/
const SPAWN_ARGS = Object.freeze(["name", "description", "prompt", "context", "agentPreset"]);
/**
* Reject arguments outside one tool's accepted set, listing what it does accept.
* @param toolName - model-facing tool name used in the error.
* @param args - model-generated argument record.
* @param accepted - the exact accepted property names.
* @throws Error naming every unknown key (sorted) and the accepted set.
*/
function assertKnownArgs(toolName, args, accepted) {
	const known = new Set(accepted);
	const unknown = Object.keys(args ?? {}).filter((key) => !known.has(key)).sort();
	if (unknown.length === 0) return;
	throw new Error(\`unknown argument\${unknown.length === 1 ? "" : "s"} \${unknown.map((key) => \`"\${key}"\`).join(", ")}; \${toolName} accepts: \${accepted.join(", ")}\`);
}
/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */`,
  },

  // ── 缺口 ③：removed 在工具面被折叠成 failed（服务侧 status 映射见 remove.status-map） ──
  //   工具侧 schema 必须放行 removed，否则 jsonOutput 的 schema 校验会把整行打回。
  {
    id: 'removed.view-enum',
    file: TT,
    probe: `\t\t\t\t"provisioning",
\t\t\t\t"failed",
\t\t\t\t"removed"
\t\t\t]`,
    old: `\t\t\t\t"provisioning",
\t\t\t\t"failed"
\t\t\t]`,
    next: `\t\t\t\t"provisioning",
\t\t\t\t"failed",
\t\t\t\t"removed"
\t\t\t]`,
  },

  // ── 缺口 ③ 传输层：ISS-634 事故形态（漏一层 ⇒ 整段会话历史加载失败） ──
  //   修的是 **zod 面**。0.2.1 时代 zod 与 JSON-schema 是两套手写面，必须各打一遍；
  //   0.2.2 起 JSON-schema 由 zod 经 `z.toJSONSchema` 运行时派生，只需补 zod
  //   （快照 IC-1877-1，复检：grep -rc '"provisioning"' 后看命中是否落在 z./zod.z. 而非 "enum"）。

  // ── 缺口 ③ 传输层 dsh-api-remotes/lib/client.js ──
  //   ⚠️ 这个文件里 z.literal("failed") 大量出现但**只有 5 处是 team-member phase**，
  //   其余属别的语义（账号授权流 / Loader fiberPhase / 终端 state / 审批 application
  //   / 远端 host-client 状态 / 安装 bundle），绝不能一起改。
  //
  //   定位法：认 "failed, provisioning, active" 这个**有序三元组**（团队 phase 的指纹），
  //   而不是认单个 "failed"。0.2.2 实测 5 处命中，全部是 zod 形态。
  //
  //   缩进不统一（4 处 8 tab、1 处 9 tab）⇒ 必须按缩进拆 id，一个 id 一个 count。
  //   禁止把它们并成一条蒙一个数。
  {
    id: 'removed.transport-remotes-zod-8',
    file: REMOTES,
    probe: `zod.z.union([
\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\tzod.z.literal("active"),
\t\t\t\t\t\t\t\tzod.z.literal("removed")
\t\t\t\t\t\t\t])`,
    old: `zod.z.union([
\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\tzod.z.literal("active")
\t\t\t\t\t\t\t])`,
    next: `zod.z.union([
\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\tzod.z.literal("active"),
\t\t\t\t\t\t\t\tzod.z.literal("removed")
\t\t\t\t\t\t\t])`,
    count: 4,
  },
  {
    id: 'removed.transport-remotes-zod-9',
    file: REMOTES,
    probe: `zod.z.union([
\t\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\t\tzod.z.literal("active"),
\t\t\t\t\t\t\t\t\tzod.z.literal("removed")
\t\t\t\t\t\t\t\t])`,
    old: `zod.z.union([
\t\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\t\tzod.z.literal("active")
\t\t\t\t\t\t\t\t])`,
    next: `zod.z.union([
\t\t\t\t\t\t\t\t\tzod.z.literal("failed"),
\t\t\t\t\t\t\t\t\tzod.z.literal("provisioning"),
\t\t\t\t\t\t\t\t\tzod.z.literal("active"),
\t\t\t\t\t\t\t\t\tzod.z.literal("removed")
\t\t\t\t\t\t\t\t])`,
    count: 1,
  },
]

const args = new Set(process.argv.slice(2))
const mode = args.has('--check') ? 'check' : args.has('--revert') ? 'revert' : 'apply'

/**
 * 一处补丁的**合法前态**。字符串 = 单一前态（常态）；数组 = 同一行有两种历史形态
 * 都算「未应用」（ISS-636：remove.status-map 会把 removed 折成 failed，本单要
 * 再把 failed 改成 removed —— 同一行代码，靠后的补丁不能靠加 new id 独立表达，
 * 否则 a) 未打过 1497 的原始树上旧 id 会把它先改成中间态、b) 打过后 probe 被改掉、
 * 旧 id 永久失配）。
 *
 * 判据不放宽：命中的前态必须**恰好一个**，且它在文本中出现的次数**恰好**等于
 * edit.count。两个前态同时命中 = 语义不清，按锚点失配处理。
 */
function preStates(edit) {
  return Array.isArray(edit.old) ? edit.old : [edit.old]
}

function readOrFail(file) {
  if (!existsSync(file)) {
    console.error(`✗ 找不到 ${file}\n  运行时根目录不对？用 DSH_RUNTIME_ROOT=... 指定。`)
    process.exit(3)
  }
  return readFileSync(file, 'utf8')
}

/** 补丁涉及的全部目标文件（去重；EDITS 增删时不用改这里） */
function patchFiles() {
  return [...new Set(EDITS.map((edit) => edit.file))]
}

/** 一次性载入所有目标文件（任一缺失即中止） */
function loadTexts() {
  return new Map(patchFiles().map((file) => [file, readOrFail(file)]))
}

function backupName(file) {
  return file.split('/node_modules/@deepseek-ai/')[1].replaceAll('/', '__')
}

function doBackup(file) {
  mkdirSync(BACKUP, { recursive: true })
  const dest = join(BACKUP, backupName(file))
  if (!existsSync(dest)) copyFileSync(file, dest)
  return dest
}

function revert() {
  let n = 0
  for (const file of patchFiles()) {
    const src = join(BACKUP, backupName(file))
    if (!existsSync(src)) {
      console.log(`- 无备份，跳过 ${file}`)
      continue
    }
    copyFileSync(src, file)
    n += 1
    console.log(`↩ 已回滚 ${file}`)
  }
  const total = patchFiles().length
  console.log(n === total
    ? `回滚完成（${n} 个文件，备份为首次补丁前的原始文件）`
    : `⚠️ 回滚不完整（${n}/${total}）：缺备份的文件保持现状`)
}

/**
 * 解析「这条补丁在当前文本上该做什么」。
 *
 * @returns {{state:'applied'|'missing'|'partial'|'mismatch', pairs:Array<{old:string,next:string}>, hits:number}}
 *   applied  = probe 恰好 count 处
 *   missing  = 恰有一个前态命中，且命中次数等于 count（可直接替换）
 *   partial  = probe 部分命中（半截）
 *   mismatch = 前态命中次数不对 / 多个前态同时命中 / 一个都没命中
 */
function inspectEdit(edit, hay) {
  const expected = edit.count ?? 1
  const probeHits = hay.split(edit.probe).length - 1
  if (probeHits === expected) return { state: 'applied', pairs: [], hits: probeHits }
  if (probeHits > 0) return { state: 'partial', pairs: [], hits: probeHits }

  const olds = preStates(edit)
  const nexts = Array.isArray(edit.next) ? edit.next : olds.map(() => edit.next)
  if (Array.isArray(edit.next) && edit.next.length !== olds.length) {
    throw new Error(`${edit.id}: old/next 数组长度不一致（${olds.length} vs ${edit.next.length}）`)
  }
  const matched = olds
    .map((old, index) => ({ old, next: nexts[index], hits: hay.split(old).length - 1 }))
    .filter((entry) => entry.hits > 0)
  // 两个前态同时命中 ⇒ 语义不清（可能一处已换、另一处还没），不做猜测
  if (matched.length !== 1) return { state: 'mismatch', pairs: [], hits: matched.length }
  if (matched[0].hits !== expected) return { state: 'mismatch', pairs: [], hits: matched[0].hits }
  return { state: 'missing', pairs: matched, hits: matched[0].hits }
}

function check() {
  const texts = loadTexts()
  let applied = 0
  let missing = 0
  let conflict = 0
  for (const edit of EDITS) {
    const hay = texts.get(edit.file)
    const expected = edit.count ?? 1
    const outcome = inspectEdit(edit, hay)
    // C1（审查 ISS-634）：probe 只命中一次就判「已应用」是假绿 ——
    //   一处 count=5 的补丁只打了 1 处，旧判据仍报全绿，而这正是本单事故的形态。
    if (outcome.state === 'applied') {
      applied += 1
      continue
    }
    if (outcome.state === 'partial') {
      conflict += 1
      console.log(`✗ 半截补丁 ${edit.id}：probe 命中 ${outcome.hits}/${expected}（部分站点已打，必须人工核对）`)
      continue
    }
    if (outcome.state === 'missing') {
      missing += 1
      console.log(`· 未应用 ${edit.id}`)
      continue
    }
    conflict += 1
    console.log(`✗ 锚点失配 ${edit.id}（期望 ${expected} 处前态；实际命中 ${outcome.hits} 个前态分组，上游可能已改，需人工核对）`)
  }
  console.log(`\n补丁状态：已应用 ${applied}/${EDITS.length}，缺失 ${missing}，锚点失配 ${conflict}`)
  return missing === 0 && conflict === 0 ? 0 : 1
}

function apply() {
  const texts = loadTexts()
  const todo = []
  for (const edit of EDITS) {
    const hay = texts.get(edit.file)
    const expected = edit.count ?? 1
    const outcome = inspectEdit(edit, hay)
    if (outcome.state === 'applied') continue
    if (outcome.state === 'partial') {
      console.error(`✗ 中止 ${edit.id}：半截补丁（probe 命中 ${outcome.hits}/${expected}），先人工核对再重跑`)
      process.exit(2)
    }
    if (outcome.state === 'mismatch') {
      console.error(`✗ 中止 ${edit.id}：锚点期望 ${expected} 处，实际命中 ${outcome.hits} 个前态分组`)
      console.error('  未写入任何文件。上游版本可能已变，请人工核对。')
      process.exit(2)
    }
    todo.push({ edit, pair: outcome.pairs[0] })
  }
  // 旧 JSON-schema 面（0.2.1 及更早）没有对应锚点 —— 该面存在而我们只打 zod，
  // 会静默留下「zod 放行但 JSON-schema 不放行」的半截状态（ISS-634 事故形态）。
  // 这里在**写入前**拦住：宁可一字不写，也不留半截。
  for (const [label, file] of LEGACY_SCHEMA_FACES) {
    const text = texts.get(file)
    if (text === void 0) continue
    const bare = text.split(LEGACY_SCHEMA_HEAD + ']').length - 1
    if (bare > 0) {
      console.error(`✗ 中止：${label} 存在 ${bare} 处手写 JSON-schema phase 面，但本补丁只打 zod 面。`)
      console.error('  该版本需配套的 JSON-schema 锚点（0.2.1 时代形态），未写入任何文件。')
      process.exit(2)
    }
  }
  if (todo.length === 0) {
    console.log('✓ 补丁已在位，无需改动')
    return
  }
  for (const file of texts.keys()) doBackup(file)
  for (const { edit, pair } of todo) {
    const before = texts.get(edit.file)
    texts.set(edit.file, before.split(pair.old).join(pair.next))
    console.log(`+ ${edit.id}`)
  }
  for (const [file, text] of texts) writeFileSync(file, text, 'utf8')
  console.log(`✓ 已应用 ${todo.length} 处（备份在 ${BACKUP}）`)
}

/**
 * 装配一个足够真实的 Team 工具面，用于**行为级**断言（不是 grep）。
 *
 * 为什么能做到：tool-agent-team 的 `apply(ctx)` 只用 `ctx.agents.list()` /
 * `ctx.agentTeams.tryMembership()` / `scoped.tools.register()` / `scoped.systemPrompt.*`
 * 这几样，全部可以用几十行桩喂饱；`defineTool` 会把参数 spec 编译成真正的 JSON Schema，
 * 所以拿到的 `tool.parameters` / `tool.output.schema` 就是**模型真正看到的**那份。
 * 同理 TeamService 的 roster.list() 只需 `ctx.reflect.provide` + 可控 journal。
 *
 * @returns {{tools: Map<string, any>, roster: (members:any[], headers:Map<string,any>) => any[]}|undefined}
 */
async function loadTeamSurfaces() {
  const at = await import(pathToFileURL(join(NM, AT_PKG, 'lib/index.js')).href)
  const tt = await import(pathToFileURL(join(NM, TT_PKG, 'lib/index.js')).href)

  const tools = new Map()
  const scoped = {
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
    },
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  }
  const agent = { id: 'agent-lead', ctx: scoped }
  // listMembers 由断言按场景覆写：它是 list_agents.execute 的唯一真实入口
  const agentTeams = {
    tryMembership: () => ({ role: 'lead' }),
    listMembers: () => [],
    spawnTeammate: () => { throw new Error('assertBehavior stub: spawnTeammate not wired') },
  }
  tt.apply({
    agents: { list: () => [agent] },
    agentTeams,
    on: () => {},
    effect: () => {},
  }, {})

  /**
   * 造一个受控 TeamService：`agentTeams.listMembers` 走它 ⇒ 工具断言拿到的是
   * **真实服务路径**产出的行（roster.list → memberView），不是手搓的假行。
   * @param members - journal 里的成员行（含 phase）
   * @param headers - session id → header（模拟含/不含 agentPreset 两种子会话）
   */
  const serviceFor = async (members, headers) => {
    const sessions = {
      get: (id) => headers.has(id) ? { header: headers.get(id) } : void 0,
    }
    const ctx = {
      agents: { list: () => [], get: () => void 0 },
      sessions,
      sessionPersistence: {},
      sessionProjections: { register: async () => () => {} },
      subagents: {},
      reflect: { provide: () => {} },
      on: () => {},
      effect: () => {},
    }
    ctx.root = ctx
    const service = new at.TeamService(ctx, {})
    // 0.2.2 起 journal/roster/tasks 从构造函数挪进 `[Service.init]` 钩子（0.2.1 在构造函数里建）。
    // 两种形态都撑住：roster 为空就先跑 init，否则直接可用。
    if (service.roster === void 0) {
      const init = Object.getOwnPropertySymbols(at.TeamService.prototype)
        .find((sym) => sym.description === 'cordis.init')
      if (init === void 0) throw new Error('TeamService 既无 roster 也无 cordis.init 钩子，装配无法继续')
      await service[init]()
      if (service.roster === void 0) throw new Error('Service.init 执行后 roster 仍为空')
    }
    service.roster.journal = { state: () => ({ members }) }
    // 只把「调用者身份解析」桩掉（那需要完整 Agent 运行时）；roster.list 保持真身，
    // 断言要验的正是 roster.list → memberView 这条真实路径。
    service.roster.tryMembership = () => ({ root: { id: 'root-1', options: {} }, id: 'root-1', role: 'lead', name: 'lead' })
    return service
  }

  /** 直接用受控 journal 驱动 TeamRoster.list()。 */
  const rosterList = async (members, headers) =>
    (await serviceFor(members, headers)).roster.list({ root: { id: 'root-1', options: {} } })

  return { tools, rosterList, serviceFor, agentTeams, agent }
}

/** 取一个工具的真实编译产物（模型看到的 schema），不存在则记失败 */
function toolOf(surfaces, name, failures) {
  const tool = surfaces.tools.get(name)
  if (tool === void 0) failures.push(`工具 ${name} 未注册`)
  return tool
}

/** 行为断言：补丁在盘上不等于在运行时生效 */
async function assertBehavior() {
  const failures = []
  let surfaces
  try {
    surfaces = await loadTeamSurfaces()
  } catch (err) {
    // 运行时根不完整（装配没装好 / 路径不对）⇒ 不算「断言通过」
    console.error(`✗ 行为断言无法执行（运行时根不完整）：${err.message}`)
    return false
  }
  const { tools, rosterList } = surfaces

  // ── ISS-634 既有断言 ─────────────────────────────────────────
  if (!tools.has('remove_teammate')) failures.push('remove_teammate 工具未注册')
  if (!tools.has('spawn_teammate')) failures.push('spawn_teammate 工具未注册')

  // ── 缺口 ①：agentPreset 必须真的出现在模型可见的 schema 与真实返回里 ──
  const listAgents = toolOf(surfaces, 'list_agents', failures)
  const spawnTeammate = toolOf(surfaces, 'spawn_teammate', failures)

  if (listAgents !== void 0) {
    // list_agents 的 output schema 是 MEMBER_VIEW_SCHEMA（items 即成员行）
    const props = listAgents.output?.schema?.items?.properties ?? {}
    if (props.agentPreset === void 0) {
      failures.push('list_agents 的返回 schema 未声明 agentPreset（真实返回体里会被裁掉）')
    }
  }
  if (spawnTeammate !== void 0) {
    const props = spawnTeammate.output?.schema?.properties?.member?.properties ?? {}
    if (props.agentPreset === void 0) {
      failures.push('spawn_teammate 的返回 schema 未声明 agentPreset')
    }
  }

  // 服务侧真实行为：带预设的子会话 ⇒ 行里有 agentPreset；子会话已回收 ⇒ 不写该键
  const echoed = await rosterList(
    [{ id: 'm-live', name: 'alpha', phase: 'active', description: 'd', provider: 'spawn', context: 'fresh' }],
    new Map([['m-live', { agentPreset: 'reviewer' }]]),
  )
  const liveRow = echoed.find((row) => row.id === 'm-live')
  if (liveRow?.agentPreset !== 'reviewer') {
    failures.push(`TeamRoster.list 未回显 agentPreset（实际 ${JSON.stringify(liveRow?.agentPreset)}）`)
  }
  const recycled = await rosterList(
    [{ id: 'm-gone', name: 'beta', phase: 'removed', description: 'd', provider: 'spawn', context: 'fresh' }],
    new Map(), // 会话已回收 ⇒ sessions.get() 返回 undefined
  )
  const goneRow = recycled.find((row) => row.id === 'm-gone')
  if (goneRow !== void 0 && 'agentPreset' in goneRow) {
    failures.push(`会话已回收时不应写 agentPreset 键（实际 ${JSON.stringify(goneRow.agentPreset)}）`)
  }

  // ── 缺口 ②：未知参数必须抛错，且错误消息列出可用参数 ──
  if (spawnTeammate !== void 0) {
    const exec = { agent: { id: 'agent-lead' } }
    const okArgs = { name: 'alpha', description: 'd', prompt: 'p' }
    // 先把 spawnTeammate 桩设成「被调用即记录」，这样：白名单拦下 ⇒ 桩一次都不该被调；
    // 白名单失效 ⇒ 桩被调到（不论桩抛不抛，都能判出来）。
    let reachedSpawn = false
    surfaces.agentTeams.spawnTeammate = () => { reachedSpawn = true; throw new Error('stub: reached spawnTeammate') }
    try {
      await spawnTeammate.execute({ ...okArgs, agentPresett: 'reviewer' }, exec)
      failures.push('spawn_teammate 接受了未知参数 agentPresett（拼错会被静默丢弃 ⇒ 提权）')
    } catch (err) {
      const message = String(err?.message ?? '')
      // 必须是白名单自己抛的错，且点名拼错的键 + 列出可用参数。
      // 不认「只要抛错就算过」：桩的副作用抛错同样会抛，那会让断言假绿。
      if (!/^unknown argument/.test(message)) {
        failures.push(`未知参数未由白名单拒绝（实际抛错：${message}）`)
      } else {
        if (!message.includes('"agentPresett"')) failures.push(`未知参数报错未点名拼错的键：${message}`)
        const accepted = ['name', 'description', 'prompt', 'context', 'agentPreset']
        const missing = accepted.filter((key) => !message.includes(key))
        if (missing.length > 0) failures.push(`未知参数报错未列出可用参数 ${JSON.stringify(missing)}：${message}`)
      }
      if (reachedSpawn) failures.push('未知参数穿过了白名单、到达 spawnTeammate（提权已发生）')
    }
    // 反向：合法参数不能被白名单误伤（走到 spawnTeammate 才算过白名单）
    reachedSpawn = false
    try {
      await spawnTeammate.execute({ ...okArgs }, exec)
    } catch (err) {
      if (String(err?.message ?? '').startsWith('unknown argument')) {
        failures.push(`spawn_teammate 把合法参数误判为未知参数：${err?.message}`)
      }
    }
    if (!reachedSpawn) failures.push('合法参数未到达 spawnTeammate（白名单误伤或路径断了）')

    // spawn_teammate 的返回体（含 agentPreset）同样受 additionalProperties:false 约束。
    // 走真实 memberView：让真实 TeamService 的 spawn 路径产出 member，再核契约。
    const spawnService = await surfaces.serviceFor([], new Map())
    surfaces.agentTeams.spawnTeammate = () => {
      // memberView 是服务侧真实实现，直接调它 → 契约漂移能被抓到
      const member = { id: 'm-new', name: 'delta', phase: 'active', description: 'd', provider: 'spawn', context: 'fresh' }
      return { member: spawnService.roster.memberView(member) }
    }
    try {
      const spawned = await spawnTeammate.execute({ ...okArgs }, exec)
      const memberSchema = spawnTeammate.output?.schema?.properties?.member ?? {}
      const memberProps = memberSchema.properties ?? {}
      const foreign = Object.keys(spawned.member ?? {}).filter((key) => !(key in memberProps))
      if (foreign.length > 0) {
        failures.push(`spawn_teammate 真实返回含 schema 外键 ${JSON.stringify(foreign)}（会被 output 校验打回）`)
      }
      const spawnStatuses = memberProps.status?.enum ?? []
      if (!spawnStatuses.includes('removed')) {
        failures.push(`spawn_teammate 的 status 枚举缺 removed（实际 ${JSON.stringify(spawnStatuses)}）`)
      }
    } catch (err) {
      failures.push(`spawn_teammate.execute 抛错：${err?.message}`)
    }
  }

  // ── 缺口 ③：removed 不得再被折叠成 failed ──
  if (listAgents !== void 0) {
    const statusEnum = listAgents.output?.schema?.items?.properties?.status?.enum ?? []
    if (!statusEnum.includes('removed')) {
      failures.push(`list_agents 的 status 枚举缺 removed（实际 ${JSON.stringify(statusEnum)}）`)
    }
  }
  const removedRows = await rosterList(
    [{ id: 'm-gone', name: 'beta', phase: 'removed', description: 'd', provider: 'spawn', context: 'fresh', error: 'removed by lead' }],
    new Map(),
  )
  const removedRow = removedRows.find((row) => row.id === 'm-gone')
  if (removedRow?.status !== 'removed') {
    failures.push(`TeamRoster.list 把 removed 折叠成了 ${JSON.stringify(removedRow?.status)}（应为 removed）`)
  }

  // ── 契约校验：真实 execute 产出的行不得越过 additionalProperties:false 的 schema ──
  //   这一条抓的是「schema 声明了 agentPreset、但真实返回里有 schema 外键」这类
  //   两端不匹配 —— 只查 schema 声明查不到，只有跑真实 execute 才查得到。
  if (listAgents !== void 0) {
    // 走真实服务路径：listMembers → roster.list → memberView。
    // 若这里换成手搓的假行，host/服务两端契约漂移（schema 声明了但服务不产出、
    // 或服务产出 schema 外键）就永远查不出来 —— 那正是本单要防的形态。
    const service = await surfaces.serviceFor(
      [
        { id: 'm-a', name: 'alpha', phase: 'active', description: 'd', provider: 'spawn', context: 'fresh' },
        { id: 'm-c', name: 'charlie', phase: 'removed', description: 'd', provider: 'spawn', context: 'fresh', error: 'removed by lead' },
      ],
      new Map([['m-a', { agentPreset: 'reviewer' }]]),
    )
    surfaces.agentTeams.listMembers = (caller) => service.listMembers(caller)
    try {
      const visible = await listAgents.execute({}, { agent: surfaces.agent })
      const itemProps = listAgents.output?.schema?.items?.properties ?? {}
      const statuses = itemProps.status?.enum ?? []
      const foreign = [...new Set(visible.flatMap((row) => Object.keys(row).filter((key) => !(key in itemProps))))]
      if (foreign.length > 0) {
        failures.push(`list_agents 真实返回含 schema 外键 ${JSON.stringify(foreign)}（会被 output 校验打回）`)
      }
      const outOfEnum = visible.filter((row) => !statuses.includes(row.status)).map((row) => row.status)
      if (outOfEnum.length > 0) {
        failures.push(`list_agents 真实返回含枚举外 status ${JSON.stringify(outOfEnum)}`)
      }
      const withPreset = visible.find((row) => row.target === 'alpha')
      if (withPreset?.agentPreset !== 'reviewer') {
        failures.push(`list_agents 真实返回未带出 agentPreset（实际 ${JSON.stringify(withPreset?.agentPreset)}）`)
      }
      const removedVisible = visible.find((row) => row.target === 'charlie')
      if (removedVisible?.status !== 'removed') {
        failures.push(`list_agents 真实返回把 removed 折叠成了 ${JSON.stringify(removedVisible?.status)}`)
      }
    } catch (err) {
      failures.push(`list_agents.execute 抛错：${err?.message}`)
    }
  }

  // ── 传输层：枚举类补丁按站点计数核（H1 / ISS-634 事故形态） ──
  for (const [label, file, needle, expected] of [
    ['host typert zod phase', join(NM, 'dsh-api-session-controller/lib/typert.host.js'), 'z.literal("active"), z.literal("removed")', 5],
    ['remote typert zod phase', join(NM, 'dsh-api-session-controller/lib/typert.remote-client.js'), 'z.literal("active"), z.literal("removed")', 5],
    ['remotes typert zod phase', REMOTES, 'zod.z.literal("removed")', 5],
    ['Web 名册 removed 分支', join(NM, 'dsh-experimental-client-ui-agent-team/lib/client.js'), 'case "removed":', 2],
  ]) {
    if (!existsSync(file)) {
      failures.push(`${label} 文件不存在`)
      continue
    }
    const n = readFileSync(file, 'utf8').split(needle).length - 1
    if (n !== expected) failures.push(`${label} 补丁不全（${n}/${expected} 站点）`)
  }

  // ── 旧 JSON-schema 面守护（0.2.1 及更早） ──
  //   0.2.2 起该面消失（由 zod 派生），本断言在 0.2.2 上恒真空通过。
  //   但只要目标版本仍有手写 JSON-schema phase 面，它就必须带上 removed ——
  //   否则整段会话投影会因 "Invalid option" 失败（ISS-634 事故形态）。
  for (const [label, file] of LEGACY_SCHEMA_FACES) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const bare = text.split(LEGACY_SCHEMA_HEAD + ']').length - 1
    const ok = text.split(LEGACY_SCHEMA_HEAD + ',"removed"]').length - 1
    if (bare > 0) {
      failures.push(`${label} 仍有 ${bare} 处未含 removed（该面存在就必须打：${ok} 处已含）`)
    }
  }

  if (failures.length > 0) {
    console.error('✗ 行为断言失败：')
    for (const f of failures) console.error(`  - ${f}`)
    return false
  }
  console.log('✓ 行为断言全绿：agentPreset 回显（含回收态不写键）/ spawn 未知参数抛错 / removed 保持 / 传输层 4 组站点计数')
  return true
}

if (mode === 'revert') {
  revert()
  process.exit(0)
}
if (mode === 'check') {
  const code = check()
  const ok = await assertBehavior()
  process.exit(code === 0 && ok ? 0 : 1)
}
apply()
const ok = await assertBehavior()
process.exit(ok ? 0 : 1)
