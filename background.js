'use strict';

/* ---------- 우클릭 메뉴: 선택한 텍스트를 오늘 메모에 추가 ---------- */
const MENU_ID = 'daily-memo-add-selection';

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

chrome.runtime.onInstalled.addListener(() => {
  // 업데이트 때 같은 id 가 남아 있으면 오류가 나므로 먼저 비움
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '오늘 메모에 추가',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;

  const key = todayKey();
  const { memos = {}, settings = {} } = await chrome.storage.local.get(['memos', 'settings']);
  const prev = memos[key] ? memos[key].text.replace(/\s+$/, '') : '';
  const quote = info.selectionText.trim();
  const source = info.pageUrl ? `\n— ${info.pageUrl}` : '';
  const text = (prev ? prev + '\n\n' : '') + quote + source;

  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const item = { text, updatedAt: Date.now() };
  if (memos[key] && memos[key].html) {
    // 서식이 있는 메모는 html 도 유지
    const addition = quote.split('\n').map((l) => `<div>${esc(l)}</div>`).join('') + (source ? `<div>${esc(source.trim())}</div>` : '');
    item.html = memos[key].html + '<div><br></div>' + addition;
  }
  memos[key] = item;
  await chrome.storage.local.set({ memos });

  if (settings.sync) requestSync();

  // 짧게 배지로 알림
  chrome.action.setBadgeText({ text: '+' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b3127' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
});

/* ---------- 구글 드라이브 동기화 ----------
 * 사용자 본인 드라이브의 앱 전용 폴더(appDataFolder)에 memos.json 한 파일로 저장.
 * 파일 내용: { memos: { "YYYY-MM-DD": { text, html?, updatedAt } }, deleted: { "YYYY-MM-DD": 삭제시각 } }
 * 병합: 같은 날짜는 updatedAt(메모) 과 삭제시각(deleted) 중 큰 쪽이 이김.
 * 결과는 chrome.storage.local 의 syncState 에 기록하고 팝업이 읽어 상태줄에 보여줌.
 */
const FILE_NAME = 'memos.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let syncing = false;
let syncAgain = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sync') requestSync();
});

// 팝업이 떠 있는 동안에도, 다른 기기가 바꾼 걸 받아오도록 15분마다 한 번
chrome.alarms.create('sync', { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'sync') return;
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.sync) requestSync();
});

function requestSync() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  runSync().finally(() => {
    syncing = false;
    if (syncAgain) { syncAgain = false; requestSync(); }
  });
}

async function setState(state) {
  await chrome.storage.local.set({ syncState: Object.assign({ at: Date.now() }, state) });
}

async function runSync() {
  const { settings = {}, memos = {}, deleted = {} } = await chrome.storage.local.get(['settings', 'memos', 'deleted']);
  if (!settings.sync) return;
  let token;
  try {
    token = await getToken(false);
  } catch (e) {
    await setState({ ok: false, error: 'auth' });
    return;
  }
  try {
    const remote = await pull(token);
    const merged = merge({ memos, deleted }, remote.data);
    if (merged.localChanged) {
      await chrome.storage.local.set({ memos: merged.memos, deleted: merged.deleted });
    }
    if (merged.remoteChanged) {
      await push(token, remote.fileId, { memos: merged.memos, deleted: merged.deleted });
    }
    await setState({ ok: true, pulled: merged.pulled, pushed: merged.pushed });
  } catch (e) {
    if (e.status === 401) {
      // 토큰 만료: 캐시를 지우고 다음 동기화 때 새로 받음
      await chrome.identity.removeCachedAuthToken({ token });
      await setState({ ok: false, error: 'auth' });
    } else if (e.status === 403 && /quota|storage/i.test(e.message)) {
      await setState({ ok: false, error: 'quota' });
    } else {
      await setState({ ok: false, error: 'network' });
    }
  }
}

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no token'));
      else resolve(token);
    });
  });
}

async function api(token, url, init = {}) {
  init.headers = Object.assign({ Authorization: `Bearer ${token}` }, init.headers || {});
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => res.statusText));
    err.status = res.status;
    throw err;
  }
  return res;
}

// 파일을 찾아 내용을 읽음. 없으면 { fileId: null, data: null }
async function pull(token) {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const list = await (await api(token, `${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
  const fileId = list.files && list.files[0] ? list.files[0].id : null;
  if (!fileId) return { fileId: null, data: null };
  const data = await (await api(token, `${API}/files/${fileId}?alt=media`)).json().catch(() => null);
  return { fileId, data };
}

async function push(token, fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await api(token, `${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return;
  }
  const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] });
  const boundary = 'dm' + Date.now();
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  await api(token, `${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
}

// 날짜별 최신 상태를 고르고, 로컬/원격 각각 바뀌었는지 표시
function merge(local, remote) {
  const r = remote && typeof remote === 'object' ? remote : {};
  const rm = r.memos || {}, rd = r.deleted || {};
  const lm = local.memos || {}, ld = local.deleted || {};
  const memos = {}, deleted = {};
  let pulled = 0, pushed = 0, localChanged = false, remoteChanged = false;
  const dates = new Set([...Object.keys(lm), ...Object.keys(ld), ...Object.keys(rm), ...Object.keys(rd)]);
  for (const d of dates) {
    const cands = [
      lm[d] && lm[d].text ? { ts: lm[d].updatedAt || 0, memo: lm[d], side: 'l' } : null,
      ld[d] ? { ts: ld[d], memo: null, side: 'l' } : null,
      rm[d] && rm[d].text ? { ts: rm[d].updatedAt || 0, memo: rm[d], side: 'r' } : null,
      rd[d] ? { ts: rd[d], memo: null, side: 'r' } : null,
    ].filter(Boolean);
    cands.sort((a, b) => b.ts - a.ts);
    const win = cands[0];
    if (win.memo) memos[d] = win.memo; else deleted[d] = win.ts;
    const lState = lm[d] && lm[d].text ? lm[d].updatedAt : (ld[d] ? -ld[d] : undefined);
    const rState = rm[d] && rm[d].text ? rm[d].updatedAt : (rd[d] ? -rd[d] : undefined);
    const wState = win.memo ? win.ts : -win.ts;
    if (lState !== wState) { localChanged = true; if (win.memo) pulled++; }
    if (rState !== wState) { remoteChanged = true; if (win.memo) pushed++; }
  }
  return { memos, deleted, pulled, pushed, localChanged, remoteChanged };
}
