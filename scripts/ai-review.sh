#!/usr/bin/env bash
#
# ⛔ 已废止（ISS-628 · 2026-10-20 老板裁决「废掉」）—— **不要再使用本脚本**。
#
# 废止日期：2026-10-20
# ⚠️ 2026-11-02：`scripts/merge-iss.sh` 与 `forge-pm/lib/auto-merge*.js` 已一并删除。
#    下方提及它们的内容是**废止史**，不是可执行路径。
# 废止原因：本脚本是「自动合并闭环」的一环 ——
#   · `ai-review.sh` 第 8 段把审查结论回写成 issue frontmatter 的 `aiReview` 字段；
#   · `merge-iss.sh` 的门禁 1 与 `--auto` 判据读的也是这个字段。
#   而 `aiReview.by === "reviewer"` 是**自报自由文本、链上无第三方核对**（ISS-613 一审实证为自举漏洞）；
#   2026-10-20 又实测「合并」与「done」都不经过它 ⇒ 整套作为「谁写了就唤醒一次自动合并」的
#   半死旁路，已按老板裁决下线（`forge-pm/lib/auto-merge*.js` 同批加废止头、`/forge-pm/auto-merge` 端点退役）。
#
# 替代路径：
#   · 审查结论 → 落**单据 note**（`matter_issue note`：append-only、有 actor、有时间、可追溯）；
#   · 合并     → Lead 收口 + 门禁（落点 `done-gate` 仍有效，那是另一套带牙的判据）；
#   · done     → 老板批（`status: done` 当前无闸，属纪律而非机制）。
#
# 保留形态：**不物理删除**（历史可查：当年门禁怎么判、判据长什么样）。
#   文件内容未改动，但跑它不再有任何闭环语义 —— 它写进去的 `aiReview` 现在只是一个普通字段。
# AI 自动审查（issue 内闭环 V0）—— DOC-225 / ISS-421
#
# 用法：
#   scripts/ai-review.sh <ISS-NNN> [--agent <agentId>] [--base <ref>] [--no-open] [--timeout <sec>] [--dry-run]
#
# 环境变量：FORGE_PM_API（默认 http://127.0.0.1:3210/forge-pm）、FORGE_PM_ROOT（默认 ~/.dsh/pm）
#           ——对接隔离验证实例（dev-instance 3211）时覆盖。
#
# 流程：读 issue → 定 diff 区间（worktree 分支 / 已 merge 区间）→ 组装审查 prompt
#       （内联 skills/ai-reviewer 知识包 + REVIEW_GUIDE + spec + diff）→ 派单（默认 copilot 通道）
#       → 轮询终态 → 回收报告 → 解析 verdict → 回写 issue（锚定评论 + aiReview + note）
#       → 打开 VS Code（worktree 模式）。
#
# ⚠️ ISS-690（2026-09-21）换轨：派单从 `POST /agent/dispatch`（**必落 RUN 文件**）
#    改为 `POST /queue {action:create}` —— ISS-652 的新派单路（会话优先，零 RUN 文件）。
#    · 锚点：会话路 = `sessionId`（薄表 dispatch_link）· 回落路 = `runId`
#    · 轮询：会话路查 `GET /dispatch-links?issueId=`，回落路查 `GET /agent/runs?issueId=`
#      （`listRuns` 会带上瞬态行，故两条路都不依赖 run 文件）
#    · 兜底：报告文件缺失时，会话路取薄表 `lastText`，回落路才读 run events
#    为什么必须换：本脚本是遗留路由"唯一生产调用方"，它要 runId 就把落盘语义钉死在那儿 ——
#    而实测**真正往存量添文件的是裸派单自检**（`issueId:""`）。两处一起收口才叫"零 RUN 文件"。
#
# 产出：issue 时间线内一条 AI 审查报告评论 + frontmatter.aiReview 摘要（含 sessionId 或 runId）。
# 本脚本不 merge、不改 issue 状态——merge 由 Lead 收口（老板终审后）。
set -euo pipefail

ISS=""
AGENT_ID=""
BASE_REF="main"
OPEN_VSC=1
TIMEOUT_SEC=900
POLL_INTERVAL=10
DRY_RUN=0

