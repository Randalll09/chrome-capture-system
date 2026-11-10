import { getImage } from '../lib/db.js';

const $ = (id) => document.getElementById(id);
const base = $('base');
const overlay = $('overlay');
const wrap = $('wrap');
const stage = $('stage');
const textInput = $('textInput');
const cropBar = $('cropBar');
const bctx = base.getContext('2d');
const octx = overlay.getContext('2d');

const FONT_FAMILY = 'system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const HISTORY_PIXEL_BUDGET = 400_000_000;
// 캡처 이미지는 보통 화면 배율(devicePixelRatio)로 찍히므로, 선 두께·글자 크기를 그만큼 키워서 화면과 같은 느낌으로 그림
const DPR = window.devicePixelRatio || 1;

const state = {
  tool: 'rect',
  color: '#ff3b30',
  zoom: 1,
  fit: true,
  drag: null,        // 진행 중인 드래그
  crop: null,        // 선택된 자르기 영역 (이미지 좌표)
  text: null,        // 입력 중인 글씨 {x, y}
  dirty: null,       // overlay 에서 지워야 할 영역
  undo: [],
  redo: [],
};

// ───────────────────────── 불러오기 ─────────────────────────

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  const blob = id ? await getImage(id).catch(() => null) : null;
  if (!blob) {
    wrap.hidden = true;
    showMessage('캡처 이미지를 찾을 수 없습니다. 다시 캡처해 주세요.');
    return;
  }
  const bmp = await createImageBitmap(blob);
  base.width = overlay.width = bmp.width;
  base.height = overlay.height = bmp.height;
  bctx.drawImage(bmp, 0, 0);
  bmp.close();
  applyZoom(true);
  updateUi();
}

function showMessage(text) {
  const m = $('message');
  m.textContent = text;
  m.hidden = false;
}

// ───────────────────────── 화면 배율 ─────────────────────────

function naturalSize() {
  return { w: base.width / DPR, h: base.height / DPR };
}

function fitZoom() {
  const { w, h } = naturalSize();
  const availW = stage.clientWidth - 48;
  const availH = stage.clientHeight - 48;
  let z = Math.min(1, availW / w);
  if (h / w < 2.5) z = Math.min(z, availH / h); // 아주 긴(전체 페이지) 이미지는 너비만 맞춤
  return Math.max(0.05, z);
}

function applyZoom(fit, zoom) {
  state.fit = fit;
  state.zoom = fit ? fitZoom() : Math.min(8, Math.max(0.05, zoom));
  const { w, h } = naturalSize();
  wrap.style.width = Math.round(w * state.zoom) + 'px';
  wrap.style.height = Math.round(h * state.zoom) + 'px';
  $('zoomFit').textContent = Math.round(state.zoom * 100) + '%';
  repositionFloating();
}

/** 이미지 픽셀 / 화면 CSS px */
function k() {
  return base.width / wrap.getBoundingClientRect().width;
}

window.addEventListener('resize', () => { if (state.fit) applyZoom(true); });
$('zoomIn').onclick = () => applyZoom(false, state.zoom * 1.25);
$('zoomOut').onclick = () => applyZoom(false, state.zoom / 1.25);
$('zoomFit').onclick = () => (state.fit ? applyZoom(false, 1) : applyZoom(true));

// ───────────────────────── 도구/옵션 ─────────────────────────

function setTool(tool) {
  commitText();
  cancelCrop();
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  overlay.classList.toggle('text', tool === 'text');
  $('widthField').hidden = !['rect', 'ellipse', 'pen'].includes(tool);
  $('fontField').hidden = tool !== 'text';
}
document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

function setColor(color, fromPicker) {
  state.color = color;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', !fromPicker && s.dataset.color === color));
  document.querySelector('.custom').classList.toggle('active', !!fromPicker);
  if (!fromPicker) $('color').value = color;
  if (state.text) textInput.style.color = color;
}
document.querySelectorAll('.swatch').forEach((s) => (s.onclick = () => setColor(s.dataset.color)));
$('color').oninput = (e) => setColor(e.target.value, true);
$('fontSize').onchange = () => { if (state.text) styleTextInput(); textInput.focus(); };

const lineWidth = () => Number($('lineWidth').value) * DPR;
const fontPx = () => Number($('fontSize').value) * DPR;

// ───────────────────────── 실행 취소 ─────────────────────────

function snapshot() {
  const c = document.createElement('canvas');
  c.width = base.width;
  c.height = base.height;
  c.getContext('2d').drawImage(base, 0, 0);
  return c;
}

