'use strict';

/* ---------- 상수 / 상태 ---------- */
const MEMOS_KEY = 'memos';        // { "YYYY-MM-DD": { text, updatedAt } }
const SIZE_KEY = 'popupSize';     // { w, h }
const SETTINGS_KEY = 'settings';  // { sync: bool, fontSize: 'normal'|'large' }
const DELETED_KEY = 'deleted';    // { "YYYY-MM-DD": 삭제시각 } 동기화 때 다른 기기에서 되살아나지 않게 함
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

let memos = {};
let deleted = {};
let settings = { sync: false, fontSize: 'normal' };
let currentDate = '';
let saveTimer = null;
let dirty = false;
let selfWriting = false;          // 내가 쓴 storage 변경은 무시하기 위한 플래그

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const views = { editor: $('view-editor'), list: $('view-list'), settings: $('view-settings'), export: $('view-export') };
const memoEl = $('memo');
const dateLabel = $('date-label');
const statusEl = $('status');
const btnToday = $('btn-today');
const btnDelete = $('btn-delete');
const searchEl = $('search');
const btnClear = $('btn-clear');
const listEl = $('list');
const optSync = $('opt-sync');
const settingsInfo = $('settings-info');

const fmtBar = $('fmt');

/* ---------- 편집기 유틸 (contenteditable) ---------- */
function getText() {
  // innerText 는 div/br 을 줄바꿈으로 바꿔 줌
  return memoEl.innerText.replace(/\n$/, '');
}
function setContent(memo) {
  if (!memo) { memoEl.innerHTML = ''; return; }
  if (memo.html) memoEl.innerHTML = sanitizeHtml(memo.html);
  else memoEl.textContent = memo.text;
}
function focusEnd() {
  memoEl.focus();
  const r = document.createRange();
  r.selectNodeContents(memoEl);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
// 저장용 정규화: 어떤 마크업이 들어와도 b / mark / span.lg / span.sm / div / br 만 남김.
// 서식이 하나도 없으면 null 을 돌려줘 text 만 저장하게 함.
function normalizeHtml(root) {
  let hasFormat = false;
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function walk(node, st) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        if (!n.nodeValue) continue;
        let t = esc(n.nodeValue);
        if (st.size === 'lg') t = `<span class="lg">${t}</span>`;
        if (st.size === 'sm') t = `<span class="sm">${t}</span>`;
        if (st.mark) t = `<mark class="${st.mark}">${t}</mark>`;
        if (st.bold) t = `<b>${t}</b>`;
        if (st.bold || st.mark || st.size) hasFormat = true;
        out += t;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out += '<br>'; continue; }
      const cs = n.style;
      let mark = st.mark;
      if (tag === 'MARK') mark = ['y', 'r', 'g'].find((c) => n.classList.contains(c)) || 'y';
      const byBg = colorKeyFromBg(cs.backgroundColor);
      if (byBg === 'none') mark = '';          // 투명 배경 = 형광펜 해제
      else if (byBg) mark = byBg;
      const next = {
        bold: st.bold || tag === 'B' || tag === 'STRONG' || cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 600,
        mark,
        size: st.size,
      };
      if (n.classList.contains('lg')) next.size = 'lg';
      else if (n.classList.contains('sm')) next.size = 'sm';
      else if (/x-large|xx-large|larger/.test(cs.fontSize)) next.size = 'lg';
      else if (/x-small|xx-small|^small$|smaller/.test(cs.fontSize)) next.size = 'sm';
      else if (cs.fontSize === 'medium') next.size = '';
      const inner = walk(n, next);
      const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
      out += block ? `<div>${inner || '<br>'}</div>` : inner;
    }
    return out;
  }
  const html = walk(root, { bold: false, mark: '', size: '' });
  return hasFormat ? html : null;
}
// 불러올 때: 저장된 html 을 다시 한 번 정규화해서 안전하게 주입
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out = normalizeHtml(tpl.content);
  if (out !== null) return out;
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return esc(tpl.content.textContent);
}

