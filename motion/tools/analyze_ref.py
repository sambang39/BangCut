#!/usr/bin/env python3
"""Offline census of reference prprojs ('07', '01(Renewal)'): sequences, Blur ALs,
말풍선 masters, caption tracks. Read-only."""
import gzip, re, sys, json

P07 = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/07/07_실비보험료 매달 내면서 '이것' 안 챙기셨나요? 보험사가 절대 먼저 안 알려주는 3가지 권리!.prproj"
P01 = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/01(Renewal)/01(Renewal).prproj"

import unicodedata
def load(p):
    p = unicodedata.normalize("NFD", p)
    return gzip.decompress(open(p, "rb").read()).decode("utf-8")

def index(s):
    objs = {}
    for m in re.finditer(r'<(\w+) ObjectID="(\d+)"', s):
        tag, oid = m.group(1), int(m.group(2))
        end = s.find("</" + tag + ">", m.start())
        objs[oid] = (tag, m.start(), end + len(tag) + 3)
    return objs

for label, path in [("07", P07), ("01R", P01)]:
    s = load(path)
    print("=== %s === size %.1fMB" % (label, len(s) / 1e6))
    for m in re.finditer(r'<Sequence ObjectID="(\d+)"[^>]*>', s):
        a = m.start()
        end = s.find("</Sequence>", a)
        nm = re.search(r"<Name>([^<]*)</Name>", s[a:end])
        print("  seq:", nm.group(1) if nm else "?", "oid", m.group(1))
    for fx in ["AE.ADBE Gaussian Blur 2", "AE.ADBE Tint", "AE.ADBE Fill", "AE.ADBE Black&White"]:
        print("  fx %-26s x%d" % (fx, s.count(fx)))
    from collections import Counter
    for kw in ["말풍선", "Blur", "블러"]:
        names = Counter(re.findall(r"<Name>([^<]*%s[^<]*)</Name>" % kw, s))
        print("  name~%s:" % kw, dict(list(names.items())[:8]))
    trks = []
    for m in re.finditer(r'<CaptionDataClipTrack ObjectUID="([\w-]+)"', s):
        a = m.start(); end = s.find("</CaptionDataClipTrack>", a)
        n = len(re.findall(r'<TrackItem Index', s[a:end]))
        trks.append((m.group(1)[:8], n))
    print("  caption tracks:", trks)
    print()
