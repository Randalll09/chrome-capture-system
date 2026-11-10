import { putImage } from './lib/db.js';

// chrome.tabs.captureVisibleTab 은 초당 2회로 제한되므로 간격을 둡니다.
const CAPTURE_GAP_MS = 550;
const MAX_TILES = 150; // 너무 긴 페이지에서 무한정 스크롤하지 않도록 제한
const MAX_CANVAS_SIDE = 32000;
const MAX_CANVAS_AREA = 240_000_000;

let lastCaptureAt = 0;
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 진입점 ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'start') {
    startFromActiveTab(msg.mode).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: friendlyError(err) })
    );
    return true;
  }
  if (msg?.type === 'capture-rect' && sender.tab) {
    captureArea(sender.tab, {
      rect: msg.rect,
      single: msg.single,
      hideFixed: msg.single ? 'none' : 'always',
    }).catch((err) => reportError(sender.tab.id, err));
    return false;
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = {
    'capture-visible': 'visible',
    'capture-full': 'full',
    'capture-element': 'element',
    'capture-region': 'region',
  }[command];
  if (!mode) return;
  const run = tab ? start(mode, tab) : startFromActiveTab(mode);
  run.catch((err) => reportError(tab?.id, err));
});

async function startFromActiveTab(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  return start(mode, tab);
}

async function start(mode, tab) {
  if (mode === 'visible') {
    const dataUrl = await captureVisible(tab.windowId);
    const blob = await (await fetch(dataUrl)).blob();
    await openEditor(blob, tab);
    return;
  }
  if (mode === 'full') {
    // 스크립트 주입이 가능한 페이지인지 먼저 확인 (실패 시 팝업에 오류 표시)
    await exec(tab.id, () => true);
    // 팝업이 응답을 받고 닫힐 수 있도록 실제 작업은 비동기로 진행
    captureArea(tab, { rect: null, single: false, hideFixed: 'after-first' }).catch((err) =>
      reportError(tab.id, err)
    );
    return;
  }
  if (mode === 'element' || mode === 'region') {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [mode === 'element' ? 'content/picker.js' : 'content/region.js'],
    });
    return;
  }
  throw new Error('알 수 없는 캡처 방식입니다: ' + mode);
}

// ───────────────────────── 캡처 ─────────────────────────

