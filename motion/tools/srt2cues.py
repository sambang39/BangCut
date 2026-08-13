#!/usr/bin/env python3
import sys, re, json

src, dst = sys.argv[1], sys.argv[2]
txt = open(src, encoding="utf-8-sig").read()
cues = []
for m in re.finditer(
        r"(\d+)\s*\n(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\s*\n(.*?)(?=\n\s*\n|\Z)",
        txt, re.S):
    g = m.groups()
    t0 = int(g[1]) * 3600 + int(g[2]) * 60 + int(g[3]) + int(g[4]) / 1000
    t1 = int(g[5]) * 3600 + int(g[6]) * 60 + int(g[7]) + int(g[8]) / 1000
    cues.append({"i": int(g[0]), "t0": round(t0, 3), "t1": round(t1, 3),
                 "text": " ".join(g[9].strip().splitlines())})
json.dump(cues, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("cues=%d span=%.1f~%.1f" % (len(cues), cues[0]["t0"], cues[-1]["t1"]))
