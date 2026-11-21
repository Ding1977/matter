// 出图②：停在 **model pane（搜索 + 分组列表）**。有档位时先退回列表；搜索框留空、列表滚到顶。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const trigger = () =>
    [...document.querySelectorAll("button")].find(
      (b) => typeof b.className === "string" && b.className.includes("max-w-[220px]"),
    )
  trigger()?.click()
  await sleep(700)
  let pop = document.querySelector(".matter-picker-ui")
  if (!pop) return JSON.stringify({ error: "弹层没开" })
  if (pop.querySelector('input[type="range"]')) {
    const row = [...pop.querySelectorAll("button")].find((b) => String(b.className).includes("mx-auto block"))
    row?.click()
    await sleep(700)
    pop = document.querySelector(".matter-picker-ui")
  }
  const list = [...pop.querySelectorAll("div")].find((d) => String(d.className).includes("overflow-y-auto"))
  if (list) list.scrollTop = 0
  await sleep(300)
  return JSON.stringify({
    pane: pop.querySelector('input[type="range"]') ? "root" : "model",
    itemCount: pop.querySelectorAll('[role^="menuitem"]').length,
    groups: [...pop.querySelectorAll("div")].filter((d) => String(d.className).includes("sticky")).map((d) => (d.innerText || "").trim()),
    hasCheck: [...pop.querySelectorAll("span")].some((s) => (s.innerText || "").trim() === "✓"),
  })
})()
