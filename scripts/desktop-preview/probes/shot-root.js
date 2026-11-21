// 出图①：停在 **root pane（滑条面板）**。若当前模型没有档位（照设计会直接进列表），
// 就先在列表里挑一个有档位的模型（GLM-5.3）—— 选完弹层会留在 root pane（这正是 forge 行为）。
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

  if (!pop.querySelector('input[type="range"]')) {
    // 进列表挑一个有档位的模型
    const item = [...pop.querySelectorAll('[role^="menuitem"]')].find((b) => (b.innerText || "").includes("GLM-5.3"))
    item?.click()
    await sleep(1800)
    pop = document.querySelector(".matter-picker-ui")
  }
  const range = pop?.querySelector('input[type="range"]')
  return JSON.stringify({
    pane: range ? "root" : "model",
    text: (pop?.innerText || "").replace(/\n/g, " | "),
    ticks: [...(pop?.querySelectorAll("span") || [])].map((s) => (s.innerText || "").trim()).filter((t) => /^(默认|关|最低|低|中|高|超高|极高)$/.test(t)),
    triggerText: (trigger()?.innerText || "").trim(),
  })
})()
