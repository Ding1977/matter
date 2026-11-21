#!/bin/bash
# watchdog-web.sh: dsh web watchdog - auto-restart 3210 when it dies.
# Concurrent sessions sometimes kill the 3210 process directly while debugging
# plugins; this daemon probes every 5s and brings it back via restart-web.sh.
# Run: nohup bash <repo>/scripts/watchdog-web.sh >> ~/.dsh/watchdog.log 2>&1 &
#
# ── 已退役（ISS-558 · 2026-10-01）────────────────────────────────────────────
# ⚠️ 本脚本已退役，**不要**再 load / 启用它的 launchd 项 `com.openforge.watchdog`。
#    取代者：scripts/watchdog-matter.sh（现役唯一 watchdog；探 3210，经 restart-matter.sh 拉起，
#    launchd 项 com.openforge.watchdog-matter）。
#    退役原因：com.openforge.watchdog 与 com.openforge.watchdog-matter 曾同时探活 3210，却各用
#    不同重启脚本（restart-web.sh vs restart-matter.sh）→ 互相打架，~/.dsh/watchdog.log 累计
#    **3133 行含 restart**（口径：`grep -c restart`；其中 `web down` 1567 行、完整措辞
#    "web down (confirmed x2, why=no-listener), restarting..." 1104 行 —— 别把 3133 说成某一措辞的次数）。
#    （另注：`grep -c 'confirmed x2'` = 1177，含 70 条 curl-exit-1 + 3 条 curl-exit-22；引用数字前先想清口径。）
#    收敛记录：ISS-968（2026-09-30）起 watchdog-matter 为唯一；ISS-558（2026-10-01）清理运行
#    环境残留（~/Library/LaunchAgents/com.openforge.watchdog.plist → .retired-20261001）。
#    保留文件原因：被 web-crash-evidence.sh / restart-web-detached.sh / watchdog-matter.sh /
#    lint-scripts.mjs / scripts/baseline/code-inventory.json 等 8 处引用，删除会连锁报红；
#    且其中的探活 / 锁自愈修复正是 watchdog-matter.sh 的照抄来源，留作参考实现。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# launchd 环境默认 PATH 无 /usr/local/bin（node 所在），restart-web.sh 已用绝对路径；
# 这里再兜底补全，保证 lsof/curl/node 等工具在 launchd 下可用。
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# 2026-08-31 双保险：清掉可能继承的 HTTP(S)_PROXY，避免 curl 把 127.0.0.1 探活请求
# 发到代理端口（代理无法环回访问本机 → curl-exit-1 → 误判服务死亡 → 误杀健康服务）。
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

RESTART="<repo>/scripts/restart-web.sh"
PROBE_URL="http://127.0.0.1:3210"

probe() {
  lsof -tiTCP:3210 -sTCP:LISTEN >/dev/null 2>&1 || { PROBE_WHY="no-listener"; return 1; }
  # 2026-08-31 修复（ISS- watchdog 误杀健康服务）：
  # dsh web 在根路径无 token 时返回 303/401 鉴权重定向，且本进程可能继承了 HTTP_PROXY
  # 导致 curl 走代理访问 127.0.0.1 失败（curl-exit-1）。两种情况下服务器实际存活，但旧探测
  # 只认「200 且含 __DSH_BOOT__」，于是误判 down → 每 ~10s 杀掉健康服务 → 前端在重启抖动中
  # 拿到残缺 manifest（缺 batches）→ "Failed to load plugins / batches must be an array"。
  # 修复：--noproxy '*' 强制直连本地；只要服务器返回任何 HTTP 状态码（含 303/401 重定向/
  # 鉴权页）即证明进程存活，不再要求特定 body。真正死亡时 curl 拿不到状态码 → 判 down。
  local code
  code=$(curl -s --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null)
  if printf '%s' "$code" | grep -qE '^[0-9]{3}$'; then
    PROBE_WHY="ok(http=$code)"
    return 0
  fi
  PROBE_WHY="no-http-response"
  return 1
}

