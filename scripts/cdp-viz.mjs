// cdp-viz —— CDP 操作可视化注入层（ISS-263）
//
// 背景：cdp-driver 走 Input.dispatchMouseEvent 注入的是 **CDP 合成事件**，不会移动 macOS
// 硬件光标，点击也是瞬间完成 —— 老板看不出 agent 点了哪里。本模块往目标页面注入一个
// 零侵入的视觉层：① 虚拟鼠标指针（带点击波纹）② 区域高亮（复用 agent 霓虹那套视觉）。
//
// 注入而非固化：这是**测试夹具**不是产品功能。运行时注入 → reload 即清、不进 bundle、
// 不用 build:client、第三方页面（webview guest）也能注入（Runtime.evaluate 不受页面 CSP 影响）。
//
// 三条血泪约束（都真踩过）：
//  1. **布局关键样式一律内联**：v1~v4 把 position/z-index/opacity 交给 `<style>`，一旦那个 style
//     标签失效，root 退化成 static、光标 opacity=1 → **按文档流排到 body 末尾**，表现为主窗口
//     最下面凭空多出一只鼠标（老板 09-08 实锤）。现在：定位/层叠/可见性写在元素 style 上，
//     `<style>` 只承载动画与霓虹环 —— 丢了最多"不动/不亮"，绝不会错位。
//  2. **区域高亮复用霓虹，不另造视觉语言**：conic-gradient 与 `--forge-neon-angle` /
//     `forge-neon-rotate` 沿用 forge-ui 全局（register.tsx neonCss），只把画法换成 `::after` +
//     mask 环：不写 border（不挤占被挂容器布局）、不写 background padding-box（不把容器背景刷成
//     bg-layer-1，那是原 .matter-neon-toolsa 的副作用）、`inset:-2px`（环落在容器**外侧**像素，
//     顺带绕开 <webview> 原生层盖 DOM 的坑）。
//  3. **残留必须自清**：TTL 自动淡出 + 失焦/隐藏即隐 + 安装前清扫孤儿子树（driver 崩了也不留）。
//
// 坐标口径：指针与区域框一律用**目标页自己的 viewport CSS 像素**（与 dispatchMouseEvent 同空间；
// 注意 ≠ 截图设备像素，dpr=2 时截图是 2 倍，见 ISS-264）。宿主页与 guest 各持一份实例。
//
// 层级坑：forge.browser / 会话B 是 Electron <webview> = 原生视图层，绘于宿主 DOM 之上、CSS
// z-index 盖不住。所以 guest 内的指针必须注进 guest 文档；区域框由宿主贴在 webview 容器外侧
// 负责，guest 内只画指针（见 point()），避免同屏两圈。
//
// 用法（driver 侧）：
//   await conn.evalRaw(VIZ_SNIPPET)                          // 幂等安装（版本变了/样式丢了自动重装）
//   await conn.evalRaw(`__cdpViz.focus(${x},${y})`)          // 宿主：指针 + 自查区域 + 霓虹框
//   await conn.evalRaw(`__cdpViz.point(${x},${y},${label})`) // guest：只画指针（框归宿主）
//   await conn.evalRaw(`__cdpViz.off()`)                     // screenshot 前必调，防污染验收图
export const VIZ_SNIPPET = `(function(){
  var VER = 'v10';
  var CSS = [
    // 自带 @property：色带旋转角度必须是可动画的注册属性。**不能**蹭 forge-ui 的
    // --forge-neon-angle —— 一旦那个 style 不在/变量取不到值，conic-gradient(from var(...))
    // 整条 background 声明按 CSS 规则直接作废（实测 bg:none，霓虹哑掉）。同一条纪律：
    // 可视化层不许依赖任何可能被清掉的外部样式。色带与动画节奏仍与 forge-neon 一致。
    '@property --cdpviz-angle{syntax:"<angle>";initial-value:0deg;inherits:false}',
    '@keyframes __cdpviz_neon{to{--cdpviz-angle:360deg}}',
    '@keyframes __cdpviz_pulse{from{opacity:.9;transform:scale(.28)}to{opacity:0;transform:scale(1.75)}}',
    '#__cdpviz_cur svg{display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.55))}',
    // 区域高亮 = 复用霓虹视觉：同一条 conic-gradient 色带 + 同样的 5s 线性旋转。
    // ::after + mask 只留 2px 环，不碰被挂容器的 border / background / 布局。
    '.__cdpviz_neon{position:relative}',
    '.__cdpviz_neon::after{content:"";position:absolute;inset:-2px;z-index:2147483646;pointer-events:none;',
    '  border-radius:10px;padding:2px;box-sizing:border-box;',
    '  background:conic-gradient(from var(--cdpviz-angle),#ff3366,#ff9933,#ffee33,#33ff99,#33aaff,#9933ff,#ff33cc,#ff3366) border-box;',
    '  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);',
    '  -webkit-mask-composite:xor;mask-composite:exclude;',
    '  animation:__cdpviz_neon 5s linear infinite}',
    '@media (prefers-reduced-motion: reduce){.__cdpviz_neon::after{animation:none}}'
  ].join('\\n');
  function cssEl(){ return document.getElementById('__cdpviz_css') }
  function putCss(){
    var st = document.createElement('style');
    st.id = '__cdpviz_css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    return st;
  }
  // 清扫：DOM 里有残留就先拆干净（哪怕句柄已随旧文档失配）。"版本相同但样式被删"也算半拉子，
  // 必须重装 —— 这正是上一版漏掉的那一类。
  function sweep(){
    var n = document.getElementById('__cdpviz_root');
    if (n) n.remove();
    var c = cssEl();
    if (c) c.remove();
    var m = document.querySelectorAll('.__cdpviz_neon');
    for (var i = 0; i < m.length; i++) m[i].classList.remove('__cdpviz_neon');
  }
  if (window.__cdpViz && window.__cdpViz.version === VER && document.getElementById('__cdpviz_root') && cssEl()) {
    return 'viz ready';
  }
  sweep();
  putCss();
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 布局关键样式全部内联（position / z-index / opacity），不依赖 <style> 存活。
  function node(id, extra){
    var d = document.createElement('div');
    d.id = id;
    d.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;opacity:0;' +
      'transition:opacity .18s ease,transform .11s cubic-bezier(.22,.61,.36,1);' + (extra || '');
    return d;
  }
  var root = document.createElement('div');
  root.id = '__cdpviz_root';
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible;opacity:1';
  var tag = node('__cdpviz_tag', 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2px;' +
    'padding:2px 7px;border-radius:6px;background:rgba(17,19,23,.93);color:#d6ebff;white-space:nowrap;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35)');
  var pulse = node('__cdpviz_pulse', 'width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #33aaff');
  var cur = node('__cdpviz_cur', 'width:22px;height:22px');
  cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18.2 L7.3 14.3 L10 20 L12.7 18.8 L10.1 13.3 L16 12.9 Z" fill="#fff" stroke="#12141a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  root.appendChild(tag); root.appendChild(pulse); root.appendChild(cur);
  (document.body || document.documentElement).appendChild(root);
  var timer = 0, marked = null, TTL = 2600;
  function arm(){ clearTimeout(timer); timer = setTimeout(api.off, TTL) }
  // 区域锚点：forge-ui 面板 = data-surface-instance / data-panel / data-slot；会话栏 =
  // data-forge-conv / data-forge-sidebar-col；webview 宿主 = <webview>。命中不到退到语义标签，
  // 保证"永远有个框"。属性为空的锚点（如 data-forge-conv=""）用锚点名兜底，标签说得出是哪块。
  var SEL = ['[data-surface-instance]', '[data-slot="panel-slot"]', '[data-forge-conv]',
             '[data-forge-sidebar-col]', '[data-forge="Panel"]', '[data-forge="TabBar"]',
             'webview', 'iframe', 'section', 'aside', 'main'];
  var NAME = ['surface', 'panel-slot', 'conversation', 'sidebar', 'panel', 'tab-bar',
              'webview', 'iframe', 'section', 'aside', 'main'];
  function regionAt(x, y) {
    var el = document.elementFromPoint(x, y);
    for (var i = 0; i < SEL.length; i++) {
      var hit = el;
      while (hit && hit !== document.body) {
        if (hit.matches && hit.matches(SEL[i])) {
          var r = hit.getBoundingClientRect();
          if (r.width > 24 && r.height > 16) {
            var name = hit.getAttribute('data-surface-instance') || hit.getAttribute('data-panel') ||
                       hit.getAttribute('data-forge') || hit.getAttribute('data-forge-fill') || NAME[i];
            return { el: hit, x: r.left, y: r.top, w: r.width, h: r.height, name: name, tag: hit.tagName.toLowerCase() };
          }
        }
        hit = hit.parentElement;
      }
    }
    return null;
  }
  function unmark(){ if (marked) { marked.classList.remove('__cdpviz_neon'); marked = null } }
  function showTag(html, x, y, h) {
    tag.innerHTML = html;
    var tw = tag.offsetWidth || 160, th = tag.offsetHeight || 20;
    var tx = Math.max(4, Math.min(innerWidth - tw - 4, x));
    var ty = y - th - 6;
    if (ty < 2) ty = Math.min(innerHeight - th - 2, y + (h || 0) + 6);
    tag.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
    tag.style.opacity = '1';
  }
  var api = {
    version: VER,
    // 区域高亮：给锚点容器挂 __cdpviz_neon（伪元素霓虹环）+ 身份标签。
    // 返回 false = 这块区域当前不可见（宽高为 0，例如被切走的挂起实例）→ driver 要如实报，别装成功。
    region: function (r, label) {
      if (!cssEl()) putCss();            // 样式被清掉就自愈：宁可多插一个 style，也不让霓虹哑掉
      if (marked && (!r || marked !== r.el)) unmark();
      if (!r || !r.w || !r.h) { if (!r) unmark(); tag.style.opacity = '0'; return false }
      if (r.el) { marked = r.el; marked.classList.add('__cdpviz_neon') }
      showTag('<b style="color:#7fc4ff;font-weight:600">' + (label || r.name || '?') + '</b>', r.x + 10, r.y, r.h);
      // 自己续期：ring / surface activate 这类"只画框不动手"的调用也要按时淡出，
      // 否则霓虹会永久留在老板界面上（focus/point 的 arm() 覆盖不到这条路径）。
      arm();
      return true;
    },
    pointer: function (x, y) {
      cur.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 1) + 'px)';
      cur.style.opacity = '1';
    },
    pulse: function (x, y) {
      if (reduce) return;
      if (!cssEl()) putCss();
      pulse.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      pulse.style.opacity = '1';
      pulse.classList.remove('go');
      void pulse.offsetWidth;
      pulse.classList.add('go');
      setTimeout(function () { pulse.style.opacity = '0' }, 1300);
    },
    // 宿主用：指针落位 + 自查区域 + 霓虹框；自查不到（第三方页/guest）就框整块视口。
    // 返回命中身份，供 driver 判断落点是否落在 <webview> 里（宿主事件进不去 guest → 要告警）。
    focus: function (x, y, label) {
      var r = regionAt(x, y);
      api.pointer(x, y);
      api.region(r || { x: 6, y: 6, w: innerWidth - 12, h: innerHeight - 12, name: label || 'viewport' },
                 label || (r && r.name) || 'viewport');
      arm();
      // inWv：落点是否落在 <webview> 原生层内（宿主 DOM 里画的指针在那块会被盖住 → driver 要提示加 --guest）。
      // 必须拿**命中点元素**往上找 webview：锚点容器是 webview 的祖先，closest 找不到。
      var pt = document.elementFromPoint(x, y)
      var inWv = !!(pt && (pt.tagName === 'WEBVIEW' || (pt.closest && pt.closest('webview'))))
      return r ? { name: r.name, tag: r.tag, w: Math.round(r.w), h: Math.round(r.h), inWv: inWv }
               : { name: label || 'viewport', tag: null, inWv: inWv };
    },
    // guest 用：只画指针（区域框归宿主贴 webview 外侧，否则同屏两圈）。
    point: function (x, y, label) {
      api.pointer(x, y);
      if (label) showTag('<b style="color:#7fc4ff;font-weight:600">' + label + '</b>', x + 16, y + 18, 0);
      arm();
      return label || null;
    },
    // 键盘类动作无坐标 → 高亮焦点元素所在锚点容器（"正在往哪儿打字"）。
    focusEl: function (label) {
      var el = document.activeElement;
      if (!el || el === document.body) { unmark(); tag.style.opacity = '0'; return null }
      var anchor = el.closest('[data-surface-instance],[data-slot="panel-slot"],[data-forge-conv],' +
                    '[data-forge-sidebar-col],[data-forge="Panel"]') || el;
      var b = anchor.getBoundingClientRect();
      var name = anchor.getAttribute('data-surface-instance') || anchor.getAttribute('data-panel') ||
                 anchor.getAttribute('data-forge') || (el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''));
      api.region({ el: anchor, x: b.left, y: b.top, w: b.width, h: b.height, name: name }, label || name);
      arm();
      return name;
    },
    // driver 把 host 坐标换算成 guest 局部坐标：给出承载 webview 的矩形。
    origin: function (instanceId) {
      var host = instanceId && document.querySelector('[data-surface-instance=' + JSON.stringify(instanceId) + ']');
      var wv = (host ? host.querySelector('webview') : document.querySelector('webview'));
      if (!wv) return null;
      var r = wv.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    // 续期：动作派发完再调一次，TTL 从"结束"起算（否则 dwell 已吃掉一半，截图时早淡了）。
    keep: function () { arm(); return TTL },
    off: function () {
      clearTimeout(timer);
      cur.style.opacity = '0'; tag.style.opacity = '0'; pulse.style.opacity = '0';
      unmark();
    },
    state: function () {
      return {
        ver: VER, ttl: TTL, reduce: reduce, css: !!cssEl(),
        on: cur.style.opacity === '1' || !!marked,
        marked: marked ? (marked.getAttribute('data-surface-instance') || marked.getAttribute('data-panel') || marked.tagName) : null
      }
    }
  };
  // 老板切回自己的操作时绝不该还看见一只假光标：失焦 / 页面隐藏即隐。
  addEventListener('blur', function () { api.off() });
  document.addEventListener('visibilitychange', function () { if (document.hidden) api.off() });
  window.__cdpViz = api;
  return 'viz installed ' + VER;
})()`
