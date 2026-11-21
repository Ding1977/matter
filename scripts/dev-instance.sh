#!/usr/bin/env bash
# 隔离验证实例（ISS-329）—— 在 3211 上验证 worktree 的 host 插件改动，
# 生产会话（3210）全程不重启、不中断。
#
# 为什么需要：3210 就是会话宿主，改 host 插件要重启它 = 当前会话中断、正在跑的任务半途而废。
# 把「验证」搬到独立实例上，生产会话就再也不受开发影响。
#
# 隔离边界：
#   DSH_HOME=~/.dsh-verify     会话/配置独立（绝不碰生产 ~/.dsh 的会话数据）
#   FORGE_PM_ROOT=~/.dsh-verify/pm
#       分层隔离：issues/documents/projects/... 共享（symlink，验证要真实数据、以读为主）；
#       runs/sessions/queue/state **独立**（写频繁，独立后两实例可真正并行，不再撞号/覆盖）
#   FORGE_AGENTS_ROOT=~/.dsh-verify/agent-runs（ISS-570 P0⓪c）
#       agent 域换根后的第二个根：runs/sessions/state 独立、agents/（引擎配置）软链生产。
#       没有这一段，P2 之后 3211 会把 agent 数据直写生产 ~/.dsh/pm（静默污染）。
#   端口 3211                  与生产 3210 并存
#   profiles 用硬链接树复制    （cp -al，秒级、不占空间），插件 symlink 改指目标 worktree
#
# 用法：
#   dev-instance.sh start <ISS-NNN>   起验证实例（插件指向 ~/wt/dsh-forge/<ISS> 或 .wt/<ISS>）
#   dev-instance.sh stop              停验证实例
#   dev-instance.sh restart <ISS-NNN> 重启并切换插件指向
#   dev-instance.sh status            状态 + 端口 + 插件指向
#   dev-instance.sh logs [n]          日志尾

set -euo pipefail

REPO="${DSH_FORGE_REPO:-<repo>}"
WT_ROOT="${DSH_FORGE_WT_ROOT:-<wt>}"
VERIFY_HOME="${DSH_HOME_VERIFY:-$HOME/.dsh-verify}"
PORT="${DSH_VERIFY_PORT:-3211}"
PROD_PORT="${DSH_PROD_PORT:-3210}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
LOG="$VERIFY_HOME/dev-instance.log"
PIDFILE="$VERIFY_HOME/dev-instance.pid"
DSH_BIN="$REPO/../dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js"

c_ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
c_warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
c_err()  { printf "\033[31m✗\033[0m %s\n" "$*"; }

# ─── 生产 home 探测（ISS-608：本脚本此前写死 `$HOME/.dsh`，而生产早已搬到 ~/.dsh-matter）──
#
# 为什么**不写死**也**不写死新值**：
#   2026-09-27 那次「甲案搬家」把生产 home 从 `~/.dsh` 挪到 `~/.dsh-matter`
#   （`~/.dsh` 从此归官方 App），本脚本没跟 ⇒ 四条路径全悬空、实例「看着绿数据全错」。
#   若这次只把默认值改成 `~/.dsh-matter`，**下次再搬家就再坏一次**（同一类事故第三遍）。
#   故改为**从活着的 3210 进程探测**：谁在跑 3210，它开的就是生产 home（lsof 可验，
#   沙箱里 `ps -E` 常不可用、`lsof` 可用 —— 与 `prod-guard.sh` 同一判据来源）。
#   探测不到（3210 没跑）⇒ 退回候选列表里**存在的那个**，仍探测不到才报错退出。
detect_prod_home() {
  # ① 显式指定优先（CI / 特殊现场）
  if [ -n "${DSH_HOME_PROD:-}" ]; then echo "$DSH_HOME_PROD"; return 0; fi
  # ② 从活着的 3210 进程探测（权威）
  # ⚠️ 不写 `2>/dev/null`：实测 lsof **无匹配时完全安静**（退出码 1、stderr 空）⇒ 抑制是多余的，
  #    而多余的抑制会把真错误一起吞掉（独立审查 2026-10-12 · M3 的棘轮口径）。
  local pid
  pid="$(lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN | head -1)" || pid=""
  if [ -n "$pid" ]; then
    local h
    # 取该进程打开的文件里出现频次最高的 ~/.dsh* home（排除 profiles/ 等子路径干扰）
    h="$(lsof -p "$pid" | grep -oE "$HOME/\.dsh[a-zA-Z0-9_-]*" | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')" || h=""
    if [ -n "$h" ] && [ -d "$h" ]; then echo "$h"; return 0; fi
  fi
  # ③ 3210 未跑 ⇒ 按候选序取第一个存在的（新布局在前：搬家后的现役位置）
  for cand in "$HOME/.dsh-matter" "$HOME/.dsh"; do
    if [ -d "$cand/profiles" ]; then echo "$cand"; return 0; fi
  done
  return 1
}

