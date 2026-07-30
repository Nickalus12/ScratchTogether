"""Build the Squiggle demo video: brand card -> real two-cursor capture -> logo card.

The middle section is genuine footage. Two signed-in browsers drive the editor
while a third sits in the same room and records what it receives -- so both
cursors in the video are real remote cursors rendered by the collab overlay,
not drawn on afterwards.

    python make_demo.py login     # one-time, headed: you sign each profile in
    python make_demo.py record    # drive + capture the room
    python make_demo.py cards     # render intro/outro from brand.html
    python make_demo.py build     # stitch to out/squiggle-demo.mp4
    python make_demo.py all       # cards + record + build

Login is manual on purpose: credentials go into the browser by your hand and
live only in the profile dirs under .profiles/ (gitignored).
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
PROFILES = HERE / ".profiles"
OUT = HERE / "out"
FRAMES = HERE / "frames"

SITE = "https://squigglegames.app"
ROOM = "demo"
W, H = 1280, 720
FPS = 30

# driver-a and driver-b move the mice; spectator only watches and records.
ROLES = ("driver-a", "driver-b", "spectator")

INTRO_S, OUTRO_S = 3.0, 4.0

# The Blockly workspace viewport, in page coords. Every cursor waypoint has to
# stay inside it: cursor position is only broadcast from mousemove on the
# workspace SVG, so a cursor over the stage or palette transmits nothing.
WS = {"x0": 330, "y0": 105, "x1": 775, "y1": 665}

# What the two of them build. Selected by category + a regex over the block's
# rendered text, so this survives palette reordering between TurboWarp versions.
SCRIPT_A = [
    ("Events", r"when .*clicked"),
    ("Motion", r"^move .* steps"),
    ("Motion", r"^turn .* degrees"),
    ("Looks", r"^say .* for .* seconds"),
]
SCRIPT_B = [
    ("Events", r"when .* key pressed"),
    ("Looks", r"^change color effect by"),
    ("Looks", r"^next costume"),
    ("Sound", r"^start sound|^play sound"),
]
ANCHOR_A = (385, 150)
ANCHOR_B = (385, 420)


def ffmpeg(*args: str) -> None:
    exe = shutil.which("ffmpeg")
    if not exe:
        sys.exit("ffmpeg not on PATH")
    subprocess.run([exe, "-y", "-loglevel", "error", *args], check=True)


# ---------------------------------------------------------------- login ---

def cmd_login(args) -> None:
    """Open each profile headed so the human can sign in. Cookies persist."""
    with sync_playwright() as p:
        for role in ROLES:
            d = PROFILES / role
            d.mkdir(parents=True, exist_ok=True)
            ctx = p.chromium.launch_persistent_context(
                str(d), headless=False, viewport={"width": W, "height": H},
                args=["--force-device-scale-factor=1"])
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(f"{SITE}/", wait_until="domcontentloaded")
            print(f"\n[{role}] Sign in with the account for this role, then press Enter here.")
            input("  ...waiting: ")
            ctx.close()
    print("\nAll profiles stored under .profiles/ -- rerun 'record' any time.")


# ----------------------------------------------------------- page setup ---

def open_room(p, role: str, record: bool, headed: bool = False):
    """Headless by default, and that is load-bearing rather than a speed choice.

    Cursors are only broadcast from mousemove on the Blockly SVG, and both the
    send path and the housekeeping sweep bail out on document.hidden. Three
    headed windows stack at the same screen position, so the occluded ones go
    hidden and clear their own cursor -- the room looks empty. Headless pages
    are never occluded, and they don't get background-throttled either, which
    is what was silently breaking the block drags.
    """
    d = PROFILES / role
    if not d.exists():
        sys.exit(f"profile {role} missing -- run 'make_demo.py login' first")
    kwargs = dict(headless=not headed, viewport={"width": W, "height": H},
                  args=["--force-device-scale-factor=1", "--hide-scrollbars"])
    if record:
        kwargs["record_video_dir"] = str(OUT / "raw")
        kwargs["record_video_size"] = {"width": W, "height": H}
    ctx = p.chromium.launch_persistent_context(str(d), **kwargs)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(f"{SITE}/r/{ROOM}", wait_until="domcontentloaded")
    return ctx, page


def wait_for_editor(page, timeout=90_000) -> None:
    """The workspace is the last thing to mount, so it is the readiness signal."""
    page.wait_for_selector(".blocklySvg, .blocklyWorkspace", timeout=timeout)
    if "/?next=" in page.url:
        sys.exit(f"{page.url} -- that profile is signed out; rerun 'login'")
    page.wait_for_timeout(2500)


# ------------------------------------------------------------- movement ---

def _ease(t):
    return 1 - (1 - t) ** 3


def glide(page, x0, y0, x1, y1, steps=40, hold=0.014):
    """Move in many small hops -- the overlay broadcasts on mousemove, so a
    single jump teleports the remote cursor instead of animating it."""
    for i in range(1, steps + 1):
        e = _ease(i / steps)
        page.mouse.move(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e)
        time.sleep(hold)


def glide_pair(pa, a0, a1, pb, b0, b1, steps=44, hold=0.014):
    """Advance both cursors one step at a time so they travel simultaneously."""
    for i in range(1, steps + 1):
        e = _ease(i / steps)
        pa.mouse.move(a0[0] + (a1[0] - a0[0]) * e, a0[1] + (a1[1] - a0[1]) * e)
        pb.mouse.move(b0[0] + (b1[0] - b0[0]) * e, b0[1] + (b1[1] - b0[1]) * e)
        time.sleep(hold)


# -------------------------------------------------------- palette + DOM ---

_FIND_FLYOUT = """
([pat]) => {
    const re = new RegExp(pat, 'i');
    for (const el of document.querySelectorAll('.blocklyFlyout .blocklyDraggable')) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (re.test(t)) {
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            return {x: r.x, y: r.y, w: r.width, h: r.height, text: t};
        }
    }
    return null;
}"""

# Top-level stacks only -- a stack is one draggable group, so its rect grows as
# blocks are added and its bottom edge is where the next block belongs.
_NEAREST_STACK = """
([x, y]) => {
    let best = null, bd = Infinity;
    for (const el of document.querySelectorAll('.blocklyBlockCanvas > .blocklyDraggable')) {
        const r = el.getBoundingClientRect();
        if (r.width < 8) continue;
        const d = (r.x + r.width / 2 - x) ** 2 + (r.y + r.height / 2 - y) ** 2;
        if (d < bd) { bd = d; best = {x: r.x, y: r.y, w: r.width, h: r.height}; }
    }
    return best;
}"""

# Real connectivity, straight from Blockly -- proves the blocks snapped into
# stacks rather than landing as four loose blocks that merely look adjacent.
_STACK_REPORT = """
() => {
    const ws = window.Blockly && window.Blockly.getMainWorkspace
        && window.Blockly.getMainWorkspace();
    if (!ws) return null;
    return ws.getTopBlocks(false).map(b => {
        let n = 1, c = b;
        while (c.getNextBlock && c.getNextBlock()) { c = c.getNextBlock(); n++; }
        return {type: b.type, len: n};
    }).sort((p, q) => q.len - p.len);
}"""


def select_category(page, name: str) -> None:
    ok = page.evaluate("""
        ([n]) => {
            for (const el of document.querySelectorAll('.scratchCategoryMenuItem')) {
                if ((el.textContent || '').trim().toLowerCase() === n.toLowerCase()) {
                    el.click();
                    return true;
                }
            }
            return false;
        }""", [name])
    if not ok:
        print(f"    ! category {name} not found")
    page.wait_for_timeout(750)


def find_in_flyout(page, pattern: str, tries: int = 6):
    """Locate a palette block, scrolling the flyout when it sits off-screen."""
    for _ in range(tries):
        hit = page.evaluate(_FIND_FLYOUT, [pattern])
        if hit and 70 < hit["y"] < H - 90:
            return hit
        # Wheel over the flyout; Blockly scrolls its own canvas.
        page.mouse.move(190, 400)
        page.mouse.wheel(0, 260 if (not hit or hit["y"] >= H - 90) else -260)
        page.wait_for_timeout(280)
    return page.evaluate(_FIND_FLYOUT, [pattern])


def drag_to(page, src, tx, ty, settle=0.45):
    """Drag a block so its TOP-LEFT lands at (tx,ty).

    Blockly translates the block by the mouse delta, and the grab lands at the
    block's centre, so the drop point has to carry that half-size offset.
    """
    cx, cy = src["x"] + src["w"] / 2, src["y"] + src["h"] / 2
    glide(page, cx, cy, cx, cy, steps=2, hold=0.05)     # settle before grabbing
    page.mouse.move(cx, cy)
    page.mouse.down()
    glide(page, cx, cy, tx + src["w"] / 2, ty + src["h"] / 2, steps=34, hold=0.016)
    page.mouse.up()
    time.sleep(settle)


def place_block(page, category: str, pattern: str, anchor, first: bool):
    """Drop one block, snapping it under the stack already at `anchor`."""
    select_category(page, category)
    src = find_in_flyout(page, pattern)
    if not src:
        print(f"    ! no palette block matching /{pattern}/ in {category}")
        return False
    if first:
        tx, ty = anchor
    else:
        stack = page.evaluate(_NEAREST_STACK, list(anchor))
        if not stack:
            tx, ty = anchor
        else:
            # Sit the new block on the stack's bottom edge; Blockly's snap
            # radius closes the last few pixels and makes the connection.
            tx, ty = stack["x"], stack["y"] + stack["h"] - 4
    tx = max(WS["x0"] + 10, min(tx, WS["x1"] - src["w"] - 10))
    ty = max(WS["y0"] + 10, min(ty, WS["y1"] - src["h"] - 10))
    drag_to(page, src, tx, ty)
    return True


def build_script(page, script, anchor, label: str):
    for i, (cat, pat) in enumerate(script):
        placed = place_block(page, cat, pat, anchor, first=(i == 0))
        print(f"    {label} {i + 1}/{len(script)} {cat}:/{pat}/ {'ok' if placed else 'MISS'}")


# --------------------------------------------------------------- record ---

def peers_visible(page) -> int:
    """Remote cursor sprites the spectator is actually rendering right now."""
    return page.evaluate("() => document.querySelectorAll('[data-peer]').length")


def cmd_record(args) -> None:
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    for f in (OUT / "raw").glob("*.webm"):
        f.unlink()

    with sync_playwright() as p:
        spec_ctx, spec = open_room(p, "spectator", record=True, headed=args.headed)
        a_ctx, a = open_room(p, "driver-a", record=False, headed=args.headed)
        b_ctx, b = open_room(p, "driver-b", record=False, headed=args.headed)

        for name, pg in (("spectator", spec), ("driver-a", a), ("driver-b", b)):
            print(f"  waiting for {name} ...")
            wait_for_editor(pg)

        print("  recording ...")
        time.sleep(1.5)

        # Open on both cursors arriving at once, so the first frames already
        # say "two people are in here" before anything is built.
        glide_pair(a, (360, 620), ANCHOR_A, b, (740, 160), ANCHOR_B, steps=52)
        time.sleep(0.7)
        print(f"    cursors on screen: {peers_visible(spec)}")

        # They alternate block for block. A parked cursor keeps rendering, so
        # both stay on screen the whole time while each takes a turn.
        for i in range(max(len(SCRIPT_A), len(SCRIPT_B))):
            if i < len(SCRIPT_A):
                cat, pat = SCRIPT_A[i]
                print(f"    A {i + 1} {cat}:/{pat}/",
                      "ok" if place_block(a, cat, pat, ANCHOR_A, first=(i == 0)) else "MISS")
            if i < len(SCRIPT_B):
                cat, pat = SCRIPT_B[i]
                print(f"    B {i + 1} {cat}:/{pat}/",
                      "ok" if place_block(b, cat, pat, ANCHOR_B, first=(i == 0)) else "MISS")

        # Let the finished scripts sit on screen, then a last shared flourish.
        time.sleep(1.2)
        glide_pair(a, ANCHOR_A, (560, 250), b, ANCHOR_B, (600, 560), steps=34)
        time.sleep(2.2)

        cursors = peers_visible(spec)
        stacks = spec.evaluate(_STACK_REPORT)
        for ctx in (a_ctx, b_ctx):
            ctx.close()
        spec_ctx.close()   # video is flushed on close

    vids = sorted((OUT / "raw").glob("*.webm"))
    if not vids:
        sys.exit("no video produced")
    ffmpeg("-i", str(vids[0]), "-vf", f"scale={W}:{H},fps={FPS}",
           "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(OUT / "footage.mp4"))

    print(f"  cursors rendered: {cursors} (want 2)")
    if stacks is None:
        print("  stacks: window.Blockly unavailable -- could not verify connectivity")
    else:
        print(f"  stacks built:     {[(s['type'], s['len']) for s in stacks[:4]]}")
        if sum(1 for s in stacks if s["len"] >= 3) < 2:
            print("  ! expected two stacks of 3+ blocks -- rerun with --headed to watch")
    if cursors < 2:
        print("  ! fewer than two cursors reached the recording")
    print(f"  -> {OUT / 'footage.mp4'}")


# ---------------------------------------------------------------- cards ---

def render_card(page, scene: str, seconds: float) -> Path:
    d = FRAMES / scene
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    for i in range(int(seconds * FPS)):
        page.evaluate("([s, t]) => window.frame(s, t)", [scene, i / FPS])
        page.screenshot(path=str(d / f"{i:04d}.png"))
    ffmpeg("-framerate", str(FPS), "-i", str(d / "%04d.png"),
           "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(OUT / f"{scene}.mp4"))
    return OUT / f"{scene}.mp4"


def cmd_cards(args) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        page.goto((HERE / "brand.html").as_uri(), wait_until="load")
        page.wait_for_function("window.ready !== undefined")
        page.evaluate("window.ready")          # logo decoded before any screenshot
        for scene, secs in (("intro", INTRO_S), ("outro", OUTRO_S)):
            print(f"  rendering {scene} ...")
            print(f"  -> {render_card(page, scene, secs)}")
        b.close()


# ---------------------------------------------------------------- build ---

def cmd_build(args) -> None:
    parts = [OUT / "intro.mp4", OUT / "footage.mp4", OUT / "outro.mp4"]
    missing = [p.name for p in parts if not p.exists()]
    if missing:
        sys.exit(f"missing {', '.join(missing)} -- run 'cards' and 'record' first")
    listing = OUT / "concat.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing),
           "-c:v", "libx264", "-crf", "20", "-preset", "slow",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUT / "squiggle-demo.mp4"))
    print(f"  -> {OUT / 'squiggle-demo.mp4'}")


def cmd_gif(args) -> None:
    """Two-pass palette GIF. A global 256-colour palette bands the block
    gradients badly, so the palette is generated from these frames only."""
    src = OUT / ("squiggle-demo.mp4" if args.source == "demo" else "footage.mp4")
    if not src.exists():
        sys.exit(f"missing {src.name} -- run 'record' first")
    pal, dst = OUT / "palette.png", OUT / "squiggle-demo.gif"
    vf = f"fps={args.gif_fps},scale={args.gif_width}:-1:flags=lanczos"
    clip = ["-ss", str(args.start), "-t", str(args.dur), "-i", str(src)]

    ffmpeg(*clip, "-vf", f"{vf},palettegen=stats_mode=diff", str(pal))
    ffmpeg(*clip, "-i", str(pal), "-lavfi",
           f"{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
           "-loop", "0", str(dst))

    mb = dst.stat().st_size / 1e6
    print(f"  -> {dst}  ({mb:.1f} MB, {args.dur}s @ {args.gif_fps}fps, {args.gif_width}px wide)")
    if mb > 8:
        print("  ! heavy for a Reddit upload -- drop --dur or --gif-width")


def main() -> None:
    global ROOM
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["login", "record", "cards", "build", "gif", "all"])
    ap.add_argument("--room", default=ROOM)
    ap.add_argument("--headed", action="store_true",
                    help="watch the drivers (cursors may self-clear when windows overlap)")
    ap.add_argument("--source", choices=["footage", "demo"], default="footage",
                    help="gif from the raw capture, or from the carded video")
    ap.add_argument("--start", type=float, default=0.0, help="gif start, seconds")
    ap.add_argument("--dur", type=float, default=10.0, help="gif length, seconds")
    ap.add_argument("--gif-width", type=int, default=800)
    ap.add_argument("--gif-fps", type=int, default=15)
    args = ap.parse_args()
    ROOM = args.room

    steps = ["cards", "record", "build", "gif"] if args.step == "all" else [args.step]
    for s in steps:
        print(f"[{s}]")
        {"login": cmd_login, "record": cmd_record, "cards": cmd_cards,
         "build": cmd_build, "gif": cmd_gif}[s](args)


if __name__ == "__main__":
    main()
