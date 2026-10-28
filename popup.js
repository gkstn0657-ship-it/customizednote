'use strict';

/* ---------- 상수 / 상태 ---------- */
const MEMOS_KEY = 'memos';        // { "YYYY-MM-DD": { text, title?, html?, updatedAt } }
const SIZE_KEY = 'popupSize';     // { w, h }
const SETTINGS_KEY = 'settings';  // { sync: bool, fontSize: 'normal'|'large' }
const DELETED_KEY = 'deleted';    // { "YYYY-MM-DD": 삭제시각 } 동기화 때 다른 기기에서 되살아나지 않게 함
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const EXT_ID = (chrome.runtime && chrome.runtime.id) || 'kedcopdniobclbhkilmfocdapigdappd';
const REVIEW_URL = `https://chromewebstore.google.com/detail/${EXT_ID}/reviews`;

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
const titleEl = $('title');
const pageEl = $('page');
const toolsEl = $('tools');
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
const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'UL', 'OL', 'BLOCKQUOTE']);
const LINE_TAGS = 'div,p,h1,h2,h3,li,pre';
const LINE_SET = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'LI', 'PRE']);
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 화면 내용을 글자로. 목록은 "• " / "1. ", 체크박스는 ☐/✅, 이미지는 [이미지]
function plainText(root) {
  let out = '';
  const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  (function walk(node) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'IMG') { out += '[이미지]'; continue; }
      if (n.classList.contains('cb')) { out += n.textContent; continue; }
      if (BLOCK_TAGS.has(tag)) {
        nl();
        if (tag === 'LI') {
          const parent = n.parentElement;
          const idx = Array.prototype.indexOf.call(parent.children, n) + 1;
          out += parent.tagName === 'OL' ? `${idx}. ` : '• ';
        }
        walk(n);
        nl();
        continue;
      }
      walk(n);
    }
  })(root);
  return out.replace(/\n$/, '');
}
function getText() {
  return plainText(memoEl);
}
function setContent(memo) {
  titleEl.value = memo && memo.title ? memo.title : '';
  if (!memo) { memoEl.innerHTML = ''; return; }
  if (memo.html) memoEl.innerHTML = sanitizeHtml(memo.html);
  else memoEl.textContent = bodyOf(memo);
  memoEl.querySelectorAll('a').forEach((a) => { a.title = 'Ctrl+클릭으로 열기'; });
}
// text 는 "제목\n본문" 꼴로 저장함 (검색·내보내기·동기화가 제목도 다루게). 본문만 꺼냄
function bodyOf(memo) {
  if (!memo) return '';
  if (memo.title && memo.text.startsWith(memo.title)) return memo.text.slice(memo.title.length).replace(/^\n/, '');
  return memo.text;
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
function focusStart() {
  memoEl.focus();
  const r = document.createRange();
  r.selectNodeContents(memoEl);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function setCaret(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// 저장용 정규화: 어떤 마크업이 들어와도 아래 태그만 남김.
//   글자: b i u s code mark span.lg span.sm a[href]
//   줄:   div(정렬) h1 h2 h3 ul ol li pre br img[src] span.cb
// 서식이 하나도 없으면 null 을 돌려줘 text 만 저장하게 함.
function normalizeHtml(root) {
  let hasFormat = false;
  const alignAttr = (n) => {
    const a = (n.style && n.style.textAlign) || n.getAttribute('align') || '';
    if (a !== 'center' && a !== 'right') return '';
    hasFormat = true;
    return ` style="text-align: ${a}"`;
  };
  function wrapText(t, st) {
    if (st.size === 'lg') t = `<span class="lg">${t}</span>`;
    if (st.size === 'sm') t = `<span class="sm">${t}</span>`;
    if (st.mark) t = `<mark class="${st.mark}">${t}</mark>`;
    if (st.code) t = `<code>${t}</code>`;
    if (st.strike) t = `<s>${t}</s>`;
    if (st.underline) t = `<u>${t}</u>`;
    if (st.italic) t = `<i>${t}</i>`;
    if (st.bold) t = `<b>${t}</b>`;
    if (st.href) t = `<a href="${escAttr(st.href)}">${t}</a>`;
    if (st.bold || st.italic || st.underline || st.strike || st.code || st.mark || st.size || st.href) hasFormat = true;
    return t;
  }
  function walk(node, st) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        if (!n.nodeValue) continue;
        out += wrapText(esc(n.nodeValue), st);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'IMG') {
        const src = n.getAttribute('src') || '';
        if (/^(data:image\/|https?:\/\/)/i.test(src)) { out += `<img src="${escAttr(src)}">`; hasFormat = true; }
        continue;
      }
      if (n.classList && n.classList.contains('cb')) {
        const on = n.dataset.checked === '1' || /[☑✅]/.test(n.textContent);
        out += cbHtml(on);
        hasFormat = true;
        continue;
      }
      const cs = n.style;
      let mark = st.mark;
      if (tag === 'MARK') mark = ['y', 'r', 'g'].find((c) => n.classList.contains(c)) || 'y';
      const byBg = colorKeyFromBg(cs.backgroundColor);
      if (byBg === 'none') mark = '';          // 투명 배경 = 형광펜 해제
      else if (byBg) mark = byBg;
      const deco = `${cs.textDecorationLine || ''} ${cs.textDecoration || ''}`;
      const next = {
        bold: st.bold || tag === 'B' || tag === 'STRONG' || cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 600,
        italic: st.italic || tag === 'I' || tag === 'EM' || cs.fontStyle === 'italic',
        underline: st.underline || tag === 'U' || deco.includes('underline'),
        strike: st.strike || tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || deco.includes('line-through'),
        code: st.code || tag === 'CODE',
        mark,
        size: st.size,
        href: st.href,
      };
      if (cs.fontWeight === 'normal' || cs.fontWeight === '400') next.bold = false;
      if (cs.fontStyle === 'normal') next.italic = false;
      if (tag === 'A') {
        const h = n.getAttribute('href') || '';
        if (/^(https?:\/\/|mailto:)/i.test(h)) next.href = h;
      }
      if (n.classList.contains('lg')) next.size = 'lg';
      else if (n.classList.contains('sm')) next.size = 'sm';
      else if (/x-large|xx-large|larger/.test(cs.fontSize)) next.size = 'lg';
      else if (/x-small|xx-small|^small$|smaller/.test(cs.fontSize)) next.size = 'sm';
      else if (cs.fontSize === 'medium') next.size = '';
      const inner = walk(n, next);
      if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
        const t = tag.toLowerCase();
        out += `<${t}${alignAttr(n)}>${inner || '<br>'}</${t}>`;
        hasFormat = true;
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        const t = tag.toLowerCase();
        out += `<${t}>${inner}</${t}>`;
        hasFormat = true;
        continue;
      }
      if (tag === 'LI') { out += `<li${alignAttr(n)}>${inner || '<br>'}</li>`; hasFormat = true; continue; }
      if (tag === 'PRE') { out += `<pre${alignAttr(n)}>${inner || '<br>'}</pre>`; hasFormat = true; continue; }
      const block = BLOCK_TAGS.has(tag);
      out += block ? `<div${alignAttr(n)}>${inner || '<br>'}</div>` : inner;
    }
    return out;
  }
  const html = walk(root, { bold: false, italic: false, underline: false, strike: false, code: false, mark: '', size: '', href: '' });
  return hasFormat ? html : null;
}
// 불러올 때: 저장된 html 을 다시 한 번 정규화해서 안전하게 주입
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out = normalizeHtml(tpl.content);
  if (out !== null) return out;
  return esc(tpl.content.textContent);
}

