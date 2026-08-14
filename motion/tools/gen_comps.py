#!/usr/bin/env python3
"""Generate Hyperframes comp HTMLs: 4 MG boards (a4/a6/a7/a8), 7 bubbles, 3 side overlays."""
import json, os

SP = os.path.dirname(os.path.abspath(__file__))
V2 = "/Users/apple/Desktop/Bang's Work/Coding/BangCut_Motion_Lab/keyword-pop/compositions/v2"
mg = {m["id"]: m for m in json.load(open(SP + "/mg_jobs.json"))}
bubbles = json.load(open(SP + "/bubble_jobs.json"))
sos = json.load(open(SP + "/so_jobs.json"))

HEAD = """<!doctype html><html lang="ko"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=1920, height=1080"/>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
@font-face{font-family:'GmarketSansBold';src:url('https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2001@1.1/GmarketSansBold.woff') format('woff');font-display:block;}
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css');
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1920px;height:1080px;overflow:hidden;background:transparent;}
.title{font-family:'GmarketSansBold',sans-serif;font-size:84px;color:#1e1e1e;letter-spacing:.02em;white-space:nowrap;}
.title .br{color:#B8860B;}
.gm{font-family:'GmarketSansBold',sans-serif;}
.pt{font-family:'Pretendard',sans-serif;}
%s
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="%s" data-width="1920" data-height="1080">
  <div class="clip" data-start="0" data-duration="%s" data-track-index="1" style="position:absolute;inset:0">
"""
TAIL = """  </div>
</div>
<script>
window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});
%s
window.__timelines["main"]=tl;
</script></body></html>
"""

def comp(dur, css, body, anim):
    return (HEAD % (css, dur, dur)) + body + (TAIL % anim)

def title_html(t):
    inner = t.replace("《", '<span class="br">《</span>').replace("》", '<span class="br">》</span>')
    return '<div class="title" id="tt">%s</div>' % inner

def lt(m, t_abs):  # local time
    return round(t_abs - m["t0"], 2)

# ---------------- T4: 숫자로 (2 sections) ----------------
m = mg["T4"]; el = m["elements"]
css = """
.wrap{position:absolute;left:120px;top:150px;width:1680px;height:800px;display:flex;flex-direction:column;align-items:center;gap:56px;}
.cards{display:flex;gap:64px;}
.card{width:480px;padding:36px 24px;background:rgba(255,255,255,.55);border:5px solid #1e1e1e;border-radius:26px;
  display:flex;flex-direction:column;align-items:center;gap:16px;box-shadow:0 10px 24px rgba(0,0,0,.12);}
.card .emoji{font-size:110px;line-height:1;}
.card .kw{font-size:46px;color:#1e1e1e;text-align:center;line-height:1.25;}
.card.good{border-color:#1d7a3e;} .card.good .kw b{color:#1d7a3e;}
.card.bad{border-color:#C0392B;} .card.bad .kw b{color:#C0392B;}
.limits{display:flex;flex-direction:column;gap:26px;align-items:center;}
.lim{font-size:54px;color:#1e1e1e;white-space:nowrap;}
.lim b{color:#C0392B;}
.lim.punch{font-size:64px;color:#C0392B;background:rgba(255,255,255,.6);border:5px solid #C0392B;border-radius:20px;padding:14px 44px;}
"""
body = """<div class="wrap">
  %s
  <div class="cards">
    <div class="card" id="c1"><div class="emoji">🏥</div><div class="kw gm">정형외과 비급여<br><b>20만원</b></div></div>
    <div class="card good" id="c2"><div class="emoji">😌</div><div class="kw gm">1세대<br><b>거의 전액 환급</b></div></div>
    <div class="card bad" id="c3"><div class="emoji">😨</div><div class="kw gm">5세대<br><b>내 부담 10만</b></div></div>
  </div>
  <div class="limits">
    <div class="lim gm" id="l1">연간 한도 5,000만 → <b>1,000만</b></div>
    <div class="lim gm" id="l2">통원 <b>20만/일</b> ・ 입원 <b>300만/회</b></div>
    <div class="lim punch gm" id="l3">한도 초과 = 전부 내 돈</div>
  </div>
</div>""" % title_html(m["title"])
anim = "\n".join([
 'tl.from("#tt",{y:-30,opacity:0,duration:0.5,ease:"power3.out"},0.40);',
 'tl.from("#c1",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[0][1]),
 'tl.from("#c2",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[1][1]),
 'tl.from("#c3",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[2][1]),
 'tl.to("#c3",{rotate:1.5,duration:0.1,yoyo:true,repeat:5,ease:"sine.inOut"},%s);' % (lt(m, el[2][1]) + 0.5),
 'tl.from("#l1",{y:40,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[3][1]),
 'tl.from("#l2",{y:40,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[4][1]),
 'tl.from("#l3",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.0)"},%s);' % lt(m, el[5][1]),
])
open(V2 + "/a4.html", "w").write(comp(round(m["t1"] - m["t0"], 3), css, body, anim))