/* ---------- 서식: 선택 시 나타나는 버튼 ---------- */
function selectionInMemo() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!memoEl.contains(r.commonAncestorContainer)) return null;
  return r;
}
// 형광펜 색: CSS 변수 값을 rgb 문자열로 바꿔 두고, 배경색 → 색 키(y/r/g) 를 역으로 찾음
const HL_KEYS = ['y', 'r', 'g'];
let hlRgb = {};
function hexToRgb(hex) {
  const h = hex.trim().replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
function refreshHlColors() {
  const cs = getComputedStyle(document.documentElement);
  hlRgb = {};
  for (const k of HL_KEYS) hlRgb[k] = hexToRgb(cs.getPropertyValue(`--hl-${k}`));
  hlRgb.page = hexToRgb(cs.getPropertyValue('--bg')); // 페이지 배경 = 형광펜 없음
}
function colorKeyFromBg(bg) {
  if (!bg) return null;
  if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || bg === 'initial' || bg === 'inherit' || bg === hlRgb.page) return 'none';
  for (const k of HL_KEYS) if (hlRgb[k] === bg) return k;
  // 다크/라이트 전환 등으로 값이 다르면 가장 가까운 색으로
  const m = bg.match(/\d+/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number);
  let best = 'y', bestD = Infinity;
  for (const k of HL_KEYS) {
    const [r2, g2, b2] = hlRgb[k].match(/\d+/g).map(Number);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD < 2500 ? best : 'none'; // 비슷한 색이 없으면 형광펜 아님
}
function currentMark() {
  return colorKeyFromBg(document.queryCommandValue('backColor')); // 크롬은 hiliteColor 조회값이 비어 있음
}
function isMarked() {
  const c = currentMark();
  return !!c && c !== 'none';
}
function currentSizeLevel() {
  const v = document.queryCommandValue('fontSize');
  if (v === '5' || v === '6' || v === '7') return 1;
  if (v === '1' || v === '2') return -1;
  return 0;
}
function updateFmtBar() {
  const r = selectionInMemo();
  if (!r || views.editor.hidden || !calEl.hidden) { fmtBar.hidden = true; return; }
  const rect = r.getBoundingClientRect();
  const wrap = memoEl.parentElement.getBoundingClientRect();
  fmtBar.hidden = false;
  const bw = fmtBar.offsetWidth, bh = fmtBar.offsetHeight;
  let left = rect.left - wrap.left + rect.width / 2 - bw / 2;
  left = clamp(left, 6, wrap.width - bw - 6);
  let top = rect.top - wrap.top - bh - 8;
  if (top < 4) top = rect.bottom - wrap.top + 8;
  fmtBar.style.left = `${left}px`;
  fmtBar.style.top = `${top}px`;
  fmtBar.querySelector('[data-cmd=bold]').classList.toggle('on', document.queryCommandState('bold'));
  const cur = currentMark();
  fmtBar.querySelectorAll('[data-cmd=mark]').forEach((b) => b.classList.toggle('on', b.dataset.color === cur));
}
function applyFormat(cmd, color) {
  if (!selectionInMemo()) return;
  if (!hlRgb.y) refreshHlColors();
  document.execCommand('styleWithCSS', false, true);
  if (cmd === 'bold') {
    document.execCommand('bold');
  } else if (cmd === 'mark') {
    const key = color || 'y';
    // 같은 색을 다시 누르면 해제, 다른 색이면 바꿈
    document.execCommand('hiliteColor', false, currentMark() === key ? 'transparent' : hlRgb[key]);
  } else if (cmd === 'bigger' || cmd === 'smaller') {
    const lv = clamp(currentSizeLevel() + (cmd === 'bigger' ? 1 : -1), -1, 1);
    document.execCommand('fontSize', false, lv === 1 ? '5' : lv === -1 ? '2' : '3');
  }
  memoEl.dispatchEvent(new Event('input'));
  updateFmtBar();
}

/* ---------- 날짜 유틸 ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayKey = () => toKey(new Date());
function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return toKey(new Date(y, m - 1, d + days));
}
function formatKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = DAYS[new Date(y, m - 1, d).getDay()];
  return `${y}.${pad2(m)}.${pad2(d)} (${dow})`;
}
function formatMonth(key) {
  const [y, m] = key.split('-');
  return `${y}년 ${Number(m)}월`;
}
function formatTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ---------- 저장소 ---------- */
async function load() {
  const res = await chrome.storage.local.get([MEMOS_KEY, DELETED_KEY, SETTINGS_KEY, SIZE_KEY, 'syncState']);
  memos = res[MEMOS_KEY] || {};
  deleted = res[DELETED_KEY] || {};
  syncState = res.syncState || null;
  settings = Object.assign({ sync: false, fontSize: 'normal' }, res[SETTINGS_KEY]);
  const s = res[SIZE_KEY];
  if (s && s.w && s.h) applySize(s.w, s.h);
  applyFontSize();
}
async function persistMemos() {
  selfWriting = true;
  await chrome.storage.local.set({ [MEMOS_KEY]: memos, [DELETED_KEY]: deleted });
  selfWriting = false;
}
async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/* ---------- 동기화 (구글 드라이브, background.js 가 수행) ----------
 * 팝업은 로컬에 저장한 뒤 background 에 메시지만 보냄. 결과는 storage.local 의 syncState 로 돌아옴.
 */
const byteSize = (obj) => new TextEncoder().encode(JSON.stringify(obj)).length;
let syncState = null;

function requestSync() {
  if (!settings.sync) return;
  chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {});
}
// 상태줄 뒤에 붙일 동기화 문구. 정상이면 빈 문자열
function syncNote() {
  if (!settings.sync || !syncState || syncState.ok) return '';
  if (syncState.error === 'auth') return ' · 동기화: 구글 로그인 필요';
  if (syncState.error === 'quota') return ' · 드라이브 용량 부족';
  return ' · 동기화 실패, 다시 시도합니다';
}