/* ---------- 선택 영역 유틸 ---------- */
function selectionInMemo() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!memoEl.contains(r.commonAncestorContainer)) return null;
  return r;
}
function selectionInEditor() {
  const sel = window.getSelection();
  return sel && sel.rangeCount > 0 && memoEl.contains(sel.getRangeAt(0).commonAncestorContainer);
}
function ensureEditorFocus() {
  if (document.activeElement !== memoEl || !selectionInEditor()) focusEnd();
}
function anchorElement() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let el = sel.getRangeAt(0).commonAncestorContainer;
  if (el.nodeType === 3) el = el.parentElement;
  return el && memoEl.contains(el) ? el : null;
}
function closestInMemo(selector) {
  const el = anchorElement();
  if (!el) return null;
  const hit = el.closest(selector);
  return hit && memoEl.contains(hit) && hit !== memoEl ? hit : null;
}
// 노드가 속한 "줄" 블록 (없으면 memoEl)
function blockOf(node) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== memoEl && !LINE_SET.has(el.tagName)) el = el.parentElement;
  return el || memoEl;
}
// 선택 영역에 걸친 줄 블록들 (자식 블록이 없는 것만). 루트 바로 아래 글자면 [memoEl]
function selectedBlocks() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return [];
  const r = sel.getRangeAt(0);
  const start = blockOf(r.startContainer);
  if (start === memoEl) return [memoEl];
  const all = [...memoEl.querySelectorAll(LINE_TAGS)].filter((b) => r.intersectsNode(b) && !b.querySelector(LINE_TAGS));
  return all.length ? all : [start];
}

