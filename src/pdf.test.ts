import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
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
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 30_000);

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
    expect(performance.now() - started).toBeLessThan(12_000);
  }, 20_000);

  test("reads a 5 MB image without decoding its pixels", () => {
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
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

function lzwEncode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const dict = new Map<number, number>();
  let next = 258;
  let word = -1;
  const codes = [256];
  for (const byte of data) {
    if (word < 0) {
      word = byte;
      continue;
    }
    const key = word * 256 + byte;
    const found = dict.get(key);
    if (found !== undefined) word = found;
    else {
      codes.push(word);
      if (next < 4096) dict.set(key, next++);
      else {
        codes.push(256);
        dict.clear();
        next = 258;
      }
      word = byte;
    }
  }
  if (word >= 0) codes.push(word);
  codes.push(257);
  const out: number[] = [];
  let buffer = 0,
    bits = 0,
    width = 9,
    decodedNext = 258,
    previous = false;
  for (const code of codes) {
    buffer = (buffer << width) | code;
    bits += width;
    while (bits >= 8) out.push((buffer >>> (bits -= 8)) & 255);
    if (code === 256) {
      width = 9;
      decodedNext = 258;
      previous = false;
    } else {
      if (
        previous &&
        decodedNext < 4096 &&
        ++decodedNext + earlyChange === 1 << width &&
        width < 12
      )
        width++;
      previous = true;
    }
  }
  if (bits) out.push((buffer << (8 - bits)) & 255);
  return Uint8Array.from(out);
}

function runLengthEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    let end = i + 1;
    while (end < data.length && end < i + 128 && data[end] === data[i]) end++;
    if (end - i > 1) out.push(257 - (end - i), data[i]!);
    else {
      while (end < data.length && end < i + 128 && data[end] !== data[end + 1])
        end++;
      out.push(end - i - 1, ...data.subarray(i, end));
    }
    i = end;
  }
  return Uint8Array.from([...out, 128]);
}

function unAscii85(text: string): Uint8Array {
  const out: number[] = [];
  let group = 0,
    n = 0;
  const write = (count: number) => {
    for (let k = 0; k < count; k++) out.push((group >>> (24 - k * 8)) & 255);
  };
  for (const c of text) {
    if (c === "~") break;
    if (c === "z") out.push(0, 0, 0, 0);
    else if (c >= "!" && c <= "u") {
      group = group * 85 + c.charCodeAt(0) - 33;
      if (++n === 5) {
        write(4);
        group = n = 0;
      }
    }
  }
  if (n > 1) {
    for (let i = n; i < 5; i++) group = group * 85 + 84;
    write(n - 1);
  }
  return Uint8Array.from(out);
}

function reencodeTable(
  filter: string,
  encode: (data: Uint8Array) => Uint8Array
): Uint8Array {
  let replaced = 0;
  const source = Buffer.from(read("reportlab-table.pdf")).toString("latin1");
  const changed = source.replace(
    /<<\s*\/Filter\s*\[\s*\/ASCII85Decode\s+\/FlateDecode\s*]\s*\/Length\s+\d+\s*>>\s*stream\r?\n([\s\S]*?)endstream/g,
    (_, data: string) => {
      replaced++;
      return Buffer.from(
        stream(filter, encode(inflateSync(unAscii85(data))))
      ).toString("latin1");
    }
  );
  expect(replaced).toBe(2);
  return Buffer.from(changed, "latin1");
}

describe("PDF content filters", () => {
  for (const early of [undefined, 0, 1]) {
    test(`LZWDecode with EarlyChange ${early ?? "default"} preserves the corpus text`, () => {
      const params =
        early === undefined ? "" : `/DecodeParms << /EarlyChange ${early} >>`;
      const pdf = reencodeTable(`/Filter /LZWDecode ${params}`, (data) =>
        lzwEncode(data, early ?? 1)
      );
      expect(readPdf(pdf)).toEqual(readPdf(read("reportlab-table.pdf")));
    });
  }
  test("LZWDecode applies the same PNG predictor as FlateDecode", () => {
    const pdf = reencodeTable(
      "/Filter /LZWDecode /DecodeParms << /Predictor 12 /Columns 1 >>",
      (data) => {
        const predicted = new Uint8Array(2 * data.length);
        for (let i = 0; i < data.length; i++) {
          predicted[i * 2] = 2;
          predicted[i * 2 + 1] = data[i]! - (data[i - 1] ?? 0);
        }
        return lzwEncode(predicted);
      }
    );
    expect(readPdf(pdf)).toEqual(readPdf(read("reportlab-table.pdf")));
  });
  test("RunLengthDecode preserves the corpus text", () => {
    const pdf = reencodeTable("/Filter /RunLengthDecode", runLengthEncode);
    expect(readPdf(pdf)).toEqual(readPdf(read("reportlab-table.pdf")));
  });
  test("LZW dictionary resets and all code widths preserve a long text stream", () => {
    let seed = 7;
    const letters = Array.from({ length: 100_000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(65 + ((seed >>> 24) % 26));
    }).join("");
    const content = Buffer.from(`BT /F1 0.0001 Tf 10 10 Td (${letters}) Tj ET`);
    const pdf = (bytes: Uint8Array, filter = "") =>
      build([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] >>",
        `<< /Type /Page /Contents 4 0 R /Resources << ${PDF_FONT} >> >>`,
        stream(filter, bytes),
      ]);
    const original = readPdf(pdf(content));
    expect(original?.pages[0]!.text).toBe(letters);
    for (const early of [0, 1]) {
      expect(
        readPdf(
          pdf(
            lzwEncode(content, early),
            `/Filter /LZWDecode /DecodeParms << /EarlyChange ${early} >>`
          )
        )
      ).toEqual(original);
    }
  });
  test("an unsupported content filter leaves the page present, with empty text", () => {
    const pdf = reencodeTable("/Filter /DCTDecode", (data) => data);
    expect(readPdf(pdf)?.pages.map((p) => p.text)).toEqual(["", ""]);
  });
});