usage() { grep '^# 用法：' -A 2 "$0" | sed 's/^# \{0,2\}//'; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)    AGENT_ID="$2"; shift 2 ;;
    --base)     BASE_REF="$2"; shift 2 ;;
    --no-open)  OPEN_VSC=0; shift ;;
    --timeout)  TIMEOUT_SEC="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage ;;
    -*)         echo "未知参数: $1" >&2; usage ;;
    *)          [[ -z "$ISS" ]] || { echo "多余参数: $1" >&2; usage; }; ISS="$1"; shift ;;
  esac
done
[[ -n "$ISS" && "$ISS" =~ ^ISS-[0-9]+$ ]] || { echo "第一个参数必须是 ISS-NNN" >&2; usage; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PM_ROOT="${FORGE_PM_ROOT:-${HOME}/.dsh/pm}"
# ISS-570 线 #1：agent 数据（runs/sessions/agents/state）已搬到 AGENTS_ROOT。
# 优先环境变量，其次新目录，最后回落 PM 根——最后一档是给**还没搬数据的机器**用的
# （双电脑同步：代码先过去、数据后过去），不是给已搬家环境留的兜底。
AGENTS_ROOT="${FORGE_AGENTS_ROOT:-}"
[[ -z "$AGENTS_ROOT" ]] && { [[ -d "${HOME}/.dsh/agent-runs/runs" ]] && AGENTS_ROOT="${HOME}/.dsh/agent-runs" || AGENTS_ROOT="$PM_ROOT"; }
INCOMING_DIR="${PM_ROOT}/review-incoming"
RUNS_DIR="${AGENTS_ROOT}/runs"
PM_API="${FORGE_PM_API:-http://127.0.0.1:3210/forge-pm}"
SKILL_DIR="${REPO_ROOT}/skills/ai-reviewer"

log()  { printf '\033[32m[ai-review]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ai-review]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ai-review]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 定位 issue（排除 -activity/-comments 等侧车日志）────────
ISSUE_FILE="$(ls -t "${PM_ROOT}/issues/"*"${ISS}"*.md 2>/dev/null | grep -v -- '\(-activity\|-comments\)\.md$' | head -1 || true)"
[[ -n "$ISSUE_FILE" ]] || die "找不到 ${ISS} 对应的 issue 文件"
ISSUE_REL="issues/$(basename "$ISSUE_FILE")"
log "issue: ${ISSUE_REL}"

# frontmatter 简析（yaml 子集：key: value 行）
fm_read() { # $1=key → 输出 value（去引号）
  python3 - "$ISSUE_FILE" "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---", text, re.S)
if not m: sys.exit(0)
for line in m.group(1).splitlines():
    mm = re.match(rf'^{re.escape(sys.argv[2])}:\s*(.*?)\s*$', line)
    if mm:
        print(mm.group(1).strip().strip('"').strip("'"))
        break
PY
}
FM_TITLE="$(fm_read title)"
FM_WORKTREE="$(fm_read worktree)"
FM_BRANCH="$(fm_read branch)"
FM_ESTIMATE="$(fm_read estimate)"

# ── 2. 定 diff 区间 ────────────────────────────────────────────
MODE=""
WT_DIR=""
HEAD_REF=""
if [[ -n "$FM_WORKTREE" && -e "$FM_WORKTREE/.git" ]]; then
  WT_DIR="$FM_WORKTREE"; MODE="worktree"
elif [[ -e "${HOME}/wt/dsh-forge/${ISS}/.git" ]]; then
  WT_DIR="${HOME}/wt/dsh-forge/${ISS}"; MODE="worktree"
fi

if [[ "$MODE" == "worktree" ]]; then
  HEAD_REF="$FM_BRANCH"
  [[ -n "$HEAD_REF" ]] || HEAD_REF="$ISS"
  if ! git -C "$WT_DIR" show-ref --verify --quiet "refs/heads/${HEAD_REF}"; then
    HEAD_REF="$(git -C "$WT_DIR" rev-parse --abbrev-ref HEAD)"
  fi
  git -C "$WT_DIR" cat-file -e "${BASE_REF}" 2>/dev/null || die "worktree 里没有基准 ${BASE_REF}"
  DIFF_RANGE="${BASE_REF}...${HEAD_REF}"
  GIT_RANGE="$DIFF_RANGE"
  DIFF_CTX_DIR="$WT_DIR"
  MODE_NOTE="审查单元：\`git diff ${DIFF_RANGE}\`（worktree 已提交区间）"
  log "区间: ${DIFF_RANGE}（worktree: ${WT_DIR}）"
else
  # 已 merge 单：找 merge commit，审第一父差异（main 视角的实际合入内容）
  # 主仓库根反推：脚本可能跑在 worktree 里，merged 区间与工作区对照必须在主 checkout
  GIT_COMMON="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  MAIN_ROOT="$([[ -n "$GIT_COMMON" ]] && dirname "$GIT_COMMON" || echo "$REPO_ROOT")"
  [[ -d "$MAIN_ROOT" ]] || MAIN_ROOT="$REPO_ROOT"
  MERGE_SHA="$(git -C "$MAIN_ROOT" log --merges --grep "merge(${ISS})" -1 --format=%H 2>/dev/null || true)"
  [[ -n "$MERGE_SHA" ]] || die "${ISS} 既无 worktree 也无 merge commit，无法确定审查区间"
  DIFF_RANGE="${MERGE_SHA}^1..${MERGE_SHA}"
  GIT_RANGE="$DIFF_RANGE"
  DIFF_CTX_DIR="$MAIN_ROOT"
  MODE="merged"
  MODE_NOTE="审查单元：\`git diff ${DIFF_RANGE}\`（该单已 merge；取证据用 \`git show ${MERGE_SHA}\` 与工作区文件对照）"
  log "区间: ${DIFF_RANGE}（已 merge: $(git -C "$MAIN_ROOT" log -1 --format=%s "$MERGE_SHA")）"
fi

NUMSTAT="$(git -C "$DIFF_CTX_DIR" diff --numstat "${GIT_RANGE}" || true)"
DIRTY_NUMSTAT=""
UNTRACKED_LIST=""
UNTRACKED_BLOCK=""
if [[ "$MODE" == "worktree" ]]; then
  # untracked 收集提前：仅含新增文件的 worktree（tracked diff 为空）也必须能进审查（自举审查发现）
  UNTRACKED_LIST="$(git -C "$DIFF_CTX_DIR" ls-files --others --exclude-standard || true)"
fi
if [[ "$MODE" == "worktree" && -z "$(echo "$NUMSTAT" | tr -d '[:space:]')" ]]; then
  # 区间无已提交差异 → 回退工作区变更模式（HEAD vs WORKTREE，REVIEW_GUIDE §一.1）
  DIRTY_NUMSTAT="$(git -C "$DIFF_CTX_DIR" diff HEAD --numstat || true)"
  if [[ -z "$(echo "$DIRTY_NUMSTAT" | tr -d '[:space:]')" && -z "$(echo "$UNTRACKED_LIST" | tr -d '[:space:]')" ]]; then
    die "worktree 既无已提交区间差异也无工作区改动"
  fi
  NUMSTAT="$DIRTY_NUMSTAT"
  GIT_RANGE="HEAD"
  DIFF_RANGE="HEAD（工作区未提交变更）"
  MODE_NOTE="审查单元：\`git diff HEAD\` + 下方新增文件（**工作区未提交变更**；这是开发中途预审，最终审查以提交后区间为准）"
  warn "worktree 区间无已提交差异，改审工作区未提交变更（HEAD vs WORKTREE）"
fi
if [[ "$MODE" == "worktree" && -z "$(echo "$NUMSTAT" | tr -d '[:space:]')" && -n "$(echo "$UNTRACKED_LIST" | tr -d '[:space:]')" ]]; then
  # untracked-only：合成 numstat 展示（真实 git numstat 对 untracked 无输出）
  NUMSTAT="$(printf '%s\n' "$UNTRACKED_LIST" | awk '{print "-\t-\t" $0}')"
fi
[[ -n "$(echo "$NUMSTAT" | tr -d '[:space:]')" ]] || die "区间无 diff（${DIFF_RANGE}）"
# 工作区模式下 untracked 新文件不在 git diff 里——单列全文供审（否则新建文件全部漏审）
if [[ -n "$(echo "$UNTRACKED_LIST" | tr -d '[:space:]')" ]]; then
  while IFS= read -r uf; do
    [[ -n "$uf" ]] || continue
    UNTRACKED_BLOCK="${UNTRACKED_BLOCK}
### 新增文件：${uf}
\`\`\`
$(cat "${DIFF_CTX_DIR}/${uf}")
\`\`\`
"
  done <<< "$UNTRACKED_LIST"
  log "另有 untracked 新文件: $(echo "$UNTRACKED_LIST" | grep -c . | tr -d ' ') 个（将全文纳入审查）"
fi
DIFF_LINES="$(git -C "$DIFF_CTX_DIR" diff "${GIT_RANGE}" | wc -l | tr -d ' ')"
log "diff 规模: $(echo "$NUMSTAT" | wc -l | tr -d ' ') 文件 / ${DIFF_LINES} 行"

FULL_DIFF="$(git -C "$DIFF_CTX_DIR" diff "${GIT_RANGE}")"
DIFF_TRUNCATED_NOTE=""
if (( DIFF_LINES > 4000 )); then
  FULL_DIFF="$(git -C "$DIFF_CTX_DIR" diff "${GIT_RANGE}" | head -4000)"
  DIFF_TRUNCATED_NOTE="⚠️ diff 超过 4000 行已截断——请按 numstat 清单主动读取重点文件后再审（你在仓库内）。"
fi

# ── 3. 组装 prompt（内联知识包 + 守则 + spec + diff）───────────
for f in "SKILL.md" "dims/core.md" "dims/enhanced.md" "redlines.md"; do
  [[ -f "${SKILL_DIR}/${f}" ]] || die "知识包缺文件: skills/ai-reviewer/${f}（请先在仓库里就位）"
done
[[ -f "${REPO_ROOT}/REVIEW_GUIDE.md" ]] || die "缺 REVIEW_GUIDE.md"

SPEC_BODY=""
while IFS= read -r res; do
  doc_rel="$(printf '%s' "$res" | cut -d'|' -f1 | xargs 2>/dev/null || true)"
  case "$doc_rel" in
    documents/*)
      doc_path="${PM_ROOT}/${doc_rel}"
      [[ -f "$doc_path" ]] && SPEC_BODY="${SPEC_BODY}

--- spec：${doc_rel} ---
$(head -120 "$doc_path")"
      ;;
  esac
done < <(fm_read resources | tr ',' '\n' | sed 's/^\[//; s/\]$//; s/^ *//; s/ *$//' | grep -v '^$' || true)

PROMPT_FILE="/tmp/airun-${ISS}.prompt.md"
{
  echo "# 审查任务：${ISS}（estimate=${FM_ESTIMATE:-未分档}）"
  echo
  echo "issue 标题：${FM_TITLE:-（读取失败）}"
  echo "审查区间：${MODE_NOTE}"
  echo "仓库上下文：${DIFF_CTX_DIR}"
  [[ "$MODE" == "worktree" ]] && echo "当前目录即该单 worktree，可直接 git/读文件/跑测试取证。"
  echo
  echo "报告落地路径（**必须**用这个绝对路径写完整报告，覆盖写）："
  echo "  ${INCOMING_DIR}/airun-${ISS}.md"
  echo
  echo "$DIFF_TRUNCATED_NOTE"
  echo
  echo "═══ 执行流程与输出协议（skills/ai-reviewer/SKILL.md）═══"
  cat "${SKILL_DIR}/SKILL.md"
  echo
  echo "═══ 核心五维（每单必查）═══"
  cat "${SKILL_DIR}/dims/core.md"
  echo
  echo "═══ 增强五维 + 路由表 + severity 门禁 ═══"
  cat "${SKILL_DIR}/dims/enhanced.md"
  echo
  echo "═══ 红线清单（逐条扫）═══"
  cat "${SKILL_DIR}/redlines.md"
  echo
  echo "═══ REVIEW_GUIDE.md（质量基准）═══"
  cat "${REPO_ROOT}/REVIEW_GUIDE.md"
  echo
  if [[ -n "$SPEC_BODY" ]]; then
    echo "═══ 该单 spec（节选）═══"
    echo "$SPEC_BODY"
    echo
  fi
  echo "═══ diff numstat ═══"
  echo '```'
  echo "$NUMSTAT"
  echo '```'
  echo
  echo "═══ diff 全文 ═══"
  echo '```diff'
  echo "$FULL_DIFF"
  echo '```'
  if [[ -n "$UNTRACKED_BLOCK" ]]; then
    echo "═══ 新增文件（untracked）——与 diff 同等对待，逐个审 ═══"
    echo "$UNTRACKED_BLOCK"
  fi
} > "$PROMPT_FILE"
log "prompt 组装完成: $(wc -l < "$PROMPT_FILE" | tr -d ' ') 行"

