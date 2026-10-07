'use strict';

// 우클릭 메뉴: 선택한 텍스트를 오늘 메모에 추가
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

  if (settings.sync) {
    try { await chrome.storage.sync.set({ [`m:${key}`]: memos[key] }); } catch (e) { /* 용량 초과 등은 무시 */ }
  }

  // 짧게 배지로 알림
  chrome.action.setBadgeText({ text: '+' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b3127' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
});
