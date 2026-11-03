"""
The PDF corpus in src/fixtures/pdf/: small files from real PDF producers, each
picked for a feature a PDF reader must handle (object streams, embedded subset
fonts, CropBox, /Rotate, incremental updates, image-only pages ...).

    uv run --with reportlab --with fpdf2 --with pypdf --with pikepdf \
      --with pymupdf python scripts/generate-pdf-corpus.py

Output is deterministic: fixed seeds, fixed dates and IDs. fpdf2-unicode.pdf
embeds DejaVu Sans from /usr/share/fonts. Chrome PDFs are made only when
google-chrome or chromium is on PATH (their dates and IDs are overwritten in
place, so the byte offsets stay valid).
"""

import datetime
import io
import os
import random
import re
import shutil
import subprocess
import tempfile
import zlib
from pathlib import Path

import fpdf
import pikepdf
import pymupdf
import pypdf
from PIL import Image, ImageDraw
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import A4, landscape, letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    SimpleDocTemplate,
    Table,
    TableStyle,
)

OUT = Path(__file__).resolve().parent.parent / "src" / "fixtures" / "pdf"
DATE = datetime.datetime(2026, 11, 3, tzinfo=datetime.timezone.utc)
DEJAVU = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")

SENTENCES = [
    "The river town woke slowly, and the baker opened his shutters before the first cart rolled over the bridge.",
    "Most visitors came for the market, but a few stayed for the quiet streets and the long view of the hills.",
    "In the afternoon the light turned gold, and the old clock in the square ran four minutes late, as it always had.",
    "Engineers measured the water level every morning and wrote the numbers in a book that nobody else read.",
    "When the rain finally arrived, it fell for three days without a pause, and the fields became small lakes.",
    "Children walked to school along the canal, counting boats and arguing about which one was the fastest.",
    "The library kept its doors open until nine, which made it the warmest place in town during the winter.",
    "A new road was planned for the spring, although the council had promised the same thing for eleven years.",
    "Every Friday the musicians gathered near the fountain and played songs that their grandparents had taught them.",
    "By evening the market stalls were gone, and only the smell of bread and oranges remained in the square.",
    "Some people said the town had not changed in a century, while others insisted that everything was different now.",
    "The station master checked his watch twice, nodded at the driver, and the last train of the day pulled away.",
]

ACCENTS = [
    "Le café était fermé, mais la pâtisserie à côté vendait encore des crêpes et des éclairs.",
    "Die Brücke über den Fluss wurde im Frühjahr repariert, und die Straßen waren voller Menschen.",
    "El niño comió una manzana mientras su abuela leía el periódico en el jardín.",
    "Ação, coração e informação são palavras comuns em português; não é difícil.",
    "Åsa och Örjan åkte till Göteborg för att se på hamnen och äta räksmörgås.",
]
CYRILLIC_GREEK = [
    "Москва — столица России, и в ней живёт больше двенадцати миллионов человек.",
    "Киев и Минск тоже большие города со старыми улицами и широкими площадями.",
    "Η Αθήνα είναι η πρωτεύουσα της Ελλάδας και μια από τις αρχαιότερες πόλεις του κόσμου.",
]
CJK = [
    "东京是日本的首都，也是世界上人口最多的城市之一。",
    "今日は天気がとても良いので、公園を散歩しました。",
    "北京的秋天很美，很多人去长城和故宫参观。",
    "서울은 한국의 수도이며 많은 사람들이 살고 있습니다.",
]

CODE = '''def merge_sorted(left: list[int], right: list[int]) -> list[int]:
    """Merge two sorted lists into one sorted list."""
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result


class Counter:
    def __init__(self, start: int = 0) -> None:
        self.value = start

    def increment(self, step: int = 1) -> int:
        self.value += step
        return self.value


if __name__ == "__main__":
    print(merge_sorted([1, 4, 9], [2, 3, 10]))  # [1, 2, 3, 4, 9, 10]
    counter = Counter()
    for _ in range(3):
        counter.increment()
    print(f"count={counter.value}")
'''


