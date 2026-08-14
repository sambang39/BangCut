#!/usr/bin/env python3
"""Build full moment-plan job files for 09_Test regeneration.
Outputs: zoom_jobs.json, emph_jobs.json, bubble_jobs.json, so_jobs.json,
         mg_jobs.json, sfx_jobs.json, plan_report.txt
"""
import json, os, unicodedata

SP = os.path.dirname(os.path.abspath(__file__))
cuts = json.load(open(SP + "/v1_starts_clean.json"))
cues = {q["i"]: q for q in json.load(open(
    "/Users/apple/Desktop/Bang's Work/Coding/Adobe_Premiere Pro Extansion_BangCut/motion/tools/cues.json"))}

MOGRT_DIR = "/Users/apple/Desktop/Bang's Work/VideoGraphy/_템플릿/Mogrt"
SFX_DIR = "/Users/apple/Desktop/Bang's Work/VideoGraphy/_템플릿/사운드"

# resolve template number -> actual (NFD) filename
mogrt_files = {}
for f in os.listdir(MOGRT_DIR):
    if f.endswith(".mogrt"):
        key = unicodedata.normalize("NFC", f)
        mogrt_files[key.split("_")[0] + ("_L" if "_L" in key else "_R" if "_R" in key else
                    "_1" if "1번째" in key else "_2" if "2번째" in key else "_3" if "3번째" in key else "")] \
            = os.path.join(MOGRT_DIR, f)

sfx_files = {}
for f in os.listdir(SFX_DIR):
    if f.endswith((".mp3", ".wav")):
        sfx_files[unicodedata.normalize("NFC", f)] = os.path.join(SFX_DIR, f)

def sfx(name):
    assert name in sfx_files, "missing sfx " + name
    return name

# ---------- zooms: (cue_t0, scale) snapped to nearest cut ----------
ZOOMS = [(3.203,120),(9.7,110),(13.0,120),(18.5,120),(23.0,115),(28.1,105),
 (35.6,110),(44.8,105),(52.2,120),(60.2,110),(67.9,120),(82.9,110),(90.9,105),
 (96.3,110),(104.8,120),(116.3,110),(123.7,105),(131.0,120),(158.9,110),
 (206.8,110),(240.9,120),(249.2,105),(264.9,115),(272.9,120),(281.0,120),
 (287.8,105),(294.8,110),(306.3,110),(314.5,120),(319.5,105),(354.8,110),
 (362.6,120),(371.4,110),(381.8,105),(386.6,110),(404.2,115),(411.4,110),
 (419.5,105),(460.6,120),(498.6,105),(507.1,110),(517.0,115),(523.3,120),
 (533.2,105),(542.7,110),(552.5,110),(559.5,115),(568.1,120),(576.8,110),
 (582.4,105),(590.5,120),(600.9,120),(614.5,110),(623.9,105),(630.0,110)]

zoom_jobs = []
for t, sc in ZOOMS:
    snap = min(cuts, key=lambda c: abs(c - t))
    if abs(snap - t) > 0.8:
        snap = t
    nxt = [c for c in cuts if c > snap + 0.01]
    end = nxt[0] if nxt else snap + 2.5
    # extend across micro-cuts to reach >=1.2s, clamp 4.5s
    while end - snap < 1.2:
        n2 = [c for c in cuts if c > end + 0.01]
        if not n2: break
        end = n2[0]
    end = min(end, snap + 4.5)
    zoom_jobs.append({"t0": round(snap, 3), "t1": round(end, 3), "scale": sc})
# dedupe by t0
seen = set(); zoom_jobs = [z for z in zoom_jobs if not (z["t0"] in seen or seen.add(z["t0"]))]