/* ---------- 메모 저장 ---------- */
function applyEditorToMemos() {
  const text = getText();
  if (text.trim() === '') { delete memos[currentDate]; return; } // 빈 메모는 보관하지 않음
  delete deleted[currentDate];
  const item = { text, updatedAt: Date.now() };
  const html = normalizeHtml(memoEl);
  if (html !== null) item.html = html; // 서식이 있을 때만 html 보관
  memos[currentDate] = item;
}
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return;
  applyEditorToMemos();
  await persistMemos();
  dirty = false;
  updateStatus();
  requestSync();
}
function scheduleSave() {
  dirty = true;
  statusEl.textContent = '입력 중…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

/* ---------- 편집 화면 ---------- */
function updateStatus() {
  const m = memos[currentDate];
  statusEl.textContent = (m ? `저장됨 ${formatTime(m.updatedAt)}` : '저장됨') + syncNote();
  btnDelete.hidden = !m;
  resetDeleteButton();
}
function openDate(key, focus = true) {
  currentDate = key;
  setContent(memos[key]);
  dateLabel.textContent = formatKey(key);
  btnToday.hidden = key === todayKey();
  dirty = false;
  updateStatus();
  showView('editor');
  if (focus) focusEnd();
}
async function moveDay(delta) {
  await saveNow();
  openDate(shiftKey(currentDate, delta));
}

/* 삭제: 한 번 누르면 확인 상태, 3초 안에 다시 누르면 삭제 */
let deleteTimer = null;
function resetDeleteButton() {
  clearTimeout(deleteTimer);
  btnDelete.textContent = '삭제';
  btnDelete.classList.remove('confirm');
}
async function onDeleteClick() {
  if (!btnDelete.classList.contains('confirm')) {
    btnDelete.textContent = '정말 삭제?';
    btnDelete.classList.add('confirm');
    deleteTimer = setTimeout(resetDeleteButton, 3000);
    return;
  }
  clearTimeout(saveTimer);
  dirty = false;
  const date = currentDate;
  delete memos[date];
  deleted[date] = Date.now();
  await persistMemos();
  requestSync();
  setContent(null);
  updateStatus();
  memoEl.focus();
}

/* ---------- 목록 / 검색 ---------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const re = new RegExp(escapeRegExp(q), 'gi');
  let out = '', last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
function snippet(text, q) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!q) return flat.slice(0, 120);
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return flat.slice(0, 120);
  const start = Math.max(0, idx - 30);
  const end = Math.min(flat.length, idx + q.length + 80);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
function renderList() {
  const q = searchEl.value.trim();
  btnClear.hidden = q === '';
  const today = todayKey();
  const ql = q.toLowerCase();

  const keys = Object.keys(memos)
    .filter((k) => !q || memos[k].text.toLowerCase().includes(ql))
    .sort((a, b) => (a < b ? 1 : -1));


  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q ? '검색 결과가 없습니다' : '아직 저장된 메모가 없습니다';
    listEl.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  let lastMonth = '';
  for (const key of keys) {
    const month = key.slice(0, 7);
    if (month !== lastMonth) {
      const h = document.createElement('div');
      h.className = 'month';
      h.textContent = formatMonth(key);
      frag.appendChild(h);
      lastMonth = month;
    }
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.dataset.key = key;

    const date = document.createElement('div');
    date.className = 'date';
    const dateText = document.createElement('span');
    dateText.textContent = formatKey(key);
    date.appendChild(dateText);
    if (key === today) {
      const tag = document.createElement('span');
      tag.className = 'today-tag';
      tag.textContent = '오늘';
      date.appendChild(tag);
    }
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.innerHTML = highlight(snippet(memos[key].text, q), q);

    btn.append(date, preview);
    frag.appendChild(btn);
  }
  listEl.replaceChildren(frag);
}

/* ---------- 설정 ---------- */
function applyFontSize() {
  document.body.classList.toggle('font-large', settings.fontSize === 'large');
  document.querySelectorAll('#seg-font button').forEach((b) => {
    b.classList.toggle('on', b.dataset.value === settings.fontSize);
  });
}
function renderSettings() {
  optSync.checked = !!settings.sync;
  applyFontSize();
  settingsInfo.textContent = `메모 ${Object.keys(memos).length}개 · ${(byteSize(memos) / 1024).toFixed(1)}KB` + syncNote();
}
async function onToggleSync() {
  settings.sync = optSync.checked;
  await persistSettings();
  if (!settings.sync) { renderSettings(); return; }
  // 구글 로그인 (허용 창은 사용자가 토글을 누른 직후에만 띄울 수 있음)
  settingsInfo.textContent = '구글 로그인 중…';
  try {
    await chrome.identity.getAuthToken({ interactive: true });
  } catch (e) {
    settings.sync = false;
    optSync.checked = false;
    await persistSettings();
    settingsInfo.textContent = '로그인을 취소했습니다';
    return;
  }
  settingsInfo.textContent = '동기화 중…';
  syncState = null;
  requestSync();
}
/* ---------- 내보내기 ---------- */
const ex = { range: 'all', format: 'json', pendingDelete: null };
const exSummary = $('ex-summary');
const exInfo = $('ex-info');
const exGo = $('ex-go');
const exDel = $('ex-delete');
const exCancelDel = $('ex-cancel-del');

function exportRange() {
  const t = todayKey();
  if (ex.range === 'all') return [null, null];
  if (ex.range === 'year') return [`${t.slice(0, 4)}-01-01`, t];
  if (ex.range === 'month') return [`${t.slice(0, 7)}-01`, t];
  if (ex.range === '30d') return [shiftKey(t, -29), t];
  const from = $('ex-from').value || null;
  const to = $('ex-to').value || null;
  return from && to && from > to ? [to, from] : [from, to];
}
function exportKeys() {
  const [from, to] = exportRange();
  return Object.keys(memos)
    .filter((k) => (!from || k >= from) && (!to || k <= to))
    .sort();
}
function renderExport() {
  document.querySelectorAll('#ex-range button').forEach((b) => b.classList.toggle('on', b.dataset.range === ex.range));
  document.querySelectorAll('#ex-format button').forEach((b) => b.classList.toggle('on', b.dataset.format === ex.format));
  $('ex-dates').hidden = ex.range !== 'custom';
  const keys = exportKeys();
  const sub = {};
  for (const k of keys) sub[k] = memos[k];
  const kb = (byteSize(sub) / 1024).toFixed(1);
  if (keys.length) {
    exSummary.innerHTML = `<b>${keys.length}</b>개 메모 · ${kb}KB<div class="sub">${formatKey(keys[0])} ~ ${formatKey(keys[keys.length - 1])}</div>`;
  } else {
    exSummary.innerHTML = `<b>0</b>개 메모<div class="sub">이 범위에는 메모가 없습니다</div>`;
  }
  exGo.disabled = keys.length === 0;
  exGo.textContent = exDel.checked ? '저장하고 지우기' : '파일로 저장';
  exGo.classList.toggle('danger', false);
  exCancelDel.hidden = true;
  ex.pendingDelete = null;
  exInfo.textContent = '';
}
function goExport() {
  const t = todayKey();
  if (!$('ex-from').value) $('ex-from').value = shiftKey(t, -29);
  if (!$('ex-to').value) $('ex-to').value = t;
  exDel.checked = false;
  renderExport();
  showView('export');
}
function buildExportFile(keys) {
  const [from, to] = exportRange();
  const stamp = ex.range === 'all' ? todayKey() : `${(from || keys[0]).replace(/-/g, '')}-${(to || keys[keys.length - 1]).replace(/-/g, '')}`;
  if (ex.format === 'json') {
    const sub = {};
    for (const k of keys) sub[k] = memos[k];
    const payload = { app: 'daily-memo', version: 1, exportedAt: new Date().toISOString(), range: { from, to }, memos: sub };
    return { name: `daily-memo-${stamp}.json`, type: 'application/json', body: JSON.stringify(payload, null, 2) };
  }
  const lines = [`# Daily Memo (${formatKey(keys[0])} ~ ${formatKey(keys[keys.length - 1])})`, ''];
  for (const k of [...keys].reverse()) {
    lines.push(`## ${formatKey(k)}`, '', memos[k].text, '');
  }
  return { name: `daily-memo-${stamp}.md`, type: 'text/markdown', body: lines.join('\n') };
}
function downloadFile(file) {
  const blob = new Blob([file.body], { type: file.type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function deleteMany(keys) {
  const now = Date.now();
  for (const k of keys) { delete memos[k]; deleted[k] = now; }
  await persistMemos();
  requestSync();
  if (!memos[currentDate]) setContent(null);
}
async function onExportGo() {
  const keys = exportKeys();
  if (!keys.length) return;
  // 2단계: 삭제 확인 대기 중이면 실제 삭제
  if (ex.pendingDelete) {
    const del = ex.pendingDelete;
    ex.pendingDelete = null;
    await deleteMany(del);
    renderExport();
    exInfo.textContent = `${del.length}개 지웠습니다`;
    return;
  }
  downloadFile(buildExportFile(keys));
  if (!exDel.checked) { exInfo.textContent = `${keys.length}개 저장했습니다`; return; }
  // 저장 후 삭제: 한 번 더 확인
  ex.pendingDelete = keys;
  exInfo.textContent = `저장했습니다. ${keys.length}개를 지울까요?`;
  exGo.textContent = `${keys.length}개 지우기`;
  exGo.classList.add('danger');
  exCancelDel.hidden = false;
}
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const src = data && data.memos && typeof data.memos === 'object' ? data.memos : data;
    let added = 0, updated = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v.text !== 'string') continue;
      const item = { text: v.text, updatedAt: Number(v.updatedAt) || Date.now() };
      if (typeof v.html === 'string' && v.html) item.html = v.html; // 서식 보존 (불러올 때 다시 정규화됨)
      if (!memos[k]) { memos[k] = item; added++; }
      else if (item.updatedAt > memos[k].updatedAt) { memos[k] = item; updated++; }
      else continue;
      delete deleted[k];
    }
    await persistMemos();
    requestSync();
    settingsInfo.textContent = `가져오기 완료 · 추가 ${added} · 갱신 ${updated}`;
    if (!views.editor.hidden) openDate(currentDate, false);
  } catch (e) {
    settingsInfo.textContent = '가져오기 실패: JSON 파일이 아닙니다';
  }
}