function historyLimit() {
  return Math.max(3, Math.floor(HISTORY_PIXEL_BUDGET / (base.width * base.height)));
}

function pushHistory() {
  state.undo.push(snapshot());
  while (state.undo.length > historyLimit()) state.undo.shift();
  state.redo = [];
  state.unsaved = true;
  updateUi();
}

function restore(c) {
  const sizeChanged = c.width !== base.width || c.height !== base.height;
  base.width = overlay.width = c.width;
  base.height = overlay.height = c.height;
  bctx.drawImage(c, 0, 0);
  if (sizeChanged) applyZoom(state.fit, state.zoom);
}

function undo() {
  commitText();
  cancelCrop();
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  updateUi();
}

function redo() {
  commitText();
  cancelCrop();
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  updateUi();
}

$('undo').onclick = undo;
$('redo').onclick = redo;

function updateUi() {
  $('undo').disabled = !state.undo.length;
  $('redo').disabled = !state.redo.length;
  $('dims').textContent = `${base.width} × ${base.height}px`;
}

// ───────────────────────── 그리기 ─────────────────────────

function toImage(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(base.width, ((e.clientX - r.left) / r.width) * base.width)),
    y: Math.max(0, Math.min(base.height, ((e.clientY - r.top) / r.height) * base.height)),
  };
}

function shapeRect(a, b, square) {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

function drawShape(ctx, tool, r) {
  ctx.save();
  ctx.strokeStyle = state.color;
  ctx.lineWidth = lineWidth();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (tool === 'rect') {
    ctx.rect(r.x, r.y, r.w, r.h);
  } else {
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPen(ctx, pts) {
  ctx.save();
  ctx.strokeStyle = state.color;
  ctx.lineWidth = lineWidth();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  if (pts.length > 1) ctx.lineTo(pts.at(-1).x, pts.at(-1).y);
  ctx.stroke();
  ctx.restore();
}

function clearOverlay() {
  if (!state.dirty) return;
  const d = state.dirty;
  octx.clearRect(d.x, d.y, d.w, d.h);
  state.dirty = null;
}

function markDirty(r, pad = 0) {
  const p = pad + 4;
  const n = { x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 };
  if (!state.dirty) { state.dirty = n; return; }
  const d = state.dirty;
  const x = Math.min(d.x, n.x), y = Math.min(d.y, n.y);
  state.dirty = { x, y, w: Math.max(d.x + d.w, n.x + n.w) - x, h: Math.max(d.y + d.h, n.y + n.h) - y };
}

function boundsOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = toImage(e);
  if (state.tool === 'text') {
    e.preventDefault();
    if (state.text) { commitText(); return; } // 입력 중이면 바깥 클릭으로 확정
    startText(p);
    return;
  }
  overlay.setPointerCapture(e.pointerId);
  if (state.tool === 'crop') cancelCrop();
  state.drag = { start: p, last: p, pts: [p] };
});

overlay.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d) return;
  const p = toImage(e);
  d.last = p;
  if (state.tool === 'pen') {
    d.pts.push(p);
    clearOverlay();
    drawPen(octx, d.pts);
    markDirty(boundsOf(d.pts), lineWidth());
    return;
  }
  const r = shapeRect(d.start, p, e.shiftKey && state.tool !== 'crop');
  clearOverlay();
  if (state.tool === 'crop') {
    drawCropOverlay(r);
  } else {
    drawShape(octx, state.tool, r);
    markDirty(r, lineWidth());
  }
});

overlay.addEventListener('pointerup', (e) => {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  const p = toImage(e);
  if (state.tool === 'pen') {
    d.pts.push(p);
    clearOverlay();
    pushHistory();
    drawPen(bctx, d.pts);
    return;
  }
  const r = shapeRect(d.start, p, e.shiftKey && state.tool !== 'crop');
  clearOverlay();
  if (r.w < 3 && r.h < 3) return; // 그냥 클릭은 무시
  if (state.tool === 'crop') {
    state.crop = {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)),
    };
    drawCropOverlay(state.crop);
    showCropBar();
  } else {
    pushHistory();
    drawShape(bctx, state.tool, r);
  }
});

// ───────────────────────── 자르기 ─────────────────────────

function drawCropOverlay(r) {
  octx.save();
  octx.fillStyle = 'rgba(0,0,0,.5)';
  octx.fillRect(0, 0, overlay.width, overlay.height);
  octx.clearRect(r.x, r.y, r.w, r.h);
  const lw = Math.max(1, k());
  octx.lineWidth = lw;
  octx.strokeStyle = '#fff';
  octx.setLineDash([6 * lw, 4 * lw]);
  octx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
  octx.restore();
  state.dirty = { x: 0, y: 0, w: overlay.width, h: overlay.height };
}

