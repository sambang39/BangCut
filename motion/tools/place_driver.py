#!/usr/bin/env python3
"""Placement driver: runs ExtendScript payloads via cdp.js and polls results.
Usage: place_driver.py zoom|emph|sfx|subtest|subclean|subplace N|movs
"""
import json, os, subprocess, sys, time, unicodedata

SP = os.path.dirname(os.path.abspath(__file__))
NFD = lambda s: unicodedata.normalize("NFD", s)

def run_es(es, timeout=300):
    """Send ExtendScript (string) via panel evalScript, poll window.__t."""
    wrapper = ('(function(){window.__t="pending";window.__adobe_cep__.evalScript(%s,'
               'function(r){window.__t=r;});return "sent";})()') % json.dumps(es)
    open(SP + "/_send.js", "w").write(wrapper)
    r = subprocess.run(["node", SP + "/cdp.js", "FILE", SP + "/_send.js"],
                       capture_output=True, text=True, cwd=SP)
    assert "sent" in r.stdout, "send failed: " + r.stdout + r.stderr
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(1.5)
        p = subprocess.run(["node", SP + "/cdp.js", "window.__t"],
                           capture_output=True, text=True, cwd=SP)
        out = p.stdout.strip()
        if out and '"pending"' not in out:
            return json.loads(out)  # unquote outer JSON string
    raise TimeoutError("ES poll timeout")

def es_header():
    return """
function findItemByName(root, name){
  for(var i=0;i<root.children.numItems;i++){
    var it=root.children[i];
    if(String(it.name)===name) return it;
    if(it.type===2){ var r=findItemByName(it,name); if(r) return r; }
  }
  return null;
}
function findItemByTail(root, tail){
  for(var i=0;i<root.children.numItems;i++){
    var it=root.children[i];
    try{ var mp=it.getMediaPath?String(it.getMediaPath()):"";
         if(mp && mp.length>=tail.length && mp.substr(mp.length-tail.length)===tail) return it; }catch(e){}
    if(it.type===2){ var r=findItemByTail(it,tail); if(r) return r; }
  }
  return null;
}
function clipAt(tr, t){
  for(var i=0;i<tr.clips.numItems;i++){
    var c=tr.clips[i];
    if(Math.abs(c.start.seconds-t)<0.05) return c;
  }
  return null;
}
"""

def cmd_zoom():
    jobs = json.load(open(SP + "/zoom_jobs.json"))
    es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, rt=app.project.rootItem;
var zi=findItemByName(rt,"Zoom");
if(!zi) return JSON.stringify({err:"no Zoom item"});
var vt=sq.videoTracks[2];
var jobs=%s, done=0, miss=[];
for(var i=0;i<jobs.length;i++){
  var j=jobs[i];
  vt.overwriteClip(zi, j.t0);
  var c=clipAt(vt, j.t0);
  if(!c){ miss.push(j.t0); continue; }
  c.end=j.t1; done++;
}
return JSON.stringify({done:done,total:jobs.length,miss:miss,clips:vt.clips.numItems});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % json.dumps(jobs)
    print(run_es(es))

def cmd_emph(maxn=None):
    # cap NEW imports per Premiere session: importMGT segfaults after ~15-30 calls/session
    jobs = [j for j in json.load(open(SP + "/emph_built.json")) if j.get("built")]
    new_ok = 0
    CH = 1  # one per call + save: rapid importMGT crashes Premiere 26.3
    for k in range(0, len(jobs), CH):
        chunk = [{"p": NFD(j["built"]), "t0": j["t0"], "t1": j["t1"]} for j in jobs[k:k+CH]]
        es = es_header() + """
(function(){try{
var sq=app.project.activeSequence;
var v5=sq.videoTracks[4];
var jobs=%s, ok=0, skip=0, bad=[];
for(var i=0;i<jobs.length;i++){
  var j=jobs[i];
  if(clipAt(v5, j.t0)){ skip++; continue; }
  var c=sq.importMGT(j.p, j.t0, 4, 0);
  if(!c){ bad.push(j.t0); continue; }
  try{ c.end=j.t1; }catch(e2){ bad.push("trim@"+j.t0); }
  ok++;
}
app.project.save();
return JSON.stringify({ok:ok,skip:skip,bad:bad,v5:v5.clips.numItems});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % json.dumps(chunk)
        r = run_es(es, timeout=600)
        print(k, r, flush=True)
        try:
            new_ok += json.loads(r).get("ok", 0)
        except Exception:
            pass
        if maxn and new_ok >= maxn:
            print("CAP %d reached — clean restart advised" % maxn, flush=True)
            return
        time.sleep(3.0)

def cmd_sfx():
    data = json.load(open(SP + "/sfx_jobs.json"))
    sfx = data["sfx"]
    files = sorted(set(s["file"] for s in sfx))
    files_nfd = [NFD(f) for f in files]
    es = es_header() + """