if (( DRY_RUN )); then
  log "── dry-run 停止 ──"
  echo "  prompt:    ${PROMPT_FILE}"
  echo "  区间:      ${DIFF_RANGE}（${MODE} 模式）"
  echo "  报告将写:  ${INCOMING_DIR}/airun-${ISS}.md"
  exit 0
fi

# ── 4. 选 agent 并派单（ISS-690 起走**队列新路**：会话优先，零 RUN 文件）──────────
if [[ -z "$AGENT_ID" ]]; then
  AGENT_ID="$(python3 -c "import json;print(json.load(open('${AGENTS_ROOT}/agents/copilot.json')).get('id',''))" 2>/dev/null || true)"
  [[ -n "$AGENT_ID" ]] || die "读不到 copilot agent id，请用 --agent 显式指定"
fi
log "派单通道: ${AGENT_ID}"

REPORT_PATH="${INCOMING_DIR}/airun-${ISS}.md"
rm -f "$REPORT_PATH"   # 防上一轮残留冒充本轮产出

# ⚠️ ISS-690 换轨（老板拍板 C1）：本脚本此前打 `POST /forge-pm/agent/dispatch`，那条路
#    **必须落 RUN 文件**（门禁靠它校验），于是每次审查都往存量里添一个 `RUN-NNN.md`。
#    现在改成打 `POST /forge-pm/queue {action:create}` —— 即 ISS-652 的**新派单路**
#    （会话优先 → 返回 sessionId；agent 未登记 CLI-provider 时才回落 run）。
#    队列此前只能从 agent 配置推 cwd（`agent.cwd === "workspace" ? process.cwd() : agent.cwd`），
#    推不出"本单 worktree"，故 ISS-690 给队列条目加了按次 `cwd` 字段；这里照传。
#    返回体：`{sessionId, runId, dispatched, reason}` —— **两值互斥**，谁有值就走哪条轮询。
DISPATCH_JSON="$(python3 - "$PROMPT_FILE" "$AGENT_ID" "$ISS" "$DIFF_CTX_DIR" "$PM_API" <<'PY'
import json, sys, urllib.parse, urllib.request
prompt = open(sys.argv[1], encoding="utf-8").read()
payload = json.dumps({
    "action": "create",
    # memberRef 传**裸 agent id**：未建档成员按裸 id 走（member-registry 的既有语义）。
    # issueId 传短号（ISS-NNN）：会话卡的议题匹配与 activity 都按短号。
    "memberRef": sys.argv[2],
    "issueId": sys.argv[3],
    "prompt": prompt,
    "cwd": sys.argv[4],
}).encode()
req = urllib.request.Request(sys.argv[5] + "/queue", data=payload,
                             headers={"content-type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
except urllib.error.HTTPError as e:
    out = {"error": f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"}
print(json.dumps({
    "sessionId": out.get("sessionId") or "",
    "runId": out.get("runId") or "",
    "dispatched": bool(out.get("dispatched")),
    "error": out.get("error") or out.get("reason") or "",
}))
PY
)"
SESSION_ID="$(printf '%s' "$DISPATCH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sessionId",""))')"
RUN_ID="$(printf '%s' "$DISPATCH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("runId",""))')"
DISPATCHED="$(printf '%s' "$DISPATCH_JSON" | python3 -c 'import json,sys;print("1" if json.load(sys.stdin).get("dispatched") else "")')"
DISPATCH_ERR="$(printf '%s' "$DISPATCH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("error",""))')"
# 未派出去（例如并发闸门满，条目留 pending）就当失败退出 —— 与旧路的 409 语义对齐，
# 不假装成功让调用方去轮询一个永远不会动的条目。
[[ -n "$DISPATCHED" ]] || die "派单失败：${DISPATCH_ERR:-未知原因（队列条目留 pending）}"
if [[ -n "$SESSION_ID" ]]; then
  ANCHOR_KIND="session"; ANCHOR_ID="$SESSION_ID"
  RUN_FILE=""
  log "会话: ${SESSION_ID}（队列新路 · 轮询 dispatch-links，超时 ${TIMEOUT_SEC}s）"