/* ---------- 형광펜 / 크기 (선택 시 뜨는 작은 바) ---------- */
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
  const m = bg.match(/\d+/g);
  if (!m) return null;
  const [r, g, b] = m.map(Number);
  let best = 'y', bestD = Infinity;
  for (const k of HL_KEYS) {
    const [r2, g2, b2] = hlRgb[k].match(/\d+/g).map(Number);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD < 2500 ? best : 'none';
}
function currentMark() {
  return colorKeyFromBg(document.queryCommandValue('backColor'));
}
function currentSizeLevel() {
  const v = document.queryCommandValue('fontSize');
  if (v === '5' || v === '6' || v === '7') return 1;
  if (v === '1' || v === '2') return -1;
  return 0;
}
function updateFmtBar() {
  const r = selectionInMemo();
  if (!r || views.editor.hidden || !calEl.hidden || !linkBox.hidden) { fmtBar.hidden = true; return; }
  const rect = r.getBoundingClientRect();
  const wrap = memoEl.closest('.memo-wrap').getBoundingClientRect();
  fmtBar.hidden = false;
  const bw = fmtBar.offsetWidth, bh = fmtBar.offsetHeight;
  let left = rect.left - wrap.left + rect.width / 2 - bw / 2;
  left = clamp(left, 6, wrap.width - bw - 6);
  let top = rect.top - wrap.top - bh - 8;
  if (top < 4) top = rect.bottom - wrap.top + 8;
  fmtBar.style.left = `${left}px`;
  fmtBar.style.top = `${top}px`;
  const cur = currentMark();
  fmtBar.querySelectorAll('[data-cmd=mark]').forEach((b) => b.classList.toggle('on', b.dataset.color === cur));
}
function applyFormat(cmd, color) {
  if (!selectionInMemo()) return;
  if (!hlRgb.y) refreshHlColors();
  document.execCommand('styleWithCSS', false, true);
  if (cmd === 'mark') {
    const key = color || 'y';
    document.execCommand('hiliteColor', false, currentMark() === key ? 'transparent' : hlRgb[key]);
  } else if (cmd === 'bigger' || cmd === 'smaller') {
    const lv = clamp(currentSizeLevel() + (cmd === 'bigger' ? 1 : -1), -1, 1);
    document.execCommand('fontSize', false, lv === 1 ? '5' : lv === -1 ? '2' : '3');
  }
  memoEl.dispatchEvent(new Event('input'));
  updateFmtBar();
}

