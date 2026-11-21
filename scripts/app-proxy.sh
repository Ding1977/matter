#!/usr/bin/env bash
# app-proxy.sh — DSH 引擎的代理环境「单一真相源」（官方 App 19387 / 3210 独立服务共用）。
#
# ── 为什么必须有这个脚本（2026-10-03 排障，展开见 docs/memory/commandcode-direct-blocked-2026-10-03.md）──
# 1) DSH 引擎**只认启动时的环境变量**：`dsh/lib/profile-boot-*.js` 启动即调
#    `installProxyFromEnvironment(启动环境快照)`，macOS 系统代理（ClashX 那个开关）对它**完全无效**。
#    ⇒ 想让引擎走代理，只能在**拉起进程时**注入。
# 2) 三条链路的正确走法**不一样**，不能一刀切：
#    ⚠️ 以下几条是 **2026-10-03 的历史结论**，其中 commandcode / opencode 两条**已被下方更新推翻**
#       （现均为直连：搜 `改为直连` 可见两条带日期的推翻条目 —— 别记行号，注释增删会让它漂）。
#       **保留原样是留痕**，读的时候请以 DIRECT_EXEMPT 为准 —— 那才是唯一生效的名单。
#    · api.commandcode.ai / openrouter.ai —— 直连被 TLS 层阻断（当时实测 0/15 通）⇒ **必须走代理**；
#      ⚠️ 其中 api.commandcode.ai 已推翻 → 现为**直连**（搜 `老板拍板乙案`）；openrouter.ai 仍走代理。
#    · opencode.ai（opencode / opencode-go）—— 直连本身是通的、还快约 22%，但**域名会被阵发污染**
#      （当时实测 8/20 次解析到黑洞 IP → TCP 连上、TLS 永不完成 → 请求悬挂）；走代理后由**节点解析域名**
#      （ClashX 连接链实测 `HK - 香港综合`），污染免疫 ⇒ 也走代理，用 ~0.3s 换稳定性；
#      ⚠️ 已推翻 → opencode.ai 现为**直连**（ISS-645，搜 `ISS-645` 见该条）。
#    · 境内 provider（deepseek / 智谱 / sensenova / 火山 / apiqik / gmi / stepfun / minimax /
#      千问 token-plan / 小米 token-plan）—— 必须**直连**：08-28 实测境内域名被推去绕境外节点会抖到 6.2s。
# 3) **死代理比没有代理更糟**（08-28 事故：继承链里的浮动端口失效 → 境外模型 100% Connection error）：
#    所以探活失败时本脚本**显式清空**六个变量，绝不注入一个没验证过的代理。
# 4) 大小写**必须一并写**：undici 读代理变量**小写优先**（08-28 根因），只写大写等于没写。
#
# 用法：
#   bash scripts/app-proxy.sh check      # 探活 + 打印将要注入的六个变量（人看）
#   bash scripts/app-proxy.sh export     # 打印 export/unset 行（供 eval / source）
#   bash scripts/app-proxy.sh env-args   # 打印 open(1) 的 --env 参数（供 App 启动器）
#   bash scripts/app-proxy.sh apply      # launchctl setenv 持久化（**需在终端里跑**，沙箱内无权限）
#   bash scripts/app-proxy.sh restart    # 退出并带 env 重启官方 App（带自愈回退 + 日志）
#
# 退出码：0 = 有健康代理；3 = 无健康代理（变量已按「清空」处理，调用方照常继续）
set -u
# launchd 拉起时 PATH 很窄 —— 本脚本要用 lsof/curl/osascript，显式补齐（照 watchdog-matter.sh 口径）
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
APP="${DSH_APP_PATH:-/Applications/DeepSeek Harness.app}"
LOG="${FORGE_APP_PROXY_LOG:-$HOME/.dsh/app-proxy.log}"
# 日志不可写时（沙箱）退到 /dev/null —— 否则 `open -a ... >>"$LOG"` 会**因为重定向失败而启动不了 App**
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
{ : >> "$LOG"; } 2>/dev/null || LOG=/dev/null
PORT="${DSH_DESKTOP_PORT:-19387}"