/* ---------- 화면 전환 ---------- */
let prevView = 'editor';
let navSeq = 0; // 저장을 기다리는 동안 다른 화면으로 넘어갔는지 확인용
function showView(name) {
  navSeq++;
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  if (name !== 'editor') { toggleEmojiRow(false); toggleCalendar(false); }
}
async function goList() {
  const seq = navSeq;
  await saveNow();
  if (seq !== navSeq) return; // 그 사이 다른 화면이 열렸으면 덮어쓰지 않음
  renderList();
  showView('list');
  searchEl.focus();
  searchEl.select();
}
function goSettings() {
  prevView = 'list';
  renderSettings();
  showView('settings');
}

/* ---------- 창 크기 조절 ---------- */
const MIN_W = 320, MIN_H = 300, MAX_W = 800, MAX_H = 600;
const DEF_W = 320, DEF_H = 300; // 처음 실행 시 크기 = 최소 크기 (popup.css 의 --w/--h 와 같게)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let curW = DEF_W, curH = DEF_H;
function applySize(w, h) {
  curW = clamp(Math.round(w), MIN_W, MAX_W);
  curH = clamp(Math.round(h), MIN_H, MAX_H);
  document.documentElement.style.setProperty('--w', `${curW}px`);
  document.documentElement.style.setProperty('--h', `${curH}px`);
}
function initResizer(handle) {
  const dir = Number(handle.dataset.dir) || 1; // 1: 오른쪽, -1: 왼쪽
  let startX, startY, startW, startH, active = false;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    startX = e.screenX; startY = e.screenY;
    startW = curW; startH = curH;
    active = true;
    document.body.classList.add('resizing', dir === 1 ? 'resizing-r' : 'resizing-l');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!active) return;
    applySize(startW + dir * (e.screenX - startX), startH + (e.screenY - startY));
  });
  const end = () => {
    if (!active) return;
    active = false;
    document.body.classList.remove('resizing', 'resizing-r', 'resizing-l');
    chrome.storage.local.set({ [SIZE_KEY]: { w: curW, h: curH } });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    applySize(DEF_W, DEF_H);
    chrome.storage.local.remove(SIZE_KEY);
  });
}
document.querySelectorAll('.resizer').forEach(initResizer);

