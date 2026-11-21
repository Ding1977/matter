(async () => {
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms))
  const t=document.querySelector(".matter-picker-trigger")
  if(!t) return JSON.stringify({error:"no trigger"})
  const tcs=getComputedStyle(t), tr=t.getBoundingClientRect()
  t.click(); await sleep(700)
  let pop=document.querySelector(".matter-picker-ui")
  if(!pop) return JSON.stringify({error:"no popover"})
  const chev=[...t.querySelectorAll("svg")].pop()
  const menuOpen={ padding:getComputedStyle(pop).padding, radius:getComputedStyle(pop).borderRadius, border:getComputedStyle(pop).border, w:Math.round(pop.getBoundingClientRect().width), h:Math.round(pop.getBoundingClientRect().height) }
  // root → model：入口是 root pane 里那个「模型名」按钮（class 含 mx-auto block），不是 h-10 返回行
  if(pop.querySelector('input[type="range"]')){
    const entry=[...pop.querySelectorAll("button")].find((b)=>String(b.className).includes("mx-auto block"))
    entry?.click(); await sleep(700); pop=document.querySelector(".matter-picker-ui")
  }
  const opt=pop.querySelector('[role^="menuitem"]')
  const ocs=opt?getComputedStyle(opt):null, or_=opt?opt.getBoundingClientRect():null
  const gt=[...pop.querySelectorAll("div")].find((d)=>String(d.className).includes("sticky"))
  const gcs=gt?getComputedStyle(gt):null
  const groups=[...pop.querySelectorAll("div")].filter((d)=>String(d.className).includes("sticky"))
  const second=groups[1]
  return JSON.stringify({
    trigger:{ radius:tcs.borderRadius, padding:tcs.padding, height:Math.round(tr.height), font:tcs.fontSize, weight:tcs.fontWeight, color:tcs.color,
              chevronRotate: chev?getComputedStyle(chev).rotate:"n/a", chevronColor: chev?getComputedStyle(chev).color:"n/a" },
    menuOpen,
    option: ocs?{ minH:ocs.minHeight, radius:ocs.borderRadius, padding:ocs.padding, fontSize:ocs.fontSize, lineHeight:ocs.lineHeight, gap:ocs.gap,
                  h:Math.round(or_.height), role:opt.getAttribute("role"), ariaChecked:opt.getAttribute("aria-checked") }:null,
    groupTitle: gcs?{ fontSize:gcs.fontSize, lineHeight:gcs.lineHeight, padding:gcs.padding, weight:gcs.fontWeight, color:gcs.color }:null,
    groupSpacing: second?getComputedStyle(second.parentElement).marginTop:"n/a",
    signalBars: !!t.querySelector('svg[viewBox="0 0 16 16"]'),
    itemCount: pop.querySelectorAll('[role^="menuitem"]').length,
    groupCount: groups.length,
  })
})()
