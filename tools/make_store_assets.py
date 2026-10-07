# 스토어용 이미지 생성: 스크린샷 1280×800 ×4, 프로모션 타일 440×280
# 실행 조건: 테스트 크롬이 --remote-debugging-port=9333 로 떠 있어야 함 (launch_ext.py)
# 실행: python tools/make_store_assets.py
import json, base64, urllib.request, websocket, time, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'store')
os.makedirs(STORE, exist_ok=True)

popup = open(os.path.join(ROOT, 'popup.html'), encoding='utf-8').read()
body = re.search(r'<body>(.*)</body>', popup, re.S).group(1).replace('<script src="popup.js"></script>', '')
css = open(os.path.join(ROOT, 'popup.css'), encoding='utf-8').read()
js = open(os.path.join(ROOT, 'popup.js'), encoding='utf-8').read()
icon_b64 = base64.b64encode(open(os.path.join(ROOT, 'icons', 'icon128.png'), 'rb').read()).decode()

MOCK = """
function makeArea(prefix){const mem={};return{get(k,cb){const p=new Promise(r=>{const o={};if(k===null){Object.assign(o,mem)}else{for(const x of [].concat(k)){if(x in mem)o[x]=mem[x]}}r(o)});if(cb)p.then(cb);return p},set(o,cb){Object.assign(mem,JSON.parse(JSON.stringify(o)));if(cb)cb();return Promise.resolve()},remove(k,cb){for(const x of [].concat(k))delete mem[x];if(cb)cb();return Promise.resolve()},clear(){for(const k in mem)delete mem[k];return Promise.resolve()}}}
window.chrome={storage:{local:makeArea('l'),sync:makeArea('s'),onChanged:{addListener(){}}},tabs:{create(){}},runtime:{getManifest(){return{permissions:[]}}}};
"""

