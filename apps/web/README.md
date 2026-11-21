# Matter 浏览器壳（apps/web · P4-S1 · ISS-537；P4-S2 · ISS-538）

Matter 的第一个浏览器壳。**甲形态：Vite 直连**——静态 import client 包、裸 Vite 可 dev/build，不引入 DSH 的 `window.__DSH_BOOT__` / `__ModuleLoader__` 注入层（Matter 是单产品固定 UI 包集，无多会话宿主装载插件的消费者）。

## 跑起来（两形态）

```sh
# 仓库根（vite 是现有间接依赖，无需新增 npm 包）
pnpm dev                       # 形态①：裸 Vite dev server（默认 :5173）
pnpm build:shell               # 形态②第一步：产出 apps/web/dist/index.html + 静态 bundle
node_modules/.bin/vite preview --config apps/web/vite.config.ts   # 形态②第二步：预览 build 产物（默认 :4173）
pnpm vitest run apps/web/tests # 壳 + 夹具 + css 内容流 smoke（jsdom）
```

ISS-538 实测两形态都起得来、两路由都 HTTP 200：
- **dev**：`vite --config apps/web/vite.config.ts --host 127.0.0.1 --port 5199` ⇒ `/` 200、`/editor-demo` 200，`/src/{main.ts,editor-demo.tsx,editor-css.ts}` 全部 transform 200 无报错。
- **build+preview**：`vite build`（EXIT 0，1.2MB 主 bundle 含 `.bn-block-outer` 真 CSS）→ `vite preview --port 5200` ⇒ `/` 200、`/editor-demo` 200（SPA fallback）。

## boot 链与路由

```
index.html (#root + module script)
  └─ src/main.ts ── location.pathname 判路由
       ├─ /editor-demo*  → mountEditorDemo()      真 BlockNote 夹具（ISS-538）
       └─ 其余            → resolveConfig → bootWeb(root, config)
                              ├─ new Context()                       cordis client context 自举
                              ├─ installThemeStyles(ctx)             ─┐ 各恰一次（装配幂等在本调用点）
                              ├─ installDswBridgeStyles(ctx)         ─┘ review-2305 观察项
                              └─ createRoot(root).render(<KbShell/>) ui-kb 三步流（stub）

/editor-demo：bootFullEditor(fullBlockNoteSchema) + createHeadlessView → 真编辑器实例；
              installEditorStyles() 注入 BlockNote core/react 真 CSS；14 块工具条经
              ourBlockToBnFull 映射后 insertBlocks 真插入。
```

后端地址由 `?apiBase=` 或 `VITE_SHELL_API_BASE` 注入（默认 `/api`）；嵌入模式由 `?embed=1` 或 `VITE_SHELL_EMBED` 置位——置位后不渲染自带 chrome，单页聚焦。数据面是 stub，N 轨 remote-gateway-wire 后换真 Remote，boot 其余部分不动。

## 真机一分钟操作序列（ISS-538 · Q1 IME / Q2 视觉）

> **谁做**：Lead + 老板在共享浏览器亲手输入销账——实施者不冒充已测（Q1/Q2 在 ISS-538 明记 unjudged）。
> **前置**：起 dev 或 preview（见上），浏览器开 `http://<host>:<port>/editor-demo`。

1. **加载确认（5s）**：页面出现「Matter 编辑器夹具」标题 + 14 块工具条 + 中文默认正文；正文区有可见排版（BlockNote 真 CSS 生效，非裸文本）——**Q2 视觉态①截图**。
2. **组合期不回车（15s）**：切中文拼音输入法，在正文段敲 `ni` 不按 Enter（选字候选在），观察光标仍在当前段——**Q1 判据前半：组合期不换段**。
3. **组合期回车选字（20s）**：候选期按 Enter 选「你」，观察**选字上屏、光标不跳到下一段**——**Q1 判据核心：Enter 选字不换段**（若跳段即红）。
4. **段落编辑（10s）**：在段尾按 Enter 主动换段，确认能正常分段、可继续输入中文——Q1 对照组（非组合期 Enter 应换段）。
5. **toggle 收开（10s）**：点初始待办下的「折叠面板（点我收开）」，确认子块「折叠体内的中文子块」能收起/展开——**Q2 视觉态②截图**。
6. **14 块插入（10s）**：点工具条各按钮（段落/标题/…/视图块），确认每块真插入到文档并有中文内容——**Q2 视觉态③截图**。
7. **kb 三步流（10s）**：开 `http://<host>:<port>/`（非 demo 路由），点列表首行 → 出详情 → 正文区真现（BlockNote headless view），非仅 data 属性——**Q2 补充截图**。

凭证（截图 / 操作确认）由 Lead 落 ISS-538 正文，实施会话不代办销账。

## 砍九件（照 P4-0 问1 §1.7，明确不抄 DSH）

1. WebWorker preview（`preview.ts` / `emitPreviewPage` / `build:preview`）
2. 产物审计（`product-isolation.ts` / `WebProductBundleIsolation`）
3. KaTeX / 品牌字体（`katex-fonts.ts` / `brandFontLicense`）
4. `rejectStandaloneServe`（甲形态反而要裸 serve）
5. `manualChunks` / 精细分包（单 index chunk + 按需 vendor chunk）
6. 11 词 `PLATFORM_MODULES` 共享表（dedupe react/react-dom 即够）
7. PWA manifest / 多尺寸 icon / apple-touch-icon（连 favicon 都不放）
8. client-hmr / 多 locale（单 locale）
9. 7 项 `requiredClientEntryNames` 严格集（极小集 / 本单无插件审计）

## Known Limitations

- `apps/` 不在 pnpm-workspace（`packages/*/*`）与 coverage.include（`packages/*/*/src/**`）射程；壳 smoke 通过根 vitest include 显式收录。
- Vite/vitest 用 `aliases.ts` 把 `@matter/*` client 面、cordis、BlockNote CSS 指向源文件/真路径——同仓直吃 source，不经 lib 构建产物。
- 真机 IME（Q1）/ 视觉三态（Q2）属 ISS-538 的真机会话销账项，实施会话只保证「夹具可编辑 + 两形态启动 + css 内容流真」，**不冒充已测**。
- 嵌入友好②（webview 信任流）按 ISS-538 范围修订移 #9（remote-gateway-wire）验收，本单不造 stub 握手。
- `apps/web/tsconfig.json` 独立 typecheck 因未链 `@types/react-dom` 报 `react-dom/client` TS7016（ISS-537 原 boot.ts 即有）；apps/web 不在任何 gate 的 typecheck 射程，官方 `tsc -b tsconfig.next.json` 全绿。
