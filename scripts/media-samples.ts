/**
 * Images and PDFs generated from nothing but a size, for the scripts that
 * measure what providers charge for media. The pixels do not matter to a
 * provider's price, so a plain grey image of any size is a few kilobytes.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit grey PNG. Every pixel is `grey`; a second grey draws a diagonal so no codec shortcut applies. */
export function greyPng(width: number, height: number, grey = 128): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grey
  const rows = Buffer.alloc(height * (width + 1), grey);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // filter: none
    rows[y * (width + 1) + 1 + Math.floor((y * width) / height)] = 255 - grey;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * The image sizes every provider is measured at: tiny, one patch either side
 * of a boundary, odd aspect ratios, and above each provider's resize cap.
 */
export const MEASURED_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [8, 8],
  [14, 14],
  [27, 27],
  [28, 28],
  [29, 29],
  [56, 56],
  [100, 100],
  [200, 200],
  [256, 256],
  [300, 200],
  [384, 384],
  [385, 385],
  [512, 512],
  [513, 513],
  [640, 480],
  [768, 768],
  [769, 769],
  [1000, 1000],
  [1024, 1024],
  [1338, 579],
  [1568, 1568],
  [1569, 1569],
  [1920, 1080],
  [2048, 2048],
  [2576, 2576],
  [2577, 2577],
  [3000, 2000],
  [4000, 4000],
  [10, 1000],
  [1000, 10],
  [50, 2000],
  [2000, 50],
  [4000, 300],
];

export interface PdfPage {
  /** Page size in points. US Letter is 612 x 792. */
  width?: number;
  height?: number;
  /** Words of text, laid out in lines of 12 words. */
  words?: number;
  /** A grey image of this size in pixels, scaled over the whole page. */
  image?: readonly [number, number];
}

/** A PDF with these pages. It is a valid file: a text layer in Helvetica and optional page-sized images. */
export function pdf(pages: readonly PdfPage[]): Buffer {
  const objects: Array<Buffer | string> = [];
  const add = (body: Buffer | string) => objects.push(body) && objects.length;
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const page of pages) {
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    let resources = `/Font << /F1 ${font} 0 R >>`;
    let draw = "";
    if (page.image) {
      const [w, h] = page.image;
      const pixels = deflateSync(Buffer.alloc(w * h * 3, 128));
      const head = `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`;
      const imageObject = add(
        Buffer.concat([
          Buffer.from(head, "latin1"),
          pixels,
          Buffer.from("\nendstream"),
        ])
      );
      resources += ` /XObject << /Im0 ${imageObject} 0 R >>`;
      draw = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`;
    }
    const lines: string[] = [];
    for (let i = 0; i < (page.words ?? 0); i += 12) {
      const line = Array.from(
        { length: Math.min(12, (page.words ?? 0) - i) },
        (_, k) => `word${(i + k) % 97}`
      ).join(" ");
      lines.push(`(${line}) Tj 0 -14 Td`);
    }
    const text =
      lines.length > 0
        ? `BT /F1 11 Tf 36 ${height - 48} Td\n${lines.join("\n")}\nET\n`
        : "";
    const stream = draw + text;
    const contents = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << ${resources} >> /Contents ${contents} 0 R >>`
      )
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(part);
    length += part.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
