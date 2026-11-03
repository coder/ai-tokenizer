import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readPdf } from "./pdf";

const corpus = join(import.meta.dir, "fixtures/pdf");
const read = (name: string) => new Uint8Array(readFileSync(join(corpus, name)));

/** A PDF with these objects (numbered from 1), a valid xref and object 1 as its catalog. */
function build(objects: Array<string | Uint8Array>): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((object, i) => {
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.from(object as Uint8Array | string),
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(length);
    parts.push(part);
    length += part.length;
  });
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`);
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows.join("")}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
    )
  );
  return new Uint8Array(Buffer.concat(parts));
}

function stream(dict: string, data: Uint8Array | string): Uint8Array {
  const bytes = Buffer.from(data as Uint8Array | string);
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}

const LETTER: [number, number] = [612, 792];
const A4: [number, number] = [595.2756, 841.8898];
const times = (n: number, size: [number, number]) => Array(n).fill(size);

// Page sizes as a renderer shows them: the CropBox, turned by /Rotate.
const PAGES: Record<string, Array<[number, number]>> = {
  "chrome-article.pdf": [LETTER],
  "fpdf2-page-sizes.pdf": [
    LETTER,
    [595.28, 841.89],
    [792, 612],
    [200, 300],
    [612, 3000],
  ],
  "handmade-hybrid-xref.pdf": [LETTER],
  "handmade-junk-prefix.pdf": times(2, LETTER),
  "pymupdf-cjk.pdf": times(2, [595, 842]),
  "pymupdf-cropbox.pdf": [[306, 396], [612, 100], LETTER],
  "pymupdf-objstm.pdf": times(3, LETTER),
  "pypdf-incremental.pdf": times(3, A4),
  "pypdf-merged.pdf": times(5, LETTER),
  "qpdf-encrypted.pdf": times(3, LETTER),
  "qpdf-linearized.pdf": times(2, LETTER),
  "qpdf-objstm.pdf": times(2, LETTER),
  "reportlab-landscape.pdf": [[792, 612]],
  "reportlab-prose-150w-a4.pdf": times(3, A4),
  // A landscape MediaBox turned by /Rotate 90 shows as portrait.
  "reportlab-rotate90.pdf": [LETTER],
  "reportlab-scan.pdf": times(2, LETTER),
  "reportlab-table.pdf": times(2, LETTER),
};

// Text facts measured with count_tokens, which prices pdfium's extraction.
const TEXT: Array<
  [file: string, page: number, has: string[], lacks?: string[]]
> = [
  ["reportlab-prose-30w.pdf", 0, ["Chapter 1\n"]],
  ["fpdf2-code.pdf", 0, ["\n result = []\n i = j = 0\n while i < len(left)"]],
  ["fpdf2-unicode.pdf", 1, ["Москва — столица России"]],
  ["pymupdf-cjk.pdf", 0, ["东京是日本的首都，也是世界上人口最多的城市之一。"]],
  [
    "handmade-fonts-and-operators.pdf",
    0,
    [
      "financial flow: “quoted” — café • office",
      "Mac Roman: café naïve à la carte",
      "After the inline image.",
      "Text inside a form XObject.",
    ],
  ],
  [
    "handmade-fonts-and-operators.pdf",
    1,
    ["Kerned wordsand gaps", "Next line by T*same line, second run"],
  ],
  [
    "handmade-positioned-words.pdf",
    0,
    [
      "The quick brown fox jumps over the lazy dog.",
      "E = mc2 in 1905.",
      "a careful implementation of the reader",
      "\nBold by overprinting\n",
    ],
  ],
  ["pymupdf-cropbox.pdf", 0, ["A new road was planned"], ["Some people said"]],
  ["pymupdf-cropbox.pdf", 2, ["The river town woke slowly"]],
  ["pypdf-incremental.pdf", 0, ["This revision replaced the first page."]],
  ["handmade-hybrid-xref.pdf", 0, ["listed in the /XRefStm of a hybrid file"]],
  ["handmade-junk-prefix.pdf", 1, ["wrong by the junk before the header"]],
  // Invisible text (render mode 3) over a scan, as OCR tools write it.
  ["reportlab-scan-ocr.pdf", 0, ["A new road was planned for the spring"]],
  [
    "chrome-table.pdf",
    0,
    [
      "The office's financial officer filed the figures",
      "\nNorth 1 60,787 80,475 49,030 35,113 225,405\n",
    ],
  ],
];

describe("readPdf", () => {
  test("reads each page at its visible size", () => {
    for (const [name, sizes] of Object.entries(PAGES)) {
      const pages = readPdf(read(name))?.pages;
      expect(pages?.length, name).toBe(sizes.length);
      pages!.forEach((page, i) => {
        expect(page.width, `${name} page ${i + 1}`).toBeCloseTo(
          sizes[i]![0],
          3
        );
        expect(page.height, `${name} page ${i + 1}`).toBeCloseTo(
          sizes[i]![1],
          3
        );
      });
    }
  });

  test("extracts each page's text layer the way Anthropic prices it", () => {
    for (const [name, page, has, lacks = []] of TEXT) {
      const text = readPdf(read(name))!.pages[page]!.text;
      for (const part of has) expect(text, name).toContain(part);
      for (const part of lacks) expect(text, name).not.toContain(part);
    }
    expect(
      readPdf(read("reportlab-scan.pdf"))!.pages.map((p) => p.text)
    ).toEqual(["", ""]);
    // The page tree of this encrypted file is readable; its strings are not.
    expect(
      readPdf(read("qpdf-encrypted.pdf"))!.pages.map((p) => p.text)
    ).toEqual(["", "", ""]);
  });

  test("returns undefined for bytes that are not a PDF or have no pages", () => {
    expect(readPdf(new TextEncoder().encode("hello world"))).toBeUndefined();
    expect(readPdf(build(["<< /Type /Catalog >>"]))).toBeUndefined();
  });

  test("survives every truncation of a file and random bytes", () => {
    const started = performance.now();
    for (const name of [
      "handmade-hybrid-xref.pdf",
      "pymupdf-objstm.pdf",
      "qpdf-linearized.pdf",
    ]) {
      const bytes = read(name);
      for (let end = 0; end <= bytes.length; end++) {
        const pages = readPdf(bytes.subarray(0, end))?.pages;
        for (const page of pages ?? []) expect(page.width).toBeGreaterThan(0);
      }
    }
    const garbage = new Uint8Array(1024 * 1024);
    for (let i = 0, seed = 7; i < garbage.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      garbage[i] = seed >>> 24;
    }
    garbage.set(new TextEncoder().encode("%PDF-1.7\n"));
    expect(readPdf(garbage)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("ends on a cyclic page tree", () => {
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 2 >>",
      "<< /Type /Pages /Kids [2 0 R 4 0 R 3 0 R] /Parent 2 0 R >>",
      "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 200] >>",
    ]);
    expect(readPdf(pdf)?.pages).toEqual([
      { width: 100, height: 200, text: "" },
    ]);
  });

  test("caps what decompression bombs expand to", () => {
    const bomb = deflateSync(Buffer.alloc(256 * 1024 * 1024, " "));
    const pages = Array.from({ length: 8 }, (_, i) => i);
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${pages.map((i) => `${3 + i} 0 R`).join(" ")}] /Count 8 >>`,
      ...pages.map(
        (i) => `<< /Type /Page /Parent 2 0 R /Contents ${11 + i} 0 R >>`
      ),
      ...pages.map(() => stream("/Filter /FlateDecode", bomb)),
    ]);
    const started = performance.now();
    expect(readPdf(pdf)?.pages.length).toBe(8);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("reads a 5 MB file in well under a second", () => {
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> " +
        "/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
      stream(
        "",
        "q 612 0 0 792 0 0 cm /Im1 Do Q BT /F1 12 Tf 72 720 Td (Scanned.) Tj ET"
      ),
      stream(
        "/Type /XObject /Subtype /Image /Width 2000 /Height 2500 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode",
        new Uint8Array(5 * 1024 * 1024).fill(0x28)
      ),
    ]);
    const started = performance.now();
    expect(readPdf(pdf)?.pages[0]?.text).toBe("Scanned.");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