def prose(words: int, seed: int) -> str:
    """About `words` words of English prose, the same for the same seed."""
    rng = random.Random(seed)
    out: list[str] = []
    while sum(len(s.split()) for s in out) < words:
        out.append(rng.choice(SENTENCES))
    return " ".join(out)


def paragraphs(words: int, seed: int) -> list[str]:
    text = prose(words, seed).split(". ")
    return [". ".join(text[i : i + 3]).rstrip(".") + "." for i in range(0, len(text), 3)]


def numbers_rows(seed: int, rows: int) -> list[list[str]]:
    rng = random.Random(seed)
    header = ["Region", "Q1", "Q2", "Q3", "Q4", "Total"]
    regions = ["North", "South", "East", "West", "Central", "Coast", "Hills", "Valley"]
    out = [header]
    for i in range(rows):
        q = [rng.randint(100, 99999) for _ in range(4)]
        out.append([f"{regions[i % len(regions)]} {i + 1}"] + [f"{v:,}" for v in q] + [f"{sum(q):,}"])
    return out


def scan_image(seed: int) -> Image.Image:
    """A grey page that looks like a scan of printed text: dark bars on paper."""
    rng = random.Random(seed)
    image = Image.new("L", (170, 220), 236)
    draw = ImageDraw.Draw(image)
    for y in range(16, 204, 7):
        x = 16
        while x < 150:
            w = rng.randint(5, 20)
            draw.rectangle([x, y, min(x + w, 154), y + 2], fill=64)
            x += w + 4
    return image


def jpeg(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=30)
    return buffer.getvalue()


# reportlab ---------------------------------------------------------------


def reportlab_prose(name: str, pagesize, words: int, pages: int) -> None:
    styles = getSampleStyleSheet()
    story = []
    for page in range(pages):
        if page:
            story.append(PageBreak())
        story.append(Paragraph(f"Chapter {page + 1}", styles["Heading2"]))
        story += [Paragraph(p, styles["BodyText"]) for p in paragraphs(words, 100 * words + page)]
    SimpleDocTemplate(str(OUT / name), pagesize=pagesize, invariant=1).build(story)


def reportlab_table() -> None:
    styles = getSampleStyleSheet()
    story = [Paragraph("Quarterly sales by region", styles["Heading2"])]
    table = Table(numbers_rows(7, 60), repeatRows=1)
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, "grey"), ("ALIGN", (1, 0), (-1, -1), "RIGHT")]))
    story.append(table)
    SimpleDocTemplate(str(OUT / "reportlab-table.pdf"), pagesize=letter, invariant=1).build(story)


def reportlab_two_column() -> None:
    styles = getSampleStyleSheet()
    doc = BaseDocTemplate(str(OUT / "reportlab-two-column.pdf"), pagesize=letter, invariant=1)
    width = (doc.width - 0.3 * inch) / 2
    frames = [
        Frame(doc.leftMargin, doc.bottomMargin, width, doc.height, id="left"),
        Frame(doc.leftMargin + width + 0.3 * inch, doc.bottomMargin, width, doc.height, id="right"),
    ]
    doc.addPageTemplates([PageTemplate(id="columns", frames=frames)])
    story = [Paragraph("Notes from the river town", styles["Heading2"])]
    story += [Paragraph(p, styles["BodyText"]) for p in paragraphs(600, 11)]
    doc.build(story)


def reportlab_canvas(name: str, pagesize, draw, pages: int = 1) -> None:
    c = canvas.Canvas(str(OUT / name), pagesize=pagesize, invariant=1)
    for page in range(pages):
        draw(c, page)
        c.showPage()
    c.save()


def write_lines(c: canvas.Canvas, x: float, y: float, lines: list[str], size: int = 11, leading: int = 15) -> None:
    text = c.beginText(x, y)
    text.setFont("Helvetica", size, leading)
    for line in lines:
        text.textLine(line)
    c.drawText(text)


