#!/usr/bin/env python3
"""Transplant C1 caption style onto C2 track blocks by swapping FormattedTextData
BinaryHash references to the styled C1 blobs (same text -> same rendered string).
Premiere MUST be closed. Creates <prproj>.capstyle_bak.
Usage: cap_style_surgery.py <prproj> <c1_track_uid> <c2_track_uid>
"""
import re, base64, struct, gzip, shutil, sys

prproj, C1_UID, C2_UID = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copy2(prproj, prproj + ".capstyle_bak")
s = gzip.decompress(open(prproj, "rb").read()).decode("utf-8")

def tail_text(raw):
    for off in range(len(raw) - 8, 3, -1):
        (L,) = struct.unpack_from("<I", raw, off - 4)
        if 0 < L <= len(raw) - off and off + L >= len(raw) - 8:
            try:
                return raw[off:off + L].decode("utf-8")
            except UnicodeDecodeError:
                continue
    return None

objs = {}
for m in re.finditer(r'<(\w+) ObjectID="(\d+)"', s):
    tag, oid = m.group(1), int(m.group(2))
    end = s.find("</" + tag + ">", m.start())
    objs[oid] = (tag, m.start(), end + len(tag) + 3)

# global BinaryHash -> base64 data (from elements that carry data)
hash_data = {}
for m in re.finditer(r'<FormattedTextData Encoding="base64" BinaryHash="([\w-]+)">([A-Za-z0-9+/=\s]+)</FormattedTextData>', s):
    hash_data.setdefault(m.group(1), re.sub(r"\s", "", m.group(2)))

def track_block_elems(uid):
    """[(block_oid, hash, elem_str)] for a caption track."""
    a = s.find('<CaptionDataClipTrack ObjectUID="%s"' % uid)
    assert a >= 0, "track not found " + uid
    end = s.find("</CaptionDataClipTrack>", a)
    out = []
    for r in re.findall(r'<TrackItem Index="\d+" ObjectRef="(\d+)"/>', s[a:end]):
        t, aa, bb = objs[int(r)]
        bv = re.search(r'<BlockVectorItem Index="0" ObjectRef="(\d+)"/>', s[aa:bb])
        if not bv:
            continue
        bid = int(bv.group(1))
        bt, ba, bbnd = objs[bid]
        body = s[ba:bbnd]
        em = re.search(r'<FormattedTextData Encoding="base64" BinaryHash="([\w-]+)"\s*(?:/>|>[A-Za-z0-9+/=\s]*</FormattedTextData>)', body)
        if em:
            out.append((bid, em.group(1), em.group(0)))
    return out

def text_of_hash(h):
    if h not in hash_data:
        return None
    return tail_text(base64.b64decode(hash_data[h]))

# C1: text -> styled hash
c1_map = {}
for bid, h, elem in track_block_elems(C1_UID):
    txt = text_of_hash(h)
    if txt and txt not in c1_map:
        c1_map[txt] = h

# C2: rewrite each block's element to reference the styled hash (carry data too, safety)
patches = []
missing = []
for bid, h, elem in track_block_elems(C2_UID):
    txt = text_of_hash(h)
    if txt is None or txt not in c1_map:
        missing.append(txt)
        continue
    nh = c1_map[txt]
    new_elem = '<FormattedTextData Encoding="base64" BinaryHash="%s">%s\n\t\t</FormattedTextData>' % (nh, hash_data[nh])
    bt, ba, bbnd = objs[bid]
    old_body = s[ba:bbnd]
    new_body = old_body.replace(elem, new_elem, 1)
    if new_body != old_body:
        patches.append((old_body, new_body))

for old, new in patches:
    s = s.replace(old, new, 1)

open(prproj, "wb").write(gzip.compress(s.encode("utf-8")))
print("C1 texts mapped: %d | C2 patched: %d | missing: %d" % (len(c1_map), len(patches), len(missing)))
for t in missing[:8]:
    print("MISS:", repr(t))
print("written:", prproj, "backup:", prproj + ".capstyle_bak")