# ---------------- T6: 면책 확대 ----------------
m = mg["T6"]; el = m["elements"]
css = """
.wrap{position:absolute;left:120px;top:170px;width:1680px;height:760px;display:flex;flex-direction:column;align-items:center;gap:48px;}
.rows{display:flex;flex-direction:column;gap:34px;align-items:center;}
.row{font-size:60px;color:#555;white-space:nowrap;}
.row.add{color:#C0392B;font-size:66px;}
.badge{font-size:62px;color:#fff;background:#C0392B;border-radius:22px;padding:18px 52px;box-shadow:0 10px 22px rgba(192,57,43,.35);white-space:nowrap;}
"""
body = """<div class="wrap">
  %s
  <div class="rows">
    <div class="row gm" id="r1">기존: 미용・성형 뿐</div>
    <div class="row add gm" id="r2">＋ 신의료기술</div>
    <div class="row add gm" id="r3">＋ 근골격계 주사</div>
  </div>
  <div class="badge gm" id="bd">💉 허리디스크 주사도 면책!</div>
</div>""" % title_html(m["title"])
anim = "\n".join([
 'tl.from("#tt",{y:-30,opacity:0,duration:0.5,ease:"power3.out"},0.40);',
 'tl.from("#r1",{y:36,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[0][1]),
 'tl.from("#r2",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[1][1]),
 'tl.from("#r3",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[2][1]),
 'tl.from("#bd",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.0)"},%s);' % lt(m, el[3][1]),
 'tl.to("#bd",{rotate:1.6,duration:0.1,yoyo:true,repeat:5,ease:"sine.inOut"},%s);' % (lt(m, el[3][1]) + 0.5),
])
open(V2 + "/a6.html", "w").write(comp(round(m["t1"] - m["t0"], 3), css, body, anim))

# ---------------- T7: 계약 재매입 ----------------
m = mg["T7"]; el = m["elements"]
css = """
.wrap{position:absolute;left:120px;top:150px;width:1680px;height:800px;display:flex;flex-direction:column;align-items:center;gap:52px;}
.flow{font-size:58px;color:#1e1e1e;white-space:nowrap;}
.flow b{color:#B8860B;}
.calc{display:flex;flex-direction:column;gap:24px;align-items:flex-end;}
.cl{font-size:62px;color:#1e1e1e;white-space:nowrap;}
.cl small{font-size:44px;color:#666;margin-right:26px;}
.cl.res{font-size:78px;color:#B8860B;border-top:6px solid #1e1e1e;padding-top:22px;}
"""
body = """<div class="wrap">
  %s
  <div class="flow gm" id="fl">🤝 옛 계약 정리 → <b>보상 제공</b></div>
  <div class="calc">
    <div class="cl gm" id="q1"><small>낸 보험료</small>1,000만</div>
    <div class="cl gm" id="q2"><small>− 받은 보험금</small>300만</div>
    <div class="cl res gm" id="q3">= 700만 현금…?</div>
  </div>
</div>""" % title_html(m["title"])
anim = "\n".join([
 'tl.from("#tt",{y:-30,opacity:0,duration:0.5,ease:"power3.out"},0.40);',
 'tl.from("#fl",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.2)"},%s);' % lt(m, el[0][1]),
 'tl.from("#q1",{x:60,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[1][1]),
 'tl.from("#q2",{x:60,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[2][1]),
 'tl.from("#q3",{scale:0,opacity:0,duration:0.55,ease:"back.out(2.0)"},%s);' % lt(m, el[3][1]),
])
open(V2 + "/a7.html", "w").write(comp(round(m["t1"] - m["t0"], 3), css, body, anim))

