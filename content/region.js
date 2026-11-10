// 영역 지정 모드: 화면 위에서 드래그해 원하는 부분을 선택합니다.
(() => {
  if (window.__capRegionActive) return;
  window.__capRegionActive = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.35); user-select: none; }
      .layer.dragging { background: transparent; }
      .sel { position: fixed; display: none; border: 1px solid #fff; outline: 1px dashed #4f6bff;
             box-shadow: 0 0 0 100vmax rgba(0,0,0,.35); pointer-events: none; }
      .size { position: fixed; display: none; background: #1d2129; color: #fff; padding: 2px 6px; border-radius: 4px;
              font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; pointer-events: none; }
      .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: rgba(29,33,41,.92);
              color: #fff; padding: 8px 14px; border-radius: 999px; font: 13px/1.4 system-ui, "Malgun Gothic", sans-serif;
              pointer-events: none; white-space: nowrap; }
      .hint kbd { background: rgba(255,255,255,.15); border-radius: 4px; padding: 0 5px; font: inherit; }
    </style>
    <div class="layer"></div>
    <div class="sel"></div>
    <div class="size"></div>
    <div class="hint">드래그해서 캡처할 영역을 선택하세요 · <kbd>Esc</kbd> 취소</div>`;
  const layer = root.querySelector('.layer');
  const sel = root.querySelector('.sel');
  const size = root.querySelector('.size');
  const hint = root.querySelector('.hint');
  document.documentElement.appendChild(host);

  let start = null;
  let rect = null;

  function update(e) {
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight));
    rect = {
      x: Math.min(start.x, x), y: Math.min(start.y, y),
      w: Math.abs(x - start.x), h: Math.abs(y - start.y),
    };
    Object.assign(sel.style, {
      display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px',
    });
    size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    size.style.display = 'block';
    size.style.left = rect.x + 'px';
    size.style.top = (rect.y > 26 ? rect.y - 24 : rect.y + rect.h + 4) + 'px';
  }

  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    layer.classList.add('dragging');
    hint.style.display = 'none';
    update(e);
  });
  layer.addEventListener('pointermove', (e) => { if (start) update(e); });
  layer.addEventListener('pointerup', async (e) => {
    if (!start) return;
    update(e);
    start = null;
    if (rect.w < 4 || rect.h < 4) {
      // 너무 작으면 다시 선택
      layer.classList.remove('dragging');
      sel.style.display = size.style.display = 'none';
      hint.style.display = '';
      return;
    }
    const r = { x: rect.x + window.scrollX, y: rect.y + window.scrollY, w: rect.w, h: rect.h };
    cleanup();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await new Promise((res) => setTimeout(res, 50));
    chrome.runtime.sendMessage({ type: 'capture-rect', single: true, rect: r });
  });

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
    }
  }
  window.addEventListener('keydown', onKey, true);

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__capRegionActive = false;
  }
})();