def wrap(text: str, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    return lines + [line] if line else lines


def reportlab_scan(c: canvas.Canvas, page: int) -> None:
    w, h = c._pagesize
    c.drawImage(SCAN_PATH, 0, 0, w, h)


def reportlab_scan_ocr(c: canvas.Canvas, page: int) -> None:
    w, h = c._pagesize
    c.drawImage(SCAN_PATH, 0, 0, w, h)
    text = c.beginText(72, h - 72)
    text.setTextRenderMode(3)  # invisible text over the image, as OCR tools write it
    text.setFont("Helvetica", 10, 14)
    for line in wrap(prose(120, 40 + page), 90):
        text.textLine(line)
    c.drawText(text)


def reportlab_mixed(c: canvas.Canvas, page: int) -> None:
    w, h = c._pagesize
    if page == 0:
        c.beginForm("header")
        c.setFont("Helvetica-Bold", 9)
        c.drawString(72, h - 40, "River Town Quarterly - internal report")
        c.endForm()
    c.doForm("header")
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, h - 80, f"Section {page + 1}: water levels")
    write_lines(c, 72, h - 110, wrap(prose(90, 60 + page), 85))
    chart = Drawing(400, 200)
    bars = VerticalBarChart()
    bars.x, bars.y, bars.width, bars.height = 30, 20, 350, 160
    bars.data = [[random.Random(page).randint(1, 50) for _ in range(8)]]
    chart.add(bars)
    chart.drawOn(c, 72, h - 480)
    c.drawImage(SCAN_PATH, 72, 72, 150, 194)
    write_lines(c, 240, 250, wrap(prose(40, 70 + page), 50))


def reportlab_landscape(c: canvas.Canvas, page: int) -> None:
    w, h = c._pagesize
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, h - 72, "Landscape page")
    write_lines(c, 72, h - 110, wrap(prose(150, 80 + page), 110))


def reportlab_rotated(c: canvas.Canvas, page: int) -> None:
    c.setPageRotation(90)
    w, h = c._pagesize
    write_lines(c, 72, h - 72, wrap(prose(100, 90 + page), 85))


# fpdf2 -------------------------------------------------------------------


def fpdf_doc() -> fpdf.FPDF:
    pdf = fpdf.FPDF(unit="pt", format="letter")
    pdf.set_creation_date(DATE)
    pdf.set_auto_page_break(True, margin=54)
    pdf.set_margins(54, 54)
    return pdf


def fpdf_prose() -> None:
    pdf = fpdf_doc()
    pdf.set_font("helvetica", size=11)
    for page in range(2):
        pdf.add_page()
        pdf.multi_cell(0, 15, "\n\n".join(paragraphs(150, 200 + page)))
    pdf.output(str(OUT / "fpdf2-prose.pdf"))


def fpdf_code() -> None:
    pdf = fpdf_doc()
    pdf.add_page()
    pdf.set_font("courier", size=9)
    pdf.multi_cell(0, 11, CODE)
    pdf.output(str(OUT / "fpdf2-code.pdf"))


def fpdf_unicode() -> None:
    pdf = fpdf_doc()
    pdf.add_font("DejaVu", fname=str(DEJAVU))
    pdf.set_font("DejaVu", size=12)
    pdf.add_page()
    pdf.multi_cell(0, 18, "\n".join(ACCENTS))
    pdf.add_page()
    pdf.multi_cell(0, 18, "\n".join(CYRILLIC_GREEK))
    pdf.output(str(OUT / "fpdf2-unicode.pdf"))


def fpdf_page_sizes() -> None:
    pdf = fpdf_doc()
    pdf.set_font("helvetica", size=10)
    sizes = [(612, 792), (595.28, 841.89), (792, 612), (200, 300), (612, 3000)]
    for i, (w, h) in enumerate(sizes):
        pdf.set_auto_page_break(False)
        pdf.add_page(format=(w, h))
        pdf.set_xy(20, 20)
        pdf.multi_cell(w - 40, 13, f"Page {i + 1} is {w:g} by {h:g} points. " + prose(25, 300 + i))
    pdf.output(str(OUT / "fpdf2-page-sizes.pdf"))


