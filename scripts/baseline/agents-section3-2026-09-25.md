<!-- AGENTS.md §3「已拍板决策」的**历史快照**（2026-09-25 · ISS-824 让位当日，十八条原样照录）。

     ⚠️ **已失效（2026-10-19）**：原用途是给 `compile-memory.mjs` 的等价性判据当参考件，
     但该脚本与「决策卡常驻编译层」已于 2026-10-19 整体删除（老板定：决策卡不进提示词常驻，
     规则由 AGENTS.md 手写承载）。⇒ 本文件现在**仅作历史参考，不被任何脚本消费**。

     如需恢复那套机制，须重新实现脚本并按当时的卡池重写期望集合，不要指望本文件现成可用。 -->

## 3. 已拍板决策（一行一条 · 勿反复 · 展开细节 → `docs/memory/decisions-detail.md`）

1. **底座 = DSH**，绝不改其引擎（替换 = 重写且负收益）。
2. **UI = React**（A1），接受从 SolidJS 换栈；DSH web UI 是 React。
3. **Electron 壳**：E-A（loadURL 加载 `dsh web`）已验证；终态 E-B（file:// + IPC 桥）。
4. **前端架构 = surface 注册制** React 移植为 `forge-ui`（keep-alive + 单/多实例）。
5. **记忆 = DSH 原生 + 三层蒸馏**（L1 卡池→L2 主题聚合→L3 分流，不做 RAG）；机制见 memory-rules §1。
6. **UI 布局终局 = 三栏网格**（会话A | 工具面板 toolsA/B | 会话B；顶栏中插槽 + 底栏三块=面板B固定标签入口）；交互语义全文在 decisions-detail，视觉口径入 design-test-rules。
7. **三栏网格实现要点**：disable ui-layout/ui-sidebar + no-op ILayout + 重托管五 slot（详见 code-rules §3）。
8. **Electron 图标**：白底满幅 + DSH 黑鲸鱼；Dock 圆角只走 .app bundle icns（详见 decisions-detail）。
9. **会话B 定案（ISS-183）**：**webview 承载 3300 官方页**（DOC-102，老板 09-02 拍板「那就 webview 吧」+ 09-03 唯一化/常驻/空态=官方新建页）。B 面板 = Electron `<webview>` 加载 3300（web-b profile）官方 DSH 页，3300 渲染它自己的 current；外观镜像 A 由 forge-b-embed 注入（DOM 隐藏侧栏/➕⋮/stats 搬移）；通信 = guest HTTP 上报 3210 收口（`/forge-b-host/report`+`/forge-b-host/poll`）+ 3210 `executeJavaScript` 调 `__forgeBCommand`。webview **常驻不卸载**（独立 webContents，隐藏自动节流）；空态（标签行无标签）= 3300 官方新建页，**不自绘 hero**。**M3 已铲平**：forge-session-router / forge-session-b（Route B' 自建宿主整套）已删。spec 现行 **DOC-102**（取代链全貌见 decisions-detail 决策 9）。**新代码不再引入 iframe**。
10. **Matter 使用判据（老板 09-03 定）**：**默认记 issue**（`task` 标签=任务，免审批环）；**只有需要「整体视图」（里程碑/健康度/进度聚合/日期区间/整体验收）才开项目**，项目是例外不是常态；项目集成就更少（多项目同目标才开）。一句话：**issues 记「事」，projects 记「一摊事」**。判据细节 → `docs/matter-agent-guide.md §2.5`。
11. **Issue 生命周期 v1.1（09-08 重梳理 · ISS-283）**：7 态定名 待办/待评估/进行中/待审核/已完成/已取消/重复（唯一真相 `forge-pm/src/pm/api.ts` STATUS_LIST）；分诊落 `estimate` 四档（简单=直接做/复杂=建分支/困难=建项目/极难=建倡议）；complex+ 单 spec 入 Matter 文档库（**DOC 唯一真相**，specs/ 冻结为归档）+ 审批硬门禁（未 approved 不得开工）；spec 审批表态自动化（通过→自动开工+唤醒负责人；退回→自动回待办）；issue↔审查单自动联动**暂时解除**（ISS-275）。现行 spec = **DOC-170**。
12. **worktree 制（09-09 批 · ISS-294）**：complex/hard/extreme 单派单开工自动建独立工作树 `~/wt/dsh-forge/<ISS-NNN>`（路径写 frontmatter.worktree，merge 后自动清）；simple 单主 checkout commit 级；主 checkout 只跑 3210 服务与收口合并，不做 issue 开发。⚠️ **现状（09-24 ISS-805）：「自动」没有实现者**——建/清都靠人跑 `ws.sh new` / `ws.sh rm`（只有**分支**真由宿主自动建），派单提示已改成无条件要求负责人自己建。
13. **审查单暂停（09-12 老板指示）**：**不再建 REV 审查单、不再派 AI 审查**；合并改为 **agent 自审后直接 merge**（自审内容 = 等价性证明 + 全量测试 + typecheck + 依赖图/契约核验，结论写进 merge commit）。恢复由老板定。
14. **AGENTS.md 版本以本版为准（09-09 老板拍板）**：zcode checkout 回卷事故的修复版；回卷防护 = 本文件变更随当轮工作**及时 commit**，不再长期裸奔在工作区。
15. **agent 域拆包定案（09-19 落地 · DOC-256 P0~P2）**：agent 运行时住 `forge-agents`、契约住 `forge-agent-protocol`，Matter 语义一律经注册点注入，依赖方向恒为 PM → agents 单向；**新 agent 能力写 forge-agents，别写回 forge-pm**；agent 存储根 = `~/.dsh/agent-runs`。判据与回滚口径展开见 decisions-detail。
16. **T9 官方 slot 融合不做（09-12 老板决定）**：**不把余额/NEW 徽标/预检结论注入 DSH 模型页**，也不加「打开套餐总览」footer 入口（原 DOC-220 Phase 3 的 T9，单据 ISS-406 已取消）。后果 = 双入口保持「两份视图」（DSH 看模型/选择，plans 看余额/NEW/预检），T10 的 UI 层一致性随之失去对象；若仍要口径，只认「同一真相源 `/forge-plans/overview`」这一层（架构已保证，不需额外验收）。设计要点保留在 DOC-220 §5，将来重做不必从零调研。
17. **PM v2 存储归属定案（09-19 批复 · DOC-258 §0.5）**：新库 = **`~/.dsh/forge-pm.db`**（不放 `~/.dsh/pm/` 内——那里是 git 仓库且 pm-backup 每小时自动 commit）；**runs 不进 PM 库**（留 `~/.dsh/agent-runs`，决策 15）；**scheduler 拆两半**（触发/对账在 PM，闸门与派单经 `forge-agents/agent-api`）。裁剪：actor 严格化先于 DB、侧车四表推迟 Phase 2、改名与版本化并行。展开见 decisions-detail。
18. **「结构简洁高效」计入收益（09-21 老板判据 · ISS-680）**：老板原话「结构简洁高效也是一种受益，是一种长期受益」——评估优化**不只用字节/内存定价**，重复的构建逻辑、多份抄写的同一真相源、跨包隐式耦合都算长期成本；但结构改动**不豁免等价性证明**（ISS-680 步骤① 用「编译产物逐字节相同」、步骤② 用「声明级等价 + 常驻包含性守卫」）。展开见 `docs/memory/decisions-detail.md` 决策 18。
