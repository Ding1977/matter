// 探针 4：**提交等价性** —— 点列表里另一个模型，证明「换 UI 不等于换引擎」：
// DSH 侧真的接受了这次选择（trigger 文字随宿主状态变化），而不是只改了本地 state。
// 同时收集各元素的**实际字号/颜色**（判断"类有没有生效"，比如 text-[13px] 是否落到 span 上）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const findTrigger = () =>
    [...document.querySelectorAll("button")].find(
      (b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"),
    )
  const trigger = findTrigger()
  if (!trigger) return JSON.stringify({ error: "找不到本包 trigger" })

  const before = (trigger.innerText || "").trim()
  trigger.click()
  await sleep(600)
  let pop = document.querySelector(".matter-picker-ui")
  if (!pop) return JSON.stringify({ error: "弹层没开" })

  const modelRow = [...pop.querySelectorAll("button")].find((b) => String(b.className).includes("mx-auto block"))
  if (modelRow) {
    modelRow.click()
    await sleep(600)
    pop = document.querySelector(".matter-picker-ui")
  }

  const items = [...pop.querySelectorAll('[role^="menuitem"]')]
  const target = items.find((b) => (b.innerText || "").trim().split("\n")[0] !== before) || items[0]
  const targetName = (target?.innerText || "").trim().split("\n")[0]

  // 字号/颜色取证（判断 Tailwind 类是否真的生效）—— **必须在点击前算**：
  // 点完一次选择后弹层会重渲染，旧引用已脱离 DOM，getComputedStyle 会返回空串。
  const spanOf = (root) => root?.querySelector("span")
  const popCs = getComputedStyle(pop)
  const itemSpan = spanOf(target)
  const itemSpanCs = itemSpan ? getComputedStyle(itemSpan) : null
  const groupTitle = [...pop.querySelectorAll("div")].find((d) => String(d.className).includes("sticky"))
  const groupTitleCs = groupTitle ? getComputedStyle(groupTitle) : null
  const tick = [...pop.querySelectorAll("span")].find((s) => /^(默认|低|中|高|超高|极高|关)$/.test((s.innerText || "").trim()))
  const tickCs = tick ? getComputedStyle(tick) : null
  const typography = {
    popoverBg: popCs.backgroundColor,
    popoverColor: popCs.color,
    itemSpanFontSize: itemSpanCs?.fontSize ?? null,
    itemSpanColor: itemSpanCs?.color ?? null,
    groupTitleFontSize: groupTitleCs?.fontSize ?? null,
    groupTitleColor: groupTitleCs?.color ?? null,
    tickFontSize: tickCs?.fontSize ?? null,
    triggerFontSize: getComputedStyle(trigger).fontSize,
    triggerColor: getComputedStyle(trigger).color,
  }

  target?.click()
  await sleep(1600)

  const trigger2 = findTrigger()
  const pop2 = document.querySelector(".matter-picker-ui")
  const ticks = [...(pop2?.querySelectorAll("span") || [])]
    .map((s) => (s.innerText || "").trim())
    .filter((t) => /^(默认|关|最低|低|中|高|超高|极高)$/.test(t))

  return JSON.stringify({
    triggerBefore: before,
    clickedItem: targetName,
    triggerAfter: (trigger2?.innerText || "").trim(),
    committed: (trigger2?.innerText || "").trim() !== before,
    popoverStillOpen: !!pop2,
    backToRootPane: !!pop2?.querySelector('input[type="range"]'),
    ticksAfter: [...new Set(ticks)].slice(0, 8),
    typography,
  })
})()