(function(){try{
var rt=app.project.rootItem, files=%s, need=[];
for(var i=0;i<files.length;i++){
  var tail=files[i].split("/").pop();
  if(!findItemByTail(rt,tail)) need.push(files[i]);
}
var r=true;
if(need.length) r=app.project.importFiles(need,true,rt,false);
return JSON.stringify({imported:need.length,r:String(r)});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % json.dumps(files_nfd)
    print("import:", run_es(es))
    jobs = []
    last_end = -9
    for s in sfx:
        tr = 2
        if s["t"] - last_end < 0.35:
            tr = 3
        else:
            last_end = s["t"]
        jobs.append({"t": s["t"], "tail": NFD(os.path.basename(s["file"])), "tr": tr})
    CH = 30
    for k in range(0, len(jobs), CH):
        es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, rt=app.project.rootItem;
var jobs=%s, ok=0, bad=[];
for(var i=0;i<jobs.length;i++){
  var j=jobs[i];
  var it=findItemByTail(rt,j.tail);
  if(!it){ bad.push("noitem:"+j.tail.substr(0,10)); continue; }
  var tr=sq.audioTracks[j.tr];
  tr.overwriteClip(it, j.t);
  ok++;
}
return JSON.stringify({ok:ok,bad:bad,a3:sq.audioTracks[2].clips.numItems,a4:sq.audioTracks[3].clips.numItems});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % json.dumps(jobs[k:k+CH])
        print(k, run_es(es, timeout=600))

def cmd_subtest():
    sub = json.load(open(SP + "/sfx_jobs.json"))["subscribe"]
    es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, rt=app.project.rootItem;
var tail=%s;
var it=findItemByTail(rt,tail);
if(!it){ var r=app.project.importFiles([%s],true,rt,false); it=findItemByTail(rt,tail); }
if(!it) return JSON.stringify({err:"no item"});
sq.videoTracks[3].overwriteClip(it, 700);
var res={v:[],a:[]};
for(var t=0;t<sq.videoTracks.numTracks;t++){var c=clipAt(sq.videoTracks[t],700);if(c)res.v.push("V"+(t+1));}
for(var t2=0;t2<sq.audioTracks.numTracks;t2++){var c2=clipAt(sq.audioTracks[t2],700);if(c2)res.a.push("A"+(t2+1));}
return JSON.stringify(res);
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % (json.dumps(NFD(os.path.basename(sub["file"]))), json.dumps(NFD(sub["file"])))
    print(run_es(es))

def cmd_subclean():
    es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, n=0;
for(var t=0;t<sq.videoTracks.numTracks;t++){var c=clipAt(sq.videoTracks[t],700);if(c){c.remove(false,false);n++;}}
for(var t2=0;t2<sq.audioTracks.numTracks;t2++){var c2=clipAt(sq.audioTracks[t2],700);if(c2){c2.remove(false,false);n++;}}
return JSON.stringify({removed:n});
}catch(e){return JSON.stringify({err:String(e)});}})()
"""
    print(run_es(es))

def cmd_subplace(track_idx):
    sub = json.load(open(SP + "/sfx_jobs.json"))["subscribe"]
    es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, rt=app.project.rootItem;
var it=findItemByTail(rt,%s);
if(!it) return JSON.stringify({err:"no item"});
sq.videoTracks[%d].overwriteClip(it, %s);
return JSON.stringify({placed:true});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % (json.dumps(NFD(os.path.basename(sub["file"]))), track_idx, sub["t0"])
    print(run_es(es))

def cmd_movs():
    """Place MG boards (V8), bubbles (V9), SOs (V6) after renders."""
    OUTDIR = "/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/09/(Footage)/Motion_v2"
    mg = json.load(open(SP + "/mg_jobs.json"))
    bb = json.load(open(SP + "/bubble_jobs.json"))
    so = json.load(open(SP + "/so_jobs.json"))
    jobs = []
    name = {"T4":"MG_T4_숫자로.mov","T6":"MG_T6_면책확대.mov","T7":"MG_T7_계약재매입.mov","T8":"MG_T8_현금대신할인.mov"}
    for m in mg:
        f = m.get("reuse") or name[m["id"]]
        jobs.append({"p": NFD(os.path.join(OUTDIR, f)), "t0": m["t0"], "t1": m["t1"], "tr": 7})
    for b in bb:
        jobs.append({"p": NFD(os.path.join(OUTDIR, b["id"] + ".mov")), "t0": b["t0"], "t1": b["t1"], "tr": 8})
    for s in so:
        jobs.append({"p": NFD(os.path.join(OUTDIR, s["id"] + ".mov")), "t0": s["t0"], "t1": s["t1"], "tr": 5})
    for j in jobs:
        assert os.path.exists(j["p"]), "missing " + j["p"]
    es = es_header() + """
(function(){try{
var sq=app.project.activeSequence, rt=app.project.rootItem;
var jobs=%s, ok=0, bad=[];
for(var i=0;i<jobs.length;i++){
  var j=jobs[i];
  var tail=j.p.split("/").pop();
  var it=findItemByTail(rt,tail);
  if(!it){ app.project.importFiles([j.p],true,rt,false); it=findItemByTail(rt,tail); }
  if(!it){ bad.push(tail); continue; }
  var tr=sq.videoTracks[j.tr];
  tr.overwriteClip(it, j.t0);
  var c=clipAt(tr, j.t0);
  if(c){ if(c.end.seconds>j.t1+0.05) c.end=j.t1; ok++; } else bad.push("place:"+tail);
}
return JSON.stringify({ok:ok,bad:bad,v6:sq.videoTracks[5].clips.numItems,v8:sq.videoTracks[7].clips.numItems,v9:sq.videoTracks[8].clips.numItems});
}catch(e){return JSON.stringify({err:String(e)});}})()
""" % json.dumps(jobs)
    print(run_es(es, timeout=600))

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "zoom": cmd_zoom()
    elif cmd == "emph": cmd_emph(int(sys.argv[2]) if len(sys.argv) > 2 else None)
    elif cmd == "sfx": cmd_sfx()
    elif cmd == "subtest": cmd_subtest()
    elif cmd == "subclean": cmd_subclean()
    elif cmd == "subplace": cmd_subplace(int(sys.argv[2]))
    elif cmd == "movs": cmd_movs()
    else: print("unknown", cmd)
