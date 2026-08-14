#!/usr/bin/env python3
"""Extract Transform-preset donor closures (105/110/115/120) from prproj XML files.
Output: donor_lib.json {scale: {"root": oid, "objects": {oid: xml}}}
"""
import re, json, gzip

SP = "/private/tmp/claude-501/-Users-apple-Desktop-Bang-s-Work-VideoGraphy-Youtube----------Claude-/e0e1b45e-4fac-4f1c-aace-33821e66d0dc/scratchpad"

def index(s):
    objs = {}
    for m in re.finditer(r'<(\w+) ObjectID="(\d+)"', s):
        tag, oid = m.group(1), int(m.group(2))
        end = s.find("</" + tag + ">", m.start())
        objs[oid] = (tag, m.start(), end + len(tag) + 3)
    return objs

def closure(s, objs, root):
    seen, stack = set(), [root]
    while stack:
        o = stack.pop()
        if o in seen or o not in objs:
            continue
        seen.add(o)
        t, a, b = objs[o]
        for r in re.findall(r'ObjectRef="(\d+)"', s[a:b]):
            stack.append(int(r))
    return seen

def find_donors(s, objs):
    out = {}
    for m in re.finditer(r'<VideoClipTrackItem ObjectID="(\d+)"', s):
        oid = int(m.group(1))
        t, a, b = objs[oid]
        blk = s[a:b]
        sub = re.search(r'<SubClip ObjectRef="(\d+)"/>', blk)
        ch = re.search(r'<Components ObjectRef="(\d+)"/>', blk)
        if not sub or not ch:
            continue
        st, sa, sb = objs[int(sub.group(1))]
        nm = re.search(r"<Name>([^<]*)</Name>", s[sa:sb])
        if not nm or nm.group(1) != "Zoom":
            continue
        ct, ca, cb = objs[int(ch.group(1))]
        for cref in re.findall(r'<Component Index="\d+" ObjectRef="(\d+)"/>', s[ca:cb]):
            ft, fa, fb = objs[int(cref)]
            fblk = s[fa:fb]
            if "AE.ADBE Geometry2" not in fblk:
                continue
            cl = closure(s, objs, int(cref))
            scale = None
            for o in cl:
                ot, oa, ob = objs[o]
                pb = s[oa:ob]
                kf = re.search(r"<Keyframes>([^<]+)</Keyframes>", pb)
                if kf and "Scale" in pb:
                    entries = [e for e in kf.group(1).strip().split(";") if e.strip()]
                    if entries:
                        scale = int(float(entries[-1].split(",")[1]))
            if scale and scale not in out:
                out[scale] = (int(cref), cl)
    return out

lib = {}
for src in ["current", "backup"]:
    if src == "current":
        s = open(SP + "/proj_current.xml", encoding="utf-8").read()
    else:
        s = gzip.decompress(open("/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/09/09_복구본_1905.prproj", "rb").read()).decode("utf-8")
    objs = index(s)
    donors = find_donors(s, objs)
    for scale, (root, cl) in donors.items():
        if scale in lib:
            continue
        lib[scale] = {"root": root,
                      "objects": {str(o): s[objs[o][1]:objs[o][2]] for o in cl}}
    print(src, "->", sorted(donors.keys()))

json.dump(lib, open(SP + "/donor_lib.json", "w", encoding="utf-8"))
print("LIB scales:", sorted(lib.keys()),
      "sizes:", {k: len(v["objects"]) for k, v in lib.items()})
