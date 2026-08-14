#!/usr/bin/env python3
"""Deep extraction from reference prprojs (read-only):
A) '07' Blur AL donor (Gaussian Blur + Tint params/keyframes)
B) '01R' 말풍선 nested internals
C) caption<->Graphic text pairs (emphasis phrasing style)
Writes ref_style_db.json + stdout report."""
import gzip, re, json, base64, struct, unicodedata

TICKS = 254016000000.0
P07 = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/07/07_실비보험료 매달 내면서 '이것' 안 챙기셨나요? 보험사가 절대 먼저 안 알려주는 3가지 권리!.prproj"
P01 = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/01(Renewal)/01(Renewal).prproj"

def load(p):
    return gzip.decompress(open(unicodedata.normalize("NFD", p), "rb").read()).decode("utf-8")

def index(s):
    objs = {}
    for m in re.finditer(r'<(\w+) ObjectID="(\d+)"', s):
        tag, oid = m.group(1), int(m.group(2))
        end = s.find("</" + tag + ">", m.start())
        objs[oid] = (tag, m.start(), end + len(tag) + 3)
    return objs

def tail_text(raw):
    for off in range(len(raw) - 8, 3, -1):
        (L,) = struct.unpack_from("<I", raw, off - 4)
        if 0 < L <= len(raw) - off and off + L >= len(raw) - 8:
            try:
                return raw[off:off + L].decode("utf-8")
            except UnicodeDecodeError:
                continue
    return None

db = {}

# ---------- A) '07' Blur AL donor ----------
s = load(P07); objs = index(s)
def body(oid):
    t, a, b = objs[oid]
    return s[a:b]

blur_report = []
for m in re.finditer(r'<VideoClipTrackItem ObjectID="(\d+)"', s):
    oid = int(m.group(1)); blk = body(oid)
    sub = re.search(r'<SubClip ObjectRef="(\d+)"/>', blk)
    ch = re.search(r'<Components ObjectRef="(\d+)"/>', blk)
    st = re.search(r"<Start>(\d+)</Start>", blk)
    en = re.search(r"<End>(\d+)</End>", blk)
    if not (sub and ch):
        continue
    nm = re.search(r"<Name>([^<]*)</Name>", body(int(sub.group(1))))
    if not nm or nm.group(1) != "Blur":
        continue
    item = {"t0": round(int(st.group(1)) / TICKS, 2) if st else None,
            "t1": round(int(en.group(1)) / TICKS, 2) if en else None, "fx": []}
    chain = body(int(ch.group(1)))
    for cref in re.findall(r'<Component Index="\d+" ObjectRef="(\d+)"/>', chain):
        fb = body(int(cref))
        mn = re.search(r"<MatchName>([^<]*)</MatchName>", fb)
        if not mn or mn.group(1) in ("AE.ADBE Opacity", "AE.ADBE Motion"):
            continue
        fx = {"match": mn.group(1), "params": []}
        for pref in re.findall(r'<Param Index="\d+" ObjectRef="(\d+)"/>', fb):
            pb = body(int(pref))
            pn = re.search(r"<Name>([^<]*)</Name>", pb)
            kf = re.search(r"<Keyframes>([^<]+)</Keyframes>", pb)
            sv = re.search(r"<StartKeyframeValue[^>]*>([^<]{0,60})", pb)
            entry = {"name": pn.group(1) if pn else "?"}
            if kf:
                keys = []
                for e in kf.group(1).strip().split(";"):
                    if not e.strip():
                        continue
                    parts = e.split(",")
                    keys.append({"t": round(int(parts[0]) / TICKS, 4), "v": parts[1],
                                 "interp": parts[2] if len(parts) > 2 else None})
                entry["keys"] = keys
            elif sv:
                entry["start"] = sv.group(1).strip()
            if "keys" in entry or "start" in entry:
                fx["params"].append(entry)
        item["fx"].append(fx)
    blur_report.append(item)
db["blur_al_07"] = blur_report
print("=== A) '07' Blur AL instances:", len(blur_report))
for it in blur_report[:8]:
    print(" ", it["t0"], "->", it["t1"])
    for fx in it["fx"]:
        print("    ", fx["match"])
        for p in fx["params"]:
            if "keys" in p:
                print("       %s keys: %s" % (p["name"], [(k["t"], k["v"], k["interp"]) for k in p["keys"]]))
            else:
                print("       %s = %s" % (p["name"], p.get("start")))

