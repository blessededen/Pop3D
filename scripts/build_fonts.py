"""PDF용 한글 폰트 준비.

Windows에 설치된 Noto Sans KR(SIL OFL 1.1)을 PDF 임베딩용으로 가볍게 만든다.
- Regular: 가변 폰트(NotoSansKR-VF.ttf)를 wght=400으로 고정
- Bold: 정적 NotoSansKR-Bold.ttf
- 둘 다 한글 완성형 11,172자 + 라틴/기호만 남기고 서브셋
다른 PC에서는 --src 로 Noto Sans KR 폴더를 지정하면 된다.
"""
import argparse
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

RANGES = [
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x2000, 0x206F), (0x20A0, 0x20CF),
    (0x2100, 0x214F), (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2460, 0x24FF),
    (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x3000, 0x303F),
    (0x3130, 0x318F), (0xAC00, 0xD7A3), (0xFF01, 0xFF60),
]


def unicodes():
    for a, b in RANGES:
        yield from range(a, b + 1)


def make_subset(font: TTFont, out_path: str):
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=list(unicodes()))
    sub.subset(font)
    font.save(out_path)
    print(f"{out_path}: {os.path.getsize(out_path) / 1024:.0f} KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"C:\Windows\Fonts")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "fonts"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    vf = TTFont(os.path.join(args.src, "NotoSansKR-VF.ttf"))
    regular = instancer.instantiateVariableFont(vf, {"wght": 400})
    make_subset(regular, os.path.join(args.out, "NotoSansKR-Regular.ttf"))

    bold = TTFont(os.path.join(args.src, "NotoSansKR-Bold.ttf"))
    make_subset(bold, os.path.join(args.out, "NotoSansKR-Bold.ttf"))


if __name__ == "__main__":
    main()
