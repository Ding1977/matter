#!/bin/bash
# 重启 dsh web（3210）：自动找 PID → 杀干净 → 重启 → 验证
# 用法：bash <repo>/scripts/restart-web.sh
#
# ── 老盘遗留（ISS-558 · 2026-10-01）─────────────────────────────────────────
# ⚠️ 本脚本是**老盘（DSH_HOME=~/.dsh）的 3210 重启入口**，配套 watchdog 已退役
#    （com.openforge.watchdog / watchdog-web.sh，退役说明见 watchdog-web.sh 文件头注）。
#    3210 现在是 Matter 独立服务（DSH_HOME=~/.dsh-matter，2026-10-01 实测在跑实例
#    env: DSH_HOME=<home>/.dsh-matter）——**正规入口 = scripts/restart-matter.sh**，
#    现役 watchdog = scripts/watchdog-matter.sh（launchd 项 com.openforge.watchdog-matter）。
#    请勿用本脚本重启 3210：它会 unset DSH_HOME 并以 `--profile web` 从 ~/dsh-local 拉起老盘
#    实例，与 Matter 实例抢同一端口。
#    保留文件原因：仍被 web-crash-evidence.sh / restart-web-detached.sh / 运维手册（AGENTS.md §5）
#    等引用，删除会连锁报红；且 restart-matter.sh 的配方照抄本脚本，留作参考实现。
#
# ── ISS-558：kill 路径上的牙（本脚本同样不许无牙 kill 生产实例）───────────────
#    判据**只有一份** = scripts/prod-guard.sh（lsof -p 查 $HOME/.dsh-matter/，不依赖 ps，fail-closed）。
#    退出码：4 = 牙拦下（生产实例且未带 FORGE_ALLOW_RESTART_PROD=1）。
#    自愈通道：watchdog 委派时带 FORGE_WATCHDOG_SELFHEAL=1 ⇒ 放行。
# ─────────────────────────────────────────────────────────────────────────────
set -e

# ── ISS-491：服务动作台账（谁 / 何时 / 目标 / 结果 / 是否有在途任务）──────────────
# 现状：只有 watchdog 自己的输出被记（watchdog-restart.log 里 source=watchdog 占 100%），
# **人工与其它来源的重启零记录** → 实测「201 次重启里 47 次（23%）看不出是谁要的」，
# 真崩溃淹没在噪声里。本台账与后续 L2 控制面（forge-services）用同一格式，便于一次查询。
# 只追加、失败不影响重启（|| true）；字段固定，值均为短标量（无嵌套、无需转义）。
LEDGER="$HOME/.dsh/service-actions.jsonl"
log_action() {  # $1=result  $2=newPid  $3=bindWaitS  $4=selfCheck
  printf '{"ts":"%s","source":"%s","target":"engine-a","action":"restart","result":"%s","oldPid":"%s","newPid":"%s","bindWaitS":%s,"pluginSelfCheck":"%s","inFlightRuns":null}\n' \
    "$(date '+%F %T')" "${FORGE_RESTART_SOURCE:-manual}" "$1" "${OLD_PID:-}" "$2" "${3:-0}" "$4" \
    >> "$LEDGER" 2>/dev/null || true
}