# 候选代理：固定端口优先（ClashX 常驻），其次继承来的（可能是 agent 沙箱浮动端口，随时会死）
CANDIDATES=("http://127.0.0.1:7890" "${HTTPS_PROXY:-${HTTP_PROXY:-}}")

# 直连名单 = 环回 + 境内全量 provider 域名（apex 与点号子域两条都要，点号那条不匹配 apex 本身）
LOOPBACK="localhost,127.0.0.1,::1,[::1]"
DOMESTIC="api.deepseek.com,.deepseek.com,open.bigmodel.cn,.bigmodel.cn,token.sensenova.cn,.sensenova.cn,ark.cn-beijing.volces.com,.volces.com,api.dimleap.cn,.dimleap.cn,api.gmi-serving.com,.gmi-serving.com,api.stepfun.com,.stepfun.com,api.minimaxi.com,.minimaxi.com,token-plan.cn-beijing.maas.aliyuncs.com,.aliyuncs.com,token-plan-cn.xiaomimimo.com,.xiaomimimo.com,api.kimi.com,.kimi.com,.moonshot.cn"
# 直连豁免（2026-10-06 ISS-594 现场核查后加）：域名本身**不需要**代理、且 ClashX 规则里已走 DIRECT，
# 放进 NO_PROXY 的唯一目的是**去掉对代理存活状态的依赖** —— 代理一挂，没进名单的域名会 100% Connection error。
#   · copilot.tencent.com（WorkBuddy 网关）—— ClashX 实测命中 DomainSuffix(tencent.com)→🎯本地直连，
#     且 10-06 断网窗口里 workbuddy 与 block 掉的境外域名同时报错 ⇒ 摘出来做单点解耦。
#   · api.commandcode.ai（2026-10-18 老板拍板乙案）：**由「必须走代理」改为直连**。
#     依据 = 当日现场实测：直连 60/60 通过（0.6–3.6s），证书由 Google Trust Services 签发、
#     有效期至 2026-12-07（10-03 记录的「直连被 TLS 层阻断 0/15」前提已消失）；
#     而经 ClashX 香港节点时 **32 路并发下 25–27/32**，失败形态统一为
#     `UND_ERR_CONNECT_TIMEOUT`（10.5s）—— 单条请求正常、并发即握手排队超时。
#     这条正是当日 186 次 `llm/retry`（TRANSPORT/TIMEOUT）的来源，故摘出代理以去掉该瓶颈。
#     ⚠️ 反向条件：若日后直连再被劫持（证书 issuer 变化 / 连接超时），本节需改回代理。
#   · opencode.ai / amr-link.open-design.ai（ISS-645，老板 2026-10-23 批「甲」）：
#     **由「走代理」改为直连**。上面那条「仍不加」的前提已失效，故本条推翻它。
#     依据（当日现场实测，交替配对，带真实 key 打真实推理端点）：
#       · opencode-go 130KB 请求：经 ClashX **3/4 失败**（`UND_ERR_SOCKET` 15.5s）；直连 **5/5 全过**（4.2–5.4s）
#       · amr-link 130KB 请求：经代理 **2/4 失败**（15.4–17.8s）；直连 **4/4 全过**（3.4–4.7s）
#       ⇒ 直连不只是「通」，还**快 3 倍**（15s → 4.5s）。
#     ⚠️ 失败形态与 commandcode 那条**不同**，别混：这里是 `UND_ERR_SOCKET`（对端在**数据阶段**掐断响应流），
#       不是 `UND_ERR_CONNECT_TIMEOUT`（握手阶段）。共同点是「经代理传大块数据会断」。
#     ⚠️ 为什么只有**大请求**炸：<40KB 经代理正常；100KB+ 才稳定复现。真实会话请求 = 系统提示 18KB +
#       工具定义 + 对话历史 ⇒ 长会话必炸、短会话没事，所以表现为「用久了就超时」。
#       会话日志实证：某会话 9 次 `pi-ai stream idle timeout after 300000ms`（`block-start` 已收到但 5 分钟零产出）
#       + 8 次 `Connection error.`(TRANSPORT)，17 次重试**只有 1 次救回** ⇒ 重试机制对这个故障基本无效。
#     ⚠️ 与 ISS-644（X25519 preload）是**两件事、同一条链路**：那条治握手阶段首包过大被丢
#       （`UND_ERR_CONNECT_TIMEOUT`），本条治数据阶段响应流被掐（`UND_ERR_SOCKET`）。那条管不了这条。
#     ⚠️ 旧注释「8/20 解析到黑洞 IP」的前提**当日复验已消失**：DNS 20/20 正常（4 个合法 Cloudflare IP，
#       逐个 `--resolve` 直连全 200）；直连 15/15 全通。故本条推翻旧结论，不是忽略它。
#     ⚠️ 反向条件：若日后直连被劫持（证书 issuer 变化 / 连接超时 / DNS 出现黑洞 IP），本节需改回代理。
DIRECT_EXEMPT="copilot.tencent.com,api.commandcode.ai,.commandcode.ai,opencode.ai,.opencode.ai,amr-link.open-design.ai,.open-design.ai"
NO_PROXY_LIST="$LOOPBACK,$DOMESTIC,$DIRECT_EXEMPT"

