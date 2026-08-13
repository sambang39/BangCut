#!/usr/bin/env python3
"""Clone a Premiere-native .mogrt with new Source Text.
Usage: mogrt_build.py <src.mogrt> <new text> <out.mogrt>
"""
import sys, re, base64, gzip, zipfile, io

src, new_text, out = sys.argv[1], sys.argv[2], sys.argv[3]

with zipfile.ZipFile(src) as z:
    names = z.namelist()
    files = {n: z.read(n) for n in names}

prg_name = next(n for n in names if n.endswith(".prgraphic"))
with zipfile.ZipFile(io.BytesIO(files[prg_name])) as pz:
    pnames = pz.namelist()
    pfiles = {n: pz.read(n) for n in pnames}

proj_name = next(n for n in pnames if n.endswith(".prproj"))
xml = gzip.decompress(pfiles[proj_name]).decode("utf-8")

def patch_xml(xml, new_text):
    nb = new_text.encode("utf-8")
    patched = 0
    def repl(m):
        nonlocal patched
        b64 = re.sub(r"\s", "", m.group(2))
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return m.group(0)
        import struct
        for off in range(len(raw) - 8, 3, -1):
            (L,) = struct.unpack_from("<I", raw, off - 4) if off >= 4 else (0,)
            if 0 < L <= len(raw) - off and off + L >= len(raw) - 8:
                seg = raw[off:off + L]
                try:
                    seg.decode("utf-8")
                except Exception:
                    continue
                new_raw = raw[:off - 4] + struct.pack("<I", len(nb)) + nb + raw[off + L:]
                patched += 1
                nb64 = base64.b64encode(new_raw).decode()
                return m.group(1) + nb64 + m.group(3)
        return m.group(0)
    parts = re.split(r"(<Name>Source Text</Name>)", xml)
    outp = [parts[0]]
    for i in range(1, len(parts), 2):
        block = parts[i + 1]
        block = re.sub(
            r'(<StartKeyframeValue Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(</StartKeyframeValue>)',
            repl, block, count=1)
        outp.append(parts[i]); outp.append(block)
    return "".join(outp), patched

xml2, n = patch_xml(xml, new_text)
if n == 0:
    sys.exit("ERROR: no Source Text blob patched")
xml2 = re.sub(r"<InstanceName>[^<]*</InstanceName>",
              "<InstanceName>" + new_text + "</InstanceName>", xml2, count=1)

pfiles[proj_name] = gzip.compress(xml2.encode("utf-8"))

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as pz:
    for nname in pnames:
        pz.writestr(nname, pfiles[nname])
files[prg_name] = buf.getvalue()

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for nname in names:
        z.writestr(nname, files[nname])
print("OK patched=%d -> %s" % (n, out))