if ! PROD_HOME="$(detect_prod_home)"; then
  c_err "探测不到生产 home：3210（端口 ${PROD_PORT}）未在跑，且 \$HOME/.dsh-matter 与 \$HOME/.dsh 都没有 profiles/"
  c_err "  ⇒ 显式指定后重试，例如：DSH_HOME_PROD=~/.dsh-matter bash scripts/dev-instance.sh start ISS-NNN"
  exit 1
fi

resolve_worktree() {
  local iss="$1"
  if [ -d "$WT_ROOT/$iss" ]; then echo "$WT_ROOT/$iss"
  elif [ -d "$REPO/.wt/$iss" ]; then echo "$REPO/.wt/$iss"
  else c_err "找不到工作树：${iss}（先 ws.sh new ${iss}）"; return 1; fi
}

prepare_home() {
  local wt="$1"
  mkdir -p "$VERIFY_HOME"

  # profiles：从生产**每次同步**（ISS-608 欠账③）。
  #
  # ⚠️ 原实现只在 `$VERIFY_HOME/profiles` 不存在时 `cp -al` 一次（首次），此后**永不跟随生产**。
  #   而生产装配（cordis.patch.yml / settings.yaml / 插件清单）是会变的（09-28 甲案后大改过），
  #   于是验证实例跑的是**旧的装配 + 新的代码** ⇒ 「看着绿、装配却不对」的假绿。
  #   现改为：装配文件（*.yml/*.yaml/*.json 配置面）**每次覆盖**，node_modules 的 symlink 面保留
  #   （它是 `ln -sfn` 指向 worktree 的，不能覆盖）；`dist/` 亦保留（下面单独处理）。
  #
  # 判据：profiles 下**除 node_modules 外**的文件/目录，都以生产为真相源同步。
  if [ ! -d "$VERIFY_HOME/profiles" ]; then
    c_warn "首次准备：复制 profiles 骨架（秒级）"
    mkdir -p "$VERIFY_HOME/profiles"
  fi
  # node_modules 面：**首次**从生产硬链接复制一次（此后保留，由下方按 worktree 改 symlink）。
  # ⚠️ 不能"永远跳过"—— 首次运行时它根本不存在 ⇒ 插件全找不到（ISS-608 自查中修）。
  if [ ! -d "$VERIFY_HOME/profiles/node_modules" ]; then
    c_warn "首次准备：硬链接复制 profiles/node_modules（秒级、不占空间）"
    # 硬链接跨卷会失败（EXDEV）⇒ 退化为真复制；失败信息**不吞**（K9c 口径）
    if ! cp -al "$PROD_HOME/profiles/node_modules" "$VERIFY_HOME/profiles/node_modules"; then
      c_warn "硬链接不可用（跨卷？）⇒ 退化为完整复制"
      cp -R "$PROD_HOME/profiles/node_modules" "$VERIFY_HOME/profiles/node_modules"
    fi
  fi
  local synced=0 n=0
  for entry in "$PROD_HOME/profiles"/*; do
    [ -e "$entry" ] || continue
    local ename; ename="$(basename "$entry")"
    [ "$ename" = "node_modules" ] && continue   # symlink 面：上方已处理，不覆盖
    if [ -d "$entry" ]; then
      mkdir -p "$VERIFY_HOME/profiles/$ename"
      # 个别条目可能不可拷（权限/TCC）⇒ **显式告警**，不静默吞（K9c 口径）
      cp -al "$entry"/* "$VERIFY_HOME/profiles/$ename/" || c_warn "  同步跳过（不可拷）：profiles/$ename"
    else
      cp -f "$entry" "$VERIFY_HOME/profiles/$ename" || c_warn "  同步跳过（不可拷）：profiles/$ename"
    fi
    synced=$((synced+1))
  done
  # 顶层装配文件（cordis.patch.yml 等）单独确保（有些 profile 目录结构深）
  for prof in "$PROD_HOME"/profiles/*/; do
    [ -d "$prof" ] || continue
    local pn; pn="$(basename "$prof")"
    for cfg in cordis.patch.yml settings.yaml package.json; do
      [ -f "$prof$cfg" ] || continue
      mkdir -p "$VERIFY_HOME/profiles/$pn"
      cp -f "$prof$cfg" "$VERIFY_HOME/profiles/$pn/$cfg" || c_warn "  同步跳过：profiles/$pn/$cfg"
    done
  done
  c_ok "profiles 配置面已从生产同步（$synced 项；node_modules 面保留指向 worktree）"
  # 插件指向目标 worktree（worktree 里没有的插件回指主 checkout）
  for link in "$VERIFY_HOME"/profiles/node_modules/forge-*; do
    [ -L "$link" ] || [ -e "$link" ] || continue
    local pname2; pname2="$(basename "$link")"
    if [ -d "$wt/$pname2" ]; then
      ln -sfn "$wt/$pname2" "$link"; n=$((n+1))
    else
      ln -sfn "$REPO/$pname2" "$link"
    fi
  done
  c_ok "插件指向：${wt}（$n 个），其余回指主 checkout"

  # worktree 的插件目录没有 node_modules（git worktree 不带依赖）——逐个软链回主 checkout，
  # 否则插件 import @deepseek-ai/* 直接 ERR_MODULE_NOT_FOUND（首次实测踩中）
  local m=0
  for pkg in "$wt"/forge-*/; do
    [ -d "$pkg" ] || continue
    local pname; pname="$(basename "$pkg")"
    [ -d "$REPO/$pname/node_modules" ] || continue
    if [ ! -e "$pkg/node_modules" ]; then
      ln -sfn "$REPO/$pname/node_modules" "$pkg/node_modules"; m=$((m+1))
    fi
  done
  if [ "$m" -gt 0 ]; then c_ok "插件依赖已共享（$m 个 symlink → 主 checkout）"; fi

  # client 产物（dist/client.js）：worktree 是干净 checkout，没有构建产物 → 借用主 checkout 的。
  # ⚠️ ISS-418（写穿事故）：**必须 cp，绝不能 ln -s** —— 软链会让工作树里的一次 `build:client`
  # 穿过链接把**主 checkout 的产物**覆盖成「工作树那份（往往更旧）源码」的构建结果；
  # dist 不入库 → git 干净、无人察觉，线上 UI 静默回退（实测：ISS-371 工作树 20:36 的一次构建
  # 覆盖了主 checkout 的 forge-ui 产物，页面丢掉 ISS-410/412 两处已合并改动）。
  local d=0
  for pkg in "$wt"/forge-*/; do
    [ -d "$pkg" ] || continue
    local dname; dname="$(basename "$pkg")"
    # 老实例留下的写穿软链 = 雷，先拆
    if [ -L "$pkg/dist/client.js" ]; then
      rm -f "$pkg/dist/client.js"
      c_warn "已拆除写穿软链：$pkg/dist/client.js（改用复制，ISS-418）"
    fi
    if [ ! -e "$pkg/dist/client.js" ] && [ -f "$REPO/$dname/dist/client.js" ]; then
      mkdir -p "$pkg/dist"
      cp -f "$REPO/$dname/dist/client.js" "$pkg/dist/client.js"; d=$((d+1))
    fi
  done
  if [ "$d" -gt 0 ]; then c_warn "client 产物已**复制**主 checkout 的版本（$d 个）——改过前端请在工作树里 build:client"; fi
}

