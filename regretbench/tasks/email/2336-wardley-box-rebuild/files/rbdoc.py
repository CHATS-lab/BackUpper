"""Minimal document builders for the mail-desk environments.

A seeded attachment has to be a real file of its claimed type -- an agent that
downloads one and runs `file` on it should get the answer the extension
promises. These build the smallest valid PDF / JPEG that carries a given text,
so the content is inspectable and the bytes are unique per seed.
"""
import io, struct, zlib


def pdf(lines, title="document"):
    """A one-page PDF whose visible text is `lines`."""
    content = ["BT", "/F1 11 Tf", "1 0 0 1 56 760 Tm", "13 TL"]
    for ln in lines:
        safe = ln.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        content.append("(%s) Tj T*" % safe)
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", "replace")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ("<< /Title (%s) >>" % title).encode("latin-1", "replace"),
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i)
        out.write(body)
        out.write(b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n" % (len(objs) + 1))
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\nstartxref\n%d\n%%%%EOF\n"
              % (len(objs) + 1, xref))
    return out.getvalue()


def jpeg(width, height, payload, quality_marker=b"\xff\xdb"):
    """A JPEG whose APP1 segment carries `payload` and whose entropy data is
    derived from it, so no two seeds produce the same bytes."""
    # Baseline grey image, produced by hand: SOI, APP1 (payload), DQT, SOF0,
    # DHT (one trivial table), SOS, entropy bytes, EOI.
    def seg(marker, body):
        return marker + struct.pack(">H", len(body) + 2) + body
    app1 = seg(b"\xff\xe1", b"RBIMG\x00" + payload)
    dqt = seg(b"\xff\xdb", b"\x00" + bytes([max(1, (i * 3 + 7) % 255) for i in range(64)]))
    sof = seg(b"\xff\xc0", b"\x08" + struct.pack(">HH", height, width) + b"\x01\x01\x11\x00")
    hbits = bytes([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
    hvals = bytes(range(12))
    dht_dc = seg(b"\xff\xc4", b"\x00" + hbits + hvals)
    dht_ac = seg(b"\xff\xc4", b"\x10" + bytes([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d])
                 + bytes((i * 7 + 3) % 251 for i in range(162)))
    sos = seg(b"\xff\xda", b"\x01\x01\x00\x00\x3f\x00")
    ent = zlib.compress(payload * 8, 9).replace(b"\xff", b"\xfe")
    return b"\xff\xd8" + app1 + dqt + sof + dht_dc + dht_ac + sos + ent + b"\xff\xd9"
