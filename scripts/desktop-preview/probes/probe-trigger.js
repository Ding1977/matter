// 探针 1：找出 composer 里的模型选择器 trigger（官方 vs 本包），并返回可判定的事实。
// 用法：cdp-shot.mjs --pre tools/verify-854/probe-trigger.js
(() => {
  const out = { url: location.pathname, title: document.title }
  const buttons = [...document.querySelectorAll("button")]
  out.buttonCount = buttons.length

  // 本包 trigger 的判据 = 类串里带官方 chip 口径的 `max-w-[220px]`（官方 ModelSelect 用的是哈希类名）
  const ours = buttons.filter((b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"))
  out.forgeTriggerCount = ours.length
  out.forgeTriggers = ours.slice(0, 3).map((b) => ({
    text: (b.innerText || "").trim(),
    title: b.getAttribute("title"),
    hasSvg: !!b.querySelector("svg"),
    svgCount: b.querySelectorAll("svg").length,
    cls: b.className,
    rect: (() => {
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })(),
  }))

  // 官方选择器（未被遮蔽时）会出现：composer 工具行里带斜杠模型名的按钮
  out.otherModelishButtons = buttons
    .filter((b) => !ours.includes(b) && /模型|Model|DeepSeek|GLM|Kimi|Qwen/i.test(b.innerText || ""))
    .slice(0, 5)
    .map((b) => ({ text: (b.innerText || "").trim().slice(0, 60), cls: String(b.className).slice(0, 80) }))

  // composer 卡片是否存在（弹层定位依赖它）
  out.composerCard = !!document.querySelector("[data-composer-card]")
  // 本包 CSS 是否注入（作用域类名是否存在）
  const styleText = [...document.querySelectorAll("style")].map((s) => s.textContent || "").join("\n")
  out.injectedCssHasScope = styleText.includes(".matter-picker-ui")
  out.injectedCssHasH7 = styleText.includes(".h-7")
  return JSON.stringify(out)
})()
