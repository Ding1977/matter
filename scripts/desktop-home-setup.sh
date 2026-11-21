#!/bin/bash
# 给桌面端建独立 DSH_HOME（老板 09-28 决定）。原则：
#   · profile 与模块镜像私有 ⇒ 不再与老盘 3210 互抢 profiles/node_modules（second-engine.js 注释：互抢「必坏其一」）
#   · 工单数据共享 ⇒ ~/.dsh-desktop/pm 软链到 ~/.dsh/pm（Matter 面板读同一份真相，不分叉）
#   · 会话日志不共享 ⇒ 0.1.7 会把 v3 转写成 v4，与停在 0.1.5 的老盘互读有不可逆风险（ISS-836 / dsh-desktop.sh 头注）
#   · 先不放凭据 ⇒ needsWelcome = !loggedIn && !hasApiKey 才为真，登录窗才会弹
set -u
SRC="$HOME/.dsh"
DST="$HOME/.dsh-desktop"

echo "── 1) 现状"
[ -d "$DST" ] && find "$DST" -maxdepth 2 | sed 's/^/   /' | head -10 || echo "   （新家不存在，将创建）"

mkdir -p "$DST/profiles"

echo "── 2) 桌面 profile：复制生产那份（含 matter / matter-shell 装配）"
if [ -d "$SRC/profiles/desktop" ]; then
  mkdir -p "$DST/profiles/desktop"
  # 只复制文件，不复制 lock；复制后两边各自独立，界面写设置只伤它自己那份
  for f in cordis.patch.yml cordis.yml package.json; do
    [ -f "$SRC/profiles/desktop/$f" ] && cp -p "$SRC/profiles/desktop/$f" "$DST/profiles/desktop/$f" && echo "   复制 $f ($(wc -c <"$DST/profiles/desktop/$f" | tr -d ' ') B)"
  done
  echo "   装配检查：matter=$(grep -c 'id: matter$' "$DST/profiles/desktop/cordis.patch.yml") matter-shell=$(grep -c 'id: matter-shell' "$DST/profiles/desktop/cordis.patch.yml")"
fi

echo "── 3) 模块镜像：把生产镜像里的链接条目整份复制成链接（不共享目录本体）"
if [ -d "$SRC/profiles/node_modules" ]; then
  mkdir -p "$DST/profiles/node_modules"
  n=0
  for e in "$SRC"/profiles/node_modules/*; do
    b=$(basename "$e")
    [ "$b" = ".DS_Store" ] && continue
    cp -RPp "$e" "$DST/profiles/node_modules/$b" 2>/dev/null && n=$((n+1))
  done
  echo "   复制条目 $n 个；其中 matter 系：$(ls "$DST/profiles/node_modules" | grep -c '^matter')"
  echo "   抽样核对：$(readlink "$DST/profiles/node_modules/matter" 2>/dev/null || echo '(matter 非链接)')"
fi

echo "── 4) 工单数据：软链共享（不分叉，M-035 过渡约定不变）"
if [ ! -e "$DST/pm" ]; then ln -s "$SRC/pm" "$DST/pm" && echo "   $DST/pm → $SRC/pm ✓"; else echo "   已存在，跳过：$(ls -l "$DST/pm" | awk '{print $9,$10,$11}')"; fi

echo "── 5) 故意不做的事（写在脸上，免得以后以为漏了）"
echo "   · 不复制 .credentials.yaml ⇒ 让登录窗能弹（判据 needsWelcome）"
echo "   · 不共享 sessions / agent-runs / *.db ⇒ 避免 0.1.5 与 0.1.7 互读写同一份会话根"
echo "   · 不动生产 ~/.dsh 的任何文件（本脚本只读它）"

echo "── 6) 结果"
find "$DST" -maxdepth 2 | sed 's/^/   /' | head -14
