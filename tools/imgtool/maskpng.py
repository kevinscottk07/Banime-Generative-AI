"""Alpha-mask PNG writer (pure Python, no deps).

Event: {"bucket": "...", "src": "key.png", "dst": "key-mask.png", "op": "alpha_mask", "scale": 1}
Reads an 8-bit RGBA PNG and writes a gray+alpha PNG whose alpha channel is the
source alpha (gray = 0). Used to turn a background-removed cutout into a small
CSS mask image. Optional integer `scale` box-downsamples the mask.
"""
import struct
import zlib


def _chunks(data):
    i = 8
    while i < len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        yield data[i + 4:i + 8], data[i + 8:i + 8 + n]
        i += 12 + n


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_rgba(data):
    idat = b""
    for typ, body in _chunks(data):
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
    if depth != 8 or ctype not in (2, 6):
        raise ValueError(f"unsupported PNG depth={depth} color={ctype}")
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                ul = prev[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + _paeth(left, prev[x], ul)) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bpp, out


def encode_ga(w, h, alpha):
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        row = bytearray(w * 2)
        row[1::2] = alpha[y * w:(y + 1) * w]
        rows += row

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def alpha_mask(s3, event):
    data = s3.get_object(Bucket=event["bucket"], Key=event["src"])["Body"].read()
    w, h, bpp, px = decode_rgba(data)
    if bpp != 4:
        raise ValueError("source has no alpha channel")
    alpha = px[3::4]
    k = int(event.get("scale", 1))
    if k > 1:
        nw, nh = w // k, h // k
        small = bytearray(nw * nh)
        for y in range(nh):
            for x in range(nw):
                s = 0
                for dy in range(k):
                    base = (y * k + dy) * w + x * k
                    s += sum(alpha[base:base + k])
                small[y * nw + x] = s // (k * k)
        w, h, alpha = nw, nh, small
    png = encode_ga(w, h, alpha)
    s3.put_object(Bucket=event["bucket"], Key=event["dst"], Body=png, ContentType="image/png")
    return {"w": w, "h": h, "bytes": len(png)}