# ---------- emphasis: (cue_i or (t0,t1), template_key, text, mood) ----------
E = [
 (3,"009","들어보셨죠?","q"),(4,"009","얼마에 팔까?","q"),(5,"006","5천만? 1억?","money"),
 (6,"021","갑론을박","soft"),(8,"014","완전히 뒤집혔다!","fire"),(10,"007","현금 보상, 없던 일","warn2"),
 (11,"019","전혀 다른 조건","serious"),((28.1,32.5),"012","끝까지 보시면~","script"),
 ((32.5,39.4),"016","판단 기준 총정리","gold"),(17,"022","5세대 구조부터","label"),
 (18,"022","큰 그림부터","label"),(22,"009","우리에게 무슨 뜻?","q"),
 (25,"010","병원비 늘어난다","warn"),(30,"019","서로 다른 잣대","serious"),
 (31,"022","첫째, 급여","label"),(32,"008","다행히 변화 없음","pos"),
 (34,"019","암・뇌혈관 중증","serious"),(37,"008","필수 치료는 그대로","pos"),
 (38,"006","부담률 20% 유지","money"),(40,"015","80%는 실손이!","pink"),
 (41,"011","오히려 더 좋아진다?","cyan"),(42,"012","걱정 내려놓으셔도~","script"),
 (43,"014","진짜 문제는 비급여","fire"),(44,"007","실손 적자의 주범","warn2"),
 (45,"019","개편의 칼끝, 비급여","serious"),(51,"009","숫자로 확인!","q"),
 (66,"021","가장 눈여겨볼 대목","soft"),(67,"022","셋째, 면책","label"),
 (78,"007","치료비, 내 지갑에서","warn2"),((249.2,254.9),"020","비용부터 따져보기","plain"),
 ((254.9,263.6),"019","부담률↑ 면책↑","serious"),(86,"014","지금부터가 진짜!","fire"),
 (87,"010","내 증권 다시 보기","warn"),(88,"007","약관 속 재가입 주기","warn2"),
 (89,"017","모르면 손해!","bold"),(98,"019","그 시점 상품 전환","serious"),
 (100,"007","선택권이 없다","warn2"),(101,"009","세대별 정리!","q"),
 ((354.8,359.7),"006","평생 유지 1,600만","money"),(114,"007","2,400만은 전환 대상","warn2"),
 ((367.0,377.3),"019","1・2세대도 언젠간…","serious"),(120,"010","병원비 계획 재설계","warn"),
 (121,"022","오늘의 숙제","label"),((397.4,404.2),"009","안심해도 될까?","q"),
 (127,"020","간단하지 않습니다","plain"),((405.7,411.4),"007","보험사엔 적자 계약","warn2"),
 (131,"019","일괄 전환 검토까지","serious"),(133,"008","강제 전환은 무산","pos"),
 (144,"014","현금 보상, 최종 제외","fire"),(155,"022","일정 체크","label"),
 ((500.1,507.1),"006","올해 11월부터 6개월","money"),(158,"016","판단 기준 2가지","gold"),
 (160,"022","① 재가입 주기 有","label"),(163,"007","먼저 움직이지 마라","warn2"),
 ((528.9,533.2),"020","반납할 이유 없다","plain"),((533.2,539.0),"001_L","때가 되면 자동 전환","serif"),
 (169,"008","누리는 게 최선","pos"),((542.7,548.3),"016","전환은 11월에","gold"),
 (172,"022","② 재가입 주기 無","label"),((554.1,559.5),"006","15만, 20만까지↑","money"),
 (178,"017","이것 하나만!","bold"),((568.1,571.9),"007","결정은 '계산 후'","warn2"),
 ((571.9,579.6),"020","숫자 확인 후 결정","plain"),((582.4,590.5),"011","내 병원비가 정한다","cyan"),
 ((592.3,598.3),"001_L","10년, 20년 뒤까지","serif"),((614.5,619.8),"008","계산하면 답 나온다","pos"),
 (197,"010","부모님 세대 필수","warn"),(198,"015","가족분들께 공유~","pink"),
 (199,"018","구독과 좋아요!","pink"),
]
emph_jobs = []
for spec in E:
    ref, tpl, text, mood = spec
    if isinstance(ref, tuple):
        t0, t1 = ref
    else:
        t0, t1 = cues[ref]["t0"], cues[ref]["t1"]
    if t1 - t0 < 1.6:  # extend short cues to min display
        t1 = t0 + 1.6
    assert tpl in mogrt_files, "missing mogrt " + tpl
    emph_jobs.append({"t0": round(t0,3), "t1": round(t1,3), "tpl": tpl,
                      "file": mogrt_files[tpl], "text": text, "mood": mood})