/* ---------- 이벤트 ---------- */
memoEl.addEventListener('input', (e) => {
  if (memoEl.innerText.trim() === '' && memoEl.querySelector('span, b, mark, strong, font')) memoEl.innerHTML = ''; // 서식 찌꺼기 제거
  if (memoEl.innerHTML === '<br>' || memoEl.innerHTML === '<div><br></div>') memoEl.innerHTML = ''; // placeholder 복원
  if (e.inputType === 'insertText' && e.data) dropInheritedStyle(e.data);
  scheduleSave();
});
// 서식 있는 글자를 지운 직후 타이핑하면 크롬이 지워진 서식을 그대로 이어붙임.
// 방금 입력한 글자만 들어 있는 새 서식 조각이면 풀어서 일반 글자로 만든다.
function dropInheritedStyle(data) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  let el = sel.anchorNode;
  if (el.nodeType === 3) el = el.parentElement;
  if (!el || el === memoEl || !memoEl.contains(el)) return;
  const styled = ['SPAN', 'B', 'STRONG', 'MARK', 'FONT'].includes(el.tagName);
  if (!styled || el.textContent !== data) return;
  const text = document.createTextNode(data);
  el.replaceWith(text);
  const r = document.createRange();
  r.setStart(text, text.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
memoEl.addEventListener('blur', saveNow);
memoEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  }
});
// 붙여넣기는 항상 일반 텍스트로
memoEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});
document.addEventListener('selectionchange', updateFmtBar);

