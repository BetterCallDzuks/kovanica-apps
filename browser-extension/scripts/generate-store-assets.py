#!/usr/bin/env python3
"""
Generate reproducible Kovanica Wallet brand icons and Chrome Web Store / Firefox AMO
submission graphics using the official kovanica.online design system palette:
  - Background: #09090b (Dark Zinc)
  - Surface:    #121214 / #1a1a1e (Border: #2a2a30)
  - Accent:     #F2A900 (Kovanica Gold) + #2fbaa4 (Teal)
  - Foreground: #f2f1ee (Warm Ivory)
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ICONS = ROOT / "public" / "icons"
STORE_ICONS = ROOT / "store-assets" / "icons"
STORE_IMAGES = ROOT / "store-assets" / "images"

BG = (9, 9, 11, 255)            # #09090b
SURFACE = (18, 18, 20, 255)     # #121214
SURFACE_2 = (26, 26, 30, 255)   # #1a1a1e
BORDER = (42, 42, 48, 255)      # #2a2a30
GOLD = (242, 169, 0, 255)       # #F2A900
GOLD_DIM = (196, 138, 0, 255)   # #c48a00
GOLD_BG = (42, 32, 8, 255)
INK = (10, 10, 11, 255)         # #0a0a0b
WHITE = (242, 241, 238, 255)    # #f2f1ee
MUTED = (154, 154, 163, 255)    # #9a9aa3
GREEN = (47, 186, 164, 255)     # #2fbaa4 (Teal)
GREEN_BG = (14, 42, 38, 255)
BLUE = (138, 160, 180, 255)     # #8aa0b4

FONT_BOLD_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
FONT_MONO_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]


def load_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_kovanica_icon(size: int) -> Image.Image:
    """Render supersampled 4x antialiased Kovanica Wallet icon."""
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(s * 0.04)
    radius = int(s * 0.22)
    # Rounded obsidian base
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=radius, fill=BG)

    # Subtle gold outer border
    stroke = max(scale, int(s * 0.045))
    d.rounded_rectangle(
        [pad + stroke // 2, pad + stroke // 2, s - pad - stroke // 2, s - pad - stroke // 2],
        radius=max(1, radius - stroke // 2),
        outline=GOLD,
        width=stroke,
    )

    # Inner coin ring
    ring_pad = int(s * 0.16)
    ring_w = max(scale, int(s * 0.025))
    d.ellipse([ring_pad, ring_pad, s - ring_pad, s - ring_pad], outline=GOLD_DIM, width=ring_w)

    # Crisp geometric "K" monogram
    stem_x0 = int(s * 0.32)
    stem_x1 = int(s * 0.43)
    top_y = int(s * 0.25)
    bot_y = int(s * 0.75)
    mid_y = int(s * 0.50)

    # Vertical stem in ivory white
    d.rounded_rectangle([stem_x0, top_y, stem_x1, bot_y], radius=max(1, int(s * 0.02)), fill=WHITE)

    # Upper gold chevron arm
    d.polygon(
        [
            (int(s * 0.43), int(s * 0.50)),
            (int(s * 0.62), top_y),
            (int(s * 0.73), top_y),
            (int(s * 0.53), int(s * 0.50)),
        ],
        fill=GOLD,
    )
    # Lower gold chevron arm
    d.polygon(
        [
            (int(s * 0.43), int(s * 0.50)),
            (int(s * 0.53), int(s * 0.50)),
            (int(s * 0.73), bot_y),
            (int(s * 0.62), bot_y),
        ],
        fill=GOLD,
    )
    # Center accent diamond
    dia = int(s * 0.045)
    d.polygon(
        [
            (stem_x1 + int(s * 0.01), mid_y),
            (stem_x1 + int(s * 0.01) + dia, mid_y - dia),
            (stem_x1 + int(s * 0.01) + 2 * dia, mid_y),
            (stem_x1 + int(s * 0.01) + dia, mid_y + dia),
        ],
        fill=WHITE,
    )

    return img.resize((size, size), Image.Resampling.LANCZOS)


def write_icon_svg(path: Path) -> None:
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="5" y="5" width="118" height="118" rx="28" fill="#09090b" stroke="#F2A900" stroke-width="5"/>
  <circle cx="64" cy="64" r="43" fill="none" stroke="#c48a00" stroke-width="2.5"/>
  <rect x="41" y="32" width="14" height="64" rx="2.5" fill="#f2f1ee"/>
  <polygon points="55,64 79,32 93,32 68,64" fill="#F2A900"/>
  <polygon points="55,64 68,64 93,96 79,96" fill="#F2A900"/>
  <polygon points="56,64 62,58 68,64 62,70" fill="#f2f1ee"/>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def draw_pill(d: ImageDraw.ImageDraw, x: int, y: int, text: str, font, fill_bg, fill_border, fill_text) -> int:
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad_x, pad_y = 12, 6
    w = tw + pad_x * 2
    h = th + pad_y * 2
    d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=fill_bg, outline=fill_border, width=1)
    d.text((x + pad_x, y + pad_y - 1), text, font=font, fill=fill_text)
    return w


def generate_promo_small(path: Path) -> None:
    """Chrome Web Store Small Promo Tile: 440x280 RGB PNG (no alpha)."""
    w, h = 440, 280
    img = Image.new("RGBA", (w, h), BG)
    d = ImageDraw.Draw(img)

    # Subtle grid lines
    for gx in range(0, w, 40):
        d.line([(gx, 0), (gx, h)], fill=(26, 26, 30, 120), width=1)
    for gy in range(0, h, 40):
        d.line([(0, gy), (w, gy)], fill=(26, 26, 30, 120), width=1)

    # Top gold bar
    d.rectangle([0, 0, w, 5], fill=GOLD)

    # Icon
    icon = draw_kovanica_icon(76)
    img.alpha_composite(icon, (32, 46))

    # Text
    f_title = load_font(FONT_BOLD_CANDIDATES, 28)
    f_sub = load_font(FONT_BOLD_CANDIDATES, 14)
    f_body = load_font(FONT_REG_CANDIDATES, 13)
    f_pill = load_font(FONT_BOLD_CANDIDATES, 11)

    d.text((126, 52), "Kovanica Wallet", font=f_title, fill=WHITE)
    d.text((126, 88), "Self-Custodial KVNC Layer-1 Wallet", font=f_sub, fill=GOLD)
    d.text(
        (32, 144),
        "Encrypted local vault, strict PRO-21 addresses,\nPasskey unlock & window.kovanica dApp signing.",
        font=f_body,
        fill=MUTED,
        spacing=5,
    )

    px = 32
    py = 212
    for label in ["MV3", "PRO-21", "Passkey", "Wave A-C"]:
        pw = draw_pill(d, px, py, label, f_pill, GOLD_BG, GOLD_DIM, GOLD)
        px += pw + 8

    # Chrome Web Store prefers opaque PNGs for promo tiles
    img.convert("RGB").save(path, format="PNG", optimize=True)


def draw_backdrop(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (w, h), BG)
    d = ImageDraw.Draw(img)
    for gx in range(0, w, 48):
        d.line([(gx, 0), (gx, h)], fill=(26, 26, 30, 110), width=1)
    for gy in range(0, h, 48):
        d.line([(0, gy), (w, gy)], fill=(26, 26, 30, 110), width=1)
    d.rectangle([0, 0, w, 6], fill=GOLD)
    return img, d


def generate_screenshot_wallet(path: Path) -> None:
    """1280x800 Store Screenshot 1: Wallet Overview & Security."""
    w, h = 1280, 800
    img, d = draw_backdrop(w, h)

    icon_lg = draw_kovanica_icon(68)
    img.alpha_composite(icon_lg, (76, 86))

    f_h1 = load_font(FONT_BOLD_CANDIDATES, 42)
    f_sub = load_font(FONT_BOLD_CANDIDATES, 20)
    f_feat_t = load_font(FONT_BOLD_CANDIDATES, 18)
    f_feat_d = load_font(FONT_REG_CANDIDATES, 15)
    f_ui_title = load_font(FONT_BOLD_CANDIDATES, 17)
    f_ui_bold = load_font(FONT_BOLD_CANDIDATES, 14)
    f_ui_reg = load_font(FONT_REG_CANDIDATES, 13)
    f_ui_bal = load_font(FONT_BOLD_CANDIDATES, 32)
    f_mono = load_font(FONT_MONO_CANDIDATES, 12)
    f_pill = load_font(FONT_BOLD_CANDIDATES, 12)

    d.text((162, 86), "Kovanica Wallet", font=f_h1, fill=WHITE)
    d.text((164, 138), "Self-Custodial Browser Extension for KVNC L1", font=f_sub, fill=GOLD)

    features = [
        ("Zero-Plaintext Encrypted Vault", "PBKDF2-SHA256 (600,000+ iterations) + AES-256-GCM local encryption."),
        ("Strict PRO-21 Address Guard", "Canonical 64-char kvnc...dag / tknc...dag validation with BIP-44 coin type 3007."),
        ("Wave A-C Protocol Ready", "Atomic batch, gasless sponsored txs, Wave B fees, Passkey & Session Keys."),
        ("Zero Telemetry & Open Source", "No analytics, no remote code execution, direct RPC to Kovanica nodes."),
    ]
    fy = 224
    for title, desc in features:
        d.rounded_rectangle([76, fy, 640, fy + 104], radius=14, fill=SURFACE, outline=BORDER, width=1)
        d.ellipse([98, fy + 24, 112, fy + 38], fill=GOLD)
        d.text((126, fy + 18), title, font=f_feat_t, fill=WHITE)
        d.text((126, fy + 50), desc, font=f_feat_d, fill=MUTED)
        fy += 124

    # Right side: Realistic Popup Card (460 x 640)
    cx, cy, cw, ch = 730, 80, 460, 640
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=18, fill=SURFACE, outline=GOLD_DIM, width=2)

    # Header inside popup
    icon_sm = draw_kovanica_icon(30)
    img.alpha_composite(icon_sm, (cx + 22, cy + 20))
    d.text((cx + 62, cy + 25), "Kovanica Wallet", font=f_ui_title, fill=WHITE)
    draw_pill(d, cx + 286, cy + 22, "Mainnet (Chain 1)", f_pill, GREEN_BG, GREEN, GREEN)
    d.line([(cx + 20, cy + 66), (cx + cw - 20, cy + 66)], fill=BORDER, width=1)

    # Tabs
    tabs = ["Wallet", "Send", "Sessions", "Security"]
    tx = cx + 22
    tw = (cw - 44 - 24) // 4
    for idx, tab in enumerate(tabs):
        active = idx == 0
        d.rounded_rectangle(
            [tx, cy + 82, tx + tw, cy + 116],
            radius=8,
            fill=GOLD if active else SURFACE_2,
            outline=GOLD if active else BORDER,
            width=1,
        )
        d.text((tx + 22, cy + 91), tab, font=f_ui_bold, fill=BG if active else MUTED)
        tx += tw + 8

    # Account & Balance Card
    d.rounded_rectangle([cx + 22, cy + 134, cx + cw - 22, cy + 314], radius=12, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 40, cy + 150), "Account 1  (m/44'/3007'/0'/0'/0')", font=f_ui_reg, fill=MUTED)
    d.text((cx + 40, cy + 182), "1,250.4800 KVNC", font=f_ui_bal, fill=WHITE)
    draw_pill(d, cx + 40, cy + 232, "PRO-21 Verified", f_pill, GREEN_BG, GREEN, GREEN)
    draw_pill(d, cx + 178, cy + 232, "Passkey Armed", f_pill, GOLD_BG, GOLD_DIM, GOLD)
    d.text((cx + 40, cy + 276), "kvnc1q9x7m4p2v8n3k6r5t2w8y4z9c3b7f2h6j8m4p2v8n3k6r5t2w8dag", font=f_mono, fill=MUTED)

    # Wave B Fee Card
    d.rounded_rectangle([cx + 22, cy + 332, cx + cw - 22, cy + 448], radius=12, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 40, cy + 348), "Wave B Dynamic Fee & Live Head", font=f_ui_bold, fill=GOLD)
    d.text((cx + 40, cy + 378), "Base Fee / Byte:  1 atom    |   Est. Transfer: 0.0001 KVNC", font=f_ui_reg, fill=WHITE)
    d.text((cx + 40, cy + 406), "Storage Deposit Delta:  0 KVNC   |   Head Height: #482,910", font=f_ui_reg, fill=MUTED)

    # Action buttons
    d.rounded_rectangle([cx + 22, cy + 468, cx + 222, cy + 512], radius=10, fill=GOLD)
    d.text((cx + 82, cy + 482), "Send KVNC", font=f_ui_bold, fill=BG)
    d.rounded_rectangle([cx + 238, cy + 468, cx + cw - 22, cy + 512], radius=10, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 294, cy + 482), "Lock Vault", font=f_ui_bold, fill=WHITE)

    # Ecosystem footer
    d.line([(cx + 20, cy + 536), (cx + cw - 20, cy + 536)], fill=BORDER, width=1)
    d.text((cx + 22, cy + 550), "Kovanica Ecosystem", font=f_pill, fill=MUTED)
    links = ["kovanica.online", "Explorer", "Swap", "Pools", "RWA", "Docs"]
    lx = cx + 22
    ly = cy + 576
    for link in links:
        lw = draw_pill(d, lx, ly, link, f_pill, BG, BORDER, MUTED)
        lx += lw + 6
        if lx > cx + cw - 90:
            lx = cx + 22
            ly += 30

    img.convert("RGB").save(path, format="PNG", optimize=True)


def generate_screenshot_approval(path: Path) -> None:
    """1280x800 Store Screenshot 2: Isolated dApp Approval & Wave B Fee Preview."""
    w, h = 1280, 800
    img, d = draw_backdrop(w, h)

    icon_lg = draw_kovanica_icon(68)
    img.alpha_composite(icon_lg, (76, 86))

    f_h1 = load_font(FONT_BOLD_CANDIDATES, 40)
    f_sub = load_font(FONT_BOLD_CANDIDATES, 20)
    f_feat_t = load_font(FONT_BOLD_CANDIDATES, 18)
    f_feat_d = load_font(FONT_REG_CANDIDATES, 15)
    f_ui_title = load_font(FONT_BOLD_CANDIDATES, 18)
    f_ui_bold = load_font(FONT_BOLD_CANDIDATES, 14)
    f_ui_reg = load_font(FONT_REG_CANDIDATES, 13)
    f_mono = load_font(FONT_MONO_CANDIDATES, 12)
    f_pill = load_font(FONT_BOLD_CANDIDATES, 12)

    d.text((162, 86), "Transparent dApp Signing", font=f_h1, fill=WHITE)
    d.text((164, 138), "Isolated Approval Window with Wave B Fee Breakdown", font=f_sub, fill=GOLD)

    features = [
        ("window.kovanica MV3 Provider", "Injected via MAIN-world script + isolated content bridge with strict origin tagging."),
        ("Wave A Batch & Sponsored Support", "Review multi-action atomic batches and gasless fee-payer details before signing."),
        ("Wave B Fee & Deposit Preview", "Displays exact base fee per byte, total fee in KVNC, and refundable storage deposit."),
        ("Isolated Security UX", "Dedicated approval popup with zero external navigation links during signing."),
    ]
    fy = 224
    for title, desc in features:
        d.rounded_rectangle([76, fy, 640, fy + 104], radius=14, fill=SURFACE, outline=BORDER, width=1)
        d.ellipse([98, fy + 24, 112, fy + 38], fill=GOLD)
        d.text((126, fy + 18), title, font=f_feat_t, fill=WHITE)
        d.text((126, fy + 50), desc, font=f_feat_d, fill=MUTED)
        fy += 124

    # Right side: Realistic Approval Window (460 x 620)
    cx, cy, cw, ch = 730, 90, 460, 620
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=18, fill=SURFACE, outline=GOLD, width=2)

    icon_sm = draw_kovanica_icon(28)
    img.alpha_composite(icon_sm, (cx + 22, cy + 20))
    d.text((cx + 60, cy + 24), "Signature Request", font=f_ui_title, fill=WHITE)
    draw_pill(d, cx + 318, cy + 22, "Chain 1", f_pill, GOLD_BG, GOLD_DIM, GOLD)
    d.line([(cx + 20, cy + 64), (cx + cw - 20, cy + 64)], fill=BORDER, width=1)

    # Origin card
    d.rounded_rectangle([cx + 22, cy + 80, cx + cw - 22, cy + 150], radius=12, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 40, cy + 94), "Requesting Origin", font=f_pill, fill=MUTED)
    d.text((cx + 40, cy + 116), "https://testnet.kovanica.online", font=f_ui_bold, fill=WHITE)

    # Decoded Method Card
    d.rounded_rectangle([cx + 22, cy + 166, cx + cw - 22, cy + 356], radius=12, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 40, cy + 182), "Method: signBatchTransaction (2 actions)", font=f_ui_bold, fill=GOLD)
    draw_pill(d, cx + 40, cy + 212, "PRO-21 Recipient Valid", f_pill, GREEN_BG, GREEN, GREEN)
    d.text((cx + 40, cy + 252), "Action 1:  Transfer 25.0000 KVNC", font=f_ui_reg, fill=WHITE)
    d.text((cx + 40, cy + 276), "To: kvnc1q8m2...7r4k9dag", font=f_mono, fill=MUTED)
    d.text((cx + 40, cy + 306), "Action 2:  Contract Call -> swap()", font=f_ui_reg, fill=WHITE)
    d.text((cx + 40, cy + 330), "Gas Limit: 300,000", font=f_mono, fill=MUTED)

    # Wave B Fee Card
    d.rounded_rectangle([cx + 22, cy + 372, cx + cw - 22, cy + 506], radius=12, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 40, cy + 388), "Wave B Fee & Storage Estimate", font=f_ui_bold, fill=WHITE)
    rows = [
        ("Base Fee / Byte", "1 atom"),
        ("Estimated Network Fee", "0.00014 KVNC"),
        ("Refundable Storage Deposit", "0.00000 KVNC"),
    ]
    ry = cy + 418
    for k, v in rows:
        d.text((cx + 40, ry), k, font=f_ui_reg, fill=MUTED)
        d.text((cx + 300, ry), v, font=f_ui_bold, fill=WHITE)
        ry += 26

    # Reject / Approve Buttons
    d.rounded_rectangle([cx + 22, cy + 536, cx + 222, cy + 586], radius=10, fill=SURFACE_2, outline=BORDER, width=1)
    d.text((cx + 96, cy + 552), "Reject", font=f_ui_bold, fill=WHITE)
    d.rounded_rectangle([cx + 238, cy + 536, cx + cw - 22, cy + 586], radius=10, fill=GOLD)
    d.text((cx + 286, cy + 552), "Approve & Sign", font=f_ui_bold, fill=BG)

    img.convert("RGB").save(path, format="PNG", optimize=True)


def main() -> None:
    PUBLIC_ICONS.mkdir(parents=True, exist_ok=True)
    STORE_ICONS.mkdir(parents=True, exist_ok=True)
    STORE_IMAGES.mkdir(parents=True, exist_ok=True)

    write_icon_svg(STORE_IMAGES / "icon.svg")

    for size in (16, 32, 48, 128):
        icon = draw_kovanica_icon(size)
        icon.save(PUBLIC_ICONS / f"icon-{size}.png", format="PNG", optimize=True)
        icon.save(STORE_ICONS / f"icon-{size}.png", format="PNG", optimize=True)

    generate_promo_small(STORE_IMAGES / "promo-small-440x280.png")
    generate_screenshot_wallet(STORE_IMAGES / "screenshot-wallet-1280x800.png")
    generate_screenshot_approval(STORE_IMAGES / "screenshot-approval-1280x800.png")

    print("Generated all Kovanica Wallet icons and store graphics successfully.")


if __name__ == "__main__":
    main()