# PyMuPDF -----------------------------------------------------------------


def pymupdf_save(doc: pymupdf.Document, name: str, **options) -> None:
    doc.set_metadata({"producer": "PyMuPDF", "creator": "generate-pdf-corpus"})
    doc.save(str(OUT / name), garbage=4, deflate=True, no_new_id=True, **options)


def pymupdf_cjk() -> None:
    doc = pymupdf.open()
    font = pymupdf.Font("cjk")
    for page_lines in (CJK[:2], CJK[2:]):
        page = doc.new_page(width=595, height=842)
        page.insert_font(fontname="cjk", fontbuffer=font.buffer)
        for i, line in enumerate(page_lines):
            page.insert_text((60, 100 + 30 * i), line, fontname="cjk", fontsize=14)
    doc.subset_fonts()
    pymupdf_save(doc, "pymupdf-cjk.pdf")


def pymupdf_accents() -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    for i, line in enumerate(ACCENTS):
        page.insert_text((60, 100 + 22 * i), line, fontname="helv", fontsize=11)
    pymupdf_save(doc, "pymupdf-accents.pdf")


def pymupdf_objstm() -> None:
    doc = pymupdf.open()
    for page_no in range(3):
        page = doc.new_page(width=612, height=792)
        lines = wrap(prose(150, 400 + page_no), 90)
        page.insert_text((60, 72), lines, fontname="tiro", fontsize=11, lineheight=1.4)
    pymupdf_save(doc, "pymupdf-objstm.pdf", use_objstms=1)


def pymupdf_cropbox() -> None:
    """A Letter page cropped to its top-left quarter, a wide strip, and an uncropped page."""
    doc = pymupdf.open()
    for page_no in range(3):
        page = doc.new_page(width=612, height=792)
        page.insert_text((40, 60), wrap(prose(40, 500 + page_no), 40), fontname="helv", fontsize=10)
        page.insert_text((340, 500), wrap(prose(40, 510 + page_no), 40), fontname="helv", fontsize=10)
    doc.xref_set_key(doc[0].xref, "CropBox", "[0 396 306 792]")
    doc.xref_set_key(doc[1].xref, "CropBox", "[0 692 612 792]")
    pymupdf_save(doc, "pymupdf-cropbox.pdf")


# pypdf and pikepdf (qpdf) --------------------------------------------------


def pypdf_merged() -> None:
    writer = pypdf.PdfWriter()
    for name in ["reportlab-prose-30w.pdf", "fpdf2-code.pdf", "pymupdf-accents.pdf"]:
        writer.append(str(OUT / name))
    writer.add_metadata({"/Producer": "pypdf"})
    writer._ID = None
    with open(OUT / "pypdf-merged.pdf", "wb") as f:
        writer.write(f)


def pypdf_incremental() -> None:
    """Two revisions: the update replaces page 1's text and adds a third page."""
    base = OUT / "reportlab-prose-150w-a4.pdf"
    reader = pypdf.PdfReader(str(base))
    original = io.BytesIO()
    first = pypdf.PdfWriter()
    for page in reader.pages[:2]:
        first.add_page(page)
    first._ID = None
    first.write(original)
    writer = pypdf.PdfWriter(io.BytesIO(original.getvalue()), incremental=True)
    page = writer.pages[0]
    content = pypdf.generic.StreamObject()
    content.set_data(b"BT /F1 12 Tf 72 760 Td (This revision replaced the first page.) Tj ET")
    page[pypdf.generic.NameObject("/Contents")] = writer._add_object(content)
    page[pypdf.generic.NameObject("/Resources")] = pypdf.generic.DictionaryObject(
        {
            pypdf.generic.NameObject("/Font"): pypdf.generic.DictionaryObject(
                {
                    pypdf.generic.NameObject("/F1"): writer._add_object(
                        pypdf.generic.DictionaryObject(
                            {
                                pypdf.generic.NameObject("/Type"): pypdf.generic.NameObject("/Font"),
                                pypdf.generic.NameObject("/Subtype"): pypdf.generic.NameObject("/Type1"),
                                pypdf.generic.NameObject("/BaseFont"): pypdf.generic.NameObject("/Helvetica"),
                            }
                        )
                    )
                }
            )
        }
    )
    writer.add_page(reader.pages[2])
    with open(OUT / "pypdf-incremental.pdf", "wb") as f:
        writer.write(f)