// 달력
const calEl = $('cal');
const calGrid = $('cal-grid');
const calTitle = $('cal-title');
let calYear = 0, calMonth = 0; // 보고 있는 달 (month: 1~12)

function renderCalendar() {
  calTitle.textContent = `${calYear}년 ${calMonth}월`;
  const first = new Date(calYear, calMonth - 1, 1);
  const start = new Date(calYear, calMonth - 1, 1 - first.getDay()); // 그 주 일요일부터
  const today = todayKey();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = toKey(d);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-day';
    b.dataset.key = key;
    if (d.getMonth() !== calMonth - 1) b.classList.add('other');
    if (d.getDay() === 0) b.classList.add('sun');
    if (d.getDay() === 6) b.classList.add('sat');
    if (key === today) b.classList.add('today');
    if (key === currentDate) b.classList.add('selected');
    if (memos[key]) b.classList.add('has');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d.getDate();
    const dot = document.createElement('span');
    dot.className = 'dot';
    b.append(num, dot);
    frag.appendChild(b);
  }
  calGrid.replaceChildren(frag);
}
function toggleCalendar(show) {
  const on = show === undefined ? calEl.hidden : show;
  const wasOpen = !calEl.hidden;
  if (on) {
    const [y, m] = currentDate.split('-').map(Number);
    calYear = y; calMonth = m;
    renderCalendar();
    toggleEmojiRow(false);
  }
  calEl.hidden = !on;
  dateLabel.classList.toggle('on', on);
  if (!on && wasOpen) memoEl.focus();
}
dateLabel.addEventListener('click', () => toggleCalendar());
$('cal-prev').addEventListener('click', () => { if (--calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); });
$('cal-next').addEventListener('click', () => { if (++calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); });
$('cal-today').addEventListener('click', async () => { toggleCalendar(false); await saveNow(); openDate(todayKey()); });
calGrid.addEventListener('click', async (e) => {
  const b = e.target.closest('.cal-day');
  if (!b) return;
  toggleCalendar(false);
  await saveNow();
  openDate(b.dataset.key);
});