/* ---------- 서식 도구줄 ---------- */
function toggleHeading(tag) {
  const cur = (document.queryCommandValue('formatBlock') || '').toLowerCase();
  document.execCommand('formatBlock', false, cur === tag ? 'div' : tag);
}
function firstContent(block) {
  let n = block.firstChild;
  while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
  return n;
}
// 체크리스트: 선택한 줄들 맨 앞에 체크박스를 넣거나(이미 다 있으면) 뺌
function toggleChecklist() {
  const blocks = selectedBlocks();
  if (!blocks.length || blocks[0] === memoEl) { insertCheckbox(); return; }
  const hasCb = (b) => { const f = firstContent(b); return !!(f && f.nodeType === 1 && f.classList.contains('cb')); };
  const allHave = blocks.every(hasCb);
  const sel = window.getSelection();
  const collapsed = sel.isCollapsed;
  for (const b of blocks) {
    if (allHave) {
      const cb = firstContent(b);
      const next = cb.nextSibling;
      cb.remove();
      if (next && next.nodeType === 3 && next.nodeValue.startsWith(' ')) {
        next.nodeValue = next.nodeValue.slice(1);
        if (!next.nodeValue) next.remove();
      }
      if (!b.firstChild) b.appendChild(document.createElement('br'));
    } else if (!hasCb(b)) {
      const tpl = document.createElement('template');
      tpl.innerHTML = cbHtml(false);
      const span = tpl.content.firstChild;
      const space = document.createTextNode(' ');
      const br = b.firstChild && b.firstChild.tagName === 'BR' && b.childNodes.length === 1 ? b.firstChild : null;
      b.insertBefore(space, b.firstChild);
      b.insertBefore(span, space);
      if (br) br.remove();
      if (collapsed && blocks.length === 1) setCaret(space, 1);
    }
  }
  memoEl.dispatchEvent(new Event('input'));
}
// 코드: 글자를 골랐으면 인라인 <code>, 아니면 줄을 <pre> 로. 이미 코드면 해제
function toggleCode() {
  const sel = window.getSelection();
  const codeEl = closestInMemo('code');
  if (codeEl) {
    codeEl.replaceWith(...codeEl.childNodes);
    memoEl.normalize();
    memoEl.dispatchEvent(new Event('input'));
    return;
  }
  const preEl = closestInMemo('pre');
  const r = sel.getRangeAt(0);
  if (sel.isCollapsed || preEl || blockOf(r.startContainer) !== blockOf(r.endContainer)) {
    document.execCommand('formatBlock', false, preEl ? 'div' : 'pre');
    memoEl.dispatchEvent(new Event('input'));
    return;
  }
  const frag = r.extractContents();
  const code = document.createElement('code');
  code.appendChild(frag);
  r.insertNode(code);
  const nr = document.createRange();
  nr.selectNodeContents(code);
  sel.removeAllRanges();
  sel.addRange(nr);
  memoEl.dispatchEvent(new Event('input'));
}

// 링크
const linkBox = $('link-box');
const linkUrl = $('link-url');
let savedRange = null;
function currentLink() {
  return closestInMemo('a');
}
function openLinkBox() {
  ensureEditorFocus();
  savedRange = window.getSelection().getRangeAt(0).cloneRange();
  const a = currentLink();
  linkUrl.value = a ? a.getAttribute('href') || '' : '';
  $('link-remove').hidden = !a;
  linkBox.hidden = false;
  toggleEmojiRow(false);
  fmtBar.hidden = true;
  linkUrl.focus();
  linkUrl.select();
}
function closeLinkBox(restore) {
  linkBox.hidden = true;
  if (restore && savedRange) {
    memoEl.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  savedRange = null;
}
function applyLink() {
  let url = linkUrl.value.trim();
  if (!url) { closeLinkBox(true); return; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  closeLinkBox(true);
  const a = currentLink();
  const sel = window.getSelection();
  if (a) {
    a.setAttribute('href', url);
  } else if (sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    const space = document.createTextNode(' ');
    r.insertNode(space);
    r.insertNode(link);
    setCaret(space, 1);
  } else {
    document.execCommand('createLink', false, url);
  }
  memoEl.querySelectorAll('a').forEach((x) => { x.title = 'Ctrl+클릭으로 열기'; });
  memoEl.dispatchEvent(new Event('input'));
}
function removeLink() {
  closeLinkBox(true);
  const a = currentLink();
  if (a) { a.replaceWith(...a.childNodes); memoEl.normalize(); memoEl.dispatchEvent(new Event('input')); }
}
function openUrl(url) {
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, '_blank');
}
$('link-ok').addEventListener('click', applyLink);
$('link-remove').addEventListener('click', removeLink);
linkUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkBox(true); }
});
linkBox.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });

// 이미지: 긴 변 1000px 이하로 줄여 메모 안에 넣음
function insertImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const MAX = 1000;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const keepAlpha = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
    const dataUrl = c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.85);
    URL.revokeObjectURL(url);
    ensureEditorFocus();
    document.execCommand('insertImage', false, dataUrl);
    memoEl.dispatchEvent(new Event('input'));
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}
$('file-image').addEventListener('change', (e) => {
  if (e.target.files[0]) insertImageFile(e.target.files[0]);
  e.target.value = '';
});

