# popup.html 을 바탕으로 tools/preview.html 을 생성 (chrome.storage 를 localStorage 로 흉내)
# 실행: python tools/make_preview.py
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "popup.html"), encoding="utf-8").read()
body = re.search(r"<body>(.*)</body>", src, re.S).group(1)
body = body.replace('<script src="popup.js"></script>', "")

MOCK = r"""
  <script>
    function makeArea(prefix) {
      const read = (k) => { try { const v = localStorage.getItem(prefix + k); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; } };
      return {
        get(keys, cb) {
          const p = new Promise((res) => {
            const out = {};
            if (keys === null) {
              for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(prefix)) out[k.slice(prefix.length)] = read(k.slice(prefix.length)); }
            } else {
              for (const k of [].concat(keys)) { const v = read(k); if (v !== undefined) out[k] = v; }
            }
            res(out);
          });
          if (cb) p.then(cb); return p;
        },
        set(obj, cb) { for (const k in obj) localStorage.setItem(prefix + k, JSON.stringify(obj[k])); if (cb) cb(); return Promise.resolve(); },
        remove(keys, cb) { for (const k of [].concat(keys)) localStorage.removeItem(prefix + k); if (cb) cb(); return Promise.resolve(); },
      };
    }
    window.chrome = window.chrome || {};
    chrome.storage = { local: makeArea('dm:'), sync: makeArea('dmsync:'), onChanged: { addListener() {} } };
    chrome.tabs = { create: (o) => window.open(o.url) };
    chrome.runtime = { id: 'kedcopdniobclbhkilmfocdapigdappd', sendMessage: () => Promise.resolve() };

    // 샘플 데이터 (처음 한 번만): 30개, 스크롤·월 그룹 확인용
    if (!localStorage.getItem('dm:memos')) {
      const d = new Date(); const key = (o) => { const t = new Date(d); t.setDate(d.getDate() - o);
        return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`; };
      const lines = ['장보기: 우유, 계란, 커피', '확장프로그램 아이콘 다듬기', '회의 정리 — 검색은 본문 전체 대상으로, 하이라이트 필요', '운동 30분', '읽을 책: 디자인의 디자인', '전화: 치과 예약 변경', '아이디어: 날짜별 메모를 주간 요약으로 묶기', '점심 약속 12:30'];
      const offs = [1,2,3,5,6,8,9,12,14,15,18,20,22,25,27,30,33,35,38,41,45,48,52,55,60,66,72,80,90,100];
      const samples = {};
      offs.forEach((o, i) => { samples[key(o)] = { text: `${lines[i % lines.length]}\n${lines[(i*3) % lines.length]}`, updatedAt: Date.now() - o * 86400000 }; });
      // 오늘: 서식 견본 (제목, 굵게/기울임/밑줄/취소선, 제목1~3, 목록, 체크, 코드, 링크, 정렬)
      samples[key(0)] = {
        title: '오늘 할 일',
        text: ['오늘 할 일', '굵게 기울임 밑줄 취소선', '제목 2', '• 장보기', '• 운동', '1. 첫째', '2. 둘째', '☐ 보고서 ✅ 메일', 'code 와 링크', '가운데'].join(String.fromCharCode(10)),
        updatedAt: Date.now(),
        html: '<div><b>굵게</b> <i>기울임</i> <u>밑줄</u> <s>취소선</s></div><h2>제목 2</h2><ul><li>장보기</li><li>운동</li></ul><ol><li>첫째</li><li>둘째</li></ol><div><span class="cb" contenteditable="false" data-checked="0">☐</span> 보고서 <span class="cb" contenteditable="false" data-checked="1">✅</span> 메일</div><div><code>code</code> 와 <a href="https://example.com">링크</a></div><div style="text-align: center">가운데</div>',
      };
      localStorage.setItem('dm:memos', JSON.stringify(samples));
    }
  </script>
  <script src="../popup.js"></script>
"""

HEAD = """<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Daily Memo 미리보기</title>
  <link rel="stylesheet" href="../popup.css">
  <style>
    html, body { width: auto; height: auto; min-width: 0; min-height: 100vh; max-width: none; max-height: none; overflow: auto; background: #d9d9d9; }
    .frame {
      width: var(--w); height: var(--h); margin: 48px auto 16px; position: relative;
      background: var(--bg); border-radius: 10px; overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
    }
    .frame .resizer { position: absolute; }
    .note { text-align: center; color: #555; font-size: 12px; }
    @media (prefers-color-scheme: dark) { html, body { background: #0f0f0f; } .note { color: #999; } }
  </style>
</head>
<body>
  <!-- 자동 생성 파일: tools/make_preview.py 로 다시 만듭니다 -->
  <div class="frame">"""

TAIL = """  </div>
  <p class="note">미리보기 모드 · 실제 확장과 동일한 UI/로직, 저장만 브라우저 localStorage 사용</p>
""" + MOCK + """</body>
</html>
"""

out = HEAD + body.rstrip() + "\n" + TAIL
open(os.path.join(ROOT, "tools", "preview.html"), "w", encoding="utf-8").write(out)
print("preview.html generated")