elif [[ -n "$RUN_ID" ]]; then
  ANCHOR_KIND="run"; ANCHOR_ID="$RUN_ID"
  RUN_FILE="${RUNS_DIR}/${RUN_ID}.md"
  log "run: ${RUN_ID}（回落路 · 轮询 runs API，超时 ${TIMEOUT_SEC}s）"
else
  die "派单返回既无 sessionId 也无 runId —— 无法跟踪进度"
fi

# ── 5. 轮询终态（新路看 dispatch-links / 回落路看 runs API）──────────
# ⚠️ 为什么不再读 run 文件：ISS-690 之后两条路都不保证有文件 ——
#    · 会话路压根没有 run；· `/agent/dispatch` 的裸派单已改瞬态（`RUN-T…`，只在内存）。
#    两处 API 都带 status（会话行另带 turns），足以判终态。
# 状态词表 = dispatch-link.js 的 DISPATCH_STATUSES：
#    running / need_approval / stalled = 未终态；idle = 成功；error / canceled = 失败。
ELAPSED=0
STATUS=""
TURNS=""
while :; do
  POLLED="$(python3 - "$ANCHOR_KIND" "$ANCHOR_ID" "$ISSUE_REL" "$PM_API" <<'PY'
import json, sys, urllib.parse, urllib.request
kind, anchor, issue_rel, api = sys.argv[1:5]
try:
    if kind == "session":
        url = f"{api}/dispatch-links?issueId={urllib.parse.quote(issue_rel)}"
        with urllib.request.urlopen(url, timeout=15) as r:
            items = json.load(r).get("items") or []
        hit = next((x for x in items if str(x.get("sessionId")) == anchor), None)
        if not hit:
            print("pending\t0"); raise SystemExit
        print(f"{hit.get('status') or 'running'}\t{int(hit.get('turns') or 0)}")
    else:
        # listRuns 会带上 `ephemeral:true` 的瞬态行（run-manager.js:423），故两条路都认
        url = f"{api}/../forge-agents/agent/runs?issueId="
        with urllib.request.urlopen(url, timeout=15) as r:
            items = json.load(r).get("items") or []
        hit = next((x for x in items if str(x.get("id")) == anchor), None)
        if not hit:
            print("pending\t0"); raise SystemExit
        print(f"{hit.get('status') or 'queued'}\t{int(hit.get('turns') or 0)}")