# 探活：目标故意选在 NO_PROXY 名单里的域名 —— 必须 `--noproxy ""` 强制穿代理，
# 否则 curl 会绕过代理直连成功，**连死代理都判定为可用**（08-28 实测 exit 0）。
probe_proxy() {
  local c
  for c in "${CANDIDATES[@]}"; do
    [ -n "$c" ] || continue
    if curl -s -o /dev/null --max-time 3 --noproxy "" --proxy "$c" https://api.deepseek.com/models 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  return 1
}

VARS=(HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy)

# 带等待的探活：登录时 ClashX 可能还没起来（LaunchAgent 要用），等不到才判「无代理」。
probe_wait() {
  local deadline=$((SECONDS + ${1:-0})) p
  while :; do
    if p="$(probe_proxy)"; then printf '%s' "$p"; return 0; fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 2
  done
}

emit_export() {
  local p="$1" v
  if [ -n "$p" ]; then
    for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do echo "export $v='$p'"; done
    for v in NO_PROXY no_proxy; do echo "export $v='$NO_PROXY_LIST'"; done
  else
    for v in "${VARS[@]}"; do echo "unset $v"; done
  fi
}

emit_env_args() {
  local p="$1" v
  [ -n "$p" ] || return 0
  for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do printf -- '--env\n%s=%s\n' "$v" "$p"; done
  for v in NO_PROXY no_proxy; do printf -- '--env\n%s=%s\n' "$v" "$NO_PROXY_LIST"; done
}

wait_port() { # $1=期望 up|down  $2=最多等秒
  local want="$1" i
  for i in $(seq 1 "${2:-30}"); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      [ "$want" = up ] && return 0
    else
      [ "$want" = down ] && return 0
    fi
    sleep 1
  done
  return 1
}

# ── 杀进程的唯一出口：先过 scripts/prod-guard.sh 的牙（ISS-614）────────────────────
# 为什么必须有它：本脚本默认杀 19387（App），但端口来自 `PORT="${DSH_DESKTOP_PORT:-19387}"` ——
#   **可覆盖**。`DSH_DESKTOP_PORT=3210 bash scripts/app-proxy.sh restart` 时这里就是在杀生产
#   Matter 服务；旧版靠 lint 的「整文件豁免」（理由「App(19387) 代理重启入口，不碰生产 3210」）
#   放行，而那条理由描述的是**默认值**，不是**保证** ⇒ 豁免覆盖了生产杀，等于违反 AGENTS §4 铁律一。
# 现在与 restart-matter.sh / restart-web.sh 同款牙：判据在 prod-guard.sh（lsof -p 看打开的文件是否含
#   生产 home · fail-closed），本脚本只负责「每一处杀都先过它」。牙比豁免强：豁免是一句话，牙是判据。
# 返回 0 = 已放行并尝试过杀（kill 自身失败如 ESRCH 不算错）· 4 = 被牙拦下（**不杀**）· 64 = 信号写错
guarded_kill() { # $1=TERM|9  $2=pid
  local pid="${2:-}" sig="${1:-}" out
  [ -n "$pid" ] || return 0
  if ! out="$(bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" 2>&1)"; then
    printf '%s\n' "$out" >&2
    echo "✗ 拒绝杀 PID ${pid}（本脚本的 PORT=${PORT}，由 DSH_DESKTOP_PORT 可覆盖）—— 挡生产是 prod-guard 的本职" >&2
    return 4
  fi
  case "$sig" in
    TERM) kill -TERM "$pid" 2>/dev/null || true ;;
    9)    kill -9 "$pid" 2>/dev/null || true ;;
    *)    echo "✗ guarded_kill: 未知信号 '${sig}'（只认 TERM|9）" >&2; return 64 ;;
  esac
  return 0
}

