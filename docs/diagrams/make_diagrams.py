"""Generates the spec diagrams as standalone SVG files. Usage: python3 make_diagrams.py <out_dir>"""
import sys, os

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

XC, OC = "#2348C8", "#CF5206"          # player colours
XT, OT = "#DFE6FB", "#FDE5CF"          # tints for legal squares
INK, MUTE, FAINT = "#2B2A27", "#6F6A62", "#A39D92"
PLATE, SQ, SQDIM, CELL, CELLDIM = "#DDD8CD", "#FFFFFF", "#ECE9E2", "#F3F1EC", "#E4E0D8"
FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"


def mark(kind, cx, cy, size, sw, opacity=1.0, color=None):
    col = color or (XC if kind == "X" else OC)
    if kind == "X":
        h = size / 2
        return (f'<g stroke="{col}" stroke-width="{sw:.1f}" stroke-linecap="round" opacity="{opacity}">'
                f'<line x1="{cx-h:.1f}" y1="{cy-h:.1f}" x2="{cx+h:.1f}" y2="{cy+h:.1f}"/>'
                f'<line x1="{cx+h:.1f}" y1="{cy-h:.1f}" x2="{cx-h:.1f}" y2="{cy+h:.1f}"/></g>')
    return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{size/2:.1f}" fill="none" stroke="{col}" '
            f'stroke-width="{sw:.1f}" opacity="{opacity}"/>')


def big_square(x, y, b, cells=None, won=None, state="normal", accent=XC, small_labels=False,
               big_label=None, last=None, emph=None, badge=None, dashed=None):
    """One big square with its nine small squares. cells: list of 9 (None/'X'/'O')."""
    cells = cells or [None] * 9
    out = []
    fill, stroke, sw = SQ, "#C9C4B9", 1.5
    if state == "legal":
        fill, stroke, sw = (XT if accent == XC else OT), accent, 4
    elif state == "dim":
        fill = SQDIM
    out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{b:.1f}" height="{b:.1f}" rx="{b*0.06:.1f}" '
               f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    pad, gap = b * 0.08, b * 0.035
    c = (b - 2 * pad - 2 * gap) / 3
    inner_op = 0.28 if won else (0.5 if (state == "dim" or big_label) else 1)
    out.append(f'<g opacity="{inner_op}">')
    for i in range(9):
        cx0 = x + pad + (i % 3) * (c + gap)
        cy0 = y + pad + (i // 3) * (c + gap)
        cfill = SQ if state == "legal" else (CELLDIM if state == "dim" else CELL)
        cstroke = ""
        if emph == i:
            cfill, cstroke = "#FFE9A8", ' stroke="#C98A00" stroke-width="2.5"'
        out.append(f'<rect x="{cx0:.1f}" y="{cy0:.1f}" width="{c:.1f}" height="{c:.1f}" rx="{c*0.14:.1f}" fill="{cfill}"{cstroke}/>')
        if cells[i]:
            out.append(mark(cells[i], cx0 + c / 2, cy0 + c / 2, c * 0.5, max(2, c * 0.13)))
        elif small_labels:
            col = INK if emph == i else FAINT
            wt = "700" if emph == i else "500"
            out.append(f'<text x="{cx0+c/2:.1f}" y="{cy0+c/2+c*0.16:.1f}" font-size="{c*0.46:.1f}" '
                       f'font-weight="{wt}" fill="{col}" text-anchor="middle">{i+1}</text>')
        if last == i:
            out.append(f'<rect x="{cx0+1.5:.1f}" y="{cy0+1.5:.1f}" width="{c-3:.1f}" height="{c-3:.1f}" '
                       f'rx="{c*0.14:.1f}" fill="none" stroke="{INK}" stroke-width="2" stroke-dasharray="1 0"/>')
    out.append('</g>')
    if won:
        out.append(mark(won, x + b / 2, y + b / 2, b * 0.56, b * 0.09))
    if big_label is not None:
        out.append(f'<text x="{x+b/2:.1f}" y="{y+b/2+b*0.17:.1f}" font-size="{b*0.5:.1f}" font-weight="700" '
                   f'fill="{INK}" text-anchor="middle">{big_label}</text>')
    if dashed:
        out.append(f'<rect x="{x-5:.1f}" y="{y-5:.1f}" width="{b+10:.1f}" height="{b+10:.1f}" rx="{b*0.08:.1f}" '
                   f'fill="none" stroke="{dashed}" stroke-width="2.5" stroke-dasharray="7 6"/>')
    if badge:
        w = len(badge) * 7.6 + 22
        out.append(f'<rect x="{x+b/2-w/2:.1f}" y="{y+b/2-15:.1f}" width="{w:.1f}" height="30" rx="15" fill="{INK}"/>'
                   f'<text x="{x+b/2:.1f}" y="{y+b/2+5:.1f}" font-size="14" font-weight="600" fill="#fff" text-anchor="middle">{badge}</text>')
    return "\n".join(out)


def board(x, y, S, marks=None, won=None, legal=None, accent=XC, big_labels=False, small_labels=False,
          last=None, emph=None, winline=None):
    """Whole board. marks: {(b,c): 'X'|'O'}, won: {b: 'X'|'O'}, legal: set of b (others dim)."""
    marks, won = marks or {}, won or {}
    G = S * 0.028
    b = (S - 2 * G) / 3
    out = [f'<rect x="{x-G:.1f}" y="{y-G:.1f}" width="{S+2*G:.1f}" height="{S+2*G:.1f}" rx="{S*0.035:.1f}" fill="{PLATE}"/>']
    centers = []
    for B in range(9):
        bx, by = x + (B % 3) * (b + G), y + (B // 3) * (b + G)
        centers.append((bx + b / 2, by + b / 2))
        cells = [marks.get((B, i)) for i in range(9)]
        state = "normal"
        if legal is not None:
            state = "legal" if B in legal else "dim"
        out.append(big_square(bx, by, b, cells, won.get(B), state, accent, small_labels,
                              (B + 1) if big_labels else None,
                              last[1] if last and last[0] == B else None,
                              emph[1] if emph and emph[0] == B else None))
    if winline:
        (x1, y1), (x2, y2) = centers[winline[0]], centers[winline[2]]
        col = XC if won[winline[0]] == "X" else OC
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" '
                   f'stroke-width="{S*0.022:.1f}" stroke-linecap="round" opacity="0.35"/>')
    return "\n".join(out), centers, b


def text(x, y, s, size=16, weight=400, fill=INK, anchor="middle"):
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{s}</text>'


def arrow(x1, y1, x2, y2, color=INK):
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2.5" '
            f'stroke-linecap="round" marker-end="url(#arr)"/>')


