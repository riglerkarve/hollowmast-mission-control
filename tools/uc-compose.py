"""Render each UC statement to ONE composite PNG holding only the pages that carry data.

Pages 4-6 are "Help and support" boilerplate — verified by reading them — and page 1's top
quarter is a cookie banner. So this stitches the useful bands of pages 1-3 onto a single
canvas: one image per statement instead of six, which is what makes reading 62 of them
feasible.

It CROPS BY FRACTION OF PAGE HEIGHT, not by hunting for landmarks, and the fractions are
deliberately generous — an over-wide crop costs a little whitespace, while a tight one could
silently cut off the very figure being read. Page 3 in particular holds the totals right at
the top and is otherwise empty.

Usage:  uc-compose.py <out-dir> <scale> <pdf> [pdf ...]
"""
import sys, os
import pymupdf

OUT = sys.argv[1]
SCALE = float(sys.argv[2])
PATHS = sys.argv[3:]
os.makedirs(OUT, exist_ok=True)

# (page index, top fraction, bottom fraction) of each band worth keeping.
#
# The page-3 band was 0.30 and that was TOO TIGHT — caught on the May 2024 statement, whose
# longer deduction list (advance, two recoveries, child maintenance) pushed "Your total
# payment for this month is" onto page 3 below the cut. The composite ended at "Total
# deductions" and the payment figure was simply absent, with nothing to say it had been
# dropped. A crop that truncates silently is a filter that does not report its residue, and
# the temptation it creates is worse than the omission: the total is derivable by arithmetic,
# so it would have been easy to write down a number the statement was never read for.
#
# 0.55 clears the longest deduction list seen across 62 statements. The cost of being too
# generous is whitespace; the cost of being too tight is a missing figure.
BANDS = [
    (0, 0.33, 1.00),   # page 1: skip the cookie banner, keep name/period/paid/entitlement
    (1, 0.00, 1.00),   # page 2: entitlement rows, total before deductions, deductions
    (2, 0.00, 0.55),   # page 3: landlord payment, total deductions, TOTAL PAYMENT
]

for path in PATHS:
    src = pymupdf.open(path)
    if len(src) < 3:
        print(f"SKIP {os.path.basename(path)} — only {len(src)} page(s)")
        src.close()
        continue

    rects = []
    for idx, top, bot in BANDS:
        r = src[idx].rect
        rects.append((idx, pymupdf.Rect(r.x0, r.y0 + r.height * top, r.x1, r.y0 + r.height * bot)))

    width = max(r.width for _, r in rects)
    height = sum(r.height for _, r in rects)

    out = pymupdf.open()
    page = out.new_page(width=width, height=height)
    y = 0.0
    for idx, clip in rects:
        target = pymupdf.Rect(0, y, clip.width, y + clip.height)
        page.show_pdf_page(target, src, idx, clip=clip)
        y += clip.height

    stem = os.path.splitext(os.path.basename(path))[0].replace(' ', '_')
    dest = os.path.join(OUT, f"{stem}.png")
    page.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE)).save(dest)
    print(f"{os.path.basename(dest):<24} {os.path.getsize(dest)//1024:>5}KB")
    out.close()
    src.close()
