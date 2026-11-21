// 探针 3：从 root（滑条）进 model pane（搜索 + 分组列表），返回列表事实。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const trigger = [...document.querySelectorAll("button")].find(
    (b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"),
  )
  if (!trigger) return JSON.stringify({ error: "找不到本包 trigger" })
  trigger.click()
  await sleep(600)

  let pop = document.querySelector(".matter-picker-ui")
  if (!pop) return JSON.stringify({ error: "弹层没开" })

  // root pane 里那行「模型名」按钮（点它进列表）
  const modelRow = [...pop.querySelectorAll("button")].find((b) => String(b.className).includes("mx-auto block"))
  const paneBefore = pop.querySelector('input[type="range"]') ? "root" : "model"
  if (modelRow) {
    modelRow.click()
    await sleep(600)
    pop = document.querySelector(".matter-picker-ui")
  }

  const items = [...pop.querySelectorAll('[role^="menuitem"]')]
  const search = [...pop.querySelectorAll("input")].find((i) => i.type === "text" || i.type === "search" || !i.type)
  const sticky = [...pop.querySelectorAll("div")].filter((d) => String(d.className).includes("sticky"))
  const list = [...pop.querySelectorAll("div")].find((d) => String(d.className).includes("overflow-y-auto"))
  const rect = pop.getBoundingClientRect()
  const cs = getComputedStyle(pop)
  const searchCs = search ? getComputedStyle(search) : null
  const item0 = items[0]
  const item0Cs = item0 ? getComputedStyle(item0) : null

  // 搜索过滤：输入一个必然命中的关键词，看行数是否收敛
  let filtered = null
  if (search) {
    const before = items.length
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    setter.call(search, "glm")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await sleep(500)
    const after = document.querySelectorAll('.matter-picker-ui [role^="menuitem"]').length
    filtered = { before, after, query: "glm" }
    setter.call(search, "")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await sleep(300)
  }

  return JSON.stringify({
    paneBefore,
    paneAfter: pop.querySelector('input[type="range"]') ? "root" : "model",
    popover: { w: Math.round(rect.width), h: Math.round(rect.height), maxHeight: cs.maxHeight, bg: cs.backgroundColor, radius: cs.borderRadius },
    withinViewport: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    search: search
      ? { placeholder: search.placeholder, h: Math.round(search.getBoundingClientRect().height), color: searchCs.color, fontSize: searchCs.fontSize, hasFocus: document.activeElement === search }
      : null,
    groupTitles: sticky.map((d) => (d.innerText || "").trim()).filter(Boolean).slice(0, 10),
    itemCount: items.length,
    firstItem: item0
      ? { text: (item0.innerText || "").trim().slice(0, 40), h: Math.round(item0.getBoundingClientRect().height), color: item0Cs.color, fontSize: item0Cs.fontSize }
      : null,
    checkMarkCount: [...pop.querySelectorAll("span")].filter((s) => (s.innerText || "").trim() === "✓").length,
    listScrollable: list ? { h: Math.round(list.getBoundingClientRect().height), scrollH: list.scrollHeight } : null,
    filtered,
  })
})()
