#!/usr/bin/env bash
# shell-utf8-var-guard —— 「变量后紧跟全角标点」守卫（ISS-655）
#
# ## 这个坑长什么样
# `set -u` 下写 `echo "结束（exit=$rc）"`：bash 把全角括号 `（` 的**首字节 0xEF** 当成变量名的一部分，
# 于是 `$rc）` 被解析成变量 `rc\xEF` ⇒ `rc\xEF: unbound variable`，**整行报错、退出码 127**。
# 实测（2026-10-25）：`restart-matter-confirm.sh` 第 54 行因此把「重启结束（exit=0）」这条日志
# 变成 `rc�: unbound variable` —— 重启本身成功了，但那条日志没写出来，看起来像脚本坏了。
#
# 为什么不是「环境问题」：只要 `LANG/LC_CTYPE` 是 UTF-8（本仓默认 C.UTF-8），这个解析就成立。
# 无 `set -u` 时变量为空 ⇒ 静默输出乱码（`echo "无 set -u：$PORT）"` 打出 `��`），
# 有 `set -u` 时直接 127。**两种都是错的**，只是错法不同。
#
# ## 判据（能一句话说清什么情况必红）
# `.sh` 里出现 `$变量名` 紧跟全角标点（`（）「」，。：；！？`）⇒ 红。正解是加花括号 `${var}`。
# 例外（不判红）：
#   · 注释行（`^\s*#`）—— 本文件与 watchdog-matter.sh 都要写这个模式做反例说明；
#   · `$变量` 后面已有非变量名字符（`$var、` 是合法的，顿号不属于变量名）。
#
# ## 用法
#   bash scripts/shell-utf8-var-guard.sh            # 扫 scripts/*.sh，有命中 ⇒ exit 2
#   bash scripts/shell-utf8-var-guard.sh --selftest # 反向验证判据还有牙（红绿两条路径都走）
set -uo pipefail

REPO="${DSH_FORGE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"

# 全角标点集合：出现在 `$var` 之后会吞掉首字节的那些。
# ⚠️ 只列**紧跟**会出事的；`$var` 后跟空格/ASCII 标点一律安全。
FULLWIDTH='（）「」『』，。：；！？、·…—'

scan() { # $1=root ⇒ 打印 `file:line: content`，命中数走 stdout 末行
  local root="$1" f out
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$root/scripts" -maxdepth 1 -name '*.sh' -type f | sort)
  if [ "${#files[@]}" -eq 0 ]; then printf 'HITS=0\n'; return 0; fi

  # ── ISS-758：整批交给**一个** perl 进程 ──────────────────────────────────────
  # 原实现是 `while read line` 里对**每一行**跑一次 `printf '%s' "$code" | grep -qE …`
  # ⇒ 每行 fork 两个子进程；本仓 scripts/*.sh 合计 8392 行 ⇒ 约 1.7 万次 fork，
  # 实测 **409.8s**（run-gates 的 293s 红线必然先杀它，于是这格长期是「超时红 = 零信息」）。
  # 改成单进程流式扫描后 **0.12s**（同一份输入、同一份输出，见下面逐行等价的判据）。
  #
  # ⚠️ 行为必须逐条等价，别"顺手优化"：
  #   · heredoc 内容不判（`<<'TAG'` / `<<TAG` / `<<-TAG` 开，行首恰为 TAG 或 \tTAG 关）—— 原实现逐个
  #     `sed` 取 tag，这里用同样的贪心 `.*` 取**最后一个**匹配，并在换文件时重置状态。
  #   · 注释行（`^#`，不许有前导空白）不判；行内注释从**第一个** `" #"` 起截断（等价 `${code%% #*}`）。
  #   · 命中形态不变：`$NAME` 紧跟全角标点；全角集合仍只来自上面的 FULLWIDTH（**唯一真相源**，
  #     这里用 Encode 解码后拼进字符类，不另抄一份字表）。
  #   · 输出格式不变（`文件:行: 原行`，相对 root），末行 `HITS=n`，无命中返回 0、有命中返回 1。
  #
  # ⚠️ 判不了 ≠ 绿：perl 是这一步的唯一执行器（macOS / 主流 Linux 都自带，Encode 是 core 模块）。
  #    真缺了就直接非零退出并说清「没跑」，不许退化成「扫了 0 行 ⇒ 0 处 ⇒ 绿」。
  if ! command -v perl >/dev/null 2>&1; then
    printf '✗ 本机没有 perl —— 判据没跑（不记绿）。安装 perl 或改用单进程实现后重跑。\n' >&2
    return 3
  fi
  out="$(SCAN_ROOT="$root" SCAN_FW="$FULLWIDTH" perl -CSD -MEncode=decode -ne '
BEGIN {
  $root = $ENV{SCAN_ROOT};
  $fw   = decode("UTF-8", $ENV{SCAN_FW});
  $re   = qr/\$[A-Za-z_][A-Za-z0-9_]*[$fw]/;
  $hits = 0; $tag = ""; $prev = ""; $n = 0;
}
if ($ARGV ne $prev) { $prev = $ARGV; $n = 0; $tag = "" }
$n++;
$line = $_;
$line =~ s/\n\z//;
if ($tag ne "") {
  if ($line eq $tag || $line eq "\t$tag") { $tag = "" }
  next;
}
if ($line =~ /<<\x27([A-Za-z_][A-Za-z0-9_]*)\x27/) { $tag = $1 }
elsif ($line =~ /.*<<-*([A-Za-z_][A-Za-z0-9_]*)/) { $tag = $1 }
next if $tag ne "";
next if $line =~ /^#/;
$code = $line;
$code =~ s/ #.*//;
if ($code =~ /$re/) {
  $rel = $ARGV; $rel =~ s/^\Q$root\E\///;
  print "$rel:$n: $line\n";
  $hits++;
}
END { print "HITS=$hits\n" }
' "${files[@]}")"
  printf '%s\n' "$out"
  case "$(printf '%s\n' "$out" | tail -n 1)" in
    'HITS=0') return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${1:-}" = "--selftest" ]; then
  # 守卫的守卫：红绿两条路径都要真跑一遍，否则「恒绿的检查」等于没检查。
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/scripts"
  # 红：三种真实形态（无花括号 + 全角括号 / 全角逗号 / 全角冒号）
  cat > "$tmp/scripts/red.sh" <<'RED'