// 이모지 트레이
const emojiRow = $('emoji-row');
const btnEmoji = $('btn-emoji');
function toggleEmojiRow(show) {
  const on = show === undefined ? emojiRow.hidden : show;
  emojiRow.hidden = !on;
  btnEmoji.classList.toggle('on', on);
  document.body.classList.toggle('emoji-open', on);
  if (on && document.activeElement !== memoEl) focusEnd();
}
btnEmoji.addEventListener('mousedown', (e) => e.preventDefault()); // 커서 위치 유지
btnEmoji.addEventListener('click', () => toggleEmojiRow());
emojiRow.addEventListener('mousedown', (e) => e.preventDefault());
emojiRow.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (document.activeElement !== memoEl || !selectionInEditor()) focusEnd();
  document.execCommand('insertText', false, b.dataset.emoji);
});
function selectionInEditor() {
  const sel = window.getSelection();
  return sel && sel.rangeCount > 0 && memoEl.contains(sel.getRangeAt(0).commonAncestorContainer);
}
memoEl.addEventListener('scroll', updateFmtBar);
fmtBar.addEventListener('mousedown', (e) => e.preventDefault()); // 선택 유지
fmtBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) applyFormat(b.dataset.cmd, b.dataset.color);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshHlColors);

$('btn-list').addEventListener('click', goList);
$('btn-search').addEventListener('click', goList);
$('btn-back').addEventListener('click', () => openDate(currentDate));
$('btn-prev').addEventListener('click', () => moveDay(-1));
$('btn-next').addEventListener('click', () => moveDay(1));
btnToday.addEventListener('click', () => openDate(todayKey()));
btnDelete.addEventListener('click', onDeleteClick);
$('btn-new-today').addEventListener('click', () => openDate(todayKey()));

