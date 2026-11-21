#!/usr/bin/env bash
# web-crash-evidence.sh — 3210 崩溃/被杀**现场取证**（ISS-587 G 项 · 版本事故四类根因之一「静默失败」）
#
# 为什么必须有：AGENTS.md §4.1 写着「禁止直接 kill 3210，因为 web.log 没有崩溃记录，事后无从排查」。
# 但真正毁掉现场的是 **watchdog 自己的自愈重启**：kill 掉旧进程再拉新的，崩前的内存/端口/日志上下文
# 全没了。所以本脚本的唯一正确调用点是 restart **之前**（watchdog 里已接上），把现场落成一份带时间戳的
# 目录，事后能说清「是谁杀的、杀之前进程还活着吗、日志最后说了什么」。
#
# 三条硬约束：
#   ① **只读**：不 kill、不 restart、不改任何配置；只往 ~/.dsh/evidence/ 写自己的 bundle。
#   ② **快**：默认每项都是本地 O(1) 命令（macOS 没有 timeout，所以绝不放 `log show` 这种可能卡住的
#      慢查询进默认路径 —— 那会拖慢 watchdog 自愈）。要深挖用 --deep。
#   ③ **不许假绿**：拿不到的项显式标 missing/unavailable 并计数；--selftest 反向验证「该报缺的能报缺、
#      不该报缺的别报缺」（与 ISS-587 的守卫纪律同一条：假绿比没门禁更糟）。
#
# 用法：
#   bash scripts/web-crash-evidence.sh [collect] [--tag NAME] [--quiet] [--deep]
#   bash scripts/web-crash-evidence.sh latest      # 打印最近一份的 summary 与缺项
#   bash scripts/web-crash-evidence.sh selftest    # 反向验证（退出码 2 = 守卫失效）
set -uo pipefail

EVID_ROOT="${FORGE_EVIDENCE_ROOT:-$HOME/.dsh/evidence}"
WEB_LOG="${DSH_WEB_LOG:-$HOME/.dsh/web.log}"
WATCH_LOG="$HOME/.dsh/watchdog.log"
RESTART_LOG="$HOME/.dsh/watchdog-restart.log"
PIDFILE="$HOME/.dsh/web.pid"
PM_ROOT="${FORGE_PM_ROOT:-$HOME/.dsh/pm}"
KEEP=20
PORT="${FORGE_WEB_PORT:-3210}"
PORT_B="${FORGE_WEB_B_PORT:-3300}"

CMD="${1:-collect}"
case "$CMD" in collect|latest|selftest) shift || true ;; collect) shift || true ;; esac

TAG="manual"
QUIET=0
DEEP=0
for a in "$@"; do
  case "$a" in
    --tag) TAG="next" ;;
    --tag=*) TAG="${a#--tag=}" ;;
    --quiet|-q) QUIET=1 ;;
    --deep) DEEP=1 ;;
    --selftest) CMD="selftest" ;;
    *) [ "$TAG" = "next" ] && TAG="$a" ;;
  esac
done
[ "$TAG" = "next" ] && TAG="manual"

say() { [ "$QUIET" = "1" ] || echo "$@"; }

