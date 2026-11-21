(async () => {
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms))
  const ours=[...document.querySelectorAll("button")].filter((b)=>typeof b.className==="string"&&b.className.includes("max-w-[220px]"))
  const official=[...document.querySelectorAll("button")].find((b)=>/选择模型/.test(b.getAttribute("aria-label")||"")||/_7KE1Ra_trigger/.test(String(b.className)))
  if(!official) return JSON.stringify({error:"找不到官方 trigger", forgeTriggers:ours.length})
  official.click(); await sleep(900)
  const menus=[...document.querySelectorAll('[role="menu"]')]
  const menu=menus[menus.length-1]
  const r=menu?.getBoundingClientRect()
  return JSON.stringify({
    forgeTriggers:ours.length,
    clicked:(official.innerText||"").replace(/\n/g," · "),
    forgePopover:!!document.querySelector(".matter-picker-ui"),
    officialMenuCount:menus.length,
    officialMenuText:(menu?.innerText||"").replace(/\n/g," | ").slice(0,300),
    officialMenuRect:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null,
    officialHasSearchInput:!!menu?.querySelector("input"),
    officialMenuItemCount:menu?menu.querySelectorAll("button").length:0,
  })
})()