def qpdf_save(source: str, name: str, **options) -> None:
    with pikepdf.open(OUT / source) as pdf:
        # qpdf cannot hash an encrypted file into its ID, so that one gets a fixed ID.
        ids = {"static_id": True} if "encryption" in options else {"deterministic_id": True}
        pdf.save(OUT / name, **ids, **options)


# Chrome (Skia) -----------------------------------------------------------

CHROME_PAGES = {
    "chrome-article.pdf": """<h1>The river town</h1>
<p>{p0}</p><h2>Market days</h2><p>{p1}</p><p>{p2}</p>""",
    "chrome-table.pdf": """<h1>Office finances</h1>
<p>The office's financial officer filed the figures; affluent offices fit five fine fixtures.</p>
<table border=1 cellspacing=0 cellpadding=4>{rows}</table>""",
    "chrome-justified.pdf": """<h1>Justified and preformatted</h1>
<p style="text-align: justify">{short}</p>
<pre>for (let i = 0; i < 3; i++) {{
    console.log("step", i);
}}</pre>""",
    "chrome-columns.pdf": """<h1>Two columns</h1>
<div style="columns: 2; column-gap: 24px; text-align: justify">
<p>Extraordinarily long words like incomprehensibili&shy;ties and counter&shy;revolutionaries
break across lines with soft hyphens. {p0}</p><p>{p1}</p><p>{p2}</p></div>""",
}


def find_browser() -> str | None:
    return next(
        (shutil.which(b) for b in ["google-chrome", "chromium", "chromium-browser", "chrome"] if shutil.which(b)),
        None,
    )


def chrome_pdfs(browser: str) -> None:
    style = "<style>body{font-family:'Liberation Serif',serif;font-size:12pt;margin:0}h1,h2{font-weight:normal}</style>"
    rows = "".join(
        "<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in numbers_rows(9, 2)
    )
    with tempfile.TemporaryDirectory() as tmp:
        for name, body in CHROME_PAGES.items():
            ps = paragraphs(160, 600 + len(name))
            html = Path(tmp) / "page.html"
            html.write_text(
                f"<!doctype html><html lang=en><meta charset=utf-8>{style}<body>"
                + body.format(p0=ps[0], p1=ps[1], p2=ps[2], short=" ".join(ps[0].split()[:40]), rows=rows)
            )
            target = Path(tmp) / name
            env = {**os.environ, "XDG_CACHE_HOME": tmp, "XDG_CONFIG_HOME": tmp}
            subprocess.run(
                [browser, f"--user-data-dir={tmp}/profile", "--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
                 f"--print-to-pdf={target}", html.as_uri()],
                check=True, capture_output=True, env=env,
            )
            (OUT / name).write_bytes(fix_dates_and_id(target.read_bytes()))


def fix_dates_and_id(data: bytes) -> bytes:
    """Overwrite dates and the document ID with fixed values of the same length."""
    data = re.sub(rb"D:\d{14}", b"D:20261103000000", data)
    return re.sub(rb"/ID \[<([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)>\]",
                  lambda m: b"/ID [<" + b"0" * len(m[1]) + b"> <" + b"0" * len(m[2]) + b">]", data)