set -u
echo "结束（exit=$rc）"
echo "端口 $PORT，"
echo "值 $v："
RED
  # 绿：正解 + 注释 + 非全角
  cat > "$tmp/scripts/green.sh" <<'GREEN'
set -u
# 反例说明：`echo "结束（exit=$rc）"` 是错的
echo "结束（exit=${rc}）"
echo "端口 $PORT 无标点"
echo "值 ${v}："
GREEN
  bad=0
  if DSH_FORGE_REPO="$tmp" bash "$0" >/dev/null 2>&1; then
    echo "✗ 自检失败：红样本被判绿（判据没牙）"
    bad=1
  else
    echo "✓ 红样本被判红（3 处）"
  fi
  rm -f "$tmp/scripts/red.sh"
  if DSH_FORGE_REPO="$tmp" bash "$0" >/dev/null 2>&1; then
    echo "✓ 绿样本（正解/注释/非全角）被判绿"
  else
    echo "✗ 自检失败：绿样本被判红（假阳性 ⇒ 会误伤正常写法）"
    DSH_FORGE_REPO="$tmp" bash "$0" 2>&1 | sed 's/^/      /'
    bad=1
  fi
  rm -rf "$tmp"
  [ "$bad" -eq 0 ] && { echo "✓ shell-utf8-var-guard 自检通过"; exit 0; }
  exit 2
fi

out="$(scan "$REPO")"
rc=$?
if [ "$rc" -eq 3 ]; then
  # 判不了（缺执行器）不许冒充「0 处违例」—— 与「未判 ≠ 通过」同口径。
  echo "✗ shell-utf8-var-guard：判不了（执行器缺失，原因见上）⇒ 不当绿"
  exit 2
fi
printf '%s\n' "$out" | grep -v '^HITS=' | sed 's/^/  ✗ /'
hits="$(printf '%s\n' "$out" | sed -n 's/^HITS=//p')"
if [ "$rc" -ne 0 ]; then
  echo "✗ shell-utf8-var-guard：${hits} 处「\$变量 紧跟全角标点」⇒ set -u 下必报 unbound variable"
  echo "  正解：给变量加花括号 —— \${var}。判据见本脚本头注。"
  exit 2
fi
echo "✓ shell-utf8-var-guard：${hits:-0} 处违例（scripts/*.sh）"
exit 0
