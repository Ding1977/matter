// preload-x25519.mjs —— 把 Node 24 的 TLS 密钥交换组从后量子混合组降回 X25519。
//
// 为什么需要（ISS-644，2026-10-23 老板批「方案 A」）：
//   Node 24.13 默认启用 X25519MLKEM768（后量子混合密钥交换），把 TLS ClientHello
//   从 354B 撑到 **1588B**，超过单包 MTU。经本地代理的 CONNECT 隧道时，这段首包有
//   约 10~17% 概率被丢弃 ⇒ 表现为「等十几秒然后 connect timeout」：
//     TypeError: fetch failed | cause: UND_ERR_CONNECT_TIMEOUT @10505~10571ms
//   ⚠️ 这不是代理（ClashX）的毛病：失败窗口内 ClashX 零告警、裸 CONNECT 隧道从不失败、
//      抽掉本问题后经同一个 ClashX 跑 314/314 全绿。curl 的 ClientHello 只有 301B，
//      所以 curl 全绿 —— 跟「curl 兜底 vs node fetch」无关，两个都会中招。
//
// 实测（2026-10-23，交替配对，避免时段波动）：
//   现状 fails: 6/120 · 本 preload fails: **0/120**
//   ClientHello: 1588B → **354B**
//   三家真实端点（各 25 次）：opencode 22/25→25/25 · amr 22/25→25/25 · commandcode 19/25→25/25
//
// 代价：失去 MLKEM 后量子防护（当前无实际威胁 —— 见 ISS-644 note 的威胁评估）。
// 回滚：把 restart-matter.sh 里 NODE_OPTIONS 的 `--import .../preload-x25519.mjs` 删掉再重启即可。
//
// ⚠️ 生效方式：**下次重启**（TLS 默认值在模块加载时固定，改文件不会热加载到已在跑的进程）。
// ⚠️ 作用域只有 3210（restart-matter.sh）；App(19387) 不走本脚本，不受影响。
import tls from "node:tls"

tls.DEFAULT_ECDH_CURVE = "X25519"