# ---------- bubbles (V9): emoji + text, duration = cue (min 2.5) ----------
B = [
 (2,"💰","옛날 실손 삽니다!"),(21,"📢","손해율을 잡겠다!"),(77,"🤷","무조건 치료받자!"),
 (84,"🙄","옛날 실비니까 남 일~"),(99,"🙋","옛날 조건으로 낼게요"),(143,"🤑","얼마 받고 팔까?"),
 (161,"🤔","미리 갈아탈까?"),
]
bubble_jobs = []
for i,(ci, emoji, text) in enumerate(B):
    t0, t1 = cues[ci]["t0"], cues[ci]["t1"]
    if t1 - t0 < 2.5: t1 = t0 + 2.5
    bubble_jobs.append({"id": "BB%d" % (i+1), "t0": round(t0,3), "t1": round(t1,3),
                        "emoji": emoji, "text": text})

# ---------- side overlays (V6, alpha) ----------
so_jobs = [
 {"id":"SO1","t0":292.6,"t1":306.3,"emoji":"🏠","kw":"전세 재계약","sub":"조건은 그 시점 시세로"},
 {"id":"SO2","t0":386.6,"t1":397.4,"emoji":"✅","kw":"오늘의 숙제","sub":"재가입 주기・만기 확인"},
 {"id":"SO3","t0":600.9,"t1":612.4,"emoji":"📋","kw":"증권 확인","sub":"주기 있나? 없나?"},
]

# ---------- MG boards (V8) ----------
mg_jobs = [
 {"id":"T1","reuse":"MG_T1_급여vs비급여.mov","t0":71.504,"t1":79.245},
 {"id":"T2","reuse":"MG_T2_비급여쪼개기.mov","t0":138.771,"t1":158.892},
 {"id":"T3","reuse":"MG_T3_재가입주기.mov","t0":321.354,"t1":354.787},
 {"id":"T4","comp":"a4.html","t0":160.3,"t1":206.8,"title":"《 비중증 비급여, 숫자로 》",
  "elements":[["🏥 정형외과 비급여 20만",163.2],["1세대: 거의 전액 환급",166.4],
              ["5세대: 내 부담 10만",176.5],["연간 한도 5,000만 → 1,000만",187.7],
              ["통원 20만/일 ・ 입원 300만/회",190.8],["한도 초과 = 전부 내 돈",195.5]]},
 {"id":"T6","comp":"a6.html","t0":212.0,"t1":240.9,"title":"《 면책 확대 》",
  "elements":[["기존: 미용・성형",217.1],["+ 신의료기술",224.4],
              ["+ 근골격계 주사",230.2],["허리디스크 주사도 면책",234.1]]},
 {"id":"T7","comp":"a7.html","t0":427.4,"t1":460.6,"title":"《 계약 재매입 》",
  "elements":[["옛 계약 정리 → 보상 제공",431.8],["낸 보험료 1,000만",447.3],
              ["- 받은 보험금 300만",449.8],["= 700만 현금…?",453.3]]},
 {"id":"T8","comp":"a8.html","t0":465.8,"t1":498.6,"title":"《 현금 대신 할인 》",
  "elements":[["1・2세대 → 5세대 전환 시",470.2],["3년간 보험료 50% 할인",474.8],
              ["월 4만원 기준 ≈ 70만원",481.8],["목돈 아닌 '할인'",493.9]]},
]

# ---------- 구독 (V6) ----------
subscribe_job = {"t0": 287.8, "file":
  "/Users/apple/Desktop/Bang's Work/VideoGraphy/_템플릿/효과자료/MOV_기본/01_좋아요 구독 알림설정.mov"}