# Handmade ----------------------------------------------------------------
# Features no library above writes on request: a hybrid xref, a junk prefix
# that shifts every offset, glyph-name /Differences, MacRoman, ASCIIHex and
# unfiltered content, inline images, and kerned TJ arrays.


def stream(entries: bytes, data: bytes) -> bytes:
    return b"<< " + entries + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def handmade(objects: dict[int, bytes], *, prefix: bytes = b"", compressed: dict[int, bytes] | None = None) -> bytes:
    """A PDF with a classic xref table. `compressed` objects go into an object
    stream that only a hybrid-file /XRefStm lists, as old Word files do."""
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}
    size = max([*objects, *(compressed or {})]) + 1
    if compressed:
        stm, xstm = size, size + 1
        size += 2
        header = b""
        body = b""
        for num, obj in compressed.items():
            header += b"%d %d " % (num, len(body))
            body += obj + b"\n"
        objects = {**objects, stm: stream(b"/Type /ObjStm /N %d /First %d /Filter /FlateDecode" % (len(compressed), len(header)), zlib.compress(header + body))}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num + objects[num] + b"\nendobj\n"
    trailer = b"/Size %d /Root 1 0 R" % size
    if compressed:
        rows = b""
        for index, num in enumerate(compressed):
            rows += bytes([2]) + stm.to_bytes(4, "big") + index.to_bytes(2, "big")
        offsets[xstm] = len(out)
        index = b" ".join(b"%d 1" % num for num in compressed)
        out += b"%d 0 obj\n" % xstm + stream(b"/Type /XRef /Size %d /W [1 4 2] /Index [%s]" % (size, index), rows) + b"\nendobj\n"
        trailer += b" /XRefStm %d" % offsets[xstm]
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for num in range(1, size):
        out += b"%010d 00000 n \n" % offsets[num] if num in offsets else b"0000000000 00000 f \n"
    out += b"trailer\n<< " + trailer + b" >>\nstartxref\n%d\n%%%%EOF\n" % xref
    return prefix + bytes(out)


def page_objects(contents: list[bytes], fonts: bytes, extra: dict[int, bytes] | None = None, size: bytes = b"[0 0 612 792]") -> dict[int, bytes]:
    pages = 10 + 2 * len(contents)
    objects = {
        1: b"<< /Type /Catalog /Pages %d 0 R >>" % pages,
        pages: b"<< /Type /Pages /MediaBox %s /Resources << /Font %s >> /Count %d /Kids [%s] >>"
        % (size, fonts, len(contents), b" ".join(b"%d 0 R" % (10 + 2 * i) for i in range(len(contents)))),
    }
    for i, content in enumerate(contents):
        objects[10 + 2 * i] = b"<< /Type /Page /Parent %d 0 R /Contents %d 0 R >>" % (pages, 11 + 2 * i)
        objects[11 + 2 * i] = content
    return {**objects, **(extra or {})}


HELVETICA = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
# Helvetica's advance widths for codes 32 to 126, so a reader and a renderer agree on word gaps.
HELVETICA_WIDTHS = (
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 "
    "278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 "
    "611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 "
    "556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
)
HELVETICA_WITH_WIDTHS = (
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding "
    b"/FirstChar 32 /LastChar 126 /Widths [" + HELVETICA_WIDTHS.encode() + b"] >>"
)


def helvetica_width(text: str, size: float) -> float:
    widths = [int(w) for w in HELVETICA_WIDTHS.split()]
    return sum(widths[ord(c) - 32] for c in text) * size / 1000