except Exception as e:
    print(f"poll-error:{type(e).__name__}\t0")
PY
)"
  STATUS="${POLLED%%$'\t'*}"
  TURNS="${POLLED##*$'\t'}"
  case "$STATUS" in
    idle|error|canceled) break ;;
  esac
  (( ELAPSED >= TIMEOUT_SEC )) && die "轮询超时（${TIMEOUT_SEC}s，status=${STATUS:-未知}）。报告与派单记录保留，可稍后人工回收：${REPORT_PATH}"
  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED+POLL_INTERVAL))
  printf '\033[32m[ai-review]\033[0m … %ss（status=%s turns=%s）\r' "$ELAPSED" "${STATUS:-pending}" "${TURNS:-0}"
done
[[ "$STATUS" == "idle" ]] || die "派单终态=${STATUS}（${ANCHOR_KIND}=${ANCHOR_ID}）：$(python3 - "$ANCHOR_KIND" "$ANCHOR_ID" "$ISSUE_REL" "$PM_API" <<'PY'
import json, sys, urllib.parse, urllib.request
kind, anchor, issue_rel, api = sys.argv[1:5]
try:
    if kind == "session":
        url = f"{api}/dispatch-links?issueId={urllib.parse.quote(issue_rel)}"
        with urllib.request.urlopen(url, timeout=15) as r:
            items = json.load(r).get("items") or []
        hit = next((x for x in items if str(x.get("sessionId")) == anchor), None) or {}
        print(hit.get("lastText") or hit.get("statusLabel") or "无错误详情")
    else:
        print("（回落路：失败详情见 runs API / agent 会话日志）")