# ---------- SFX ----------
MOOD_SFX = {
 "fire":  ["자막_1_뚜둥(북소리).mp3","강조_쿵!(높은 피치).mp3","자막_꽝! (충격).mp3"],
 "warn2": ["강조_쿵!!(중간 피치).mp3","자막_1_뚜둥(북소리).mp3","자막_황당 (빨래판 긁는 소리).mp3"],
 "warn":  ["자막_2_따탁(목탁소리).mp3","강조_쿵!(높은 피치).mp3"],
 "serious":["강조_쎄한 느낌.mp3","자막_2_따탁(목탁소리).mp3","자막_1_뚜둥(북소리).mp3"],
 "q":     ["자막_또잉.mp3","강조_뾰로롱(뭐지!?).mp3"],
 "money": ["효과음_캐셔.mp3","자막_따라란.mp3"],
 "pos":   ["자막_따랑.mp3","자막_띠링(체크소리).mp3","자막_샬랄라(차임소리).wav"],
 "pink":  ["효과음_ta-da!.mp3","자막_따랑.mp3"],
 "gold":  ["자막_정답 띠리링.wav","자막_따라란.mp3"],
 "cyan":  ["자막_띠링.mp3","자막_따랑.mp3"],
 "script":["자막_2_따탁(목탁소리).mp3","자막_3_탁탁.mp3"],
 "soft":  ["자막_3_탁탁.mp3","자막_POP_1.mp3"],
 "label": ["자막_3_탁탁.mp3","딸깍(마우스클릭소리_1).mp3"],
 "plain": ["자막_2_따탁(목탁소리).mp3","자막_POP_1.mp3"],
 "bold":  ["자막_꽝! (충격).mp3","자막_1_뚜둥(북소리).mp3"],
 "serif": ["자막_3_탁탁.mp3"],
}
rot = {}
sfx_jobs = []
def add_sfx(t, name):
    sfx_jobs.append({"t": round(t,3), "file": sfx_files[sfx(name)], "name": name})

for e in emph_jobs:
    lst = MOOD_SFX[e["mood"]]
    k = e["mood"]; rot[k] = rot.get(k, -1) + 1
    add_sfx(e["t0"], lst[rot[k] % len(lst)])
# special overrides
for e, name in [(10,"강조_땡(오답).mp3"), (144,"효과음_놉!.mp3")]:
    t = cues[e]["t0"]
    for s in sfx_jobs:
        if abs(s["t"] - t) < 0.05:
            s["file"] = sfx_files[name]; s["name"] = name
for b in bubble_jobs:
    add_sfx(b["t0"], "자막_드릉.mp3")
for s in so_jobs:
    add_sfx(s["t0"], "트랜지션_휙(중간).mp3")
    add_sfx(s["t0"] + 0.25, "자막_POP_1.mp3")
for m in mg_jobs:
    add_sfx(m["t0"], "트랜지션_두두둥 (예능).mp3")
    for el in m.get("elements", []):
        nm = "자막_POP_1.mp3"
        if "만" in el[0] and any(ch.isdigit() for ch in el[0]): nm = "효과음_캐셔.mp3"
        if el[0].startswith("="): nm = "강조_땡(오답).mp3"
        add_sfx(el[1], nm)
sfx_jobs.sort(key=lambda s: s["t"])

json.dump(zoom_jobs, open(SP+"/zoom_jobs.json","w"), ensure_ascii=False, indent=1)
json.dump(emph_jobs, open(SP+"/emph_jobs.json","w"), ensure_ascii=False, indent=1)
json.dump(bubble_jobs, open(SP+"/bubble_jobs.json","w"), ensure_ascii=False, indent=1)
json.dump(so_jobs, open(SP+"/so_jobs.json","w"), ensure_ascii=False, indent=1)
json.dump(mg_jobs, open(SP+"/mg_jobs.json","w"), ensure_ascii=False, indent=1)
json.dump({"subscribe": subscribe_job, "sfx": sfx_jobs},
          open(SP+"/sfx_jobs.json","w"), ensure_ascii=False, indent=1)

dur = 635.7
mgsec = sum(m["t1"]-m["t0"] for m in mg_jobs)
print("zooms=%d (%.1f/min overall)" % (len(zoom_jobs), len(zoom_jobs)/(dur/60)))
from collections import Counter
print(" scale dist:", Counter(z["scale"] for z in zoom_jobs))
print("emphasis=%d (%.1f/min non-board)" % (len(emph_jobs), len(emph_jobs)/((dur-mgsec)/60)))
print("bubbles=%d  SO=%d  MG=%d (%.0fs board, %.0f%%)" %
      (len(bubble_jobs), len(so_jobs), len(mg_jobs), mgsec, 100*mgsec/dur))
print("sfx=%d (%.1f/min)" % (len(sfx_jobs), len(sfx_jobs)/(dur/60)))