prepare_pm() {
  local vpm="$VERIFY_HOME/pm" ppm="$PROD_HOME/pm"
  mkdir -p "$vpm"
  # 共享层：生产 PM 的每个条目 symlink 过来（内容与配置，验证以读为主）
  local shared=0
  for entry in "$ppm"/*; do
    [ -e "$entry" ] || continue
    local name; name="$(basename "$entry")"
    case "$name" in runs|sessions|queue|state) continue ;; esac
    if [ ! -e "$vpm/$name" ]; then ln -sfn "$entry" "$vpm/$name"; shared=$((shared+1)); fi
  done
  # 独立层：写入频繁——独立后 3211 的 Run 号从 RUN-001 起，与生产不撞号、不覆盖会话
  for name in runs sessions queue state; do mkdir -p "$vpm/$name"; done
  c_ok "PM 分层：共享 $shared 项 + 独立 runs/sessions/queue/state"
}

# ISS-570 P0⓪c：agent 域换根后的**第二个根**。
#
# 为什么现在就改：P2 之后 forge-agents 写的是 AGENTS_ROOT（DOC-256 §7.2 线 #1 的四目录）。
# 本脚本的 PM 分层只认 FORGE_PM_ROOT 一个根——不并行支持的话，3211 验证实例会把 Run、
# 会话、ACP state **直写生产 ~/.dsh/pm**：污染恰好发生在「为了安全才做的验证」这一步，
# 而且是静默的（生产 3210 与验证实例从此共用 agent 数据，撞号/互相覆盖）。
# 现在导出环境变量是无害的：forge-agents 还不存在，没人读它（P2a 起才生效）。
prepare_agents_root() {
  local var="$VERIFY_HOME/agent-runs"
  # ISS-608 欠账④：原写 `$PROD_HOME/agent-runs/agents` —— 该路径**已不存在**（可复算：
  #   `ls ~/.dsh-matter/agent-runs` = No such file）。换根后现役位置是 `$PROD_HOME/forge-agents/`
  #   （实测 `ls ~/.dsh-matter/forge-agents/` = agents / runs / state / secrets / registry.db*）。
  #   ⇒ 软链建不出来、agents 配置缺失，实例跑的是**空配置**（假绿）。
  # 改为：**两处都探**（新位置优先），并显式报告命中哪个、没命中时告警不静默。
  local pag=""
  for cand in "$PROD_HOME/forge-agents/agents" "$PROD_HOME/agent-runs/agents"; do
    if [ -d "$cand" ]; then pag="$cand"; break; fi
  done
  for name in runs sessions state; do mkdir -p "$var/$name"; done
  # agents/（引擎配置）软链而非独立复制：验证要用**真实**引擎配置，复制一份会漂移，验出来不算数。
  # 代价是「在验证实例里改配置」会落到生产——与 PM 共享层同一口径。
  # 只删「是符号链接」这一种情况（本机 ln -sfn 的原子替换在 TCC 目录下不可靠，见 ws.sh 头注）；
  # 万一是真目录就留着不动——那说明有人放了真数据，不能 rm -rf 掉。
  if [ -L "$var/agents" ]; then rm -f "$var/agents"; fi
  if [ -n "$pag" ] && [ ! -e "$var/agents" ]; then
    ln -s "$pag" "$var/agents"
    c_ok "agent 根就绪：${var}（runs·sessions·state 独立 / agents 软链 ${pag}）"
  elif [ -z "$pag" ]; then
    c_warn "agent 配置目录未找到（试过 $PROD_HOME/forge-agents/agents 与 $PROD_HOME/agent-runs/agents）"
    c_warn "  ⇒ 验证实例将拿不到引擎配置；若本次验证涉及 agent 派单，结果不可信"
  else
    c_ok "agent 根就绪：${var}（agents 已存在，保留不动）"
  fi
}

start_instance() {
  local iss="$1"
  local wt; wt="$(resolve_worktree "$iss")" || exit 1
  prepare_home "$wt"
  prepare_pm
  prepare_agents_root

  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    c_warn "验证实例已在跑（PID $(cat "$PIDFILE")），先 stop"
    exit 1
  fi

  # ⚠️ FORGE_AGENTS_ROOT **默认不给**（ISS-570 P2a 实测踩出来的）：搬家前 agent 数据仍在
  #   ~/.dsh*/pm 的四个子目录下，此时设了新根会让 forge-agents 读到空目录 —— 于是
  #   「双前缀契约 diff」比的是两批不同数据，一致也是假的（实测：旧前缀 2887B / 新前缀 126B）。
  #   P2b 把 runs·sessions·agents·state 真搬过去之后，用 WITH_AGENTS_ROOT=1 打开。
  # ISS-675：**必须经 `env` 传**。bash 3.2 的赋值前缀在展开**之前**就被识别，
  #   所以 `KEY=VAL` 由变量展开而来时不会被当成赋值，而是被当作**命令名**执行
  #   （实测报 `FORGE_AGENTS_ROOT=…: No such file or directory`，nohup 从未启动）。
  #   `env` 自己解析每个 `KEY=VAL` 参数，与展开来源无关（实测：不带/带引号展开都失败，env 通过）。
  agents_env=""
  if [ "${WITH_AGENTS_ROOT:-0}" = "1" ]; then agents_env="FORGE_AGENTS_ROOT=$VERIFY_HOME/agent-runs"; fi
  env DSH_HOME="$VERIFY_HOME" FORGE_PM_ROOT="$VERIFY_HOME/pm" ${agents_env:+"$agents_env"} \
    nohup "$NODE_BIN" --use-env-proxy "$DSH_BIN" --profile web --port "$PORT" --no-open \
    > "$LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  disown 2>/dev/null || true

  # 等就绪（最多 40s）：**进程存活 + HTTP 状态码 ≠ 000** 两个条件同时成立才算就绪。
  # ⚠️ ISS-675：原先只看端口，且 code 用 `$(curl … || echo 000)` 取——连接失败时 curl 的
  #   `-w '%{http_code}'` 已经输出了 `000`（无换行），再被 `echo 000` 接上 ⇒ 得到 `000000`，
  #   与 `"000"` 不等 ⇒ **什么都没监听也判定「已就绪」（假绿，实测 code=000000）**。
  #   现在 ① 把 `||` 移出命令替换、② 每轮校验 PID 存活（启动即失败立刻报错并附日志尾巴，不再空等 40s）。
  for i in $(seq 1 40); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      c_err "实例进程已退出（PID ${pid}）——启动失败，日志尾部："
      tail -15 "$LOG" 2>/dev/null | sed 's/^/    /'
      rm -f "$PIDFILE"
      exit 1
    fi
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" || code=000
    if [ "$code" != "000" ]; then
      c_ok "验证实例已就绪：http://127.0.0.1:$PORT/（PID ${pid}）"
      echo "  插件代码：$wt"
      echo "  生产会话：3210 未受影响"
      echo "  日志：dev-instance.sh logs"
      return 0
    fi
  done
  c_err "40s 未就绪（进程 $pid 仍在跑但端口无响应），看日志：tail -30 $LOG"
  exit 1
}