except Exception:
    print("无错误详情")
PY
)"

# ── 6. 回收报告（文件优先；兜底按派单路分叉）───────────────────
if [[ -s "$REPORT_PATH" ]]; then
  log "产出: 报告文件 $(wc -l < "$REPORT_PATH" | tr -d ' ') 行"
elif [[ -n "$RUN_FILE" && -f "$RUN_FILE" ]]; then
  warn "报告文件未落地，尝试 run events 兜底…"
  python3 - "$RUN_FILE" "$REPORT_PATH" <<'PY'
import json, sys
chunks = []
for line in open(sys.argv[1], encoding="utf-8"):
    s = line.strip()
    if not s: continue
    try: e = json.loads(s)
    except: continue
    if str(e.get("kind", "")).endswith("message_chunk") and e.get("text"):
        chunks.append(e["text"])
text = "\n".join(chunks).strip()
if text:
    open(sys.argv[2], "w", encoding="utf-8").write(text)
    print(f"[ai-review] 兜底回收 {len(chunks)} 块 / {len(text)} 字符", file=sys.stderr)
PY
  [[ -s "$REPORT_PATH" ]] || die "agent 未产出报告（文件与 events 均空）。检查 agent 会话日志。"
  warn "兜底产出可能被 4000 字符/块截断，结论以 issue 评论为准并建议复核。"