# ---------------- T8: 현금 대신 할인 ----------------
m = mg["T8"]; el = m["elements"]
css = """
.wrap{position:absolute;left:120px;top:150px;width:1680px;height:800px;display:flex;flex-direction:column;align-items:center;gap:46px;}
.flow{font-size:56px;color:#1e1e1e;white-space:nowrap;}
.big{font-size:86px;color:#fff;background:#C0392B;border-radius:26px;padding:26px 64px;box-shadow:0 12px 26px rgba(192,57,43,.35);white-space:nowrap;}
.mid{font-size:56px;color:#1e1e1e;white-space:nowrap;} .mid b{color:#B8860B;}
.punch{font-size:60px;color:#555;background:rgba(255,255,255,.6);border:5px solid #555;border-radius:20px;padding:14px 44px;white-space:nowrap;}
"""
body = """<div class="wrap">
  %s
  <div class="flow gm" id="fl">1・2세대 → 5세대 전환 시</div>
  <div class="big gm" id="bg1">3년간 보험료 50%% 할인</div>
  <div class="mid gm" id="md">월 4만원 기준 ≈ <b>70만원</b></div>
  <div class="punch gm" id="pn">💸 목돈 아닌 '할인'</div>
</div>""" % title_html(m["title"])
anim = "\n".join([
 'tl.from("#tt",{y:-30,opacity:0,duration:0.5,ease:"power3.out"},0.40);',
 'tl.from("#fl",{y:36,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[0][1]),
 'tl.from("#bg1",{scale:0,opacity:0,duration:0.55,ease:"back.out(2.0)"},%s);' % lt(m, el[1][1]),
 'tl.from("#md",{y:36,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[2][1]),
 'tl.from("#pn",{scale:1.6,opacity:0,duration:0.45,ease:"power3.out"},%s);' % lt(m, el[3][1]),
])
open(V2 + "/a8.html", "w").write(comp(round(m["t1"] - m["t0"], 3), css, body, anim))

# ---------------- bubbles (alpha, 7f bottom-up pop) ----------------
BB_CSS = """
.grp{position:absolute;left:0;top:0;width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;}
.bub{position:relative;background:#fff;border:7px solid #1e1e1e;border-radius:44px;padding:44px 66px 44px 200px;
  box-shadow:0 14px 30px rgba(0,0,0,.25);}
.bub:after{content:'';position:absolute;left:120px;bottom:-34px;width:0;height:0;
  border:22px solid transparent;border-top:34px solid #1e1e1e;}
.bub .tx{font-family:'GmarketSansBold',sans-serif;font-size:68px;color:#1e1e1e;white-space:nowrap;}
.emoji{position:absolute;left:-10px;top:50%;transform:translateY(-58%);font-size:170px;line-height:1;
  filter:drop-shadow(0 8px 16px rgba(0,0,0,.25));}
"""
for b in bubbles:
    dur = round(b["t1"] - b["t0"], 3)
    body = """<div class="grp" id="g">
  <div class="bub"><div class="emoji" id="em">%s</div><div class="tx">%s</div></div>
</div>""" % (b["emoji"], b["text"])
    anim = "\n".join([
     'tl.fromTo("#g",{y:660},{y:0,duration:0.233,ease:"expo.out"},0);',
     'tl.from("#em",{scale:0.4,opacity:0,duration:0.3,ease:"back.out(2.6)"},0.18);',
     'tl.to("#g",{y:-7,duration:1.1,yoyo:true,repeat:%d,ease:"sine.inOut"},0.35);' % max(1, int(dur)),
    ])
    open(V2 + "/%s.html" % b["id"].lower(), "w").write(comp(dur, BB_CSS, body, anim))

# ---------------- side overlays (alpha, right column) ----------------
SO_CSS = """
.col{position:absolute;left:1290px;top:200px;width:580px;display:flex;flex-direction:column;align-items:center;gap:30px;}
.emoji{font-size:210px;line-height:1;filter:drop-shadow(0 10px 20px rgba(0,0,0,.35));}
.kw{font-family:'GmarketSansBold',sans-serif;font-size:70px;color:#fff;background:#D63426;border-radius:20px;
  padding:16px 42px;transform:rotate(-2deg);box-shadow:0 10px 24px rgba(0,0,0,.35);white-space:nowrap;}
.sub{font-family:'Pretendard',sans-serif;font-weight:800;font-size:44px;color:#fff;text-align:center;line-height:1.35;
  text-shadow:0 3px 10px rgba(0,0,0,.65), 0 0 2px rgba(0,0,0,.9);}
"""
for s in sos:
    dur = round(s["t1"] - s["t0"], 3)
    body = """<div class="col" id="g">
  <div class="emoji" id="em">%s</div>
  <div class="kw" id="kw">%s</div>
  <div class="sub" id="sb">%s</div>
</div>""" % (s["emoji"], s["kw"], s["sub"])
    anim = "\n".join([
     'tl.from("#em",{scale:0,opacity:0,duration:0.5,ease:"back.out(2.4)"},0.05);',
     'tl.from("#kw",{x:120,opacity:0,duration:0.45,ease:"power3.out"},0.30);',
     'tl.from("#sb",{y:30,opacity:0,duration:0.4,ease:"power2.out"},0.55);',
     'tl.to("#em",{y:-10,duration:1.4,yoyo:true,repeat:%d,ease:"sine.inOut"},0.8);' % max(1, int(dur / 1.5)),
    ])
    open(V2 + "/%s.html" % s["id"].lower(), "w").write(comp(dur, SO_CSS, body, anim))

print("comps written: a4 a6 a7 a8 +", len(bubbles), "bubbles +", len(sos), "SOs")