def save(name, w, h, body):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="{FONT}">\n'
           f'<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
           f'<path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker></defs>\n'
           f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="14" fill="#FBFAF7" stroke="#E2DED5" stroke-width="2"/>\n'
           + "\n".join(body) + "\n</svg>\n")
    with open(os.path.join(OUT, name), "w") as f:
        f.write(svg)


S = 360

# 1. Numbering -------------------------------------------------------------
body = [text(240, 44, "Big squares", 19, 700), text(720, 44, "Small squares", 19, 700)]
b1, _, _ = board(60, 70, S, big_labels=True)
b2, _, _ = board(540, 70, S, small_labels=True, emph=(3, 0))
body += [b1, b2,
         text(240, 472, "Numbered 1 to 9, row by row", 15, 400, MUTE),
         text(720, 472, "Same numbering inside every big square", 15, 400, MUTE),
         text(720, 496, "The marked square is 4-1 (big square 4, small square 1)", 15, 600, INK)]
save("01-numbering.svg", 960, 520, body)

# 2. Sending rule ----------------------------------------------------------
body = [text(240, 44, "1. X plays 4-1", 19, 700), text(720, 44, "2. O must play in big square 1", 19, 700)]
m = {(3, 0): "X"}
b1, _, _ = board(60, 70, S, marks=m, last=(3, 0))
b2, _, _ = board(540, 70, S, marks=m, last=(3, 0), legal={0}, accent=OC)
body += [b1, b2, arrow(446, 250, 510, 250),
         text(240, 472, "The small square number decides", 15, 400, MUTE),
         text(240, 494, "where the other player goes next", 15, 400, MUTE),
         text(720, 472, "Big square 1 is highlighted in O's colour.", 15, 400, MUTE),
         text(720, 494, "Every other big square is dimmed.", 15, 400, MUTE)]
save("02-sending-rule.svg", 960, 520, body)

# 3. Free move -------------------------------------------------------------
m = {(0, 0): "X", (0, 1): "X", (0, 2): "X", (0, 4): "O", (0, 6): "O", (3, 0): "X", (1, 0): "O", (2, 3): "O", (4, 0): "X"}
won = {0: "X"}
body = [text(480, 40, "X plays 4-1, but big square 1 is already won. O gets a free move.", 17, 600),
        text(240, 76, "Mode: Anywhere", 19, 700), text(720, 76, "Mode: Touching squares", 19, 700)]
