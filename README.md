# Daily Memo (커스터마이즈드 메모장 확장프로그램)
날짜별로 자동 정리되는 심플한 크롬 메모장 확장프로그램.
본인(박한수)가 메모장을 사용하는 방식에 맞춰 제작한 메모장 확장프로그램
- 저장 관리 간편성 ---- ( 저장 공간 관리 필요 없이 어디서나 크롬에서 메모 접근 가능 )  
- 심플한 기능 , 심플한 UI ---- ( 새로 배우지 않아도 되는 기능을 모토로 심플하게 기획) 
- 쉬운 접근성 ---- ( 크롬으로 언제나 쉬운 접근 ) 

사용하기 : https://chromewebstore.google.com/detail/kedcopdniobclbhkilmfocdapigdappd

## 기능
- 아이콘 클릭 또는 `Alt+Shift+M` → 오늘 날짜의 메모장이 바로 열림
- 입력하면 자동 저장 (팝업을 닫아도 저장)
- 헤더의 ‹ › 로 전날/다음날 이동 (`Alt+←` / `Alt+→`), "오늘로" 버튼
- 메모 목록은 최신순, 월별 그룹, 스크롤
- 검색: 본문 검색 + 하이라이트 + 발췌
- 서식: 글자를 드래그하면 버튼이 뜸 — 굵게(Ctrl+B), 형광펜 노랑/빨강/초록(노랑은 Ctrl+H), 크게/작게(Ctrl+] / Ctrl+[). 같은 색을 다시 누르면 해제
- 삭제: 편집 화면 하단 "삭제" → 3초 안에 다시 클릭
- 웹페이지에서 글을 드래그 → 우클릭 → "오늘 메모에 추가" (출처 URL 포함)
- 설정(목록 화면 톱니): 글자 크기, 구글 드라이브 동기화, 백업
  - 내보내기: 범위(전체/올해/이번 달/최근 30일/직접 선택) × 형식(JSON 복원용, 텍스트 읽기용), "저장한 뒤 지우기" 옵션(한 번 더 확인)
  - 가져오기: JSON, 같은 날짜는 더 최근 것을 남김
- 팝업 모서리(좌하/우하) 드래그로 크기 조절(320×300 ~ 800×600), 더블클릭으로 기본 크기(320×300) 복귀
- 아이보리 톤, 시스템 다크모드 자동 대응

## 설치 (개발자 모드)
1. `chrome://extensions` → 우측 상단 **개발자 모드** 켜기
2. **압축해제된 확장 프로그램을 로드합니다** → 이 폴더 선택
3. 코드 수정 후에는 확장 카드의 새로고침(↻) 버튼

## 스토어 등록
- 업로드 파일: `python tools/make_zip.py` → `store/daily-memo-<버전>.zip`
- 등록 문구·권한 근거: `store/listing.md`
- 이미지: `store/screenshot-1~4.png`(1280×800), `store/promo-small.png`(440×280) — `tools/make_store_assets.py` 로 재생성
- 개인정보처리방침: `store/privacy.html` 을 공개 URL(GitHub Pages 등)에 올려 주소를 등록
- 새 버전 올릴 때: manifest.json 의 version 올리고 zip 다시 생성. 변경 내용은 `CHANGELOG.md`

## 구조
```
manifest.json        확장 설정 (MV3; storage, contextMenus, unlimitedStorage, identity, alarms 권한)
background.js        우클릭 메뉴 "오늘 메모에 추가", 구글 드라이브 동기화
tools/make_zip.py    스토어 업로드용 zip 생성 (manifest 의 key 제외)
popup.html/css/js    메모장 UI 및 로직 (편집 / 목록·검색 / 설정)
_locales/            스토어 노출용 이름/설명 (ko, en)
icons/               아이콘 16/48/128
tools/make_icons.py  아이콘 재생성
tools/make_preview.py  popup.html → tools/preview.html (브라우저에서 바로 여는 미리보기, 샘플 30개)
```

## 데이터 형식
```json
{
  "memos":    { "2026-10-07": { "text": "...", "html": "<b>..</b> <mark class=\"y\">..</mark>", "updatedAt": 1759800000000 } },
  "settings": { "sync": false, "fontSize": "normal" },
  "popupSize": { "w": 800, "h": 600 }
}
```
`html`은 서식이 있을 때만 저장되며 허용 태그는 b, mark(y/r/g), span(lg/sm), div, br 뿐입니다. 검색과 미리보기는 `text`를 사용합니다.

동기화를 켜면 사용자 본인 구글 드라이브의 앱 전용 폴더(appDataFolder)에 `memos.json` 한 파일로 저장됩니다. 내용은 `{ memos, deleted }` 이고 `deleted` 는 `{ "YYYY-MM-DD": 삭제시각 }` 입니다. 같은 날짜는 메모의 `updatedAt` 과 삭제시각 중 큰 쪽이 이깁니다. 드라이브 통신은 background.js 가 맡고, 팝업은 저장 후 `{ type: "sync" }` 메시지만 보냅니다.

개발자 모드로 테스트하려면 확장 ID 가 OAuth 클라이언트에 등록된 ID 와 같아야 하므로 manifest.json 에 스토어의 공개 키(`key`)를 넣어 둡니다. 스토어 업로드 zip 은 `python tools/make_zip.py` 로 만들며 `key` 는 자동으로 빠집니다.
