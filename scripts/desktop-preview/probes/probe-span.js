(async () => {
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms))
  const t=document.querySelector(".matter-picker-trigger")
  t.click(); await sleep(600)
  let pop=document.querySelector(".matter-picker-ui")
  if(pop.querySelector('input[type="range"]')){ [...pop.querySelectorAll("button")].find((b)=>String(b.className).includes("mx-auto block"))?.click(); await sleep(600); pop=document.querySelector(".matter-picker-ui") }
  const opt=pop.querySelector('[role^="menuitem"]')
  const name=opt?.querySelector("span")
  const input=[...pop.querySelectorAll("input")].find((i)=>i.type!=="range")
  return JSON.stringify({
    nameSpan:{ fontSize:getComputedStyle(name).fontSize, lineHeight:getComputedStyle(name).lineHeight, weight:getComputedStyle(name).fontWeight, color:getComputedStyle(name).color },
    triggerNameSpan:(()=>{const s=[...t.querySelectorAll("span")].find((x)=>(x.innerText||"").trim().length>1);return s?{fontSize:getComputedStyle(s).fontSize, overflow:getComputedStyle(s).overflow, ellipsis:getComputedStyle(s).textOverflow}:null})(),
    search:{ h:Math.round(input.getBoundingClientRect().height), fontSize:getComputedStyle(input).fontSize, radius:getComputedStyle(input).borderRadius, placeholder:input.placeholder },
    optionRectWidth:Math.round(opt.getBoundingClientRect().width),
    menuInnerWidth:Math.round(pop.getBoundingClientRect().width),
  })
})()