echo "==> -1. 重启互斥锁（防双实例）"
# ISS-402：watchdog-restart.log 是**追加写且原先每行没有时间戳/来源** —— 事后无法判断
# 「谁在什么时候重启的」「是常态还是抽风」。故每次调用打一条带时间戳与来源的头。
# 来源由调用方用 FORGE_RESTART_SOURCE 声明（watchdog 会设），缺省视为人工。
echo "──────────────────────────────────────────────────────────────"
echo "==> [$(date '+%Y-%m-%d %H:%M:%S')] restart-web.sh 启动（source=${FORGE_RESTART_SOURCE:-manual}，pid=$$）"
# macOS 无 flock(1)，用 mkdir 原子锁。没有它：kill 旧进程到新实例 bind 之间有空窗
# （归档/锁清理/代理探活可拖到 5-13s），watchdog 连续 2 次探测失败就会并发跑第二个
# 本脚本 → 两个 node 并发写同一 ~/.dsh profile（会话日志 seq gap/torn），或杀掉刚
# 起来的活实例。第二个实例进入时这里直接退出（watchdog 下一轮自然会探到新实例）。
# 陈旧锁强抢：锁目录 mtime 超 180s 视为上次异常退出残留（trap 没跑到）。
LOCK_DIR="$HOME/.dsh/restart-web.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
  if [ "$LOCK_AGE" -gt 180 ]; then
    echo "    陈旧锁（${LOCK_AGE}s）强抢重拿"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { echo "!! 抢锁仍失败，退出（另一实例重启中）"; exit 0; }
  else
    echo "!! 已有 restart-web.sh 在跑（${LOCK_AGE}s 内），本次跳过——防双实例"
    log_action skipped-lock "" 0 ""
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# ⚠️ 2026-09-20 ISS-635：以下守卫于提交 c21ad98 被删除（提交信息称「把逻辑归回分离版」，
#   但 restart-web-detached.sh **只 kill、不 spawn**（见其 :7-8），故守卫必须留在本脚本。
#   两段均**逐字恢复**自 `git show c21ad98^:scripts/restart-web.sh`（:31-51 / :229-249）。
# ── ISS-537：自证家门（A 引擎的家永远是 ~/.dsh）────────────────────────────────
# 为什么要显式 unset：本脚本会被**别的引擎的会话**调用。实测（2026-09-17）——在跑于
# 3300/B 引擎的 agent 会话里执行本脚本，新起的 3210 继承了 `DSH_HOME=~/.dsh-b`，于是
# A 引擎去读 `~/.dsh-b/profiles/web/*`（空壳配置）→ **所有插件路由 404**，而脚本只按
# 「PID 有了」报成功。A 引擎的 home 只认默认值 `~/.dsh`；B 的家门只经 FORGE_DSH_HOME
# 传给 second-engine（下面 export 那行），两者不可混。
if [ -n "${DSH_HOME:-}" ]; then
  echo "    清理继承的 DSH_HOME=${DSH_HOME}（A 引擎必须用 ~/.dsh；B 的家门走 FORGE_DSH_HOME）"
fi
unset DSH_HOME

# ⚠️⚠️ ISS-553（2026-09-17 实测事故）：**必须连 FORGE_ENGINE_ROLE 一起清**。
#   同一个坑的第二只脚：本脚本从「跑在 B 里的 agent 会话」调用时，环境里还带着
#   `FORGE_ENGINE_ROLE=secondary`（由 second-engine 注入给 B）。A 继承它之后，插件会
#   把自己当副引擎 → `/forge-plans/*` 全部"转发到主引擎 http://127.0.0.1:3210"
#   = **转发给自己** → 所有插件路由 500/fetch failed（实测：套餐页与模型选择器同时挂）。
#   判据：`[forge-model] 副引擎（FORGE_ENGINE_ROLE=secondary）→ …` 出现在 A 的 web.log 里就是它。
if [ -n "${FORGE_ENGINE_ROLE:-}" ]; then
  echo "    清理继承的 FORGE_ENGINE_ROLE=${FORGE_ENGINE_ROLE}（A 是主引擎，不能带副引擎标记）"
fi
unset FORGE_ENGINE_ROLE

echo "==> 0. 存档旧 web.log（崩溃取证）"
# 2026-08-28 ISS-104 排障：web「崩」后 web.log 被本次重启的 > 重定向覆盖，死前日志
# 永远丢失。macOS 无 node 崩溃报告（进程是被干净杀掉的），真凶只能靠死前日志定位。
# 保留最近 5 份，更旧的改名让位。
if [ -f "$HOME/.dsh/web.log" ]; then
  ARCHIVE="$HOME/.dsh/web.log.crash-$(date +%Y%m%d-%H%M%S)"
  cp "$HOME/.dsh/web.log" "$ARCHIVE" 2>/dev/null && echo "    已存档: $ARCHIVE ($(wc -c < "$ARCHIVE" | tr -d ' ') bytes)"
  # 只保留最近 5 份正体，更旧的直接删除；.old 是旧实现（只改名不删除）的产物，
  # 会无限累积（文件名每轮 +4 字节直到 255 上限）——统一清掉（ISS-126）。
  ls -t "$HOME"/.dsh/web.log.crash-* 2>/dev/null | grep -v '\.old$' | tail -n +6 | while IFS= read -r OLD; do rm -f "$OLD"; done
  find "$HOME/.dsh" -maxdepth 1 -name 'web.log.crash-*.old' -delete 2>/dev/null || true