function runTool(cmd) {
  if (cmd === 'emoji') { toggleEmojiRow(); return; }
  if (cmd === 'image') { $('file-image').click(); return; }
  if (!calEl.hidden) return;
  if (cmd === 'link') { openLinkBox(); return; }
  ensureEditorFocus();
  document.execCommand('styleWithCSS', false, true);
  switch (cmd) {
    case 'bold': document.execCommand('bold'); break;
    case 'italic': document.execCommand('italic'); break;
    case 'underline': document.execCommand('underline'); break;
    case 'strike': document.execCommand('strikeThrough'); break;
    case 'h1': case 'h2': case 'h3': toggleHeading(cmd); break;
    case 'ul': document.execCommand('insertUnorderedList'); break;
    case 'ol': document.execCommand('insertOrderedList'); break;
    case 'checkbox': toggleChecklist(); updateTools(); return;
    case 'code': toggleCode(); updateTools(); return;
    case 'left': document.execCommand('justifyLeft'); break;
    case 'center': document.execCommand('justifyCenter'); break;
    case 'right': document.execCommand('justifyRight'); break;
    default: return;
  }
  memoEl.dispatchEvent(new Event('input'));
  updateTools();
}
const qcs = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
function updateTools() {
  if (views.editor.hidden) return;
  const inEd = document.activeElement === memoEl && selectionInEditor();
  const st = {};
  if (inEd) {
    st.bold = qcs('bold');
    st.italic = qcs('italic');
    st.underline = qcs('underline');
    st.strike = qcs('strikeThrough');
    const fb = (document.queryCommandValue('formatBlock') || '').toLowerCase();
    st.h1 = fb === 'h1'; st.h2 = fb === 'h2'; st.h3 = fb === 'h3';
    st.ul = qcs('insertUnorderedList');
    st.ol = qcs('insertOrderedList');
    st.code = !!closestInMemo('code, pre');
    st.link = !!currentLink();
    st.center = qcs('justifyCenter');
    st.right = qcs('justifyRight');
    const blocks = selectedBlocks();
    st.checkbox = blocks.length > 0 && blocks[0] !== memoEl && blocks.every((b) => { const f = firstContent(b); return !!(f && f.nodeType === 1 && f.classList.contains('cb')); });
  }
  toolsEl.querySelectorAll('button[data-cmd]').forEach((b) => {
    const c = b.dataset.cmd;
    if (c === 'emoji' || c === 'image' || c === 'left') return;
    b.classList.toggle('on', !!st[c]);
  });
}
toolsEl.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // 선택/커서 유지
toolsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (b) runTool(b.dataset.cmd);
});

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
function syncNote() {
  if (!settings.sync || !syncState || syncState.ok) return '';
  if (syncState.error === 'auth') return ' · 동기화: 구글 로그인 필요';
  if (syncState.error === 'quota') return ' · 드라이브 용량 부족';
  if (syncState.error === 'limit') return ' · 연동 용량 초과 · 내보내기로 정리하세요';
  return ' · 동기화 실패, 다시 시도합니다';
}
function syncWarn() {
  return !!(settings.sync && syncState && !syncState.ok && (syncState.error === 'limit' || syncState.error === 'quota'));
}

