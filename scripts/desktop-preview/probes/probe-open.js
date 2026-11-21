// 探针 2：点开本包 trigger，返回弹层内部的可判定事实（形态是否 forge）。
// 用法：cdp-shot.mjs --pre tools/verify-854/probe-open.js --post-ms 1200
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const trigger = [...document.querySelectorAll("button")].find(
    (b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"),
  )
  if (!trigger) return JSON.stringify({ error: "找不到本包 trigger（未遮蔽官方？）" })
  trigger.click()
  await sleep(700)

  const pop = document.querySelector(".matter-picker-ui")
  if (!pop) return JSON.stringify({ error: "点击后没有 .matter-picker-ui 弹层" })

  const text = (pop.innerText || "").trim()
  const inputs = [...pop.querySelectorAll("input")]
  const range = pop.querySelector('input[type="range"]')
  const thumbs = pop.querySelectorAll('[data-slot="slider-thumb"]')
  const groups = [...pop.querySelectorAll('[role^="menuitem"]')]
  // 分组标题 = 弹层里 sticky 的 div（无 role），逐个取文本
  const sticky = [...pop.querySelectorAll("div")].filter((d) => String(d.className).includes("sticky"))

  const rect = pop.getBoundingClientRect()
  const cs = getComputedStyle(pop)
  return JSON.stringify({
    popoverText: text.slice(0, 500),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    withinViewport: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    position: cs.position,
    background: cs.backgroundColor,
    borderRadius: cs.borderRadius,
    maxHeight: cs.maxHeight,
    pane: range ? "root(滑条)" : "model(列表)",
    searchInputs: inputs.length,
    searchPlaceholder: inputs[1]?.placeholder ?? inputs[0]?.placeholder ?? null,
    sliderRange: !!range,
    sliderAriaLabel: range?.getAttribute("aria-label") ?? null,
    sliderMax: range?.getAttribute("max") ?? null,
    sliderThumbCount: thumbs.length,
    thumbSize: thumbs[0] ? `${Math.round(thumbs[0].getBoundingClientRect().width)}x${Math.round(thumbs[0].getBoundingClientRect().height)}` : null,
    groupTitles: sticky.map((d) => (d.innerText || "").trim()).filter(Boolean).slice(0, 8),
    modelRowCount: groups.length,
  })
})()