# 锁自愈（2026-08-28 ISS-104 第三段）：atomic-write 的写锁竞争者永不删已有锁，
# 进程内的写任务一旦悬挂（async 死锁/uv 线程池异常），settings.yaml.lock 就永久
# 残留 → 此后所有 settings 写（选模型/思考深度的 saveSelection 等）每次等锁 2s
# 超时 = 「选择卡几秒」。正常持锁是毫秒级，mtime 超过 120s 必为泄漏 → 移走
# （mv 改名留证；不 rm，避免与防误删策略纠缠）。120s 内的长写不受影响。
# ISS-129：与 restart-web 2b 对齐——持有者进程仍存活就不搬（只搬持有者已死/空的），
# 否则慢写会被误判泄漏，第二个写者进场与活持有者并发写同一目标。
sweep_stale_locks() {
  local f pid age
  # 顺带回收历史 .stale-* 留证文件（保留 24h 够排查用）
  find "$HOME/.dsh" -maxdepth 1 -name '*.lock.stale-*' -mtime +1 -delete 2>/dev/null || true
  for f in "$HOME/.dsh/settings.yaml.lock" "$HOME/.dsh/.credentials.yaml.lock"; do
    [ -f "$f" ] || continue
    age=$(( $(date +%s) - $(stat -f %m "$f" 2>/dev/null || echo 0) ))
    [ "$age" -lt 120 ] && continue
    pid=$(tr -d '[:space:]' < "$f" 2>/dev/null)
    if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
      continue # 持有者存活：可能是慢写/悬挂但进程还在，交由 restart-web 2b 的同款策略处理
    fi
    mv "$f" "$f.stale-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
    echo "[watchdog $(date '+%H:%M:%S')] swept stale lock: ${f##*/} (age ${age}s, holder pid ${pid:-unknown})"
  done
}

# ── ISS-544：日志与产物卫生（无上限增长 → 有上限）─────────────────────────────
# 实测：watchdog-restart.log 1.17MiB / watchdog.log 428KiB **均无轮转无上限**；
# ~/.dsh/*.bak* 29 份 1.9MB **无任何清理机制**；另有 3 份 08-28 陈旧锁长期滞留。
# 轮转用**原地截断**（tail 保留尾部 → `cat > file` 同 inode 写回），不换 inode：
#   本进程的 stdout 由 launchd 以 O_APPEND 打开，换 inode（mv）会让后续写入落到
#   已 unlink 的旧文件上（日志静默丢失）；原地截断实测对活写入者安全。
# 阈值可用 env 覆盖，便于测试（生产用默认值）。
LOG_MAX_BYTES="${FORGE_LOG_MAX_BYTES:-5242880}"    # 5MB 触发
LOG_KEEP_BYTES="${FORGE_LOG_KEEP_BYTES:-2097152}"  # 保留尾部 2MB
BAK_KEEP="${FORGE_BAK_KEEP:-10}"                   # *.bak* 保留份数
rotate_inplace() {  # $1=文件  $2=保留字节
  local f="$1" keep="$2"
  [ -f "$f" ] || return 0
  [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ] || return 0
  tail -c "$keep" "$f" > "$f.rot" 2>/dev/null || return 0
  cat "$f.rot" > "$f" 2>/dev/null && rm -f "$f.rot" 2>/dev/null
  echo "[watchdog $(date '+%H:%M:%S')] 日志轮转：${f##*/} 截到 ≤$(( keep / 1024 ))KB"
}
housekeeping() {
  local old
  rotate_inplace "$HOME/.dsh/watchdog.log" "$LOG_KEEP_BYTES"
  rotate_inplace "$HOME/.dsh/watchdog-restart.log" "$LOG_KEEP_BYTES"
  ls -t "$HOME"/.dsh/*.bak* 2>/dev/null | tail -n +$(( BAK_KEEP + 1 )) | while IFS= read -r old; do
    rm -f "$old" 2>/dev/null && echo "[watchdog $(date '+%H:%M:%S')] 清理旧备份：${old##*/}"
  done
}

echo "[watchdog $(date '+%H:%M:%S')] started (probe $PROBE_URL every 5s)"
# 2026-08-28 防误杀：web 负载高时（长 turn 生成/目录刷新/settings 重载）HTTP 响应
# 可能超过旧版 2s 探测超时 → 健康进程被误判 down → 杀掉重启。今天 19 次重启的
# 大概率来源。改为：6s 超时 + **连续 2 次失败**才动手，失败原因（curl 退出码）落日志。
PROBE_FAILS=0
LAST_RESTART=0
HK_TICK=0   # ISS-544：卫生检查节流计数（每 60 轮 ≈5min 跑一次，不必每 5s 都 ls）

# ── ISS-636：脚本自更新检测（守护脚本改了必须生效）─────────────────────────────
# bash 对 `while` 循环体是**进入循环前一次性解析**的：本进程启动后，对脚本文件的任何
# 修改都不会生效；而 launchd 的 KeepAlive 只在进程**退出**时才重启它 —— 本进程设计上
# 永不退出。实测代价：watchdog 进程陈旧 3 天（09-17 05:51 起），09-19 12:14 提交的
# ISS-587 崩溃取证代码**从未执行过**（~/.dsh/evidence 不存在、日志里「取证」命中 0）。
# 修法：每轮比对脚本 mtime；变化则**先语法自检、通过才 exec 自身**。
#   ⚠️ 语法自检不是可选项：本脚本历史上已因语法类故障踩过两次（首代 `set -u` 未绑定变量、
#      ISS-540 注释被并进 echo 行），一次写坏的编辑若直接 exec 会把守护进程带走。
SELF_PATH="${BASH_SOURCE[0]:-$0}"
SELF_MTIME="$(stat -f %m "$SELF_PATH" 2>/dev/null || echo 0)"