/* ---------- 메모 저장 ---------- */
function applyEditorToMemos() {
  const title = titleEl.value.trim();
  const body = getText();
  const text = [title, body].filter(Boolean).join('\n');
  if (text.trim() === '') {
    // 빈 메모는 보관하지 않음. 있던 메모를 비운 거면 삭제 기록을 남겨 동기화 때 되살아나지 않게 함
    if (memos[currentDate]) { delete memos[currentDate]; deleted[currentDate] = Date.now(); }
    return;
  }
  delete deleted[currentDate];
  const item = { text, updatedAt: Date.now() };
  if (title) item.title = title;
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
  statusEl.classList.toggle('warn', syncWarn());
  const limit = syncWarn() && syncState.error === 'limit';
  statusEl.classList.toggle('link', limit);
  statusEl.title = limit ? '메모 전체가 연동 상한(5MB)을 넘었습니다. 지난 메모를 파일로 저장하고 지우면 연동이 다시 됩니다. 누르면 내보내기로 이동' : '';
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
  pageEl.scrollTop = 0;
  if (focus) focusEnd();
  updateTools();
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
    const m = memos[key];
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
    btn.appendChild(date);
    if (m.title) {
      const ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.innerHTML = highlight(m.title, q);
      btn.appendChild(ttl);
    }
    const body = bodyOf(m);
    if (body.trim()) {
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.innerHTML = highlight(snippet(body, q), q);
      btn.appendChild(preview);
    }
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
    const m = memos[k];
    lines.push(`## ${formatKey(k)}${m.title ? ` — ${m.title}` : ''}`, '', bodyOf(m), '');
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
      if (typeof v.title === 'string' && v.title) item.title = v.title;
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
let navSeq = 0; // 저장을 기다리는 동안 다른 화면으로 넘어갔는지 확인용
function showView(name) {
  navSeq++;
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  if (name !== 'editor') { toggleEmojiRow(false); toggleCalendar(false); closeLinkBox(false); }
}
async function goList() {
  const seq = navSeq;
  await saveNow();
  if (seq !== navSeq) return;
  renderList();
  showView('list');
  searchEl.focus();
  searchEl.select();
}
function goSettings() {
  renderSettings();
  showView('settings');
}

/* ---------- 창 크기 조절 ---------- */
const MIN_W = 320, MIN_H = 300, MAX_W = 800, MAX_H = 600;
const DEF_W = 340, DEF_H = 420; // 처음 실행 시 크기 (popup.css 의 --w/--h 와 같게)
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
  // 글자를 다 지웠는데 서식 조각만 남으면 비움 (이미지·체크박스가 있으면 그대로)
  if (memoEl.innerText.trim() === '' && !memoEl.querySelector('img, .cb') && memoEl.querySelector('span, b, mark, strong, font, i, u, s, strike, code, a')) memoEl.innerHTML = '';
  if (memoEl.innerHTML === '<br>' || memoEl.innerHTML === '<div><br></div>') memoEl.innerHTML = ''; // placeholder 복원
  if (e.inputType === 'insertText' && e.data) dropInheritedStyle(e.data);
  if (e.inputType === 'insertText' && e.data === ' ') convertBracketCheckbox();
  scheduleSave();
});
titleEl.addEventListener('input', scheduleSave);
titleEl.addEventListener('blur', saveNow);
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) { e.preventDefault(); focusStart(); }
});
/* ---------- 체크박스 ---------- */
function cbHtml(on) {
  return `<span class="cb" contenteditable="false" data-checked="${on ? 1 : 0}">${on ? '✅' : '☐'}</span>`;
}
function insertCbAtRange(range) {
  range.deleteContents();
  const tpl = document.createElement('template');
  tpl.innerHTML = cbHtml(false);
  const span = tpl.content.firstChild;
  const space = document.createTextNode(' ');
  range.insertNode(space);
  range.insertNode(span);
  setCaret(space, 1);
}
function insertCheckbox() {
  ensureEditorFocus();
  insertCbAtRange(window.getSelection().getRangeAt(0));
  memoEl.dispatchEvent(new Event('input'));
}
function toggleCheckbox(el) {
  const on = el.dataset.checked !== '1';
  el.dataset.checked = on ? '1' : '0';
  el.textContent = on ? '✅' : '☐';
  memoEl.dispatchEvent(new Event('input'));
}
// 줄 앞에 "[]" 치고 띄어쓰기하면 체크박스로 바꿔 줌
function convertBracketCheckbox() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  const n = sel.anchorNode;
  if (!n || n.nodeType !== 3) return;
  const before = n.nodeValue.slice(0, sel.anchorOffset);
  if (!/(^|\n)\[\] $/.test(before)) return;
  const r = document.createRange();
  r.setStart(n, sel.anchorOffset - 3);
  r.setEnd(n, sel.anchorOffset);
  insertCbAtRange(r);
}
memoEl.addEventListener('mousedown', (e) => {
  const cb = e.target.closest('.cb');
  if (cb) { e.preventDefault(); toggleCheckbox(cb); return; }
  const a = e.target.closest('a');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openUrl(a.href); }
});
memoEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a && (e.ctrlKey || e.metaKey)) e.preventDefault();
});

