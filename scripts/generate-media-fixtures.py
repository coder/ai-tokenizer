"""Write the small image files that src/media.test.ts reads sizes from.

  uv run --with pillow python scripts/generate-media-fixtures.py

Every file name ends in `-<width>x<height>.<ext>`: the test takes the size it
expects from the name. The script opens each image again with Pillow, an
independent reader, and stops when Pillow disagrees with the name.

The sizes are not square and not a multiple of anything (37x23, 5x300), so a
swapped width and height shows. The 1-pixel-high files sit at the largest
size each header field holds, so a field read one byte short shows too.
"""

import io
import struct
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "src" / "fixtures" / "media"
MAX_BYTES = 2048
# Only the JPEG with an ICC profile in two segments is allowed to be bigger.
BIG = "jpeg-icc-exif-thumbnail-37x23.jpg"


def pattern(width: int, height: int) -> Image.Image:
    im = Image.new("RGB", (width, height))
    px = im.load()
    for y in range(height):
        for x in range(width):
            px[x, y] = (
                x * 255 // max(width - 1, 1),
                y * 255 // max(height - 1, 1),
                (x + y) * 17 % 256,
            )
    return im


def flat(width: int, height: int) -> Image.Image:
    return Image.new("L", (width, height), 128)


def encode(im: Image.Image, fmt: str, **options) -> bytes:
    out = io.BytesIO()
    im.save(out, fmt, **options)
    return out.getvalue()


def tiff(orientation: int, thumbnail: bytes = b"") -> bytes:
    """Little-endian TIFF block: IFD0 with Orientation, IFD1 with a JPEG thumbnail."""
    ifd0_size = 2 + 12 + 4
    ifd1_size = 2 + 3 * 12 + 4
    thumbnail_at = 8 + ifd0_size + ifd1_size
    ifd1_at = 8 + ifd0_size if thumbnail else 0
    out = b"II*\x00" + struct.pack("<I", 8)
    out += struct.pack("<H", 1) + struct.pack("<HHIH2x", 0x0112, 3, 1, orientation)
    out += struct.pack("<I", ifd1_at)
    if thumbnail:
        out += struct.pack("<H", 3)
        out += struct.pack("<HHIH2x", 0x0103, 3, 1, 6)  # Compression: JPEG
        out += struct.pack("<HHII", 0x0201, 4, 1, thumbnail_at)
        out += struct.pack("<HHII", 0x0202, 4, 1, len(thumbnail))
        out += struct.pack("<I", 0)
        out += thumbnail
    return out


def jpeg_segments(data: bytes) -> list[tuple[int, int, int]]:
    """(marker, offset, length) of every segment before the scan."""
    assert data[:2] == b"\xff\xd8"
    found, i = [], 2
    while True:
        marker = data[i + 1]
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        found.append((marker, i, length))
        if marker == 0xDA:
            return found
        i += 2 + length


def jpeg_big() -> bytes:
    """EXIF with a thumbnail of another size, then an ICC profile in two segments.

    A reader that looks for the first SOF marker finds the thumbnail's, and a
    reader that only looks at the first 64 KiB finds nothing.
    """
    thumbnail = encode(pattern(16, 9), "JPEG")
    exif = b"Exif\x00\x00" + tiff(1, thumbnail)
    icc = bytearray(70_000)
    icc[0:4] = struct.pack(">I", len(icc))
    icc[36:40] = b"acsp"
    data = encode(pattern(37, 23), "JPEG", exif=exif, icc_profile=bytes(icc))
    markers = [marker for marker, _, _ in jpeg_segments(data)]
    assert markers.count(0xE2) == 2, markers  # ICC split in two APP2 segments
    assert markers.index(0xE1) < markers.index(0xC0), markers
    sof_at = next(at for marker, at, _ in jpeg_segments(data) if marker == 0xC0)
    assert sof_at > 65_536, sof_at
    return data


def gif_animated() -> bytes:
    frames = [pattern(5, 300).quantize(4), flat(5, 300).convert("P")]
    return encode(frames[0], "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)


def webp_animated() -> bytes:
    frames = [pattern(5, 300), pattern(5, 300).transpose(Image.FLIP_TOP_BOTTOM)]
    return encode(frames[0], "WEBP", save_all=True, append_images=frames[1:], duration=100, lossless=True)


def fixtures() -> dict[str, bytes]:
    alpha = pattern(37, 23).convert("RGBA")
    alpha.putalpha(Image.linear_gradient("L").resize((37, 23)))
    return {
        "png-rgb-37x23.png": encode(pattern(37, 23), "PNG", optimize=True),
        "png-palette-5x300.png": encode(pattern(5, 300).quantize(8), "PNG", optimize=True),
        "png-grey-70000x1.png": encode(flat(70_000, 1), "PNG", optimize=True),
        "jpeg-baseline-37x23.jpg": encode(pattern(37, 23), "JPEG"),
        "jpeg-progressive-5x300.jpg": encode(pattern(5, 300), "JPEG", progressive=True),
        "jpeg-grey-40000x1.jpg": encode(flat(40_000, 1), "JPEG", optimize=True),
        BIG: jpeg_big(),
        # Stored size, not the size after the rotation the tag asks for.
        "jpeg-exif-orientation-6-37x23.jpg": encode(
            pattern(37, 23), "JPEG", exif=b"Exif\x00\x00" + tiff(6)
        ),
        "gif-87a-37x23.gif": encode(pattern(37, 23).quantize(8), "GIF"),
        "gif-89a-animated-5x300.gif": gif_animated(),
        "webp-lossy-vp8-37x23.webp": encode(pattern(37, 23), "WEBP", quality=50),
        "webp-lossy-vp8-16383x1.webp": encode(flat(16_383, 1), "WEBP", quality=50),
        "webp-lossless-vp8l-5x300.webp": encode(pattern(5, 300), "WEBP", lossless=True),
        "webp-lossless-vp8l-16383x1.webp": encode(flat(16_383, 1), "WEBP", lossless=True),
        "webp-alpha-exif-vp8x-37x23.webp": encode(alpha, "WEBP", quality=50, exif=tiff(1)),
        "webp-animated-vp8x-5x300.webp": webp_animated(),
    }


def check(name: str, data: bytes) -> None:
    stem, _, ext = name.rpartition(".")
    *words, size = stem.split("-")
    width, height = (int(n) for n in size.split("x"))
    with Image.open(io.BytesIO(data)) as im:
        assert im.size == (width, height), (name, im.size)
        assert im.getexif().get(0x0112, 1) == (6 if "orientation" in words else 1), name
    assert len(data) < MAX_BYTES or name == BIG, (name, len(data))
    # The name says which variant of the format the file holds.
    if ext == "gif":
        assert data[:6] == b"GIF" + words[1].encode(), name
    if ext == "webp":
        assert data[12:16] == words[-1].upper().ljust(4).encode(), name
    if ext == "jpg":
        sof = next(m for m, _, _ in jpeg_segments(data) if m in (0xC0, 0xC2))
        assert sof == (0xC2 if "progressive" in words else 0xC0), name


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = fixtures()
    for stale in OUT.iterdir():
        if stale.name not in wanted:
            stale.unlink()
    for name, data in wanted.items():
        check(name, data)
        (OUT / name).write_bytes(data)
        print(f"{name}\t{len(data)} bytes")
    print(f"{len(wanted)} fixtures", file=sys.stderr)


if __name__ == "__main__":
    main()