while true; do
  _m="$(stat -f %m "$SELF_PATH" 2>/dev/null || echo 0)"
  if [ "$_m" != "0" ] && [ "$_m" != "$SELF_MTIME" ]; then
    if bash -n "$SELF_PATH" 2>/dev/null; then
      echo "[watchdog $(date '+%H:%M:%S')] 脚本已更新（mtime ${SELF_MTIME} → ${_m}）→ 语法自检通过，重载自身"
      exec /bin/bash "$SELF_PATH" "$@"
    else
      echo "[watchdog $(date '+%H:%M:%S')] ⚠️ 脚本已更新但语法自检未通过 → 暂不重载（继续用旧代码守护）；修好后再次改动即重试"
      SELF_MTIME="$_m"
    fi
  fi
  sweep_stale_locks
  HK_TICK=$(( HK_TICK + 1 ))
  [ $(( HK_TICK % 60 )) -eq 0 ] && housekeeping
  if ! probe; then
    NOW=$(date +%s)
    if [ $((NOW - LAST_RESTART)) -lt 30 ]; then
      # boot 宽限（ISS-119）：刚重启完 node 冷启动 + 插件加载可能要十几秒才 bind，
      # 这段失败不累计——否则 restart-web.sh 的 kill→bind 空窗会被凑满 2 次失败，
      # watchdog 并发再拉一个 restart（restart-web 内部有互斥锁兜底，这里是双保险）。
      echo "[watchdog $(date '+%H:%M:%S')] probe fail in boot grace ($PROBE_WHY) — not counting"
    else
      PROBE_FAILS=$((PROBE_FAILS + 1))
      echo "[watchdog $(date '+%H:%M:%S')] probe fail #$PROBE_FAILS ($PROBE_WHY)"
      if [ "$PROBE_FAILS" -ge 2 ]; then
        # ISS-402：先把「上一个进程」的下场记清楚，再重启——
        # 监听一消失，PID 就无从得知；pidfile（由 restart-web.sh 写）让我们能区分
        # 三种截然不同的情形：进程已消失（崩/被杀）/ 进程还在但不服务（卡死）/ 无记录。
        PREV="$(cat "$HOME/.dsh/web.pid" 2>/dev/null || true)"
        if [ -n "$PREV" ]; then
          PREV_PID="${PREV%% *}"; PREV_AT="${PREV##* }"
          if kill -0 "$PREV_PID" 2>/dev/null; then
            echo "[watchdog $(date '+%H:%M:%S')]   ↳ 上一进程 pid=${PREV_PID} **仍活着但不服务**（卡死），已活 $(( $(date +%s) - PREV_AT ))s"
          else
            echo "[watchdog $(date '+%H:%M:%S')]   ↳ 上一进程 pid=${PREV_PID} **已消失**（无遗言），它活了 $(( $(date +%s) - PREV_AT ))s"
          fi
        else
          echo "[watchdog $(date '+%H:%M:%S')]   ↳ 无 pidfile 记录（旧版本重启遗留 或 进程从未记过）"
        fi
        echo "[watchdog $(date '+%H:%M:%S')] web down (confirmed x2, why=$PROBE_WHY), restarting..."
        PROBE_FAILS=0
        # 崩溃取证（ISS-587）：**必须在 restart 之前抓** —— restart 本身就是毁掉现场的那一步
        # （kill 旧进程 → 端口/进程/内存现场全没）。脚本只读，任何失败都不该挡住自愈，故 || true；
        # 但 bundle 路径必须落进日志，否则留了证据等于没留。
        EVID_DIR=$(bash "$(dirname "$0")/web-crash-evidence.sh" collect --tag watchdog --quiet 2>/dev/null | head -1) || true
        echo "[watchdog $(date '+%H:%M:%S')]   ↳ 现场取证：${EVID_DIR:-采集失败（不影响重启）}"
        # ISS-558：本文件虽已退役，但它是 restart-web.sh 的**自动委派路径**，同样要带自愈标记
        # （防被手动 load 时被牙拦下 —— 牙的判据在 scripts/prod-guard.sh，认这个标记放行）。
        FORGE_RESTART_SOURCE=watchdog FORGE_WATCHDOG_SELFHEAL=1 bash "$RESTART" >> ~/.dsh/watchdog-restart.log 2>&1
        LAST_RESTART=$(date +%s)
        sleep 3
        if probe; then
          echo "[watchdog $(date '+%H:%M:%S')] restart ok"
        else
          echo "[watchdog $(date '+%H:%M:%S')] restart failed, retry in 5s"
        fi
      fi
    fi
  else
    PROBE_FAILS=0
  fi
  sleep 5
done