noproxy_hit() { # $1=host —— 命中 NO_PROXY 返回 0（= 直连）
  # ⚠️ NO_PROXY 是**后缀语义**，不是字面匹配：条目 `open-design.ai` 或 `.open-design.ai`
  #   都表示「open-design.ai 及其**所有子域**直连」。2026-10-27 实测（curl remote_ip 判据）：
  #     NO_PROXY='.open-design.ai' → amr-link.open-design.ai ip=104.21.45.58（直连）
  #     NO_PROXY='open-design.ai'  → 同上直连；NO_PROXY='' → ip=127.0.0.1（走代理）
  #   若用字面 `case ",$NO_PROXY_LIST,"` 比对，`amr-link.open-design.ai` 会被误判「走代理」——
  #   今天只因为名单里恰有裸条目才没暴露，改天只剩点前缀就会骗人。故在此做后缀判定。
  local h="$1" e oldifs
  oldifs="$IFS"; IFS=','
  for e in $NO_PROXY_LIST; do
    e="${e#.}"                       # 点前缀去掉，统一成裸域再比
    [ -n "$e" ] || continue
    case "$h" in
      "$e"|*".$e") IFS="$oldifs"; return 0 ;;   # 全等，或以 ".裸域" 结尾（= 其子域）
    esac
  done
  IFS="$oldifs"
  return 1
}