async function captureVisible(windowId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (String(err?.message).includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('캡처 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
}

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

/**
 * 문서 좌표(CSS px) 기준 사각형을 캡처합니다.
 * - rect 가 null 이면 문서 전체
 * - single 이면 스크롤 없이 현재 화면에서 잘라냄
 * - 그 외에는 스크롤하며 여러 장을 찍어 이어 붙임
 */
async function captureArea(tab, { rect, single, hideFixed }) {
  if (busy) throw new Error('이미 캡처가 진행 중입니다.');
  busy = true;
  const tabId = tab.id;
  try {
    const info = await exec(tabId, pagePrepare, [!rect && !single]);
    const area = normalizeRect(rect || { x: 0, y: 0, w: info.docW, h: info.docH }, info);
    if (area.w < 1 || area.h < 1) throw new Error('캡처할 영역이 비어 있습니다.');

    // 타일 위치 계산
    const positions = [];
    if (single) {
      positions.push(null);
    } else {
      for (let y = area.y; y < area.y + area.h; y += info.vh) {
        for (let x = area.x; x < area.x + area.w; x += info.vw) positions.push({ x, y });
        if (positions.length > MAX_TILES) break;
      }
    }

    let canvas, ctx, scale;
    if (hideFixed === 'always') await exec(tabId, pageHideFixed);

    for (let i = 0; i < positions.length; i++) {
      if (positions.length > 1) setBadge(tabId, Math.round((i / positions.length) * 100) + '%');
      const pos = positions[i];
      const scroll = pos
        ? await exec(tabId, pageScrollTo, [pos.x, pos.y])
        : { sx: info.sx, sy: info.sy };

      const dataUrl = await captureVisible(tab.windowId);
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const ratio = bmp.width / info.iw; // 실제 픽셀 / CSS px

      if (!canvas) {
        scale = Math.min(
          ratio,
          MAX_CANVAS_SIDE / area.w,
          MAX_CANVAS_SIDE / area.h,
          Math.sqrt(MAX_CANVAS_AREA / (area.w * area.h))
        );
        canvas = new OffscreenCanvas(Math.round(area.w * scale), Math.round(area.h * scale));
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
      }

      // 이번 화면과 캡처 대상 영역이 겹치는 부분만 그림 (스크롤바 제외)
      const x0 = Math.max(area.x, scroll.sx);
      const y0 = Math.max(area.y, scroll.sy);
      const x1 = Math.min(area.x + area.w, scroll.sx + info.vw);
      const y1 = Math.min(area.y + area.h, scroll.sy + info.vh);
      if (x1 > x0 && y1 > y0) {
        ctx.drawImage(
          bmp,
          (info.ox + x0 - scroll.sx) * ratio, (info.oy + y0 - scroll.sy) * ratio,
          (x1 - x0) * ratio, (y1 - y0) * ratio,
          Math.round((x0 - area.x) * scale), Math.round((y0 - area.y) * scale),
          Math.round((x1 - x0) * scale), Math.round((y1 - y0) * scale)
        );
      }
      bmp.close();

      // 첫 장 이후에는 고정 헤더 등이 반복해서 찍히지 않도록 숨김
      if (i === 0 && hideFixed === 'after-first' && positions.length > 1) {
        await exec(tabId, pageHideFixed);
      }
    }

    await exec(tabId, pageRestore).catch(() => {});
    setBadge(tabId, '');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await openEditor(blob, tab);
  } catch (err) {
    await exec(tabId, pageRestore).catch(() => {});
    setBadge(tabId, '');
    throw err;
  } finally {
    busy = false;
  }
}

function normalizeRect(r, info) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.min(info.docW, r.x + r.w) - x;
  const h = Math.min(info.docH, r.y + r.h) - y;
  return { x, y, w, h };
}

async function openEditor(blob, tab) {
  const id = crypto.randomUUID();
  await putImage(id, blob);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor/editor.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

// ───────────────────────── 오류/표시 ─────────────────────────

function setBadge(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#4f6bff' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission|activeTab/i.test(m)) {
    return '이 페이지는 크롬 정책상 캡처할 수 없습니다. (chrome:// 페이지, 웹 스토어 등)';
  }
  return m;
}

async function reportError(tabId, err) {
  console.error(err);
  if (tabId == null) return;
  setBadge(tabId, '!');
  const message = friendlyError(err);
  await exec(tabId, (m) => alert('캡처 실패: ' + m), [message]).catch(() => {});
  setTimeout(() => setBadge(tabId, ''), 3000);
}

// ─────────────── 아래 함수들은 페이지 안에서 실행됩니다 ───────────────

function pagePrepare(findScroller) {
  const de = document.documentElement;
  const body = document.body || de;
  if (!window.__capState) {
    window.__capState = {
      sx: window.scrollX,
      sy: window.scrollY,
      behavior: de.style.scrollBehavior,
      hidden: [],
      scroller: null,
    };
  }
  const st = window.__capState;
  de.style.setProperty('scroll-behavior', 'auto', 'important');

  // 창(window)은 스크롤되지 않고 안쪽 박스만 스크롤되는 페이지(웹앱, 문서 뷰어 등)는
  // 화면에서 가장 넓게 보이는 스크롤 박스를 찾아 그 박스를 스크롤하며 캡처
  const windowScrolls = Math.max(de.scrollHeight, body.scrollHeight) > window.innerHeight + 2;
  if (findScroller && !windowScrolls) {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 100) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (best) {
      if (!st.scroller) {
        st.scroller = { el: best, sx: best.scrollLeft, sy: best.scrollTop, behavior: best.style.scrollBehavior };
      }
      best.style.setProperty('scroll-behavior', 'auto', 'important');
      const r = best.getBoundingClientRect();
      const ox = Math.max(0, r.left + best.clientLeft);
      const oy = Math.max(0, r.top + best.clientTop);
      return {
        sx: best.scrollLeft,
        sy: best.scrollTop,
        ox,
        oy,
        vw: Math.min(best.clientWidth, window.innerWidth - ox),
        vh: Math.min(best.clientHeight, window.innerHeight - oy),
        iw: window.innerWidth,
        docW: best.scrollWidth,
        docH: best.scrollHeight,
      };
    }
  }

  const vw = de.clientWidth || window.innerWidth;
  const vh = de.clientHeight || window.innerHeight;
  return {
    sx: window.scrollX,
    sy: window.scrollY,
    ox: 0,
    oy: 0,
    vw,
    vh: Math.min(vh, window.innerHeight),
    iw: window.innerWidth,
    docW: Math.max(de.scrollWidth, body.scrollWidth, vw),
    docH: Math.max(de.scrollHeight, body.scrollHeight, vh),
  };
}

async function pageScrollTo(x, y) {
  const sc = window.__capState?.scroller?.el;
  if (sc) {
    sc.scrollTo(x, y);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 120));
    return { sx: sc.scrollLeft, sy: sc.scrollTop };
  }
  window.scrollTo(x, y);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 120)); // 지연 로딩 이미지/애니메이션 대기
  return { sx: window.scrollX, sy: window.scrollY };
}

function pageHideFixed() {
  const st = window.__capState;
  if (!st) return;
  const target = document.querySelector('[data-cap-target]');
  const scroller = st.scroller?.el;
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    if (target && (el.contains(target) || target.contains(el))) continue;
    if (scroller && el.contains(scroller)) continue; // 스크롤 박스 자체나 그 부모는 숨기지 않음
    st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
}

function pageRestore() {
  const st = window.__capState;
  if (!st) return;
  for (const [el, v, p] of st.hidden) {
    if (v) el.style.setProperty('visibility', v, p);
    else el.style.removeProperty('visibility');
  }
  document.querySelectorAll('[data-cap-target]').forEach((el) => el.removeAttribute('data-cap-target'));
  const de = document.documentElement;
  if (st.behavior) de.style.scrollBehavior = st.behavior;
  else de.style.removeProperty('scroll-behavior');
  window.scrollTo(st.sx, st.sy);
  if (st.scroller) {
    const { el, sx, sy, behavior } = st.scroller;
    if (behavior) el.style.scrollBehavior = behavior;
    else el.style.removeProperty('scroll-behavior');
    el.scrollTo(sx, sy);
  }
  delete window.__capState;
}
