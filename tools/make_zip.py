# 스토어 업로드용 zip 생성: python tools/make_zip.py → store/daily-memo-<version>.zip
# manifest.json 의 key(개발용 ID 고정) 는 빼고 넣음
import json, os, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['background.js', 'popup.html', 'popup.css', 'popup.js']
DIRS = ['icons', '_locales']

manifest = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
manifest.pop('key', None)
out = os.path.join(ROOT, 'store', f"daily-memo-{manifest['version']}.zip")

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    for f in FILES:
        z.write(os.path.join(ROOT, f), f)
    for d in DIRS:
        for r, _, fs in os.walk(os.path.join(ROOT, d)):
            for f in fs:
                p = os.path.join(r, f)
                z.write(p, os.path.relpath(p, ROOT).replace(os.sep, '/'))
print(out)
