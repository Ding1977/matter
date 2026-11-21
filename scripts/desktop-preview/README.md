# desktop-preview —— 给「官方桌面端 profile」的 client 插件拍照

> 用途：验证**只有官方契约、没有 forge 壳**的宿主里，某个 client 插件到底渲染成什么样。
> 起点 = ISS-854（把模型选择器换成 forge 形态）。三个平台坑写在下面，都是实测踩出来的。

## 它解决什么

官方桌面端（`/Applications/DeepSeek Harness.app`，19387，profile `desktop`）：
- 老板正在用，**不能为了验样式反复重启**（client 产物 rev 固化于进程启动 + loader 按包名缓存模块）；
- `dsh web --profile desktop` 被**硬拒绝**（见坑 ①）。

于是做法 = 在同一 bundle 集下起一个**换了名字的 profile** 的普通网页实例，用 Chrome 离屏截图。

## 用法（三步）

```bash
V=<workspace>/tools/verify-854            # 任意 scratch 目录（不入库）

# ① 隔离 home：真拷贝 profile + 保留链接地拷 node_modules，再挂上要验的插件
mkdir -p "$V/home/profiles" "$V/out"
cp -R  ~/.dsh/profiles/desktop        "$V/home/profiles/deskview"     # 真拷贝（cp -al 会写穿生产）
cp -RP ~/.dsh/profiles/node_modules   "$V/home/profiles/node_modules" # -P 保留符号链接，别拷目标内容
ln -sfn <checkout>/forge-model-desktop "$V/home/profiles/node_modules/forge-model-desktop"
python3 - <<'PY'   # profile 名不能叫 desktop（坑 ①）
import json; p="$V/home/profiles/deskview/package.json".replace("$V","<V>")
d=json.load(open(p)); d["name"]="dsh-profile-deskview"; json.dump(d,open(p,"w"),indent=2)
PY
cat >> "$V/home/profiles/deskview/cordis.patch.yml" <<'YAML'

- insert:
    - id: forge-model-desktop
      name: forge-model-desktop
YAML

# ② 起实例（token 会打在日志里；**用 sed 整条取，别用 [A-Za-z0-9]* 截断**，token 里带 `-`）
DSH_HOME="$V/home" nohup /usr/local/bin/node --use-env-proxy \
  ~/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js --profile deskview --port 3216 --no-open \
  > "$V/out/web.log" 2>&1 &
TOKEN=$(sed -n 's/.*token=//p' "$V/out/web.log" | tail -1)

# ③ 截图 / 探针
/usr/local/bin/node scripts/desktop-preview/cdp-shot.mjs \
  --url "http://127.0.0.1:3216/?token=$TOKEN" --out "$V/out/01.png" \
  --width 1440 --height 900 --scale 2 --wait-ms 13000 --color-scheme dark \
  --pre scripts/desktop-preview/probes/probe-open.js --post-ms 1200 \
  --user-data-dir "$V/out/chrome-profile"
```

## 三个平台坑（踩过的，别重踩）

| # | 现象 | 根因 | 对策 |
|---|---|---|---|
| ① | `dsh web --profile desktop` → `error: profile "desktop" is managed exclusively by the Electron application` | `dsh/lib/bin.js:36` 按**profile 名**硬拒（`profile.toLowerCase() === "desktop"`） | 同 bundle 集、**换个 profile 名**（本脚本用 `deskview`） |
| ② | Chrome 起来了，但 `Page.enable` 永远不返回；日志 `sandbox initialization failed: Operation not permitted` → `GPU process isn't usable. Goodbye.` | DSH 的 seatbelt 沙箱下，**Chrome 的嵌套沙箱**初始化失败 → GPU/renderer 死 | Chrome 加 `--no-sandbox --disable-gpu`（不是绕过安全，是让嵌套沙箱让位） |
| ③ | Node 24 自带 WebSocket（undici）连 CDP：`Browser.getVersion` 能过，第二条命令就 `TypeError` + `1006` | undici WS 与 Chrome 153 的帧处理不兼容 | 改用 **`--remote-debugging-pipe`**（fd3/fd4 上 NUL 分隔 JSON），本脚本已内置 |

另外两条纪律：
- **别拷贝 `Electron.app`**：拷贝会破坏代码签名 → `dyld: Library not loaded: @rpath/libffmpeg.dylib`。要用就用**原地**二进制（且加 `--user-data-dir=<工作区内路径>`，否则它往 `~/Library/Application Support` 写、被沙箱拒）。
- **别把 `~/.dsh` 当 scratch**：`cp -al` 硬链接复制会让后续编辑写穿生产文件；`cp -RP` 保留链接再改副本才是安全的。

## 文件

- `cdp-shot.mjs` —— Chrome 离屏截图 + 页面内探针执行（`--pre <js>`：截图前在页面里跑 JS，返回值打印出来）。
- `probes/` —— ISS-854 用的探针（trigger 定位 / 弹层形态 / 列表与搜索 / **提交等价性** / 宿主健康度 / 官方对照）。它们断言的是"DOM 可判定事实"（尺寸、字号、颜色、条数、是否越界），比看图更抗主观。
- `electron-offscreen-main.cjs` —— Electron 版的截图脚本（保留作备选）。
  **后缀必须是 `.cjs`**：根 `package.json` 的 `"type": "module"`（ISS-836）会让 `.js` 按 ESM 解析，
  而本脚本是 CommonJS（`require`）⇒ 改为 `.js` 会直接 `require is not defined in ES module scope`（ISS-847）。
  改名后两种用法都可（实测 Electron 42.3.3）：
  ```bash
  # 传目录（目录里需有 package.json 的 "main": "electron-offscreen-main.cjs"）
  Electron --user-data-dir=<工作区内路径> <app 目录> --url ... --out out/01.png
  # 或直接传文件
  Electron --user-data-dir=<工作区内路径> scripts/desktop-preview/electron-offscreen-main.cjs --url ... --out out/01.png
  ```