// 서식 있는 글자를 지운 직후 타이핑하면 크롬이 지워진 서식을 그대로 이어붙임.
// 방금 입력한 글자만 들어 있는 새 서식 조각이면 풀어서 일반 글자로 만든다.
function dropInheritedStyle(data) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
  let el = sel.anchorNode;
  if (el.nodeType === 3) el = el.parentElement;
  if (!el || el === memoEl || !memoEl.contains(el)) return;
  const styled = ['SPAN', 'B', 'STRONG', 'MARK', 'FONT', 'I', 'EM', 'U', 'S', 'STRIKE', 'CODE'].includes(el.tagName);
  if (!styled || el.textContent !== data) return;
  const text = document.createTextNode(data);
  el.replaceWith(text);
  setCaret(text, text.length);
}
memoEl.addEventListener('blur', saveNow);
memoEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (closestInMemo('li')) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    else if (!e.shiftKey) document.execCommand('insertText', false, '\t');
    return;
  }
  // 빈 본문 맨 앞에서 Backspace → 제목으로
  if (e.key === 'Backspace' && memoEl.textContent === '' && !memoEl.querySelector('img, .cb')) {
    e.preventDefault();
    titleEl.focus();
    titleEl.setSelectionRange(titleEl.value.length, titleEl.value.length);
  }
});
// 붙여넣기: 이미지는 그림으로, 나머지는 일반 텍스트로
memoEl.addEventListener('paste', (e) => {
  const cd = e.clipboardData || window.clipboardData;
  const img = cd.files && [...cd.files].find((f) => f.type.startsWith('image/'));
  e.preventDefault();
  if (img) { insertImageFile(img); return; }
  document.execCommand('insertText', false, cd.getData('text/plain'));
});
memoEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  insertImageFile(f);
});
document.addEventListener('selectionchange', () => { updateFmtBar(); updateTools(); });
memoEl.addEventListener('focus', updateTools);
memoEl.addEventListener('blur', updateTools);

// 달력
const calEl = $('cal');
const calGrid = $('cal-grid');
const calTitle = $('cal-title');
let calYear = 0, calMonth = 0; // 보고 있는 달 (month: 1~12)

function renderCalendar() {
  calTitle.textContent = `${calYear}년 ${calMonth}월`;
  const first = new Date(calYear, calMonth - 1, 1);
  const start = new Date(calYear, calMonth - 1, 1 - first.getDay());
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
    closeLinkBox(false);
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
emojiRow.addEventListener('mousedown', (e) => e.preventDefault());
emojiRow.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ensureEditorFocus();
  document.execCommand('insertText', false, b.dataset.emoji);
});
pageEl.addEventListener('scroll', updateFmtBar);
fmtBar.addEventListener('mousedown', (e) => e.preventDefault()); // 선택 유지
fmtBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) applyFormat(b.dataset.cmd, b.dataset.color);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshHlColors);

// 리뷰: 별을 누르면 웹스토어 리뷰 화면으로
$('btn-review').addEventListener('click', () => openUrl(REVIEW_URL));
$('stars').addEventListener('click', (e) => { if (e.target.closest('button')) openUrl(REVIEW_URL); });

$('btn-list').addEventListener('click', goList);
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
statusEl.addEventListener('click', async () => {
  if (!statusEl.classList.contains('link')) return;
  await saveNow();
  goExport();
  exInfo.textContent = '지난 메모를 저장하고 지우면 연동이 다시 됩니다';
});
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
$('link-shortcuts').addEventListener('click', () => openUrl('chrome://extensions/shortcuts'));

document.addEventListener('keydown', (e) => {
  const inEditor = !views.editor.hidden;
  const inSettings = !views.settings.hidden;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (inEditor && !linkBox.hidden) { closeLinkBox(true); return; }
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
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f' && inEditor) {
    e.preventDefault();
    goList();
    return;
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveNow();
    return;
  }
  if (inEditor && mod && !e.altKey && (document.activeElement === memoEl || document.activeElement === titleEl)) {
    const k = e.key.toLowerCase();
    let cmd = null;
    if (e.shiftKey) {
      if (k === 's') cmd = 'strike';
      else if (k === 'c') cmd = 'checkbox';
      else if (e.code === 'Digit7') cmd = 'ol';
      else if (e.code === 'Digit8') cmd = 'ul';
    } else {
      cmd = { b: 'bold', i: 'italic', u: 'underline', e: 'code', k: 'link', 1: 'h1', 2: 'h2', 3: 'h3' }[k] || null;
      if (k === 'h' || k === '[' || k === ']') {
        e.preventDefault();
        applyFormat({ h: 'mark', '[': 'smaller', ']': 'bigger' }[k]);
        return;
      }
    }
    if (cmd) { e.preventDefault(); runTool(cmd); }
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
  requestSync();
})();
