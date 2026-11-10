// 요소 선택 모드: 개발자 도구의 요소 선택기처럼 마우스를 올린 요소를 강조하고 클릭으로 선택합니다.
(() => {
  if (window.__capPickerActive) return;
  window.__capPickerActive = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { position: fixed; border: 2px solid #4f6bff; background: rgba(79,107,255,.18);
             box-sizing: border-box; pointer-events: none; display: none; transition: all .05s linear; }
      .label { position: fixed; background: #1d2129; color: #fff; padding: 3px 7px; border-radius: 4px;
               font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; display: none;
               max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
      .label b { color: #9db1ff; font-weight: 600; }
      .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: rgba(29,33,41,.92);
              color: #fff; padding: 8px 14px; border-radius: 999px; font: 13px/1.4 system-ui, "Malgun Gothic", sans-serif;
              box-shadow: 0 4px 16px rgba(0,0,0,.25); white-space: nowrap; }
      .hint kbd { background: rgba(255,255,255,.15); border-radius: 4px; padding: 0 5px; font: inherit; }
    </style>
    <div class="box"></div>
    <div class="label"></div>
    <div class="hint">캡처할 요소를 클릭하세요 · <kbd>↑</kbd> 상위 요소 · <kbd>↓</kbd> 하위 요소 · <kbd>Esc</kbd> 취소</div>`;
  const box = root.querySelector('.box');
  const label = root.querySelector('.label');
  const hint = root.querySelector('.hint');
  document.documentElement.appendChild(host);

  let current = null;
  let history = []; // ↑로 올라간 경로 (↓로 되돌아가기)

  function describe(el) {
    let s = `<b>${el.tagName.toLowerCase()}</b>`;
    if (el.id) s += '#' + CSS.escape(el.id);
    const cls = [...el.classList].slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
    const r = el.getBoundingClientRect();
    return `${s}${cls}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
  }

  function draw() {
    if (!current) return;
    const r = current.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
    });
    label.innerHTML = describe(current);
    label.style.display = 'block';
    const lh = 24;
    let top = r.top - lh - 4;
    if (top < 4) top = Math.min(r.bottom + 4, window.innerHeight - lh - 4);
    label.style.top = Math.max(4, top) + 'px';
    label.style.left = Math.max(4, Math.min(r.left, window.innerWidth - label.offsetWidth - 4)) + 'px';
    // 안내 문구가 선택 영역을 가리면 아래로 이동
    const nearTop = r.top < 60 && r.bottom > 0;
    hint.style.top = nearTop ? 'auto' : '12px';
    hint.style.bottom = nearTop ? '12px' : 'auto';
  }

  function setCurrent(el, keepHistory) {
    if (!el || el === host || el === document.documentElement) return;
    if (!keepHistory) history = [];
    current = el;
    draw();
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== current) setCurrent(el, false);
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    block(e);
    if (current) pick(current);
  }

  function onKey(e) {
    if (e.key === 'Escape') { block(e); cleanup(); return; }
    if (!current) return;
    if (e.key === 'ArrowUp') {
      block(e);
      const p = current.parentElement;
      if (p && p !== document.documentElement) { history.push(current); setCurrent(p, true); }
    } else if (e.key === 'ArrowDown') {
      block(e);
      const c = history.pop() || current.firstElementChild;
      if (c) setCurrent(c, true);
    } else if (e.key === 'Enter') {
      block(e);
      pick(current);
    }
  }

  const listeners = [
    ['mousemove', onMove], ['click', onClick], ['keydown', onKey],
    ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block],
    ['dblclick', block], ['contextmenu', block], ['auxclick', block],
  ];
  listeners.forEach(([t, f]) => window.addEventListener(t, f, true));
  window.addEventListener('scroll', draw, true);
  window.addEventListener('resize', draw);

  function cleanup() {
    listeners.forEach(([t, f]) => window.removeEventListener(t, f, true));
    window.removeEventListener('scroll', draw, true);
    window.removeEventListener('resize', draw);
    host.remove();
    window.__capPickerActive = false;
  }

  async function pick(el) {
    cleanup();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = Math.min(document.documentElement.clientHeight || window.innerHeight, window.innerHeight);
    let r = el.getBoundingClientRect();
    const fits = r.width <= vw && r.height <= vh;
    if (fits) {
      // 한 화면에 들어가는 요소는 화면 안으로 스크롤한 뒤 한 번에 캡처
      if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }
    } else {
      el.setAttribute('data-cap-target', '');
    }
    // 오버레이가 사라진 화면이 그려질 때까지 대기
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await new Promise((res) => setTimeout(res, 50));
    r = el.getBoundingClientRect();
    chrome.runtime.sendMessage({
      type: 'capture-rect',
      single: fits,
      rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
    });
  }
})();