fi

echo "==> 1. 查找并杀掉 3210 旧进程"
OLD_PID=$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  # ISS-402：记录旧进程已活多久 —— 「跑了 3 分钟就死」和「跑了 6 小时才死」是两种事故，
  # 原先只记 PID，无法区分（macOS 的 ps -o etime 给出 ELAPSED）。
  echo "    旧 PID: ${OLD_PID}，已存活 $(ps -o etime= -p "$OLD_PID" 2>/dev/null | tr -d ' ' || echo 未知)"
  # 牙（ISS-558 MEDIUM-1）：kill 之前先问 prod-guard.sh —— 3210 上若跑的是 Matter 生产实例，
  # 本脚本（老盘入口）更不该把它顺手杀掉。判据只有那一份，这里不抄。
  GUARD="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/prod-guard.sh"
  if ! bash "$GUARD" require-kill "$OLD_PID"; then exit 4; fi
  kill "$OLD_PID" 2>/dev/null || true
  sleep 2
  # 兜底：未释放则强杀
  REMAIN=$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$REMAIN" ]; then
    echo "    仍未释放，强杀: ${REMAIN}（说明旧进程忽略 SIGTERM 或卡在 IO）"
    echo "$REMAIN" | xargs kill -9 2>/dev/null || true
    sleep 1
  else
    echo "    旧进程已按 SIGTERM 正常退出"
  fi
else
  echo "    3210 无进程（原本就没在跑；若是 watchdog 拉起，说明进程已自行消失且无遗言）"
fi

echo "==> 2. 确认端口已释放"
if lsof -tiTCP:3210 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    !! 端口仍被占用，请手动检查：lsof -iTCP:3210"
  exit 1
fi
echo "    端口已释放 ✓"

echo "==> 2b. 清理孤儿写锁"
# 2026-08-28 ISS-104 第二根因：atomic-write 的跨进程写锁（<file>.lock，内容=持有者PID）
# **竞争者永不删除已有锁、孤儿恢复是操作员动作**（util/atomic-write 源码 L120）。
# kill 一个恰在持锁写 settings 的旧 web 进程 → 孤儿锁残留 → 此后**所有** settings 写
# （选模型/思考深度的 saveDefaultModelSelection、forge-plans 目录写回）都等锁 2s 超时
# → 「选择模型后等几秒」。重启正是孤儿锁的产生时刻，故 kill 后必须清理。
# 只删持有者已死/空的锁；持有者仍存活则保留（防误删真实并发持有）。
for LF in "$HOME/.dsh/settings.yaml.lock" "$HOME/.dsh/.credentials.yaml.lock"; do
  if [ -f "$LF" ]; then
    LPID=$(tr -d '[:space:]' < "$LF" 2>/dev/null)
    if [ -z "$LPID" ]; then
      rm -f "$LF"; echo "    清理空锁: $LF"
    elif ps -p "$LPID" >/dev/null 2>&1; then
      echo "    锁 $LF 持有者 PID $LPID 仍存活，保留"
    else
      rm -f "$LF"; echo "    清理孤儿锁: $LF (持有者 PID $LPID 已死)"
    fi
  fi
done