searchEl.addEventListener('input', renderList);
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = listEl.querySelector('.item');
  if (first) openDate(first.dataset.key);
});
btnClear.addEventListener('click', () => {
  searchEl.value = '';
  renderList();
  searchEl.focus();
});
listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (item) openDate(item.dataset.key);
});

$('btn-settings').addEventListener('click', goSettings);
$('btn-settings-back').addEventListener('click', () => { renderList(); showView('list'); });
optSync.addEventListener('change', onToggleSync);
$('seg-font').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.fontSize = b.dataset.value;
  applyFontSize();
  await persistSettings();
});
$('btn-export').addEventListener('click', goExport);
$('btn-export-back').addEventListener('click', () => { renderSettings(); showView('settings'); });
$('ex-range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ex.range = b.dataset.range; renderExport(); } });
$('ex-format').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ex.format = b.dataset.format; renderExport(); } });
$('ex-from').addEventListener('change', renderExport);
$('ex-to').addEventListener('change', renderExport);
exDel.addEventListener('change', renderExport);
exGo.addEventListener('click', onExportGo);
exCancelDel.addEventListener('click', renderExport);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = '';
});
$('link-shortcuts').addEventListener('click', () => {
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

document.addEventListener('keydown', (e) => {
  const inEditor = !views.editor.hidden;
  const inSettings = !views.settings.hidden;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (inEditor && !calEl.hidden) { toggleCalendar(false); return; }
    if (inEditor && !emojiRow.hidden) { toggleEmojiRow(false); return; }
    if (!views.export.hidden) { renderSettings(); showView('settings'); return; }
    if (inSettings) { renderList(); showView('list'); }
    else if (inEditor) goList();
    else openDate(currentDate);
    return;
  }
  if (inEditor && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    moveDay(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && inEditor) {
    e.preventDefault();
    goList();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveNow();
    return;
  }
  if (inEditor && (e.ctrlKey || e.metaKey) && !e.altKey) {
    const map = { b: 'bold', h: 'mark', '[': 'smaller', ']': 'bigger' };
    const cmd = map[e.key.toLowerCase()];
    if (cmd) { e.preventDefault(); applyFormat(cmd); }
  }
});

// 다른 곳(우클릭 메뉴, 다른 기기 동기화)에서 메모가 바뀌면 화면 갱신
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[MEMOS_KEY] && !selfWriting) {
    memos = changes[MEMOS_KEY].newValue || {};
    if (!views.editor.hidden && !dirty) openDate(currentDate, false);
    else if (!views.list.hidden) renderList();
  }
  if (area === 'local' && changes[DELETED_KEY] && !selfWriting) deleted = changes[DELETED_KEY].newValue || {};
  if (area === 'local' && changes.syncState) {
    syncState = changes.syncState.newValue || null;
    if (!views.editor.hidden && !dirty) updateStatus();
    else if (!views.settings.hidden) {
      if (syncState && syncState.ok) settingsInfo.textContent = `동기화 완료 · 받음 ${syncState.pulled} · 보냄 ${syncState.pushed}`;
      else renderSettings();
    }
  }
});

// 팝업이 닫힐 때 대기 중인 저장을 즉시 반영
window.addEventListener('pagehide', () => {
  if (!dirty) return;
  clearTimeout(saveTimer);
  applyEditorToMemos();
  chrome.storage.local.set({ [MEMOS_KEY]: memos, [DELETED_KEY]: deleted });
  requestSync();
});

/* ---------- 시작 ---------- */
(async () => {
  refreshHlColors();
  await load();
  openDate(todayKey());
  // 동기화 켜져 있으면 background 가 받아오고, 바뀐 메모는 storage.onChanged 로 화면에 반영됨
  requestSync();
})();