# ── 采集 ───────────────────────────────────────────────────────────────────
# collect_bundle <输出目录> <DSH_HOME 覆盖（selftest 用）> → 返回缺失项数
collect_bundle() {
  local dir="$1"
  mkdir -p "$dir" || return 1
  local miss=0 total=0
  local ok_list="" miss_list=""

  # 每个来源写成独立文件，缺失时也要留下"为什么缺"的一行 —— 空文件与"没这项"必须能区分
  put() { # put <名字> <命令...>
    local name="$1"; shift
    total=$((total + 1))
    if "$@" > "$dir/$name.txt" 2>"$dir/$name.err"; then
      if [ -s "$dir/$name.txt" ]; then
        ok_list="$ok_list $name"
      else
        # 命令成功但没输出（例如没有监听者）：这本身就是结论，不算缺
        ok_list="$ok_list $name(空=无输出)"
        rm -f "$dir/$name.err"
      fi
    else
      miss=$((miss + 1))
      miss_list="$miss_list $name"
      { echo "采集失败（见同名 .err）"; cat "$dir/$name.err" 2>/dev/null; } > "$dir/$name.txt"
    fi
    rm -f "$dir/$name.err"
  }

  # ① 现场元信息
  {
    echo "taken_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "tag=$TAG"
    echo "uptime=$(uptime)"
    echo "probe_port=$PORT"
  } > "$dir/meta.txt"

  # ② 探活细节（走 --noproxy，与 watchdog 同款判据，否则又会被代理坑出误判）
  put probe env -u HTTP_PROXY -u HTTPS_PROXY curl -s --noproxy '*' --max-time 6 \
    -o /dev/null -w 'http_code=%{http_code} exit_ok\n' "http://127.0.0.1:$PORT/"

  # ③ 端口与进程：谁在听、还在不在、吃了多少内存
  put listeners lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  put listeners_b lsof -nP -iTCP:"$PORT_B" -sTCP:LISTEN
  # 只看 DSH 自己那批进程：全量 ps 会把无关的 Electron/WorkBuddy 长命令行灌进来，
  # 事后翻证据的人要的是"服务端进程在不在、吃了多少"，不是一屏噪音。
  put procs sh -c "ps -Ao pid,rss,etime,command | grep -iE 'deepseek-ai/dsh|lib/bin\\\\.js|profiles/web|watchdog-web|restart-web|dsh/lib' | grep -v grep | head -20"
  # ④ pidfile 与「进程是否真的没了」——区分「进程死了」与「只是不响应」。
  # ⚠️ pidfile 内容是「<pid> <时间戳>」两段（restart-web.sh 写的），必须取**第一个字段**再 kill -0；
  #    整串传进去永远判成已死，那是一条会误导事后排查的假证据（实测抓到过一次）。
  put pidfile sh -c "printf 'pidfile=$PIDFILE\n'; if [ -f '$PIDFILE' ]; then p=\$(awk '{print \$1}' '$PIDFILE'); echo \"pid=\$p raw='\$(cat '$PIDFILE')'\"; if [ -n \"\$p\" ] && kill -0 \"\$p\" 2>/dev/null; then echo 'alive=yes（进程还在，只是不响应）'; else echo 'alive=no'; fi; else echo 'no-pidfile'; fi"
  # ⑤ 日志：尾巴 + 关键错误行（崩溃的直接证据）
  put web_log_tail sh -c "tail -n 200 '$WEB_LOG' 2>/dev/null"
  put web_log_errors sh -c "grep -inE 'error|fatal|SIGKILL|SIGSEGV|SIGABRT|out of memory|heap|uncaught|EADDRINUSE|killed|exit code' '$WEB_LOG' 2>/dev/null | tail -n 60"
  put watchdog_tail sh -c "tail -n 80 '$WATCH_LOG' 2>/dev/null"
  put restart_tail sh -c "tail -n 60 '$RESTART_LOG' 2>/dev/null"
  # ⑥ 与数据侧的时间相关性：pm 目录每小时自动 commit，一次回滚常与崩溃同窗口
  put pm_git sh -c "git -C '$PM_ROOT' log --oneline -5 --date=iso --pretty='%h %ad %s' 2>/dev/null"
  # ⑦ 孤儿写锁残留（写配置卡 2s 的那类事故现场）。
  # ⚠️ 没有锁文件是**好消息**：`ls` 无匹配时退出码 1，会被 put 误判成"采集失败"——
  #    那是假红（自测第一版就报了这条）。用 `|| true` 让"无残留"落成空输出，语义才对。
  put stale_locks sh -c "ls -1 ${DSH_HOME:-$HOME/.dsh}/*.yaml.lock 2>/dev/null || true"
  if [ "$DEEP" = "1" ]; then
    # 慢查询只进 --deep：macOS 的 log show 可能要好几秒，自愈路径上等不起
    put system_log sh -c "log show --last 3m --predicate 'process == \"node\"' --style compact 2>/dev/null | tail -n 200"
  fi

  {
    echo "bundle=$dir"
    echo "tag=$TAG"
    echo "sources_total=$total"
    echo "sources_missing=$miss"
    echo "missing:$miss_list"
    echo "ok:$ok_list"
  } > "$dir/summary.txt"
  # 顺手清掉过旧的 bundle（自我约束，不写满盘）
  ls -1dt "$EVID_ROOT"/web-crash-* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -rf "$old"; done
  echo "$miss"
}

do_collect() {
  local dir="$EVID_ROOT/web-crash-$(date -u '+%Y%m%d-%H%M%S')Z"
  local miss
  miss=$(collect_bundle "$dir")
  say "取证目录：$dir"
  say "缺项：$miss"
  [ "$QUIET" = "1" ] || cat "$dir/summary.txt"
  # --quiet 是给别人当命令行替换用的（watchdog 要把路径落进自己的日志），所以此时**只**输出目录
  [ "$QUIET" = "1" ] && echo "$dir"
  echo "$dir" > "$EVID_ROOT/.latest"
  return 0
}