const PDF_FONT = "/Font << /F1 << /Subtype /Type1 /BaseFont /Helvetica >> >>";

function sharedContent(
  content: Uint8Array | string,
  filter = "",
  packed = false
): Uint8Array {
  const pages = Array.from(
    { length: 200 },
    () => "<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>"
  );
  const first = packed ? 5 : 4;
  const kids = pages.map((_, i) => `${first + i} 0 R`).join(" ");
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count 999999999 /Resources << ${PDF_FONT} >> >>`,
    stream(filter, content),
  ];
  if (packed) {
    let body = "",
      header = "";
    pages.forEach((page, i) => {
      header += `${first + i} ${body.length} `;
      body += page + "\n";
    });
    objects.push(
      stream(
        `/Type /ObjStm /N 200 /First ${header.length} /Filter /FlateDecode`,
        deflateSync(Buffer.from(header + body))
      )
    );
  } else objects.push(...pages);
  return build(objects);
}

function fontPdf(cmap: string, descendant = ""): Uint8Array {
  return build([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] >>",
    "<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    stream("", "BT /F1 1 Tf 10 10 Td <0041> Tj ET"),
    `<< /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R /DescendantFonts [<< ${descendant} >>] >>`,
    stream("/Filter /FlateDecode", deflateSync(Buffer.from(cmap))),
  ]);
}

describe("hostile PDFs", () => {
  test("bounds malformed objects, including objects that start inside an unclosed string", () => {
    for (const suffix of ["[", "<<", "<< /A ", "(", "<"]) {
      const objects = Array.from(
        { length: 80_000 },
        (_, i) => `${i + 1} 0 obj ${suffix}`
      ).join("");
      const started = performance.now();
      expect(readPdf(Buffer.from("%PDF-1.4\n" + objects))).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(4000);
    }
  }, 30_000);

  test("bounds raw and packed pages that all draw the same large stream", () => {
    for (const packed of [false, true]) {
      const pdf = sharedContent(
        `BT /F1 0.001 Tf 10 10 Td (${"a ".repeat(500_000)}) Tj ET`,
        "",
        packed
      );
      const started = performance.now();
      const result = readPdf(pdf)!;
      expect(result.pages.length).toBe(200);
      expect(result.pages[0]!.text).toStartWith("a a a");
      expect(
        result.pages.reduce((sum, p) => sum + p.text.length, 0)
      ).toBeLessThanOrEqual(8_000_000);
      expect(result.pages.at(-1)!.text).toBe("");
      expect(performance.now() - started).toBeLessThan(4000);
    }
  }, 15_000);

  test("charges repeated comments, empty content streams, and recursive forms", () => {
    const forms: Array<string | Uint8Array> = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>",
      stream("", "/X Do"),
    ];
    for (let depth = 0; depth < 8; depth++) {
      forms.push(
        stream(
          `/Subtype /Form /Filter /FlateDecode /Resources << /XObject << /X ${6 + depth} 0 R >> >>`,
          deflateSync(Buffer.from(depth === 7 ? "" : "/X Do ".repeat(1000)))
        )
      );
    }
    const contents = Array.from(
      { length: 1000 },
      () => "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"
    );
    const empty = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${contents.map((_, i) => `${i + 5} 0 R`).join(" ")}] >>`,
      stream("", ""),
      `[${"3 0 R ".repeat(150_000)}]`,
      ...contents,
    ]);
    for (const pdf of [
      sharedContent(("%" + "x".repeat(98) + "\n").repeat(10_000)),
      empty,
      build(forms),
    ]) {
      const started = performance.now();
      expect(readPdf(pdf)?.pages.length).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(4000);
    }
  }, 20_000);

  test("bounds object-stream offsets and expanded CMap ranges", () => {
    const n = 100_000;
    const header = Array.from({ length: n }, (_, i) => `${i + 10} 0 `).join("");
    const objects = build([
      stream(
        `/Type /ObjStm /N ${n} /First ${header.length} /Filter /FlateDecode`,
        deflateSync(Buffer.from(header + "[" + "0 ".repeat(4_000_000)))
      ),
    ]);
    const cmap =
      "beginbfrange\n" +
      Array.from(
        { length: 30_000 },
        (_, i) =>
          `<${(i * 256).toString(16).padStart(8, "0")}> <${(i * 256 + 255).toString(16).padStart(8, "0")}> <0041>\n`
      ).join("") +
      "endbfrange";
    for (const pdf of [
      objects,
      fontPdf(cmap),
      fontPdf(
        "beginbfrange <ffffffffffffffffffff> <ffffffffffffffffffff> <0041> endbfrange"
      ),
      fontPdf("", "/W [9007199254740993 9007199254740993 1]"),
    ]) {
      const started = performance.now();
      readPdf(pdf);
      expect(performance.now() - started).toBeLessThan(4000);
    }
  }, 20_000);

  test("bounds reused coordinate arrays, whose fields have fixed sizes", () => {
    const zeros = "0 ".repeat(100_000);
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${Array.from({ length: 1000 }, (_, i) => `${i + 3} 0 R`).join(" ")}] /MediaBox [0 0 612 792 ${zeros}] /Resources << /XObject << /X 1005 0 R >> >> >>`,
      ...Array.from(
        { length: 1000 },
        () => "<< /Type /Page /Parent 2 0 R /Contents 1003 0 R >>"
      ),
      stream("", "/X Do ".repeat(1000)),
      "null",
      stream(`/Subtype /Form /Matrix [1 0 0 1 0 0 ${zeros}]`, ""),
    ]);
    const started = performance.now();
    expect(readPdf(pdf)?.pages.length).toBe(1000);
    expect(performance.now() - started).toBeLessThan(4000);
  }, 15_000);

  test("bounds 100,000 empty pages without trusting the page count", () => {
    const pages = Array.from({ length: 100_000 }, () => "<< /Type /Page >>");
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${i + 3} 0 R`).join(" ")}] /Count 999999999 >>`,
      ...pages,
    ]);
    const started = performance.now();
    const count = readPdf(pdf)?.pages.length ?? 0;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(100_000);
    expect(performance.now() - started).toBeLessThan(4000);
  }, 15_000);

  test("charges expanded glyph text before normalizing millions of ligatures", () => {
    const pdf = build([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] >>",
      `<< /Type /Page /Contents 4 0 R /Resources << ${PDF_FONT.replace("/Helvetica", "/Helvetica /ToUnicode 5 0 R")} >> >>`,
      stream("", `BT /F1 0.001 Tf 10 10 Td (${"A".repeat(20_000)}) Tj ET`),
      stream("", `beginbfchar <41> <${"fb03".repeat(256)}> endbfchar`),
    ]);
    const started = performance.now();
    const text = readPdf(pdf)!.pages[0]!.text;
    expect(text).toStartWith("ffiffi");
    expect(text.length).toBeLessThanOrEqual(8_000_000);
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test("caps compressed strings, TJ arrays and inline images", () => {
    for (const content of [
      `BT /F1 0.001 Tf 10 10 Td (${"ab ".repeat(4_000_000)}) Tj ET`,
      "[" + "(a) -250 ".repeat(1_500_000) + "] TJ",
      "[" + "0 ".repeat(6_000_000) + "]",
      "(".repeat(12_000_000),
      "BI ID " + "xEI ".repeat(3_000_000),
    ]) {
      const pdf = sharedContent(
        deflateSync(Buffer.from(content)),
        "/Filter /FlateDecode"
      );
      const started = performance.now();
      expect(readPdf(pdf)?.pages.length).toBe(200);
      expect(performance.now() - started).toBeLessThan(4000);
    }
  }, 30_000);

  test("caps LZW and RunLength output, including truncated streams", () => {
    const expanded = Buffer.from(
      " ".repeat(8 * 1024 * 1024) +
        "BT /F1 12 Tf 10 10 Td (Past the output cap.) Tj ET"
    );
    const lzw = lzwEncode(expanded);
    const rle = runLengthEncode(expanded);
    for (const [filter, bytes] of [
      ["LZWDecode", lzw],
      ["RunLengthDecode", rle],
    ] as const) {
      for (const data of [bytes, bytes.subarray(0, bytes.length >> 1)]) {
        const pdf = sharedContent(data, `/Filter /${filter}`);
        const started = performance.now();
        const result = readPdf(pdf)!;
        expect(result.pages.length).toBe(200);
        expect(result.pages[0]!.text).toBe("");
        expect(performance.now() - started).toBeLessThan(4000);
      }
    }
  }, 30_000);
});