def positioned_words() -> bytes:
    """Lines laid out the way TeX and word processors write them: spaces as
    kerning or as gaps between separately placed words, never as characters."""
    out = [b"BT /F1 11 Tf 14 TL 72 720 Td"]
    out.append(b"[(The)-333(quic)20(k)-333(bro)-28(wn)-333(fox)-333(jumps)-333(o)-15(v)-15(er)-333(the)-333(lazy)-333(dog.)] TJ")
    out.append(b"T* [(Kerning)-80(inside)-90(a)-120(word)-60(stays)-333(joined.)] TJ ET")
    y = 680
    for words in (prose(14, 900).split(), prose(14, 901).split()):
        x = 72.0
        line = b"BT /F1 11 Tf"
        for word in words:
            line += b" 1 0 0 1 %.2f %d Tm (%s) Tj" % (x, y, word.encode())
            x += helvetica_width(word, 11) + helvetica_width(" ", 11)
        out.append(line + b" ET")
        y -= 14
    out.append(b"BT /F1 11 Tf 72 640 Td (Einstein wrote E = mc) Tj 4 Ts (2) Tj 0 Ts ( in 1905.) Tj ET")
    out.append(b"BT /F1 11 Tf 14 TL 72 620 Td (The library needs a careful imple-) Tj T* (mentation of the reader.) Tj ET")
    out.append(b"BT /F1 11 Tf 72 580 Td (Bold by overprinting) Tj ET BT /F1 11 Tf 72.3 580 Td (Bold by overprinting) Tj ET")
    for x, text in ((72, b"Name"), (250, b"Quantity"), (400, b"Price")):
        out.append(b"BT /F1 11 Tf %d 560 Td (%s) Tj ET" % (x, text))
    for x, text in ((72, b"Widget"), (250, b"12"), (400, b"$4.50")):
        out.append(b"BT /F1 11 Tf %d 546 Td (%s) Tj ET" % (x, text))
    out.append(b"BT /F1 11 Tf 150 520 Td (world, written first.) Tj -78 0 Td (Hello) Tj ET")
    return b"\n".join(out)


def handmade_files() -> None:
    differences = (
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /Type /Encoding "
        b"/BaseEncoding /WinAnsiEncoding /Differences [1 /fi /fl /quotedblleft /quotedblright /emdash /eacute /bullet /ffi] >> >>"
    )
    mac = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>"
    fonts = b"<< /F1 2 0 R /F2 3 0 R /F3 4 0 R >>"
    page1 = (
        b"BT /F2 14 Tf 72 720 Td (\\001nancial \\002ow: \\003quoted\\004 \\005 caf\\006 \\007 o\\010ce) Tj ET\n"
        b"BT /F3 12 Tf 72 690 Td (Mac Roman: caf\\216 na\\225ve \\210 la carte) Tj ET\n"
        b"BT /F1 12 Tf 72 660 Td (WinAnsi: caf\\351 \\223smart\\224 \\226 dash \\200 euro) Tj ET\n"
        b"q 64 0 0 8 72 600 cm BI /W 8 /H 1 /CS /G /BPC 8 ID ()Tj\x00\xff(E\nEI Q\n"
        b"BT /F1 12 Tf 72 580 Td (After the inline image.) Tj ET\n"
        b"/Fm1 Do\n"
    )
    page2 = (
        b"BT /F1 12 Tf 14 TL 72 720 Td [(Kerned) -250 (words) -120 (and) -600 (gaps)] TJ T*\n"
        b"[(Tight)-30(ly)-10( kerned)] TJ T* (Next line by T*) Tj (same line, second run) Tj\n"
        b"(Quote operator line) ' 2 1 (Double quote operator line) \"\n"
        b"1 0 0 1 72 600 Tm (Placed) Tj 1 0 0 1 120 600 Tm (by) Tj 1 0 0 1 140 600 Tm (Tm) Tj\n"
        b"0 -30 TD (TD moved down) Tj 200 0 Td (and right) Tj ET\n"
    )
    hexed = page2.hex().encode() + b">"
    form = stream(
        b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 2 0 R >> >>",
        b"BT /F1 12 Tf 72 540 Td (Text inside a form XObject.) Tj ET",
    )
    objects = page_objects(
        [stream(b"", page1), stream(b"/Filter /ASCIIHexDecode", hexed)],
        fonts,
        {2: HELVETICA, 3: differences, 4: mac},
    )
    objects[10] = objects[10].replace(b">>", b"/Resources << /Font %s /XObject << /Fm1 5 0 R >> >> >>" % fonts)
    objects[5] = form
    (OUT / "handmade-fonts-and-operators.pdf").write_bytes(handmade(objects))

    hybrid_text = b"BT /F1 12 Tf 72 720 Td (This page is listed in the /XRefStm of a hybrid file.) Tj ET"
    objects = page_objects([stream(b"", hybrid_text)], b"<< /F1 2 0 R >>")
    pages_node = objects.pop(12)
    (OUT / "handmade-hybrid-xref.pdf").write_bytes(handmade(objects, compressed={12: pages_node, 2: HELVETICA}))

    objects = page_objects([stream(b"/Filter /FlateDecode", zlib.compress(positioned_words()))], b"<< /F1 2 0 R >>", {2: HELVETICA_WITH_WIDTHS})
    (OUT / "handmade-positioned-words.pdf").write_bytes(handmade(objects))

    junk_text = b"BT /F1 12 Tf 72 720 Td (Every xref offset in this file is wrong by the junk before the header.) Tj ET"
    objects = page_objects([stream(b"", junk_text)] * 2, b"<< /F1 2 0 R >>", {2: HELVETICA})
    (OUT / "handmade-junk-prefix.pdf").write_bytes(handmade(objects, prefix=b"Content-Type: application/pdf\r\n\r\n"))