case "${1:-check}" in
  check)
    if p="$(probe_proxy)"; then st="✓ 健康代理：$p"; else st="✗ 无健康代理（将清空全部代理变量，绝不注入死代理）"; fi
    echo "$st"
    echo "--- 将注入的变量 ---"
    emit_export "${p:-}"
    # ── ISS-664：直连/走代理的列举**从 NO_PROXY_LIST 现算**，不写死字符串 ─────────────
    # 旧版这行是硬编码「api.commandcode.ai · openrouter.ai · opencode.ai（+ 其余境外）」：
    #   ISS-645 把 opencode.ai / amr-link 改直连后它仍报「走代理」⇒ 排障第一手依据骗人，
    #   把人引去查 ClashX 节点，而真故障在直连侧。**只把字符串改对仍会腐坏**（下次动名单还会漂），
    #   故改为对每个候选域名用 `case` 现查 NO_PROXY_LIST —— 改 DIRECT_EXEMPT，下面输出立刻跟着变。
    # 候选集 = 常被问到的境外 provider ∪ DIRECT_EXEMPT 里的裸域名条目
    #   （点前缀 `.foo.com` 不重复并入：判定已由 noproxy_hit 按后缀语义覆盖，并入只会让输出多出父域噪音）
    _cand="openrouter.ai opencode.ai amr-link.open-design.ai api.commandcode.ai copilot.tencent.com"
    _oldifs="$IFS"; IFS=','
    for _e in $DIRECT_EXEMPT; do
      case "$_e" in ""|.*) continue ;; esac
      case " $_cand " in *" $_e "*) continue ;; esac
      _cand="$_cand $_e"
    done
    IFS="$_oldifs"
    _direct=""; _proxied=""
    for _h in $_cand; do
      if noproxy_hit "$_h"; then _direct="$_direct$_h · "; else _proxied="$_proxied$_h · "; fi
    done
    echo "--- NO_PROXY 命中 ⇒ 直连 ---"
    echo "  ${_direct% · }（名单真相源：本脚本 DIRECT_EXEMPT，此处现算不手抄）"
    echo "--- NO_PROXY 未命中 ⇒ 走代理 ---"
    if [ -n "$_proxied" ]; then echo "  ${_proxied% · }"; else echo "  （无 —— 候选域名全部命中直连名单）"; fi
    [ -n "${p:-}" ] || exit 3
    ;;
  export)  emit_export "$(probe_proxy || true)" ;;
  env-args) emit_env_args "$(probe_proxy || true)" ;;
  apply)
    # 可选 --wait N：等 ClashX 起来（LaunchAgent 登录时用；正常手动调用不等）
    WAIT=0; [ "${2:-}" = "--wait" ] && WAIT="${3:-60}"
    p="$(probe_wait "$WAIT" || true)"
    mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
    if [ -n "$p" ]; then
      for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do launchctl setenv "$v" "$p" 2>/dev/null || true; done
      for v in NO_PROXY no_proxy; do launchctl setenv "$v" "$NO_PROXY_LIST" 2>/dev/null || true; done
      # 有牙：写完**必须回读核对** —— 沙箱里 launchctl setenv 会静默失败（只往 stderr 吐一行），
      # 不回读就会出现「报成功、其实没生效」，下次再查又是「怎么又直连了」。
      if [ "$(launchctl getenv HTTPS_PROXY 2>/dev/null)" = "$p" ]; then
        echo "✓ launchctl setenv 完成（${p}）—— 之后由 Dock/Launchpad 启动的 App 也会带上代理"
        { echo "  NO_PROXY = $NO_PROXY_LIST"; } >> "$LOG" 2>/dev/null || true
      else
        echo "✗ launchctl setenv **未生效**（沙箱/权限）：请在**真实终端**里重跑：bash $ROOT/scripts/app-proxy.sh apply" >&2
        exit 1
      fi
    else
      for v in "${VARS[@]}"; do launchctl unsetenv "$v" 2>/dev/null || true; done
      if [ -z "$(launchctl getenv HTTPS_PROXY 2>/dev/null)" ]; then
        echo "✓ 无健康代理：launchctl 里的代理变量已清空（死代理比没有代理更糟）"
      else
        echo "✗ 无健康代理，但 launchctl 里仍残留代理变量（沙箱无权限清理）：请在真实终端重跑本命令" >&2
        exit 1
      fi
    fi
    echo "[$(date '+%F %T')] apply proxy=${p:-none}" >> "$LOG" 2>/dev/null || true
    ;;
  restart)
    p="$(probe_proxy || true)"
    OLD_PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
    echo "[$(date '+%F %T')] restart start, proxy=${p:-none}, old_pid=${OLD_PID:-none}" >> "$LOG"
    A=()  # ⚠️ 不用 mapfile：macOS 自带 /bin/bash 是 3.2，没有它
    if [ -n "$p" ]; then
      while IFS= read -r line; do A+=("$line"); done < <(emit_env_args "$p")
    fi
    # 退出：优先 Apple Event 优雅退出（让引擎收尾）；被 TCC 权限拦下时退到 SIGTERM/SIGKILL。
    # 会话锁是 flock(2)（dsh-session-persistence-jsonl），进程一死内核自动释放 ⇒ 强杀也不会留死锁。
    osascript -e 'quit app "DeepSeek Harness"' >/dev/null 2>&1 || true
    if ! wait_port down 15; then
      guarded_kill TERM "$OLD_PID"
      if ! wait_port down 10; then
        guarded_kill 9 "$OLD_PID"
        wait_port down 5 || true
      fi
    fi
    sleep 1
    if [ "${#A[@]}" -gt 0 ]; then
      open -a "$APP" "${A[@]}" >>"$LOG" 2>&1
    else
      open -a "$APP" >>"$LOG" 2>&1
    fi
    NEW_PID=""
    wait_port up 40 && NEW_PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
    # 有牙：**PID 必须换**才算真重启 —— 若 Apple Event 被权限拦掉，「quit」会静默失败，
    # 随后 open -a 只是把旧实例带到前台，端口一直在听 ⇒ 不校验就会假报「已重启」。
    if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ]; then
      echo "✓ App 已重启（PID ${OLD_PID:-?} → ${NEW_PID}，代理 = ${p:-无}）：http://127.0.0.1:$PORT/"
    else
      echo "✗ 未真正重启（PID 仍是 ${NEW_PID:-无}，quit 可能被权限拦下）；改为提示手动重启" | tee -a "$LOG"
      echo "  → 请手动退出 App 再打开（launchctl 里已注入代理，Dock 启动即生效）"
      exit 1
    fi
    echo "[$(date '+%F %T')] restart done, new_pid=$NEW_PID" >> "$LOG" 2>/dev/null || true
    ;;
  exec-app)
    # launchd 托管的**唯一启动入口**（com.openforge.dsh-desktop → 本子命令）。
    #
    # 为什么必须是它：DSH 引擎只在**启动那一刻**读代理环境（profile-boot → installProxyFromEnvironment），
    # 而 macOS 上这两条路都到不了从 Dock 启动的 App：
    #   · 系统代理（ClashX 那个开关）—— 引擎根本不读；
    #   · `launchctl setenv`（gui 域）—— 实测传不到 `open`/Dock 启动的 App（`open` 的原话：
    #     "already running and so the additional environment variables could not be set"），
    #     且 ClashX 1.118 没有 TUN（只有 ProxyConfigHelper）⇒ 网络层也兜不住。
    # ⇒ 只能由 launchd 用**正确的 env** 直接把 App 拉起来；本子命令就干这件事，并负责把旧实例请下来。
    FIRST_MARK="${FORGE_FIRST_RUN_MARK:-$HOME/.dsh/.desktop-agent-first-run}"
    if [ -f "$FIRST_MARK" ]; then
      # 首次装载：先让正在跑的 agent 回合把话说完（否则 App 一退，宿主里的会话直接被掐断）
      sleep "${FORGE_FIRST_RUN_DELAY:-75}"
      rm -f "$FIRST_MARK" 2>/dev/null || true
    fi

    # ── 牙 1：崩溃循环退避 ────────────────────────────────────────────────────
    # 为什么要有：宿主有个**既有崩溃**（`cannot create effect on inactive context` —— cordis 插件热重载
    # Fiber._reload 竞态；崩溃日志 09-28/09-30/10-03 均有，与本脚本无关）。KeepAlive 会把它从
    # 「崩了就停」放大成「每 10s 闪一次」（10-03 06:11 实测 32s 内 4 次）。这里 5 分钟内 ≥4 次就退避 60s，
    # 既留住现场又能让老板看清界面，而不是跑马灯。
    STAMP="$HOME/.dsh/.desktop-agent-starts"
    NOW="$(date +%s)"
    if [ -f "$STAMP" ]; then awk -v n="$NOW" '$1 > n-300' "$STAMP" > "$STAMP.tmp" 2>/dev/null && mv "$STAMP.tmp" "$STAMP" 2>/dev/null; fi
    echo "$NOW" >> "$STAMP" 2>/dev/null || true
    RECENT="$(grep -c . "$STAMP" 2>/dev/null)"; [ -z "$RECENT" ] && RECENT=0
    if [ "$RECENT" -ge 4 ]; then
      echo "[$(date '+%F %T')] ⚠️ 5 分钟内第 ${RECENT} 次启动 → 退避 60s（疑似宿主崩溃循环，见 ~/Library/Logs/DeepSeek Harness/crash-*-host.log）" >> "$LOG" 2>/dev/null || true
      sleep 60
    fi

    # ── 牙 2：端口被占**先等**，不要抢 ─────────────────────────────────────────
    # 上一轮 10s 闪 4 次的放大器就是这里：宿主崩溃后**引擎子进程会残留**并继续占着 19387，
    # 旧写法直接 kill 掉它再起新的 ⇒ 与 Electron 单实例锁抢（新实例发现"已有实例"当场退出）
    # ⇒ launchd 再拉 ⇒ 再抢。改成：先等它自己退干净（同一 PID 最多等 45s），只有确认是**孤儿**
    # （等满还不退）才动手清场。
    OLD="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
    if [ -n "$OLD" ]; then
      echo "[$(date '+%F %T')] exec-app：19387 被 PID $OLD 占用 → 先等它自然退出（最多 45s，不抢）" >> "$LOG" 2>/dev/null || true
      WAITED=0
      while [ "$WAITED" -lt 45 ]; do
        sleep 5; WAITED=$((WAITED + 5))
        NOWPID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
        [ -z "$NOWPID" ] && break
      done
      if [ -n "${NOWPID:-}" ]; then
        echo "[$(date '+%F %T')] exec-app：等满 45s 仍被 PID $NOWPID 占用 → 判定为孤儿引擎进程，清场" >> "$LOG" 2>/dev/null || true
        # 清场同样过牙（ISS-614）：DSH_DESKTOP_PORT 被设成 3210 时，这里的"孤儿"可能就是生产实例。
        # 被拦下时**不杀也不退出**：按上面「不抢」的口径直接往下走，让 App 自己处理单实例锁
        # （退出会被 KeepAlive 每 10s 拉起一次，变成新的跑马灯）。
        if guarded_kill TERM "$NOWPID"; then
          wait_port down 10 || { guarded_kill 9 "$NOWPID"; wait_port down 5 || true; }
        else
          echo "[$(date '+%F %T')] exec-app：清场被 prod-guard 拦下 ⇒ 不杀，继续启动（PORT=${PORT}）" >> "$LOG" 2>/dev/null || true
        fi
      fi
    fi

    p="$(probe_wait "${FORGE_PROBE_WAIT:-20}" || true)"
    if [ -n "$p" ]; then
      for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do export "$v=$p"; done
      export NO_PROXY="$NO_PROXY_LIST" no_proxy="$NO_PROXY_LIST"
    else
      for v in "${VARS[@]}"; do unset "$v" 2>/dev/null || true; done   # 死代理比没有代理更糟
    fi
    echo "[$(date '+%F %T')] exec-app proxy=${p:-none}" >> "$LOG" 2>/dev/null || true
    BIN="$APP/Contents/MacOS/DeepSeek Harness"
    if [ -x "$BIN" ]; then exec "$BIN"; else exec open -a "$APP"; fi
    ;;
  install-desktop-agent)
    # 装「launchd 托管 App」：登录即带（探活后的）代理启动 + 崩溃/退出自动拉起。
    # ⚠️ 必须在**真实终端或被放行的权限下**跑：沙箱无权限写 ~/Library/LaunchAgents、也无权限 launchctl。
    PLIST="$HOME/Library/LaunchAgents/com.openforge.dsh-desktop.plist"
    OLD_AGENT="$HOME/Library/LaunchAgents/com.openforge.app-proxy-env.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    # 旧方案（只做 launchctl setenv）已证明对 Dock 启动的 App 无效 —— 按「不该在的都不在」清掉
    [ -f "$OLD_AGENT" ] && { launchctl unload "$OLD_AGENT" 2>/dev/null || true; mv "$OLD_AGENT" "$OLD_AGENT.retired-$(date +%Y%m%d)" 2>/dev/null || true; }
    : > "$HOME/.dsh/.desktop-agent-first-run" 2>/dev/null || true   # 首次给会话留 75s
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.openforge.dsh-desktop</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$ROOT/scripts/app-proxy.sh</string>
		<string>exec-app</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>FORGE_PROBE_WAIT</key>
		<string>20</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$HOME/.dsh/dsh-desktop-agent.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME/.dsh/dsh-desktop-agent.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    if [ ! -f "$PLIST" ]; then echo "✗ 未写出 ${PLIST}（沙箱无权限）：请在**真实终端**重跑本命令" >&2; exit 1; fi
    if ! launchctl load "$PLIST" 2>/dev/null; then echo "✗ launchctl load 失败（多半在沙箱内）：请在**真实终端**重跑" >&2; exit 1; fi
    if ! launchctl print "gui/$(id -u)/com.openforge.dsh-desktop" >/dev/null 2>&1; then
      echo "✗ job 未注册到 gui 域，load 没生效" >&2; exit 1
    fi
    echo "✓ 已安装并加载：${PLIST}"
    echo "  → 登录/崩溃/退出后由 launchd 用【探活后的健康代理】拉起；旧实例会在 ${FORGE_FIRST_RUN_DELAY:-75}s 后被接管"
    ;;
  *) echo "用法: bash scripts/app-proxy.sh {check|export|env-args|apply|exec-app|install-desktop-agent|restart}"; exit 2 ;;
esac
