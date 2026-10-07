# 단색 아이콘 생성기: 검정 둥근 사각형 안에 흰색 메모 줄 3개
# 실행: python tools/make_icons.py  (프로젝트 루트에서)
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")


def png(w, h, pixels):
    raw = b"".join(b"\x00" + bytes(sum(pixels[y], ())) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def coverage(x, y, w, h, r, px, py, n=4):
    """픽셀 (px,py)가 둥근 사각형에 덮이는 비율 (안티앨리어싱)."""
    cov = 0
    for i in range(n):
        for j in range(n):
            sx = px + (i + 0.5) / n
            sy = py + (j + 0.5) / n
            if not (x <= sx <= x + w and y <= sy <= y + h):
                continue
            dx = max(x + r - sx, 0, sx - (x + w - r))
            dy = max(y + r - sy, 0, sy - (y + h - r))
            if dx * dx + dy * dy <= r * r:
                cov += 1
    return cov / (n * n)


def make(S):
    pad = S * 0.04
    bg = (59, 49, 39)   # 아이보리 톤에 맞춘 진한 갈색
    fg = (250, 247, 240)
    r = S * 0.22
    lw = S * 0.09
    xs, xe = S * 0.26, S * 0.74
    rows = [(S * 0.36, xe), (S * 0.50, xe), (S * 0.64, S * 0.58)]
    pixels = []
    for py in range(S):
        row = []
        for px in range(S):
            a = coverage(pad, pad, S - 2 * pad, S - 2 * pad, r, px, py)
            if a == 0:
                row.append((0, 0, 0, 0))
                continue
            la = 0
            for y0, xend in rows:
                la = max(la, coverage(xs, y0 - lw / 2, xend - xs, lw, lw / 2, px, py))
            c = tuple(round(bg[i] * (1 - la) + fg[i] * la) for i in range(3))
            row.append((c[0], c[1], c[2], round(255 * a)))
        pixels.append(row)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"icon{S}.png"), "wb") as f:
        f.write(png(S, S, pixels))


for s in (16, 48, 128):
    make(s)
print("icons generated")