# ---------- B)+C) on '01R' ----------
s = load(P01); objs = index(s)

seq_names = {}
for m in re.finditer(r'<Sequence ObjectID="(\d+)"', s):
    oid = int(m.group(1)); blk = body(oid)
    nm = re.search(r"<Name>([^<]*)</Name>", blk)
    if nm:
        seq_names[nm.group(1)] = oid
print("\n=== B) '01R' sequences w/ 말풍선:", [k for k in seq_names if "말풍선" in k])

# caption cues
uid = re.search(r'<CaptionDataClipTrack ObjectUID="(1a706d79[\w-]+)"', s).group(1)
a = s.find('<CaptionDataClipTrack ObjectUID="%s"' % uid)
end = s.find("</CaptionDataClipTrack>", a)
cues = []
for r in re.findall(r'<TrackItem Index="\d+" ObjectRef="(\d+)"/>', s[a:end]):
    blk = body(int(r))
    st = re.search(r"<Start>(\d+)</Start>", blk)
    en = re.search(r"<End>(\d+)</End>", blk)
    bv = re.search(r'<BlockVectorItem Index="0" ObjectRef="(\d+)"/>', blk)
    txt = None
    if bv:
        bb = body(int(bv.group(1)))
        b64 = re.search(r'>([A-Za-z0-9+/=\s]{40,})</FormattedTextData>', bb)
        if not b64:
            h = re.search(r'BinaryHash="([\w-]+)"', bb)
            if h:
                b64 = re.search(r'BinaryHash="%s">([A-Za-z0-9+/=\s]{40,})</FormattedTextData>' % h.group(1), s)
        if b64:
            txt = tail_text(base64.b64decode(re.sub(r"\s", "", b64.group(1))))
    cues.append({"t0": round(int(st.group(1)) / TICKS, 2) if st else 0,
                 "t1": round(int(en.group(1)) / TICKS, 2) if en else 0, "text": txt})
cues = [c for c in cues if c["text"]]
cues.sort(key=lambda c: c["t0"])
print("\n=== C) '01R' captions decoded:", len(cues), "| sample:", [c["text"] for c in cues[:2]])

graphics = []
for m in re.finditer(r'<VideoClipTrackItem ObjectID="(\d+)"', s):
    oid = int(m.group(1)); blk = body(oid)
    sub = re.search(r'<SubClip ObjectRef="(\d+)"/>', blk)
    ch = re.search(r'<Components ObjectRef="(\d+)"/>', blk)
    st = re.search(r"<Start>(\d+)</Start>", blk)
    en = re.search(r"<End>(\d+)</End>", blk)
    if not (sub and ch and st):
        continue
    nm = re.search(r"<Name>([^<]*)</Name>", body(int(sub.group(1))))
    if not nm or nm.group(1) != "Graphic":
        continue
    chain = body(int(ch.group(1)))
    texts = []
    for cref in re.findall(r'<Component Index="\d+" ObjectRef="(\d+)"/>', chain):
        fb = body(int(cref))
        mn = re.search(r"<MatchName>([^<]*)</MatchName>", fb)
        if mn and mn.group(1) == "AE.ADBE Text":
            inm = re.search(r"<InstanceName>([^<]*)</InstanceName>", fb)
            if inm:
                texts.append(inm.group(1))
    if texts:
        graphics.append({"t0": round(int(st.group(1)) / TICKS, 2),
                         "t1": round(int(en.group(1)) / TICKS, 2) if en else None, "layers": texts})
graphics.sort(key=lambda g: g["t0"])
print("Graphic clips w/ text:", len(graphics))

pairs = []
for g in graphics:
    mid = (g["t0"] + (g["t1"] or g["t0"] + 2)) / 2
    hit = None
    for c in cues:
        if c["t0"] - 0.3 <= mid <= c["t1"] + 0.3:
            hit = c
            break
    pairs.append({"t": g["t0"], "cap": hit["text"] if hit else None, "emph": g["layers"]})
print("pairs:", len(pairs))
for p in pairs[:45]:
    print(" %7.1f  CAP: %s" % (p["t"], (p["cap"] or "-")[:36]))
    print("          EMP: %s" % (" | ".join(x[:42] for x in p["emph"])))

db["captions_01R"] = cues
db["graphics_01R"] = graphics
db["pairs_01R"] = pairs
json.dump(db, open("ref_style_db.json", "w"), ensure_ascii=False, indent=1)
print("\nwrote ref_style_db.json")