b1, _, _ = board(60, 100, S, marks=m, won=won, last=(3, 0), legal={1, 2, 3, 4, 5, 6, 7, 8}, accent=OC)
b2, _, _ = board(540, 100, S, marks=m, won=won, last=(3, 0), legal={1, 3, 4}, accent=OC)
body += [b1, b2,
         text(240, 502, "O may play in any big square that is not won", 15, 400, MUTE),
         text(720, 502, "O may play only in 2, 4 or 5, the squares touching 1", 15, 400, MUTE),
         text(720, 524, "(if all of those are won too, O may play anywhere open)", 14, 400, MUTE)]
save("03-free-move.svg", 960, 548, body)

# 4. Ties, both settings ---------------------------------------------------
tie = ["X", "O", "X", "X", "O", "O", "O", "X", "X"]
body = [text(170, 150, "Big square is full,", 18, 700), text(170, 174, "nobody has a line", 18, 700),
        big_square(60, 196, 220, tie, last=8),
        text(700, 40, "Ties: Reset square", 18, 700),
        big_square(600, 56, 200, [None] * 9, badge="Tie, square reset"),
        text(700, 306, "Ties: Stays closed", 18, 700),
        big_square(600, 322, 200, tie, state="dim", badge="Tie"),
        arrow(300, 270, 575, 170), arrow(300, 340, 575, 420),
        text(440, 176, "wiped, stays in play", 14, 400, MUTE),
        text(440, 432, "kept, closed, nobody's", 14, 400, MUTE),
        text(480, 566, "Either way the move that caused the tie (here X at small square 9) still sends O to big square 9.", 15, 400, MUTE)]
save("04-tie-rules.svg", 960, 592, body)

# 5. Winning ---------------------------------------------------------------
won = {0: "X", 4: "X", 8: "X", 2: "O", 3: "O"}
m = {(0, 0): "X", (0, 4): "X", (0, 8): "X", (0, 1): "O", (0, 2): "O",
     (4, 2): "X", (4, 4): "X", (4, 6): "X", (4, 0): "O", (4, 8): "O",
     (8, 0): "X", (8, 1): "X", (8, 2): "X", (8, 4): "O", (8, 7): "O",
     (2, 0): "O", (2, 3): "O", (2, 6): "O", (2, 4): "X", (2, 8): "X",
     (3, 3): "O", (3, 4): "O", (3, 5): "O", (3, 0): "X", (3, 8): "X",
     (1, 4): "O", (1, 8): "X", (5, 0): "O", (5, 4): "X", (6, 4): "O", (6, 2): "X", (7, 4): "X", (7, 0): "O"}
b1, _, _ = board(60, 70, S, marks=m, won=won, winline=[0, 4, 8])
body = [text(240, 44, "X wins the game", 19, 700), b1,
        text(700, 150, "Winning a big square", 17, 700, INK),
        text(700, 178, "Three in a row inside it.", 15, 400, MUTE),
        text(700, 200, "It shows a large X or O and is closed.", 15, 400, MUTE),
        text(700, 256, "Winning the game", 17, 700, INK),
        text(700, 284, "Three won big squares in a row,", 15, 400, MUTE),
        text(700, 306, "across, down or diagonal.", 15, 400, MUTE),
        text(700, 362, "Draw", 17, 700, INK),
        text(700, 390, "All nine big squares are won", 15, 400, MUTE),
        text(700, 412, "and nobody has a line.", 15, 400, MUTE)]
save("05-winning.svg", 960, 470, body)

# 6. Screen layout ---------------------------------------------------------
def box(x, y, w, h, label, fill="#FFFFFF", size=14, weight=500, rx=8, stroke="#C9C4B9", ink=MUTE):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
            + (text(x + w / 2, y + h / 2 + size * 0.36, label, size, weight, ink) if label else ""))


def clock(x, y, w, h, who, time, active=False, warn=False, size=14):
    col = XC if who == "X" else OC
    fill = (XT if who == "X" else OT) if active else "#FFFFFF"
    stroke = "#B3261E" if warn else (col if active else "#C9C4B9")
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h*0.28:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{2.5 if active or warn else 1.5}"/>',
           mark(who, x + h * 0.5, y + h / 2, h * 0.34, max(2, h * 0.09), 1.0 if active else 0.55),
           text(x + w - h * 0.3, y + h / 2 + size * 0.36, time, size, 700, "#B3261E" if warn else (INK if active else MUTE), "end")]
    return "\n".join(out)