else
  # ISS-690：会话路没有 run 文件 ⇒ 兜底改取薄表里的「最后一句」（lastText）。
  #   它本来就比 run events 更短（就是最后一条助手消息），所以同样按**可能截断**处理并告警。
  warn "报告文件未落地，尝试会话末句兜底…"
  python3 - "$ISSUE_REL" "$ANCHOR_ID" "$PM_API" "$REPORT_PATH" <<'PY'
import json, sys, urllib.parse, urllib.request
issue_rel, anchor, api, out = sys.argv[1:5]
try:
    url = f"{api}/dispatch-links?issueId={urllib.parse.quote(issue_rel)}"
    with urllib.request.urlopen(url, timeout=15) as r:
        items = json.load(r).get("items") or []
    hit = next((x for x in items if str(x.get("sessionId")) == anchor), None) or {}
    text = str(hit.get("lastText") or "").strip()
    if text:
        open(out, "w", encoding="utf-8").write(text)
        print(f"[ai-review] 兜底回收会话末句 {len(text)} 字符", file=sys.stderr)
except Exception as e:
    print(f"[ai-review] 会话末句兜底失败：{e}", file=sys.stderr)
PY
  [[ -s "$REPORT_PATH" ]] || die "agent 未产出报告（报告文件与会话末句均空）。检查会话 ${ANCHOR_ID}。"
  warn "兜底产出是「会话末句」，可能被截断，结论以 issue 评论为准并建议复核。"
fi

# ── 7. 解析 verdict 与 severity 计数 ───────────────────────────
STATS_JSON="$(python3 - "$REPORT_PATH" <<'PY'
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
first = text.lstrip().splitlines()[0].strip() if text.strip() else ""
if first.startswith("✅"): verdict = "approved"
elif first.startswith("❌"): verdict = "changes-requested"
else: verdict = "pending"
counts = {s: len(re.findall(rf'-\s*\[{s}\]', text)) for s in ("critical", "high", "medium", "low")}
has_verify = "## 验证结果" in text
print(json.dumps({"verdict": verdict, "firstLine": first[:80], **counts, "hasVerify": has_verify}))
PY
)"
VERDICT="$(printf '%s' "$STATS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verdict"])')"
N_CRIT="$(printf '%s' "$STATS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["critical"])')"
N_HIGH="$(printf '%s' "$STATS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["high"])')"
HAS_VERIFY="$(printf '%s' "$STATS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["hasVerify"])')"
log "判定: ${VERDICT}（critical=${N_CRIT} high=${N_HIGH} 验证结果章节=${HAS_VERIFY}）"