echo "==> 3. 解析代理（带健康检查）"
# 背景（2026-08-28 实测）：launchd → watchdog → 本脚本 → node 这条链路上，launchd
# 不提供环境变量，而 watchdog 自身可能继承了一个**已失效**的代理端口——历史上在某次
# agent 会话里启动 watchdog 时继承的沙箱临时代理（如 55464），端口随会话消失。
# 死代理比没有代理更糟：请求直接 ECONNREFUSED，境外模型 100% 失败，DSH 侧表现为
# TRANSPORT/TIMEOUT 重试 5 次全灭（"Connection error."）。
# 所以这里不能只判断变量是否为空（:= 兜底会被非空但失效的值骗过），必须实地探测。
# 另一个坑：不能一刀切走代理。实测境内 api.z.ai 直连 0.24s、走 ClashX 反而抖到 6.2s
# （ClashX 会把境内域名绕去远程节点帮倒忙）。故境内域名显式 NO_PROXY 直连。
# 2026-08-28 补全：此前只列了 deepseek/z.ai/bigmodel 三家，导致其余境内 provider
# （sensenova/volces 豆包/dimleap/gmi-serving）被误推去 ClashX 绕境外节点 → 抖动/超时，
# 表现为「只有 deepseek 官方通、其他全挂」。境外仅 commandcode.ai / opencode.ai /
# openrouter.ai 三家，它们不在名单内，自动走代理。
# 2026-08-31 修订：opencode.ai 实测直连（Cloudflare 任播，国内裸连可达）比走 ClashX 境外
# 节点快约 33%（中位 TTFB 4.2s vs 6.2s，10 轮样本），且 6/6 全通无失败 → 移入直连名单。
# ⚠️ 2026-10-03 反转（本次排查实测，展开见 docs/memory/commandcode-direct-blocked-2026-10-03.md）：
#   · api.commandcode.ai **直连已恒挂**（0/15 通：TCP 连上后 TLS 永不完成/被替换证书），
#     ISS-392 当年「补进直连名单」的结论**已失效**——那条现在等于主动绕过代理；
#   · opencode.ai 直连仍可用但**域名会被阵发污染**（实测 8/20 次解析到黑洞 IP → TLS 永不完成
#     → 请求悬挂；会话日志里 opencode-go 失败 22 条、req→报错 p50 541s）。
#   ⇒ 两个域名**都从直连名单摘掉**（走代理）。单一真相源已抽到 scripts/app-proxy.sh，
#     新脚本别再手抄这份名单（本文件已退役，仅保留此处修订以免旧结论被再次抄走）。
# ISS-125：必须**追加**而不是 ${NO_PROXY:-默认}（后者=继承即整体替换）——agent 沙箱/
# WorkBuddy 继承链带了任何 NO_PROXY 时，整份境内直连名单会被丢掉。
#
# 写法与其它家对齐：apex + 点号子域两条都要（点号那条不匹配 apex 本身）。
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1,api.deepseek.com,.deepseek.com,api.z.ai,.z.ai,open.bigmodel.cn,.bigmodel.cn,token.sensenova.cn,.sensenova.cn,ark.cn-beijing.volces.com,.volces.com,api.dimleap.cn,.dimleap.cn,api.gmi-serving.com,.gmi-serving.com"
export no_proxy="$NO_PROXY"

PROXY_OK=""
# ⚠️ 顺序有意为之：固定端口 7890（ClashX 常驻）**优先**于继承来的代理。
# 继承的代理常是 agent 沙箱浮动端口（58563/55464 等），探活的当下是通的，会抢占第一
# 候选；但它随会话消失即变死代理 → DSH 下次重启后境外模型 100% ECONNREFUSED。
# 这就是「每次修完只通一路、过一会儿又全挂」的循环根源，故固定端口必须排第一。
for CAND in "http://127.0.0.1:7890" "${HTTPS_PROXY:-${HTTP_PROXY:-}}"; do
  [ -n "$CAND" ] || continue
  # 探活：3s 超时，验证代理通道本身是否可用，失败即换下一个候选。
  # ⚠️ --noproxy "" 必须有：探活目标 api.deepseek.com 就在上面的 NO_PROXY 名单里，
  # 不加这个参数 curl 会绕过代理直接连通，导致**连死代理都判定为可用**（实测 exit 0），
  # 健康检查形同虚设。加了它才真正强制流量穿过代理（死代理会返回 exit 7）。
  if curl -s -o /dev/null --max-time 3 --noproxy "" --proxy "$CAND" https://api.deepseek.com/models 2>/dev/null; then
    PROXY_OK="$CAND"; break
  fi
