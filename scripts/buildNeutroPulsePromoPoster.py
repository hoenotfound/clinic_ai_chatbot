#!/usr/bin/env python3
"""Build Neutro Sense Pulse Wave first-trial promotional artwork.
This generates a static JPEG with reviewed, non-diagnostic wording.
No clinic credentials or customer data are needed.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1080, 1350
OUT = Path(__file__).resolve().parents[1] / "portal-frontend/public/neutro-pulse-safe-20261123.jpg"
IVORY = "#FAF6EF"
MAROON = "#742F28"
DEEP = "#43201D"
GOLD = "#B68C4F"
MUTED = "#7B665C"
WHITE = "#FFFFFF"


def font(size, bold=False):
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise RuntimeError("Noto CJK fonts missing. Install fonts-noto-cjk before generating the poster.")


def centered(draw, text, y, f, fill):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    draw.text(((WIDTH - (right-left)) / 2, y), text, font=f, fill=fill)


def main():
    im = Image.new("RGB", (WIDTH, HEIGHT), IVORY)
    d = ImageDraw.Draw(im)
    # Warm minimal framing without imported brand artwork or unverified device photo.
    d.rounded_rectangle((48, 42, WIDTH-48, HEIGHT-44), radius=44, outline="#D8C4A7", width=3)
    d.line((160, 120, 350, 120), fill=GOLD, width=3)
    d.line((730, 120, 920, 120), fill=GOLD, width=3)
    centered(d, "NEUTRO SENSE", 78, font(40, True), DEEP)
    centered(d, "脉冲波调理", 171, font(94, True), MAROON)
    centered(d, "结合中医调理理念与现代脉冲设备辅助护理", 305, font(35), DEEP)

    # Three benefits are consultation directions, not treatment outcome promises.
    benefits = [
        ("身体线条管理", "腹部／腰部／臀腿"),
        ("肌肉紧绷舒缓", "放松与日常护理"),
        ("产后身体护理", "由中医师评估适合度"),
    ]
    card_width = 302
    for index, (head, desc) in enumerate(benefits):
        x = 66 + index * 323
        d.rounded_rectangle((x, 404, x+card_width, 594), radius=22, fill="#F0E4D4", outline="#D6C19E", width=3)
        d.rounded_rectangle((x+99, 420, x+202, 430), radius=5, fill=GOLD)
        bbox = d.textbbox((0,0),head,font=font(36,True))
        d.text((x+(card_width-(bbox[2]-bbox[0]))/2,466),head,font=font(36,True),fill=DEEP)
        bbox = d.textbbox((0,0),desc,font=font(25))
        d.text((x+(card_width-(bbox[2]-bbox[0]))/2,529),desc,font=font(25),fill=MUTED)

    centered(d, "也可咨询日常经络养生及身体护理需求", 637, font(30), MUTED)
    d.rounded_rectangle((98, 720, WIDTH-98, 1020), radius=38, fill=MAROON)
    centered(d, "首次体验", 746, font(48, True), WHITE)
    centered(d, "RM388", 800, font(137, True), WHITE)
    centered(d, "原价 RM688", 957, font(34), "#F4E3C5")
    d.line((423, 978, 660, 978), fill="#D5B68A", width=4)

    d.rounded_rectangle((108, 1052, WIDTH-108, 1146), radius=24, fill="#F1E2CB", outline=GOLD, width=2)
    centered(d, "线上预约赠送 · 艾灸桶护理", 1074, font(43, True), MAROON)
    centered(d, "整套预约约 2 小时 15 分钟（已包含赠送护理）", 1173, font(30, True), DEEP)
    centered(d, "实际体验因人而异，是否适合需由中医师评估", 1256, font(26), MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT, "JPEG", quality=89, optimize=True, subsampling=0)
    print(f"Generated {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