stop_instance() {
  if [ ! -f "$PIDFILE" ]; then c_warn "没有记录的验证实例"; return 0; fi
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 2
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    c_ok "已停验证实例（PID ${pid}）"
  else
    c_warn "PID $pid 已不在"
  fi
  rm -f "$PIDFILE"
}

status_instance() {
  echo "── 隔离验证实例 ───────────────────────────"
  echo "端口      : ${PORT}（生产 3210）"
  echo "DSH_HOME  : $VERIFY_HOME"
  echo "PM 数据   : $VERIFY_HOME/pm（分层：内容共享 / runs·sessions·queue·state 独立）"
  echo "agent 数据: $VERIFY_HOME/agent-runs（ISS-570 换根后生效 / runs·sessions·state 独立·agents 软链生产配置）"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    c_ok "运行中（PID $(cat "$PIDFILE")）"
    local pm; pm="$(readlink "$VERIFY_HOME/profiles/node_modules/forge-pm" 2>/dev/null || echo '?')"
    echo "插件指向  : $pm"
    # 打开方式：DSH web 必须带启动时打印的 token（直接开根路径会报 authentication required）
    local url; url="$(grep -oE "http://127\.0\.0\.1:$PORT/\?token=[A-Za-z0-9_-]+" "$LOG" 2>/dev/null | tail -1 || true)"
    [ -n "$url" ] && echo "打开方式  : $url"
    echo "HTTP      : $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo '无响应')"
  else
    echo "状态      : 未运行"
  fi
  # 生产实例不受影响确认
  local prod; prod="$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -n "$prod" ] && c_ok "生产 3210 正常（PID ${prod}）" || c_warn "生产 3210 没在跑"
}

case "${1:-status}" in
  start)   shift; start_instance "${1:-}" ;;
  stop)    shift; stop_instance ;;
  restart) shift; stop_instance; start_instance "${1:-}" ;;
  status)  shift; status_instance ;;
  logs)    shift; tail -n "${1:-40}" "$LOG" ;;
  *) sed -n '2,28p' "$0" ;;
esac