done
if [ -n "$PROXY_OK" ]; then
  export HTTP_PROXY="$PROXY_OK"
  export HTTPS_PROXY="$PROXY_OK"
  # ⚠️ 小写必须一并覆盖（2026-08-28 ISS-104/「国外模型全不通」根因）：
  # undici（Node --use-env-proxy）读代理变量**小写优先** —— 继承链（launchd→watchdog
  # 是登录时启动的老进程）里的小写浮动端口（WorkBuddy 同步的 https_proxy=5xxxx）
  # 死掉后压过大写的活代理 → 境外模型全部 ECONNREFUSED（Connection error，
  # 瞬间失败 + retry 5 次退避 ≈ 15s = 会话发消息"卡一下"）。探活后小写同步设为
  # 活代理，无论继承源是什么都根治。
  export http_proxy="$PROXY_OK"
  export https_proxy="$PROXY_OK"
  echo "    代理: ${PROXY_OK}（探活通过，大小写均已覆盖）"
else
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
  echo "    代理: 无可用代理 → 直连（境内域名本就直连，境外模型可能超时）"
fi
echo "    直连名单: $NO_PROXY"
# 落盘留痕：单次覆盖写独立文件，不追加。
# 原因：watchdog-restart.log 是追加写且可能有多个 restart 并发，实测出现字节交织
# 损坏（全角括号「（」丢失首字节 ef、变量值"消失"），导致日志不可信、无法用来验证。
printf 'TIME=%s\nHTTP_PROXY=%s\nHTTPS_PROXY=%s\nNO_PROXY=%s\n' \
  "$(date '+%F %T')" "${HTTP_PROXY:-<直连>}" "${HTTPS_PROXY:-<直连>}" "$NO_PROXY" \
  > <home>/.dsh/.last-proxy-env 2>/dev/null || true

# ── 引擎B 独立化（2026-09-12：B 升 0.1.5-rc.2，A/B 引擎版本解耦）──
# B 用独立引擎树 `dsh-local-b` + 独立 DSH_HOME `~/.dsh-b`（只隔离 `profiles/` 的模块解析
# 镜像，sessions/settings/credentials 经软链共享，保会话历史一致）。`second-engine.js`
# 读这两个 env 来 spawn :3300；不设则退回旧行为（B 与 A 同引擎、同 home）。
# ISS-570 P2b-2 线 #1 → ISS-556（P2b-1 落地 2026-10-01）：agent 域根**已默认跟随宿主 home**
# （`<DSH_HOME>/forge-agents`，见 forge-agents/lib/domain.js），迁移期旧根（FORGE_PM_ROOT 下的
# runs/agents/state）由 run-manager 的 resolveRunFile 只读兼容。**本脚本不得再 export
# FORGE_AGENTS_ROOT**——显式钉死会让 ISS-744（隔离实例读生产根）复活；回滚 = 设
# FORGE_AGENTS_ROOT 指回旧根 + 重启（env 覆盖仍在，domain.js 未删）。

# ── 2026-09-28 老板拍板「B 引擎暂时先不用」（ISS-915）──────────────────────────
# 原默认 FORGE_DSH_LOCAL_ROOT=<dsh-b> 在本机已不存在 → B 被拉起时
# spawn 的 cwd 缺失 → ENOENT 未捕获异常打穿 A（3210）→ watchdog 反复重启。
# 现：① 打开总开关关掉 B（面板/自动拉起只得到「已停用」，不再 spawn）；
#     ② 引擎根回落到存在的 A 根，双保险。
# 恢复 B：删掉 FORGE_ENGINE_B_DISABLED 这行 + 重建 ~/dsh-local-b 与 ~/.dsh-b。
export FORGE_ENGINE_B_DISABLED="${FORGE_ENGINE_B_DISABLED:-1}"
export FORGE_DSH_LOCAL_ROOT="${FORGE_DSH_LOCAL_ROOT:-<dsh>}"
export FORGE_DSH_HOME="${FORGE_DSH_HOME:-<home>/.dsh-b}"

