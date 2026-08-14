#!/usr/bin/env python3
"""Batch-build text-patched mogrts for all emphasis jobs via mogrt_build.py."""
import json, os, subprocess, sys, unicodedata

SP = os.path.dirname(os.path.abspath(__file__))
TOOLS = "/Users/apple/Desktop/Bang's Work/Coding/Adobe_Premiere Pro Extansion_BangCut/motion/tools"
OUT = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/09/(Footage)/Mogrt_auto"
OUT = unicodedata.normalize("NFD", OUT)
os.makedirs(OUT, exist_ok=True)

jobs = json.load(open(SP + "/emph_jobs.json"))
ok = fail = 0
for i, j in enumerate(jobs):
    dst = os.path.join(OUT, "em_%02d_%s.mogrt" % (i + 1, j["tpl"]))
    r = subprocess.run([sys.executable, TOOLS + "/mogrt_build.py", j["file"], j["text"], dst],
                       capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(dst):
        j["built"] = dst; ok += 1
    else:
        j["built"] = None; fail += 1
        print("FAIL", i + 1, j["tpl"], r.stderr.strip()[:120] or r.stdout.strip()[:120])
json.dump(jobs, open(SP + "/emph_built.json", "w"), ensure_ascii=False, indent=1)
print("built %d ok, %d fail -> %s" % (ok, fail, OUT))