do_latest() {
  if [ ! -f "$EVID_ROOT/.latest" ]; then
    echo "还没有任何取证 bundle（${EVID_ROOT}）" >&2
    return 2
  fi
  local dir; dir=$(cat "$EVID_ROOT/.latest")
  if [ ! -d "$dir" ]; then
    echo "指针指向的 bundle 已不存在：${dir}（被清理或手工删了 —— 不算'正常'）" >&2
    return 2
  fi
  cat "$dir/summary.txt"
  echo "--- meta ---"; cat "$dir/meta.txt" 2>/dev/null
}

# ── 接线判据（ISS-649）：watchdog 必须在 restart **之前**调本脚本 ────────────
# 顺序错了就永远取不到现场（restart 自己就是毁证据的那一步），而这是最容易被
# 「顺手整理」掉的接线。
#
# ⚠️ 本判据的两个坑都是实测踩出来的（ISS-649 前原断言同时中了两枪，恒红）：
#   ① **注释不能算接线**：`watchdog-web.sh` 第 18 行的退役说明里提到了本脚本名，
#      旧断言按 `grep -n` 取第一处 ⇒ 命中注释行，`evid=18`（不是真实调用点）。
#      故先剔掉行首空白后以 `#` 开头的行，再取**第一个非注释**匹配行。
#   ② **restart 行要前缀宽松匹配**：ISS-558 把它改成了
#      `FORGE_RESTART_SOURCE=watchdog FORGE_WATCHDOG_SELFHEAL=1 bash "$RESTART"`，
#      旧的字面 pattern（`FORGE_RESTART_SOURCE=watchdog bash "$RESTART"`）于是失配 ⇒ `restart=无`。
#      现在只认「行首 FORGE_RESTART_SOURCE=watchdog … 同行还有 bash」这个前缀骨架。
#      ⚠️ 放宽 ≠ 恒绿：删掉那一行 ⇒ restart 为空 ⇒ 红。`--selftest` ④ 用临时副本自证这条。
# 非注释行里第一个匹配 <ERE> 的行号（空 = 没有）
wire_first_line() { # <file> <ERE>
  awk -v pat="$2" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^#/ { next }          # 注释行不算接线（坑①）
    line ~ pat { print NR; exit } # 只看第一处真实接线
  ' "$1" 2>/dev/null
}
# 判 <watchdog 脚本>：0 = 接线正确 · 1 = 缺失/顺序错（红）· 2 = 文件不存在（跳过，不假装通过）
check_wiring() { # <watchdog 脚本>
  local wd="$1"
  [ -f "$wd" ] || return 2
  local ln_evid ln_restart
  ln_evid=$(wire_first_line "$wd" 'bash[^|;&]*web-crash-evidence\.sh')
  ln_restart=$(wire_first_line "$wd" '^FORGE_RESTART_SOURCE=watchdog.*bash')
  if [ -n "$ln_evid" ] && [ -n "$ln_restart" ] && [ "$ln_evid" -lt "$ln_restart" ]; then
    echo "✓ watchdog 在 restart 之前取证（${ln_evid} < ${ln_restart}）"
    return 0
  fi
  echo "✗ watchdog 取证接线缺失或顺序在 restart 之后（evid=${ln_evid:-无} restart=${ln_restart:-无}）"
  return 1
}