echo "==> 4. 重启 dsh web"
cd <dsh>
# node 用绝对路径（/usr/local/bin/node）：launchd 等无 PATH 环境调用本脚本时
# 找不到 node（"nohup: node: No such file or directory"），必须显式指定。
# --use-env-proxy（Node ≥24）：让 global fetch 认 HTTP_PROXY/HTTPS_PROXY/NO_PROXY。本机是
# 「本地代理 + DNS 污染」环境，没这个 flag → 插件里所有境外域名直连必然 Connect Timeout
# （实测 models.dev：node fetch 10s 超时 / curl 走代理 1.2s 200 → 套餐「更新列表」拉不到目录）。
NODE_BIN=$(command -v node 2>/dev/null || echo /usr/local/bin/node)
"$NODE_BIN" --version >/dev/null 2>&1 || NODE_BIN=/usr/local/bin/node
nohup "$NODE_BIN" --use-env-proxy node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 3210 --no-open > ~/.dsh/web.log 2>&1 &
sleep 4

echo "==> 5. 验证"
# ISS-402：原先只 sleep 4 就取 PID —— 冷启动 + 插件加载常来不及 bind，于是这条
# "新 PID:" 经常打出**空值**（误导，且 pidfile 也写不成）。改为轮询等待（最多 30s）。
NEW_PID=""
for _i in $(seq 1 30); do
  NEW_PID=$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$NEW_PID" ] && break
  sleep 1
done
if [ -n "$NEW_PID" ]; then
  echo "    新 PID: ${NEW_PID}（旧 PID ${OLD_PID}，等待 $(( _i > 1 ? _i : 1 ))s 后 bind）"
  # ISS-402：写 pidfile —— watchdog 下轮探测到 down 时可以据此报出「上一个进程的 PID 与
  # 存活时长」（否则监听一消失，PID 就无从得知，事后只能看到一句 no-listener）。
  printf '%s %s\n' "$NEW_PID" "$(date +%s)" > "$HOME/.dsh/web.pid"
  echo "    已记 pidfile: ~/.dsh/web.pid"

  # ── ISS-537：插件路由自检（「bind 成功 ≠ 插件挂上」）──────────────────────────
  # 实测事故：从 B 引擎会话重启 → 继承 DSH_HOME → A 读空壳 profile → /forge-* 全 404，
  # 而脚本只按 PID 报成功（老板视角：「工作台打开了但什么都没了」）。这里探三条常见
  # 插件路由，任一 200 即认为装配正常（不硬绑某一个插件，防插件被停用时误报）。
  PLUGIN_OK=""; PLUGIN_CODE=""
  for _j in $(seq 1 15); do
    for _p in /forge-pm/list /forge-notify/list /forge-plans/overview; do
      PLUGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:3210${_p}" 2>/dev/null || echo 000)"
      [ "$PLUGIN_CODE" = "200" ] && { PLUGIN_OK="$_p"; break 2; }
    done
    sleep 1
  done
  if [ -n "$PLUGIN_OK" ]; then
    echo "    插件自检: ${PLUGIN_OK} = 200 ✓"
    log_action ok "$NEW_PID" "$(( _i > 1 ? _i : 1 ))" "$PLUGIN_OK"
  else
    echo "    ✗ 插件自检失败（三条路由都不是 200，最后一次 ${PLUGIN_CODE}）——大概率 home/profile 不对："
    echo "      查：ps eww ${NEW_PID} | tr ' ' '\\n' | grep -E '^DSH_HOME='（A 引擎**不该**有 DSH_HOME）"
    echo "      查：ls -l ~/.dsh/profiles/web/cordis.patch.yml（应含各插件行，不是空壳）"
    tail -5 ~/.dsh/web.log
    log_action failed-plugin-selfcheck "$NEW_PID" "$(( _i > 1 ? _i : 1 ))" "$PLUGIN_CODE"
    exit 1
  fi
else
  echo "    30s 内未 bind（watchdog 会接手重启；本次不写 pidfile，避免记下假 PID）"
  log_action no-bind "" 30 ""
fi
tail -3 ~/.dsh/web.log
