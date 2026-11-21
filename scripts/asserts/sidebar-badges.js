// 左栏 Matter 菜单徽标**可见性**断言（ISS-608 配套）
// 在无头 Chrome 里跑（经 scripts/headless-ui.mjs --eval 本文件）。
//
// 与 `scripts/sidebar-badge-assert.mjs`（CDP 真机版）的分工：
//   · 本文件 = **无头**，连隔离实例 3211，不碰老板界面，可反复跑
//   · 那个 = CDP，连真机 Electron 壳，权威但会动老板界面
// 两者判据相同（下方 visibleChain 是核心：**不能只看 textContent**）。
//
// ⚠️ 一切以「几何 + 祖先链」为准：元素在 DOM 里 ≠ 元素可见。
//    本断言就是为「用 textContent 报假绿」那次事故立的。

;(() => {
  const MENU_ID = "forge-sidebar-pm-menu"
  const menu = document.getElementById(MENU_ID)

  /** 祖先链上任一层 display:none / visibility:hidden / hidden 属性 ⇒ 不可见。 */
  const visibleChain = (el) => {
    let p = el
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p)
      if (cs.display === "none" || cs.visibility === "hidden") return false
      if (p.hasAttribute && p.hasAttribute("hidden")) return false
      p = p.parentElement
    }
    return true
  }

  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  // 当前左栏页签（Matter / 会话）
  const page = (() => {
    const hit = [...document.querySelectorAll('[role="tab"]')]
      .filter((b) => /^(Matter|会话)$/.test((b.textContent || "").trim()) && b.getBoundingClientRect().x < 400)
      .find((b) => b.getAttribute("aria-selected") === "true")
    return hit ? hit.textContent.trim() : null
  })()

  // 徽标 = li 里那个「纯数字、且带 absolute 定位」的元素（实测类名含 pointer-events-none absolute）
  const rows = menu
    ? [...menu.querySelectorAll("li")].map((li) => {
        const label = (li.textContent || "").replace(/\s+/g, " ").trim()
        const badge = [...li.querySelectorAll("*")].find(
          (e) => e.children.length === 0 && /^\d+$/.test((e.textContent || "").trim()),
        )
        const br = badge ? badge.getBoundingClientRect() : null
        const btn = li.querySelector("button")
        const btnR = btn ? btn.getBoundingClientRect() : null
        return {
          row: label.slice(0, 20),
          badgeText: badge ? badge.textContent.trim() : null,
          badgeVisible: !!(badge && br.width > 0 && br.height > 0 && visibleChain(badge)),
          badgeRect: rectOf(badge),
          /** 关键：absolute right-1 徽标是否落在其按钮的可视区内（父级 overflow-hidden 会裁剪） */
          insideButton:
            !!(br && btnR) && br.x >= btnR.x - 1 && br.right <= btnR.right + 1,
        }
      })
    : []

  const withBadge = rows.filter((r) => r.badgeText !== null)
  const menuR = rectOf(menu)

  return {
    page,
    menuFound: !!menu,
    menuHiddenAttr: menu ? menu.hasAttribute("hidden") : null,
    menuDisplay: menu ? getComputedStyle(menu).display : null,
    menuRect: menuR,
    menuVisible: !!(menu && menuR && menuR.w > 0 && menuR.h > 0 && visibleChain(menu)),
    badgeCount: withBadge.length,
    allBadgesVisible: withBadge.length > 0 && withBadge.every((r) => r.badgeVisible),
    allBadgesInsideButton: withBadge.length > 0 && withBadge.every((r) => r.insideButton),
    rows: rows.slice(0, 12),
  }
})()