function showCropBar() {
  cropBar.hidden = false;
  repositionFloating();
}

function repositionFloating() {
  const kk = k();
  if (state.crop && !cropBar.hidden) {
    const c = state.crop;
    const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;
    const barW = cropBar.offsetWidth, barH = cropBar.offsetHeight;
    let left = (c.x + c.w) / kk - barW;
    let top = (c.y + c.h) / kk + 8;
    if (top + barH > wrapH) top = (c.y + c.h) / kk - barH - 8;
    left = Math.max(4, Math.min(left, wrapW - barW - 4));
    top = Math.max(4, top);
    cropBar.style.left = left + 'px';
    cropBar.style.top = top + 'px';
    drawCropOverlay(c);
  }
  if (state.text) styleTextInput();
}

function applyCrop() {
  const c = state.crop;
  if (!c) return;
  pushHistory();
  const tmp = snapshot();
  cancelCrop();
  base.width = overlay.width = c.w;
  base.height = overlay.height = c.h;
  bctx.drawImage(tmp, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  applyZoom(true);
  updateUi();
  toast('잘라냈습니다');
}

function cancelCrop() {
  if (!state.crop) return;
  state.crop = null;
  cropBar.hidden = true;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  state.dirty = null;
}

$('cropApply').onclick = applyCrop;
$('cropCancel').onclick = cancelCrop;

// ───────────────────────── 글씨 ─────────────────────────

function startText(p) {
  state.text = { x: p.x, y: p.y };
  textInput.value = '';
  textInput.hidden = false;
  styleTextInput();
  setTimeout(() => textInput.focus(), 0);
}

function styleTextInput() {
  const kk = k();
  const t = state.text;
  Object.assign(textInput.style, {
    left: t.x / kk - 1 + 'px',
    top: t.y / kk - 1 + 'px',
    fontSize: fontPx() / kk + 'px',
    color: state.color,
  });
}

function commitText() {
  const t = state.text;
  if (!t) return;
  state.text = null;
  const value = textInput.value.replace(/\s+$/, '');
  textInput.hidden = true;
  textInput.value = '';
  if (!value) return;
  pushHistory();
  const size = fontPx();
  bctx.save();
  bctx.font = `700 ${size}px ${FONT_FAMILY}`;
  bctx.fillStyle = state.color;
  bctx.textBaseline = 'top';
  value.split('\n').forEach((line, i) => {
    bctx.fillText(line, t.x, t.y + size * 0.125 + i * size * 1.25);
  });
  bctx.restore();
}

textInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 Enter/Esc 처리하지 않음
  if (e.key === 'Escape') {
    e.preventDefault();
    textInput.value = '';
    commitText();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // Enter: 확정, Shift+Enter: 줄바꿈
    e.preventDefault();
    commitText();
  }
  e.stopPropagation();
});
textInput.addEventListener('blur', () => setTimeout(commitText, 0));

// ───────────────────────── 저장/복사 ─────────────────────────

function toBlob() {
  return new Promise((resolve) => base.toBlob(resolve, 'image/png'));
}

function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `capture_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

async function save() {
  commitText();
  cancelCrop();
  const blob = await toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  state.unsaved = false;
  toast('PNG로 저장했습니다');
}

async function copy() {
  commitText();
  cancelCrop();
  try {
    const blob = await toBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('클립보드에 복사했습니다');
  } catch (err) {
    console.error(err);
    toast('복사하지 못했습니다');
  }
}

$('save').onclick = save;
$('copy').onclick = copy;

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ───────────────────────── 단축키 ─────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target === textInput) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 's') { e.preventDefault(); save(); return; }
  if (mod && key === 'c') { e.preventDefault(); copy(); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Enter' && state.crop) { e.preventDefault(); applyCrop(); return; }
  if (e.key === 'Escape') { cancelCrop(); return; }
  if (e.key === '+' || e.key === '=') applyZoom(false, state.zoom * 1.25);
  else if (e.key === '-') applyZoom(false, state.zoom / 1.25);
  else if (e.key === '0') applyZoom(true);
  else {
    const tool = { c: 'crop', t: 'text', o: 'ellipse', r: 'rect', p: 'pen' }[key];
    if (tool) setTool(tool);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.unsaved) e.preventDefault(); // 편집 내용이 있으면 닫기 전 확인
});

setTool('rect');
load();
