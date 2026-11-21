// 探针 5：**宿主健康度** —— 证明"换一个 slot 的占位者"没有把 composer 的邻居弄坏，
// 也没有触发 slot 错误边界（那是 kind=single 遮蔽失败时的典型症状）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sleep0 = 0
  void sleep0

  const slotErrors = [...document.querySelectorAll("[data-slot-error]")]
  const composer = document.querySelector("[data-composer-card]")
  const trigger = [...document.querySelectorAll("button")].find(
    (b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"),
  )

  // composer 工具行：本包 trigger 的邻居（证明其它 chip 还在）
  let siblings = null
  if (trigger?.parentElement) {
    siblings = [...trigger.parentElement.children].map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || "").trim().slice(0, 24),
      aria: el.getAttribute("aria-label"),
      size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
      isForgeTrigger: el === trigger,
    }))
  }

  // 零高度元素扫描（只扫 composer 卡片内，判断有没有塌形的件）
  const collapsed = composer
    ? [...composer.querySelectorAll("button, input, [role='button']")]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.height === 0 && getComputedStyle(el).display !== "none"
        })
        .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 20) }))
    : []

  // 打开一次再关掉，确认没有遗留弹层 / 没把页面锁死
  trigger?.click()
  await sleep(500)
  const opened = !!document.querySelector(".matter-picker-ui")
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(400)
  const closed = !document.querySelector(".matter-picker-ui")

  return JSON.stringify({
    slotErrorCount: slotErrors.length,
    slotErrors: slotErrors.slice(0, 3).map((e) => e.getAttribute("data-slot-error")),
    composerPresent: !!composer,
    forgeTrigger: trigger ? { text: (trigger.innerText || "").trim(), size: `${Math.round(trigger.getBoundingClientRect().width)}x${Math.round(trigger.getBoundingClientRect().height)}` } : null,
    toolRowChildren: siblings,
    collapsedInComposer: collapsed,
    escapeOpensAndCloses: { opened, closed },
    bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
  })
})()