body = [text(330, 40, "Wide screen", 19, 700), text(800, 40, "Phone", 19, 700)]
body.append(f'<rect x="40" y="60" width="580" height="400" rx="12" fill="#F3F1EC" stroke="{INK}" stroke-width="2"/>')
body.append(text(60, 92, "Tic-Tac-Toe Expansion", 16, 700, INK, "start"))
bd, _, _ = board(66, 116, 310, legal={0}, accent=OC, marks={(3, 0): "X"}, last=(3, 0))
body.append(bd)
px = 410
body += [box(px, 108, 190, 40, "Status: O to move in big square 1", OT, 11, 600, 8, OC),
         clock(px, 156, 91, 32, "X", "4:52", size=13), clock(px + 99, 156, 91, 32, "O", "5:00", active=True, size=13),
         box(px, 198, 91, 30, "New game", size=12), box(px + 99, 198, 91, 30, "Undo", size=12),
         box(px, 238, 190, 84, "", size=12),
         text(px + 12, 258, "Players: two, or the computer", 11, 400, MUTE, "start"),
         text(px + 12, 278, "Rules: free move, ties", 11, 400, MUTE, "start"),
         text(px + 12, 298, "Clock: time and increment", 11, 400, MUTE, "start"),
         text(px + 12, 316, "Show numbers", 11, 400, MUTE, "start"),
         box(px, 332, 190, 62, "", size=12),
         text(px + 12, 353, "Moves", 12, 700, INK, "start"),
         text(px + 12, 376, "1. X 4-1", 12, 400, MUTE, "start"),
         box(px, 404, 190, 36, "How to play", size=12)]
fx = 700
body.append(f'<rect x="{fx}" y="60" width="200" height="400" rx="22" fill="#F3F1EC" stroke="{INK}" stroke-width="2"/>')
body.append(text(fx + 100, 86, "Tic-Tac-Toe Expansion", 12, 700, INK))
body.append(box(fx + 12, 96, 176, 26, "O to move in big square 1", OT, 10.5, 600, 8, OC))
body += [clock(fx + 12, 129, 84, 24, "X", "4:52", size=11), clock(fx + 104, 129, 84, 24, "O", "5:00", active=True, size=11)]
bd, _, _ = board(fx + 20, 166, 160, legal={0}, accent=OC, marks={(3, 0): "X"}, last=(3, 0))
body.append(bd)
body += [box(fx + 12, 340, 84, 26, "New game", size=10.5), box(fx + 104, 340, 84, 26, "Undo", size=10.5),
         box(fx + 12, 374, 176, 26, "Players, rules, clock", size=10),
         box(fx + 12, 408, 176, 26, "Numbers, moves, how to play", size=10)]
body += [text(330, 490, "Board on the left; status, clocks and controls in a side panel", 15, 400, MUTE),
         text(800, 490, "Status and clocks above the board", 15, 400, MUTE)]
save("06-screen-layout.svg", 960, 516, body)

# 7. Clock -----------------------------------------------------------------
body = [text(160, 44, "1. X is thinking", 18, 700), text(480, 44, "2. X plays", 18, 700), text(800, 44, "3. A clock reaches zero", 18, 700)]
for cx, (xt, xa, xw), (ot, oa, ow) in [(160, ("3:41", True, False), ("4:05", False, False)),
                                        (480, ("3:46", False, False), ("4:05", True, False)),
                                        (800, ("1:12", False, False), ("0:00", False, True))]:
    body += [clock(cx - 124, 70, 118, 46, "X", xt, xa, xw, 18), clock(cx + 6, 70, 118, 46, "O", ot, oa, ow, 18)]
body += [arrow(296, 93, 340, 93), arrow(616, 93, 660, 93),
         text(160, 150, "Only the player to move", 15, 400, MUTE), text(160, 172, "counts down.", 15, 400, MUTE),
         text(480, 150, "X's clock stops and gains the", 15, 400, MUTE), text(480, 172, "increment (here 5 seconds).", 15, 400, MUTE),
         text(480, 194, "O's clock starts by itself.", 15, 400, MUTE),
         text(800, 150, "O ran out of time.", 15, 400, MUTE), text(800, 172, "X wins the game.", 15, 400, MUTE)]
save("07-clock.svg", 960, 222, body)

print("wrote", sorted(os.listdir(OUT)))
