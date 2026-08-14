#!/usr/bin/env python3
"""Inject zoom-preset Transform components into bare Zoom AL clips in a .prproj.
Usage: surgery_inject.py <prproj> <jobs.json>   # jobs: [{"t": seconds, "scale": 105|110|115|120}]
Premiere MUST be closed. Creates <prproj>.surgery_bak backup.
"""
import re, json, gzip, shutil, sys

SP = "/private/tmp/claude-501/-Users-apple-Desktop-Bang-s-Work-VideoGraphy-Youtube----------Claude-/e0e1b45e-4fac-4f1c-aace-33821e66d0dc/scratchpad"
TICKS = 254016000000

prproj, jobsfile = sys.argv[1], sys.argv[2]
jobs = json.load(open(jobsfile, encoding="utf-8"))
lib = json.load(open(SP + "/donor_lib.json", encoding="utf-8"))

shutil.copy2(prproj, prproj + ".surgery_bak")
s = gzip.decompress(open(prproj, "rb").read()).decode("utf-8")

def index(src):
    objs = {}
    for m in re.finditer(r'<(\w+) ObjectID="(\d+)"', src):
        tag, oid = m.group(1), int(m.group(2))
        end = src.find("</" + tag + ">", m.start())
        objs[oid] = (tag, m.start(), end + len(tag) + 3)
    return objs

objs = index(s)
maxid = max(objs.keys())

patches = []
appends = []
report = []
for job in jobs:
    want = job["t"]; scale = str(job["scale"])
    hit = None
    for m in re.finditer(r'<VideoClipTrackItem ObjectID="(\d+)"', s):
        oid = int(m.group(1)); t, a, b = objs[oid]; blk = s[a:b]
        sub = re.search(r'<SubClip ObjectRef="(\d+)"/>', blk)
        ch = re.search(r'<Components ObjectRef="(\d+)"/>', blk)
        st = re.search(r"<Start>(\d+)</Start>", blk)
        if not (sub and ch and st):
            continue
        sa = objs[int(sub.group(1))]
        nm = re.search(r"<Name>([^<]*)</Name>", s[sa[1]:sa[2]])
        if not nm or nm.group(1) != "Zoom":
            continue
        if abs(int(st.group(1)) / TICKS - want) > 0.05:
            continue
        chain_oid = int(ch.group(1))
        ca = objs[chain_oid]
        chain_blk = s[ca[1]:ca[2]]
        has_tf = any("AE.ADBE Geometry2" in s[objs[int(c)][1]:objs[int(c)][2]]
                     for c in re.findall(r'<Component Index="\d+" ObjectRef="(\d+)"/>', chain_blk))
        if has_tf:
            continue
        hit = (oid, chain_oid, chain_blk)
        break
    if not hit:
        report.append("MISS t=%s" % want)
        continue
    oid, chain_oid, chain_blk = hit
    donor = lib[scale]
    idmap = {}
    for old in donor["objects"]:
        maxid += 1
        idmap[old] = str(maxid)
    blocks = []
    for old, xml in donor["objects"].items():
        def rp(mm):
            return mm.group(1) + idmap.get(mm.group(2), mm.group(2)) + '"'
        xml2 = re.sub(r'(ObjectID=")(\d+)"', rp, xml)
        xml2 = re.sub(r'(ObjectRef=")(\d+)"', rp, xml2)
        blocks.append(xml2)
    new_root = idmap[str(donor["root"])]
    ncomps = len(re.findall(r'<Component Index="\d+"', chain_blk))
    if "</Components>" in chain_blk:
        new_chain = chain_blk.replace("</Components>",
            '\t<Component Index="%d" ObjectRef="%s"/>\n\t\t\t</Components>' % (ncomps, new_root), 1)
    else:
        new_chain = chain_blk.replace("</Node>",
            '</Node>\n\t\t\t<Components Version="1">\n\t\t\t\t<Component Index="0" ObjectRef="%s"/>\n\t\t\t</Components>' % new_root, 1)
    if new_chain == chain_blk:
        report.append("PATCH-FAIL t=%s (no anchor)" % want); continue
    patches.append((chain_blk, new_chain))
    appends.append("\n\t".join(blocks))
    report.append("OK t=%s scale=%s clip=%d chain=%d newroot=%s comps %d->%d"
                  % (want, scale, oid, chain_oid, new_root, ncomps, ncomps + 1))

for old, new in patches:
    s = s.replace(old, new, 1)
tail = s.rfind("</PremiereData>")
s = s[:tail] + "\t" + "\n\t".join(appends) + "\n" + s[tail:]

open(prproj, "wb").write(gzip.compress(s.encode("utf-8")))
ver = gzip.decompress(open(prproj,"rb").read()).decode("utf-8")
for line in report:
    if line.startswith("OK"):
        nr = line.split("newroot=")[1].split()[0]
        line2 = "VERIFY ref %s: %d" % (nr, ver.count('ObjectRef="%s"' % nr))
        report.append(line2)
print("\n".join(report))
print("written:", prproj, "backup:", prproj + ".surgery_bak")