# ── 反向验证：该报缺的能报缺，不该报缺的别报缺 ─────────────────────────────
do_selftest() {
  local fails=0
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/crashevid-selftest-XXXXXX")
  # 只本次自检用的小保留数，绝不去改真 EVID_ROOT 的 KEEP 语义
  EVID_ROOT="$tmp/evidence"; mkdir -p "$EVID_ROOT"

  # ① 全部来源都不存在的环境 → 必须报出一堆缺项（0 就代表守卫在假绿）
  WEB_LOG="$tmp/nope-web.log"; WATCH_LOG="$tmp/nope-watch.log"; RESTART_LOG="$tmp/nope-r.log"
  PIDFILE="$tmp/nope.pid"; PM_ROOT="$tmp/nope-pm"; DSH_HOME="$tmp/nope-home"
  local d1="$tmp/bundle-missing"
  local miss; miss=$(collect_bundle "$d1")
  if [ "${miss:-0}" -gt 0 ]; then
    echo "✓ 全缺环境下报出 $miss 个缺项（该响的能响）"
  else
    echo "✗ 全缺环境竟然一个缺项都没报 —— 取证脚本自己假绿"; fails=$((fails + 1))
  fi
  # summary 里必须留下缺了什么的名单，否则报了数也没法定位
  if grep -q '^missing: .*[a-z]' "$d1/summary.txt"; then
    echo "✓ summary.txt 列出了缺项名单"
  else
    echo "✗ summary.txt 没有缺项名单"; fails=$((fails + 1))
  fi

  # ② 真环境（老板机器上跑自检）→ web.log 必须拿得到；拿不到就说明路径判据本身错了
  unset DSH_HOME FORGE_PM_ROOT
  WEB_LOG="${FORGE_WEB_LOG_REAL:-$HOME/.dsh/web.log}"
  WATCH_LOG="$HOME/.dsh/watchdog.log"; RESTART_LOG="$HOME/.dsh/watchdog-restart.log"
  PIDFILE="$HOME/.dsh/web.pid"; PM_ROOT="$HOME/.dsh/pm"
  local d2="$tmp/bundle-real"
  local miss2; miss2=$(collect_bundle "$d2")
  if [ -f "$WEB_LOG" ]; then
    if [ -s "$d2/web_log_tail.txt" ]; then
      echo "✓ 真环境 web.log 采到了（不该报缺的不报，缺项数=${miss2}）"
    else
      echo "✗ 真环境明明有 $WEB_LOG 却没采到 —— 采集命令本身有问题"; fails=$((fails + 1))
    fi
  else
    echo "! 本机没有 ${WEB_LOG}，跳过正向断言（不假装通过）"
  fi

  # ③ latest 指针在 bundle 缺席时不能报成功（空指针/断链都算失效）
  echo "$tmp/不存在的目录" > "$EVID_ROOT/.latest"
  if do_latest >/dev/null 2>&1; then
    echo "✗ latest 在 bundle 不存在时居然成功 —— 假绿"; fails=$((fails + 1))
  else
    echo "✓ latest 对断链指针报错而不是沉默成功"
  fi

  # ④ 接线断言：watchdog 必须在 restart **之前**调本脚本（判据见 check_wiring 上方注释）。
  #    这里不只跑正向 —— 「放宽 pattern」最容易变成恒绿，故用临时副本**自证有牙**：
  #      (a) 删掉 restart 那一行 ⇒ 必红；
  #      (b) 把真实取证调用注释掉（只剩第 18 行注释里提到脚本名）⇒ 必红 —— 这一条正是
  #          ISS-649 之前的假判据（`evid=18` 命中的是注释）。
  local wd; wd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/watchdog-web.sh"
  check_wiring "$wd"
  case $? in
    0) : ;;
    2) echo "! 找不到 ${wd}，跳过接线断言（不假装通过）" ;;
    *) fails=$((fails + 1)) ;;
  esac
  if [ -f "$wd" ]; then
    local lnr lne mut
    mut="$tmp/watchdog-norestart.sh"
    lnr=$(wire_first_line "$wd" '^FORGE_RESTART_SOURCE=watchdog.*bash')
    if [ -n "$lnr" ]; then
      awk -v n="$lnr" 'NR != n' "$wd" > "$mut"
      if check_wiring "$mut" >/dev/null; then
        echo "✗ 删掉 restart 那一行后接线断言仍绿 —— 判据是假牙"; fails=$((fails + 1))
      else
        echo "✓ 删掉 restart 那一行 ⇒ 接线断言变红（有牙）"
      fi
    else
      echo "✗ 找不到 restart 接线行，无法做反向验证"; fails=$((fails + 1))
    fi
    mut="$tmp/watchdog-nocall.sh"
    lne=$(wire_first_line "$wd" 'bash[^|;&]*web-crash-evidence\.sh')
    if [ -n "$lne" ]; then
      awk -v n="$lne" 'NR == n { print "# " $0; next } { print }' "$wd" > "$mut"
      if check_wiring "$mut" >/dev/null; then
        echo "✗ 取证调用被注释掉后断言仍绿 —— 注释又被当成接线了"; fails=$((fails + 1))
      else
        echo "✓ 取证调用被注释掉 ⇒ 接线断言变红（注释不算接线）"
      fi
    fi
  fi

  rm -rf "$tmp"
  if [ "$fails" -gt 0 ]; then
    echo "守卫自检 $fails 项不过 → 退出 2"
    exit 2
  fi
  echo "✓ 守卫自检通过（缺项能报、现场能采、断链不装成功）"
}

case "$CMD" in
  latest) do_latest ;;
  selftest) do_selftest ;;
  *) do_collect ;;
esac