# ── 8. 回写 issue（评论 + aiReview 字段 + note）───────────────
post_pm() { # $1=path $2=json 文件
  curl -s --fail -X POST "${PM_API}$1" -H 'content-type: application/json' --data @"$2"
}
python3 - "$REPORT_PATH" "$ISSUE_REL" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read()
json.dump({"id": sys.argv[2], "text": body, "author": "ai-reviewer"},
          open("/tmp/airun.comment.json", "w"), ensure_ascii=False)
PY
# 评论 = 报告唯一落 issue 的通道，失败即产出丢失 → 硬失败（自举审查发现：回写失败不得伪装成功）
post_pm "/comment" "/tmp/airun.comment.json" >/dev/null \
  || die "评论回写失败（HTTP 错误）。报告保留在 ${REPORT_PATH}，可手工贴入 issue 后重试"

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# ISS-690：锚随派单路走 —— 会话路写 `sessionId`，回落路写 `runId`（**两值互斥**，
#   merge-iss.sh 的 aiReview 门禁两种都认）。为什么必须有锚：它是"审查真跑过"的凭据，
#   防的正是"手写一份 frontmatter 冒充已审查"（merge-iss.sh 的注释：防草稿/伪造残留）。
python3 - "$STATS_JSON" "$ISSUE_REL" "$SESSION_ID" "$RUN_ID" "$NOW_ISO" <<'PY'
import json, sys
stats = json.loads(sys.argv[1])
summary = {k: stats.get(k, 0) for k in ("critical", "high", "medium", "low")}
summary.update({"verdict": stats["verdict"], "at": sys.argv[5]})
session_id, run_id = sys.argv[3], sys.argv[4]
if session_id: summary["sessionId"] = session_id
elif run_id: summary["runId"] = run_id
if not stats.get("hasVerify"): summary["verifyMissing"] = True
json.dump({"id": sys.argv[2], "field": "aiReview", "value": summary},
          open("/tmp/airun.field.json", "w"), ensure_ascii=False)
PY
FIELD_FAIL=0
FIELD_OUT="$(post_pm "/field" "/tmp/airun.field.json" 2>/dev/null)" || FIELD_FAIL=1
printf '%s' "$FIELD_OUT" | grep -q '"ok":true' || { warn "aiReview 字段回写未确认: ${FIELD_OUT:-HTTP 错误}（摘要缺失，报告评论已落 issue）"; FIELD_FAIL=1; }

python3 - "$ISSUE_REL" "$VERDICT" "$N_CRIT" "$N_HIGH" "$ANCHOR_KIND" "$ANCHOR_ID" "$AGENT_ID" <<'PY'
import json, sys
kind = "会话" if sys.argv[5] == "session" else "run"
json.dump({"id": sys.argv[1],
           "text": f"AI 预审完成（{sys.argv[7]}）：verdict={sys.argv[2]}，critical={sys.argv[3]}，high={sys.argv[4]}；{kind}={sys.argv[6]}。",
           "by": "ai-review"},
          open("/tmp/airun.note.json", "w"), ensure_ascii=False)
PY
post_pm "/note" "/tmp/airun.note.json" >/dev/null 2>&1 || warn "note 回写失败（非阻塞）"

# ── 9. 打开审查现场 ────────────────────────────────────────────
if (( OPEN_VSC )) && [[ "$MODE" == "worktree" ]]; then
  open -a "Visual Studio Code" "$WT_DIR" 2>/dev/null || warn "打开 VS Code 失败（可手动打开 ${WT_DIR}）"
fi

echo
log "═══ 完成 ═══"
echo "  issue:     ${ISSUE_REL}"
echo "  判定:      ${VERDICT}  critical=${N_CRIT} high=${N_HIGH}"
echo "  报告文件:  ${REPORT_PATH}"
echo "  run:       ${RUN_ID}"
echo "  下一步:    老板在 VS Code/issue 内复核 → complex+ 单拨 reviewVerdict=approved → Lead 收口合并"
[[ "$VERDICT" == "changes-requested" ]] && echo "  ⚠️ AI 判定打回：critical/high 未清零前不应合并。"
# 字段回写缺口以 exit 3 区分（产出已落 issue，但 aiReview 摘要缺失）
if (( FIELD_FAIL )); then
  warn "以 exit 3 退出：aiReview 摘要未落盘（merge 门禁将拒），待 forge-pm 新字段生效后重跑即可补齐"
  exit 3
fi
exit 0