SCAN_PATH = str(OUT / ".scan.jpg")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    browser = find_browser()
    if not browser:
        print("keep chrome-*.pdf: no google-chrome or chromium on PATH")
    for old in OUT.glob("*.pdf"):
        if browser or not old.name.startswith("chrome-"):
            old.unlink()
    Path(SCAN_PATH).write_bytes(jpeg(scan_image(1)))

    reportlab_prose("reportlab-prose-30w.pdf", letter, 30, 3)
    reportlab_prose("reportlab-prose-150w-a4.pdf", A4, 150, 3)
    reportlab_prose("reportlab-prose-400w.pdf", letter, 400, 2)
    reportlab_table()
    reportlab_two_column()
    reportlab_canvas("reportlab-scan.pdf", letter, reportlab_scan, 2)
    reportlab_canvas("reportlab-scan-ocr.pdf", letter, reportlab_scan_ocr, 2)
    reportlab_canvas("reportlab-mixed.pdf", letter, reportlab_mixed, 2)
    reportlab_canvas("reportlab-landscape.pdf", landscape(letter), reportlab_landscape)
    reportlab_canvas("reportlab-rotate90.pdf", letter, reportlab_rotated)

    fpdf_prose()
    fpdf_code()
    fpdf_unicode()
    fpdf_page_sizes()

    pymupdf_cjk()
    pymupdf_accents()
    pymupdf_objstm()
    pymupdf_cropbox()

    pypdf_merged()
    pypdf_incremental()

    qpdf_save("reportlab-prose-400w.pdf", "qpdf-objstm.pdf", object_stream_mode=pikepdf.ObjectStreamMode.generate)
    qpdf_save("fpdf2-prose.pdf", "qpdf-linearized.pdf", linearize=True)
    qpdf_save(
        "reportlab-prose-30w.pdf",
        "qpdf-encrypted.pdf",
        encryption=pikepdf.Encryption(owner="owner", user="", R=4, aes=False, metadata=False),
        object_stream_mode=pikepdf.ObjectStreamMode.disable,
    )

    handmade_files()
    if browser:
        chrome_pdfs(browser)
    Path(SCAN_PATH).unlink()

    total = 0
    for path in sorted(OUT.glob("*.pdf")):
        total += path.stat().st_size
        print(f"{path.name} {path.stat().st_size}")
    print(f"{len(list(OUT.glob('*.pdf')))} files, {total} bytes")


if __name__ == "__main__":
    main()