def frame_page(caption, sub, state_js, w=800, h=600):
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>shot</title>
<style>{css}</style>
<style>
html,body{{width:1280px;height:800px;min-width:0;min-height:0;max-width:none;max-height:none;overflow:hidden;background:#efe9dc;margin:0}}
body{{display:flex;align-items:center;justify-content:center;gap:56px;padding:0 80px;box-sizing:border-box;font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif}}
.cap{{width:330px;flex-shrink:0;color:#3b3127}}
.cap .logo{{display:flex;align-items:center;gap:12px;margin-bottom:28px}}
.cap .logo img{{width:44px;height:44px;border-radius:12px}}
.cap .logo span{{font-size:22px;font-weight:700}}
.cap h1{{font-size:38px;line-height:1.25;margin:0 0 16px;font-weight:700}}
.cap p{{font-size:17px;line-height:1.6;color:#6d6358;margin:0}}
.frame{{width:{w}px;height:{h}px;position:relative;background:var(--bg);border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(59,49,39,.22),0 2px 8px rgba(59,49,39,.12);--w:{w}px;--h:{h}px}}
.frame .resizer{{position:absolute}}
.frame .view{{height:100%}}
</style></head><body>
<div class="cap"><div class="logo"><img src="data:image/png;base64,{icon_b64}"><span>Daily Memo</span></div><h1>{caption}</h1><p>{sub}</p></div>
<div class="frame" id="frame">{body}</div>
<script>{MOCK}</script>
<script>
(async()=>{{
const d=new Date();const k=o=>{{const t=new Date(d);t.setDate(d.getDate()-o);return `${{t.getFullYear()}}-${{String(t.getMonth()+1).padStart(2,'0')}}-${{String(t.getDate()).padStart(2,'0')}}`}};
const m={{}};
m[k(0)]={{text:"오늘 할 일\\n✅ 발표 자료 정리\\n⭐ 디자인 시안 피드백 보내기\\n❗ 오후 3시 치과 예약\\n\\n회의 메모\\n- 검색은 본문 전체 대상으로, 일치 부분 강조\\n- 다음 주 월요일까지 초안 공유",html:"<b>오늘 할 일</b><div>✅ 발표 자료 정리</div><div>⭐ <mark class=\\"y\\">디자인 시안 피드백</mark> 보내기</div><div>❗ <mark class=\\"r\\">오후 3시 치과 예약</mark></div><div><br></div><div><b>회의 메모</b></div><div>- 검색은 본문 전체 대상으로, 일치 부분 <mark class=\\"g\\">강조</mark></div><div>- 다음 주 월요일까지 초안 공유</div>",updatedAt:Date.now()}};
m[k(1)]={{text:"장보기: 우유, 계란, 커피 원두\\n저녁에 운동 30분",updatedAt:Date.now()-864e5}};
m[k(2)]={{text:"읽을 책: 디자인의 디자인\\n아이디어: 날짜별 메모를 주간 요약으로 묶기",updatedAt:Date.now()-2*864e5}};
m[k(4)]={{text:"전화: 치과 예약 변경\\n점심 약속 12:30 — 회사 앞 국수집",updatedAt:Date.now()-4*864e5}};
m[k(7)]={{text:"프로젝트 회고\\n잘한 것: 작은 단위로 자주 배포\\n아쉬운 것: 테스트 늦게 시작",updatedAt:Date.now()-7*864e5}};
m[k(9)]={{text:"주말 계획: 북한산, 사진 정리",updatedAt:Date.now()-9*864e5}};
m[k(12)]={{text:"면접 질문 정리 — 자기소개, 협업 경험, 실패 사례",updatedAt:Date.now()-12*864e5}};
m[k(15)]={{text:"월세 이체, 공과금 확인",updatedAt:Date.now()-15*864e5}};
m[k(20)]={{text:"영화 추천 목록: 퍼펙트 데이즈, 괴물",updatedAt:Date.now()-20*864e5}};
m[k(33)]={{text:"지난달 정리: 블로그 글 2편, 러닝 42km",updatedAt:Date.now()-33*864e5}};
m[k(40)]={{text:"노트북 수리 접수 번호 20260828-117",updatedAt:Date.now()-40*864e5}};
await chrome.storage.local.set({{memos:m,popupSize:{{w:{w},h:{h}}}}});
}})();
</script>
<script>{js}</script>
<script>setTimeout(()=>{{ {state_js} }}, 300);</script>
</body></html>"""

SHOTS = [
    ('screenshot-1.png', '오늘의 메모가<br>바로 열립니다', '아이콘을 누르면 오늘 날짜 메모장. 쓰는 대로 자동 저장되고, 글자를 드래그하면 굵게·형광펜·크기 버튼이 나타납니다.',
     """const w=document.createTreeWalker(document.getElementById('memo'),NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){const i=n.nodeValue.indexOf('초안 공유');if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+5);const s=getSelection();s.removeAllRanges();s.addRange(r);break}}"""),
    ('screenshot-2.png', '달력에서 날짜를<br>누르면 그날 메모', '메모가 있는 날은 점으로 표시됩니다. 상단 날짜를 누르면 달력이 열립니다.',
     """document.getElementById('date-label').click();"""),
    ('screenshot-3.png', '지난 메모를<br>검색으로 찾기', '본문 전체를 검색하고 일치하는 부분을 강조합니다. 메모는 월별로 정리됩니다.',
     """document.getElementById('btn-list').click();setTimeout(()=>{const s=document.getElementById('search');s.value='정리';s.dispatchEvent(new Event('input'));},150);"""),
    ('screenshot-4.png', '기간을 골라<br>내보내기', 'JSON으로 백업하거나 텍스트로 저장합니다. 저장한 메모만 골라 지울 수도 있습니다.',
     """document.getElementById('btn-list').click();setTimeout(()=>{document.getElementById('btn-settings').click();document.getElementById('btn-export').click();document.querySelector('#ex-range [data-range=\\"30d\\"]').click();},200);"""),
]

PROMO = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
html,body{{margin:0;width:440px;height:280px;overflow:hidden;background:#faf7f0;font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif;color:#3b3127}}
.wrap{{display:flex;align-items:center;gap:26px;padding:0 40px;height:100%}}
img{{width:96px;height:96px;border-radius:24px;box-shadow:0 8px 24px rgba(59,49,39,.18)}}
h1{{font-size:30px;margin:0 0 8px;font-weight:700}}
p{{margin:0;font-size:15px;line-height:1.5;color:#6d6358}}
.tag{{display:inline-block;margin-top:12px;padding:3px 10px;border:1px solid #e8e1d3;border-radius:999px;font-size:12px;color:#9a8f80}}
</style></head><body><div class="wrap"><img src="data:image/png;base64,{icon_b64}"><div><h1>Daily Memo</h1><p>날짜별로 정리되는<br>심플한 메모장</p><span class="tag">자동 저장 · 검색 · 형광펜</span></div></div></body></html>"""

# ---- CDP
v = json.load(urllib.request.urlopen('http://127.0.0.1:9333/json/version'))
ws = websocket.create_connection(v['webSocketDebuggerUrl'], suppress_origin=True)
n = [0]
def call(m, p=None, s=None):
    n[0] += 1; i = n[0]; msg = {'id': i, 'method': m, 'params': p or {}}
    if s: msg['sessionId'] = s
    ws.send(json.dumps(msg))
    while True:
        r = json.loads(ws.recv())
        if r.get('id') == i: return r

def capture(html, out, w, h):
    path = os.path.join(STORE, '_tmp.html')
    open(path, 'w', encoding='utf-8').write(html)
    url = 'file:///' + path.replace('\\', '/')
    tid = call('Target.createTarget', {'url': url})['result']['targetId']
    sid = call('Target.attachToTarget', {'targetId': tid, 'flatten': True})['result']['sessionId']
    call('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': False}, sid)
    time.sleep(1.6)
    data = call('Page.captureScreenshot', {'format': 'png', 'clip': {'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': 1}}, sid)['result']['data']
    open(os.path.join(STORE, out), 'wb').write(base64.b64decode(data))
    call('Target.closeTarget', {'targetId': tid})
    os.remove(path)
    print('saved', out)

for out, cap, sub, state in SHOTS:
    capture(frame_page(cap, sub, state), out, 1280, 800)
capture(PROMO, 'promo-small.png', 440, 280)
