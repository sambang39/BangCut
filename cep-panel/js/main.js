/* BangCut — 패널 메인 로직
   화면: 홈 / 컷편집 설정(소스 선택·엔진 실행) / 자막 편집(단어 내비·검색 드로어) */
(function () {
  "use strict";

  var C = window.BangCore;

  // ============ CEP 브리지 ============

  function inCep() { return !!window.__adobe_cep__; }

  function evalScript(script, cb) {
    if (inCep()) window.__adobe_cep__.evalScript(script, cb || function () {});
    else cb && cb("ERR:CEP 환경이 아닙니다 (브라우저 미리보기)");
  }

  function cepFs() { return (window.cep && window.cep.fs) ? window.cep.fs : null; }

  function nodeReq(mod) {
    try {
      if (typeof window.require === "function") return window.require(mod);
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(mod);
    } catch (e) {}
    return null;
  }

  function userDataDir() {
    if (!inCep() || !window.__adobe_cep__.getSystemPath) return null;
    return decodeURI(window.__adobe_cep__.getSystemPath("userData")).replace(/^file:\/\//, "");
  }

  function extensionDir() {
    if (!inCep() || !window.__adobe_cep__.getSystemPath) return null;
    return decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "");
  }

  // 프리미어가 가로채는 키를 패널이 받도록 등록
  // 방향키(텍스트 커서용)·W/A/S/D(단어 내비)·⌘Z·⇧⌘Z·⌘F·⌘S
  function registerKeys() {
    if (!inCep() || !window.__adobe_cep__.registerKeyEventsInterest) return;
    var keys = [
      { keyCode: 123 }, { keyCode: 124 }, { keyCode: 125 }, { keyCode: 126 },
      { keyCode: 123, altKey: true }, { keyCode: 124, altKey: true },
      { keyCode: 123, shiftKey: true }, { keyCode: 124, shiftKey: true },
      { keyCode: 123, altKey: true, shiftKey: true }, { keyCode: 124, altKey: true, shiftKey: true },
      { keyCode: 123, metaKey: true }, { keyCode: 124, metaKey: true },
      { keyCode: 0 }, { keyCode: 1 }, { keyCode: 2 }, { keyCode: 13 },
      { keyCode: 6, metaKey: true },
      { keyCode: 6, metaKey: true, shiftKey: true },
      { keyCode: 3, metaKey: true },
      { keyCode: 1, metaKey: true }
    ];
    try { window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(keys)); } catch (e) {}
  }

  // ============ 앱 상태 ============

  var seqInfo = { name: null, fps: 30000 / 1001, src: null };
  var settings = {
    preset: "medium", PAD_LEAD: 0.22, MIN_SILENCE: 0.30, PAD_TAIL: 0.10,
    srcMode: "track", fhd: true
  };
  var detectedSrt = null;

  var cues = [];
  var srtPath = null;
  var dirty = false;
  var history = new C.History(120);
  var typingSquash = null;

  var mode = "nav"; // nav | wordedit | sentedit
  var pointer = { cue: -1, word: 0 };
  var wordClickTimer = null;

  var find = { open: false, whole: false, rep: false, results: [], cur: -1 };

  var run = { running: false, proc: null, queue: [], sources: [], logLines: [] };

  var $ = function (id) { return document.getElementById(id); };
  var $list = $("cue-list");
  var $empty = $("empty");
  var $status = $("status");
  var $summary = $("summary");

  // ============ 화면 전환 ============

  var TITLES = { "screen-home": "", "screen-cutedit": "자동 컷편집", "screen-editor": "자막 편집" };
  var current = "screen-home";

  function showScreen(id) {
    current = id;
    ["screen-home", "screen-cutedit", "screen-editor"].forEach(function (s) {
      $(s).classList.toggle("active", s === id);
    });
    var home = id === "screen-home";
    $("btn-back").style.display = home ? "none" : "inline-block";
    $("appbar-title").style.display = home ? "none" : "inline";
    $("appbar-title").textContent = TITLES[id];
    if (home) refreshSeqInfo();
    if (id === "screen-cutedit") detectCutSource();
  }

  $("btn-back").addEventListener("click", function () { showScreen("screen-home"); });

  // ============ 상태바 ============

  function setStatus(msg, kind) {
    $status.textContent = msg;
    $status.className = kind || "";
  }

  function updateSummary() {
    var over = 0;
    for (var i = 0; i < cues.length; i++) {
      if (C.maxLineLen(cues[i].text) > C.MAX_LINE) over++;
    }
    $summary.textContent = (dirty ? "수정됨 · " : "") + "자막 " + cues.length + "개" +
      (over ? " · " + C.MAX_LINE + "자 초과 " + over + "개" : "");
  }

  // ============ 시퀀스 정보 / SRT 감지 ============

  function parseJson(res) {
    try { return JSON.parse(String(res || "")); } catch (e) { return null; }
  }

  function refreshSeqInfo(cb) {
    evalScript("bangGetSeqInfo()", function (res) {
      var info = parseJson(res);
      if (info && info.ok) {
        seqInfo.name = info.name || null;
        seqInfo.fps = parseFloat(info.fps) || seqInfo.fps;
        seqInfo.src = (info.src || "").replace(/^\/{2,}/, "/") || null;
        $("seq-name").textContent = "시퀀스: " + seqInfo.name;
        $("src-name").textContent = seqInfo.src ? seqInfo.src.split("/").pop() : "시퀀스에서 못 찾음";
      } else {
        $("seq-name").textContent = (info && info.err) ? info.err : "활성 시퀀스 없음";
        $("src-name").textContent = "—";
      }
      detectSrt();
      if (cb) cb();
    });
  }

  function statOk(path) {
    var fs = cepFs();
    if (!fs) return false;
    var r = fs.stat(path);
    return r && r.err === 0;
  }

  // 엔진 결과 폴더: 신규 BangCut/ 우선, 구버전 Premiere-Pro-edit-bang/ 폴백
  function outDirsOf(srcPath) {
    var dir = srcPath.replace(/\/[^\/]+$/, "");
    return [dir + "/BangCut", dir + "/Premiere-Pro-edit-bang"];
  }

  function detectSrt() {
    detectedSrt = null;
    var candidates = [];
    if (seqInfo.src) {
      var dir = seqInfo.src.replace(/\/[^\/]+$/, "");
      var base = seqInfo.src.split("/").pop().replace(/\.[^.]+$/, "");
      candidates = [];
      outDirsOf(seqInfo.src).forEach(function (od) {
        candidates.push(od + "/" + base + "_edit.srt");
        candidates.push(od + "/" + base + "_cut.srt");
      });
      candidates.push(dir + "/" + base + "_edit.srt");
      candidates.push(dir + "/" + base + "_cut.srt");
    }
    var last = localStorage.getItem("lastSrtPath");
    if (last) candidates.push(last);

    for (var i = 0; i < candidates.length; i++) {
      if (statOk(candidates[i])) { detectedSrt = candidates[i]; break; }
    }
    var badge = $("step2-badge");
    if (detectedSrt) {
      badge.textContent = "SRT 연결됨";
      badge.className = "step-badge ok";
      $("srt-name").textContent = detectedSrt.split("/").pop();
      $("btn-open-editor").disabled = false;
    } else {
      badge.textContent = "SRT 없음";
      badge.className = "step-badge none";
      $("srt-name").textContent = "—";
      $("btn-open-editor").disabled = true;
    }
  }

  // ============ 컷편집: 소스 선택 (F) ============

  function srcModeButtons() { return $("srcmode-row").children; }

  function setSrcMode(m) {
    settings.srcMode = m;
    var btns = srcModeButtons();
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].dataset.mode === m);
    }
    detectCutSource();
  }

  function detectCutSource() {
    var st = $("src-status");
    run.sources = [];
    var m = settings.srcMode;
    if (!inCep()) { st.innerHTML = '<span class="err">CEP 환경이 아닙니다</span>'; return; }
    st.textContent = "감지 중…";

    evalScript("bangGetCutSource(" + JSON.stringify(m) + ")", function (res) {
      var info = parseJson(res);
      if (!info || !info.ok) {
        st.innerHTML = '<span class="err">' + ((info && info.err) || "감지 실패: " + res) + "</span>";
        return;
      }
      if (info.mode === "inout") {
        var inS = parseFloat(info.tin), outS = parseFloat(info.tout);
        var okRange = isFinite(inS) && isFinite(outS) && outS > inS && inS >= 0;
        run.sources = (okRange && seqInfo.src) ? [seqInfo.src] : [];
        st.innerHTML = okRange
          ? "In/Out 구간: <b>" + C.secondsToTimecode(inS, seqInfo.fps) + " ~ " +
            C.secondsToTimecode(outS, seqInfo.fps) + "</b><br>" +
            '<span class="err">구간 컷편집은 엔진 지원 예정 — 현재는 소스 전체 기준으로 실행됩니다</span>'
          : '<span class="err">In/Out 포인트가 없습니다. 시퀀스에 I/O를 찍어주세요</span>';
        return;
      }
      var paths = (info.paths || []).map(function (p) { return p.replace(/^\/{2,}/, "/"); });
      run.sources = paths;
      var names = paths.map(function (p) { return p.split("/").pop(); });
      var label = info.mode === "selection" ? "선택한 클립" : "V1 트랙";
      st.innerHTML = label + " <b>" + paths.length + "개</b>: " +
        names.slice(0, 3).join(", ") + (names.length > 3 ? " 외 " + (names.length - 3) + "개" : "");
    });
  }

  (function () {
    var btns = srcModeButtons();
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { setSrcMode(b.dataset.mode); });
      })(btns[i]);
    }
  })();

  // ============ 컷편집: 프리셋/웨이브/설정 ============

  function buildPresetRow() {
    var row = $("preset-row");
    row.innerHTML = "";
    C.CUT_PRESETS.forEach(function (p) {
      var b = document.createElement("button");
      b.textContent = p.label;
      b.dataset.preset = p.id;
      b.addEventListener("click", function () {
        settings.PAD_LEAD = p.PAD_LEAD;
        settings.MIN_SILENCE = p.MIN_SILENCE;
        settings.PAD_TAIL = p.PAD_TAIL;
        syncCutUi();
      });
      row.appendChild(b);
    });
  }

  function matchPreset() {
    for (var i = 0; i < C.CUT_PRESETS.length; i++) {
      var p = C.CUT_PRESETS[i];
      if (Math.abs(p.PAD_LEAD - settings.PAD_LEAD) < 0.001 &&
          Math.abs(p.MIN_SILENCE - settings.MIN_SILENCE) < 0.001 &&
          Math.abs(p.PAD_TAIL - settings.PAD_TAIL) < 0.001) return p.id;
    }
    return "custom";
  }

  function syncCutUi() {
    settings.preset = matchPreset();
    var btns = $("preset-row").children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].dataset.preset === settings.preset);
    }
    $("in-padlead").value = settings.PAD_LEAD;
    $("in-minsil").value = settings.MIN_SILENCE;
    $("in-padtail").value = settings.PAD_TAIL;
    $("sw-fhd").classList.toggle("on", !!settings.fhd);
    renderWave();
  }

  function makeBars(el, heights) {
    el.innerHTML = "";
    heights.forEach(function (h) {
      var s = document.createElement("span");
      s.style.height = h + "px";
      el.appendChild(s);
    });
  }

  function renderWave() {
    makeBars($("wave-left"), [14, 22, 30, 18, 26, 12, 20]);
    makeBars($("wave-right"), [18, 28, 14, 24, 32, 16, 22]);
    $("wave-pad-lead").style.width = Math.round(12 + settings.PAD_LEAD * 90) + "px";
    $("wave-pad-tail").style.width = Math.round(12 + settings.PAD_TAIL * 90) + "px";
    $("wave-pad-lead-v").textContent = settings.PAD_LEAD + "s";
    $("wave-pad-tail-v").textContent = settings.PAD_TAIL + "s";
    var cut = $("wave-cut");
    cut.style.width = Math.round(46 + settings.MIN_SILENCE * 110) + "px";
    cut.textContent = "✂ > " + settings.MIN_SILENCE + "s";
  }

  function readCutInputs() {
    var pl = parseFloat($("in-padlead").value);
    var ms = parseFloat($("in-minsil").value);
    var pt = parseFloat($("in-padtail").value);
    if (!isNaN(pl)) settings.PAD_LEAD = Math.max(0, pl);
    if (!isNaN(ms)) settings.MIN_SILENCE = Math.max(0, ms);
    if (!isNaN(pt)) settings.PAD_TAIL = Math.max(0, pt);
    syncCutUi();
  }

  ["in-padlead", "in-minsil", "in-padtail"].forEach(function (id) {
    $(id).addEventListener("change", readCutInputs);
  });

  $("sw-fhd").addEventListener("click", function () {
    settings.fhd = !settings.fhd;
    $("sw-fhd").classList.toggle("on", settings.fhd);
  });

  function settingsPath() {
    var base = userDataDir();
    return base ? base + "/BangCut/settings.json" : null;
  }

  function saveSettings(silent) {
    localStorage.setItem("bangcutSettings", JSON.stringify(settings));
    var fs = cepFs();
    var p = settingsPath();
    if (fs && p) {
      fs.makedir(p.replace(/\/[^\/]+$/, ""));
      var r = fs.writeFile(p, JSON.stringify(settings, null, 2));
      if (r.err !== 0 && !silent) { cutStatus("설정 저장 실패 (err " + r.err + ")", "err"); return; }
    }
    if (!silent) cutStatus("컷편집 설정 저장됨", "ok");
  }

  function loadSettings() {
    var raw = null;
    var fs = cepFs();
    var p = settingsPath();
    if (fs && p) {
      var r = fs.readFile(p);
      if (r.err === 0) raw = r.data;
    }
    if (!raw) raw = localStorage.getItem("bangcutSettings");
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (typeof s.PAD_LEAD === "number") settings.PAD_LEAD = s.PAD_LEAD;
        if (typeof s.MIN_SILENCE === "number") settings.MIN_SILENCE = s.MIN_SILENCE;
        if (typeof s.PAD_TAIL === "number") settings.PAD_TAIL = s.PAD_TAIL;
        if (typeof s.srcMode === "string") settings.srcMode = s.srcMode;
        if (typeof s.fhd === "boolean") settings.fhd = s.fhd;
      } catch (e) {}
    }
  }

  function cutStatus(msg, kind) {
    var el = $("cut-status");
    el.textContent = msg;
    el.className = kind || "";
  }

  // ============ 컷편집: 엔진 실행 (G) ============

  function repoRoot() {
    var ext = extensionDir();
    if (!ext) return null;
    var fsN = nodeReq("fs");
    var pathN = nodeReq("path");
    if (!fsN || !pathN) return null;
    try {
      var real = fsN.realpathSync(ext); // 심볼릭 링크 → 저장소 내 cep-panel 실제 경로
      return pathN.dirname(real);
    } catch (e) { return null; }
  }

  function writeEngineOverride(root) {
    // 엔진의 사용자 override(config.json)에 패널 설정 3종 주입 (기존 키 보존)
    var fsN = nodeReq("fs");
    var cfgPath = root + "/config.json";
    var cfg = {};
    try { cfg = JSON.parse(fsN.readFileSync(cfgPath, "utf8")); } catch (e) {}
    cfg.MIN_SILENCE = settings.MIN_SILENCE;
    cfg.PAD_LEAD = settings.PAD_LEAD;
    cfg.PAD_TAIL = settings.PAD_TAIL;
    fsN.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }

  function logLine(s) {
    run.logLines.push(s);
    if (run.logLines.length > 400) run.logLines = run.logLines.slice(-300);
    var el = $("run-log");
    el.textContent = run.logLines.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  function setRunningUi(on) {
    $("btn-run-cut").disabled = on;
    $("btn-run-cut").textContent = on ? "실행 중…" : "컷편집 시작";
    $("btn-stop-cut").style.display = on ? "inline-block" : "none";
    $("run-log").classList.toggle("open", on || run.logLines.length > 0);
  }

  function runCut() {
    if (run.running) return;
    var cp = nodeReq("child_process");
    if (!cp) { cutStatus("Node 실행 환경을 찾지 못했습니다 (패널 재시작 필요)", "err"); return; }
    var root = repoRoot();
    if (!root || !statOk(root + "/edit.sh")) {
      cutStatus("엔진(edit.sh)을 찾지 못했습니다: " + root, "err");
      return;
    }
    if (!run.sources.length) {
      cutStatus("컷편집 대상이 없습니다 — 위에서 대상을 선택/확인해 주세요", "err");
      return;
    }
    saveSettings(true);
    try { writeEngineOverride(root); } catch (e) {
      cutStatus("엔진 설정 전달 실패: " + e.message, "err");
      return;
    }

    run.running = true;
    run.queue = run.sources.slice();
    run.logLines = [];
    setRunningUi(true);
    cutStatus("컷편집 실행 중 — " + run.queue.length + "개 소스. 패널을 닫지 마세요", "");
    logLine("== BangCut 엔진 실행 (" + run.queue.length + "개) ==");
    runNext(cp, root);
  }

  function runNext(cp, root) {
    if (!run.queue.length) {
      run.running = false;
      run.proc = null;
      setRunningUi(false);
      cutStatus("컷편집 완료 — 자막이 연결되었는지 홈에서 확인하세요", "ok");
      logLine("== 전체 완료 ==");
      refreshSeqInfo();
      return;
    }
    var src = run.queue.shift();
    logLine("\n▶ " + src.split("/").pop());
    var args = [root + "/edit.sh", src];
    if (settings.fhd) args.push("--fhd");

    var env = {};
    try {
      var pe = nodeReq("process").env;
      for (var k in pe) env[k] = pe[k];
    } catch (e) {}
    env.PATH = (env.PATH || "") + ":/usr/local/bin:/opt/homebrew/bin";

    var child = cp.spawn("/bin/bash", args, { cwd: root, env: env });
    run.proc = child;

    child.stdout.on("data", function (d) { String(d).split("\n").forEach(function (l) { if (l.trim()) logLine(l); }); });
    child.stderr.on("data", function (d) { String(d).split("\n").forEach(function (l) { if (l.trim()) logLine("! " + l); }); });
    child.on("error", function (e) {
      logLine("!! 실행 오류: " + e.message);
      run.running = false;
      setRunningUi(false);
      cutStatus("실행 오류: " + e.message, "err");
    });
    child.on("close", function (code) {
      if (!run.running) return; // 중단됨
      if (code === 0) {
        logLine("✓ 완료: " + src.split("/").pop());
        runNext(cp, root);
      } else {
        run.running = false;
        run.proc = null;
        setRunningUi(false);
        cutStatus("엔진 종료 코드 " + code + " — 로그를 확인하세요", "err");
        logLine("!! 종료 코드 " + code);
      }
    });
  }

  function stopCut() {
    if (!run.running) return;
    run.running = false;
    run.queue = [];
    try { if (run.proc) run.proc.kill("SIGTERM"); } catch (e) {}
    run.proc = null;
    setRunningUi(false);
    cutStatus("중단됨", "err");
    logLine("== 사용자 중단 ==");
  }

  $("btn-goto-cutedit").addEventListener("click", function () { showScreen("screen-cutedit"); });
  $("btn-save-settings").addEventListener("click", function () { saveSettings(false); });
  $("btn-run-cut").addEventListener("click", runCut);
  $("btn-stop-cut").addEventListener("click", stopCut);

  // ============ 자막 편집: 렌더 (단어 플로우) ============

  function tcOf(sec) { return C.secondsToTimecode(sec, seqInfo.fps); }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  function render(pointCue, pointWord) {
    cancelWordClick();
    mode = "nav";
    $list.innerHTML = "";
    if (!cues.length) {
      $list.appendChild($empty);
      updateSummary();
      return;
    }
    var frag = document.createDocumentFragment();
    cues.forEach(function (c, i) { frag.appendChild(buildRow(c, i)); });
    $list.appendChild(frag);
    if (pointCue != null) setPointer(pointCue, pointWord || 0, { scroll: true });
    else if (pointer.cue >= 0) setPointer(Math.min(pointer.cue, cues.length - 1), pointer.word, { scroll: false, noSync: true });
    refreshFindHits();
    updateSummary();
    updateHistoryButtons();
  }

  function renderRow(i) {
    var old = rowEl(i);
    if (!old) return;
    var fresh = buildRow(cues[i], i);
    old.parentNode.replaceChild(fresh, old);
    refreshFindHits();
    updateSummary();
  }

  function buildRow(c, i) {
    var row = document.createElement("div");
    row.className = "row" + (i === pointer.cue ? " selected" : "");
    row.dataset.idx = i;
    var over = C.maxLineLen(c.text) > C.MAX_LINE;
    if (over) row.classList.add("too-long");

    var meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      '<div class="idx">#' + (i + 1) +
        ' · <span class="cc' + (over ? " over" : "") + '">' + C.maxLineLen(c.text) + "자</span></div>" +
      '<div class="tc mono">' + tcOf(c.start) + "</div>";
    meta.addEventListener("click", function () { setPointer(i, 0, { scroll: false }); });
    row.appendChild(meta);

    row.appendChild(buildFlow(c, i));

    var btns = document.createElement("div");
    btns.className = "btns";
    btns.appendChild(miniBtn("▲", "위와 병합", i > 0, function () { mergeUp(i); }));
    btns.appendChild(miniBtn("▼", "아래와 병합", i < cues.length - 1, function () { mergeUp(i + 1); }));
    row.appendChild(btns);
    return row;
  }

  function buildFlow(c, i) {
    var flow = document.createElement("div");
    flow.className = "flow";
    var toks = C.tokenize(c.text);
    var last = 0;
    toks.forEach(function (tk, wi) {
      if (tk.s > last) appendWs(flow, c.text.slice(last, tk.s));
      var sp = document.createElement("span");
      sp.className = "w" + (i === pointer.cue && wi === pointer.word ? " pt" : "");
      sp.textContent = tk.t;
      sp.dataset.wi = wi;
      sp.addEventListener("click", function (e) {
        e.stopPropagation();
        onWordClick(i, wi);
      });
      flow.appendChild(sp);
      last = tk.e;
    });
    if (last < c.text.length) appendWs(flow, c.text.slice(last));
    flow.addEventListener("dblclick", function (e) {
      e.preventDefault();
      openSentEdit(i);
    });
    return flow;
  }

  function appendWs(flow, s) {
    var parts = s.split("\n");
    parts.forEach(function (p, k) {
      if (k) flow.appendChild(document.createElement("br"));
      if (p) flow.appendChild(document.createTextNode(p));
    });
  }

  function miniBtn(label, title, enabled, onClick) {
    var b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.disabled = !enabled;
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }

  function rowEl(i) { return $list.querySelector('[data-idx="' + i + '"]'); }

  function updateMeta(i) {
    var row = rowEl(i);
    if (!row) return;
    var over = C.maxLineLen(cues[i].text) > C.MAX_LINE;
    row.classList.toggle("too-long", over);
    var cc = row.querySelector(".cc");
    if (cc) {
      cc.textContent = C.maxLineLen(cues[i].text) + "자";
      cc.classList.toggle("over", over);
    }
  }

  // ============ 포인터 (단어 내비) ============

  function tokensOf(i) { return C.tokenize(cues[i].text); }

  function setPointer(ci, wi, opts) {
    opts = opts || {};
    if (ci < 0 || ci >= cues.length) return;
    var toks = tokensOf(ci);
    wi = Math.max(0, Math.min(wi, Math.max(0, toks.length - 1)));

    var oldRow = rowEl(pointer.cue);
    if (oldRow) {
      oldRow.classList.remove("selected");
      var oldW = oldRow.querySelector(".w.pt");
      if (oldW) oldW.classList.remove("pt");
    }
    pointer.cue = ci;
    pointer.word = wi;
    var row = rowEl(ci);
    if (row) {
      row.classList.add("selected");
      var sp = row.querySelector('.w[data-wi="' + wi + '"]');
      if (sp) sp.classList.add("pt");
      if (opts.scroll !== false) row.scrollIntoView({ block: "nearest" });
    }
    if (!opts.noSync) syncPlayhead(C.wordTime(cues[ci], toks, wi));
  }

  function moveWord(delta) {
    if (pointer.cue < 0) { setPointer(0, 0); return; }
    var ci = pointer.cue, wi = pointer.word + delta;
    if (wi < 0) {
      if (ci === 0) return;
      ci--;
      wi = Math.max(0, tokensOf(ci).length - 1);
    } else if (wi >= tokensOf(ci).length) {
      if (ci >= cues.length - 1) return;
      ci++;
      wi = 0;
    }
    setPointer(ci, wi);
  }

  function moveCue(delta) {
    if (pointer.cue < 0) { setPointer(0, 0); return; }
    var ci = pointer.cue + delta;
    if (ci < 0 || ci >= cues.length) return;
    setPointer(ci, pointer.word);
  }

  // ============ 단어/문장 편집 ============

  function cancelWordClick() {
    if (wordClickTimer) { clearTimeout(wordClickTimer); wordClickTimer = null; }
  }

  function onWordClick(i, wi) {
    if (mode !== "nav") return;
    if (i === pointer.cue && wi === pointer.word) {
      // 포인트된 단어를 한 번 더 클릭 → 단어 수정 (더블클릭이면 취소되고 문장 수정)
      cancelWordClick();
      wordClickTimer = setTimeout(function () {
        wordClickTimer = null;
        openWordEdit(i, wi);
      }, 280);
    } else {
      setPointer(i, wi, { scroll: false });
    }
  }

  function openWordEdit(i, wi) {
    if (mode !== "nav") return;
    var row = rowEl(i);
    var sp = row && row.querySelector('.w[data-wi="' + wi + '"]');
    var toks = tokensOf(i);
    if (!sp || wi >= toks.length) return;
    var tk = toks[wi];
    mode = "wordedit";

    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "w-edit";
    inp.value = tk.t;
    inp.style.width = Math.max(4, tk.t.length + 2) + "ch";
    sp.parentNode.replaceChild(inp, sp);
    inp.focus();
    inp.select();

    var done = false;
    function commit(cancel) {
      if (done) return;
      done = true;
      mode = "nav";
      var nv = inp.value.replace(/\s+/g, " ").trim();
      if (!cancel && nv !== tk.t) {
        pushHistory();
        var t = cues[i].text;
        var newText;
        if (nv) {
          newText = t.slice(0, tk.s) + nv + t.slice(tk.e);
        } else {
          newText = (t.slice(0, tk.s) + t.slice(tk.e)).replace(/ {2,}/g, " ").replace(/^ +| +$/g, "");
        }
        cues[i].text = newText;
        dirty = true;
      }
      renderRow(i);
      setPointer(i, Math.min(wi, Math.max(0, tokensOf(i).length - 1)), { scroll: false, noSync: true });
      updateSummary();
      if (find.open) refreshFind();
    }

    inp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(false); }
      else if (e.key === "Escape") { e.preventDefault(); commit(true); }
    });
    inp.addEventListener("blur", function () { commit(false); });
  }

  function openSentEdit(i) {
    cancelWordClick();
    if (mode === "sentedit") return;
    if (mode === "wordedit") return;
    mode = "sentedit";
    setPointer(i, pointer.cue === i ? pointer.word : 0, { scroll: false, noSync: true });

    var row = rowEl(i);
    var flow = row.querySelector(".flow");
    var ta = document.createElement("textarea");
    ta.className = "sent-edit";
    ta.value = cues[i].text;
    ta.rows = 1;
    flow.parentNode.replaceChild(ta, flow);
    autosize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    var closed = false;
    function exitSent() {
      if (closed) return;
      closed = true;
      mode = "nav";
      renderRow(i);
      setPointer(i, Math.min(pointer.word, Math.max(0, tokensOf(i).length - 1)), { scroll: false, noSync: true });
      if (find.open) refreshFind();
    }

    ta.addEventListener("input", function () {
      squashHistoryPush();
      cues[i].text = ta.value;
      dirty = true;
      autosize(ta);
      updateMeta(i);
      updateSummary();
    });
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      var metaK = e.metaKey || e.ctrlKey;
      if (metaK && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        closed = true; mode = "nav";
        if (e.shiftKey) doRedo(); else doUndo();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var pos = ta.selectionStart;
        closed = true; mode = "nav";
        splitCue(i, pos);
      } else if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0) {
        e.preventDefault();
        closed = true; mode = "nav";
        mergeUp(i);
      } else if (e.key === "Escape") {
        e.preventDefault();
        exitSent();
      }
    });
    ta.addEventListener("blur", function () { exitSent(); });
  }

  // ============ 플레이헤드 연동 ============

  var syncTimer = null;
  var syncPending = null;

  function syncPlayhead(sec) {
    syncPending = sec;
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      if (syncPending == null) return;
      var s = syncPending;
      syncPending = null;
      evalScript("bangSetPlayerPosition(" + (s + 0.0001) + ")");
    }, 120);
  }

  // ============ 이력 ============

  function pushHistory() {
    history.push(cues);
    updateHistoryButtons();
  }

  function squashHistoryPush() {
    if (!typingSquash) pushHistory();
    clearTimeout(typingSquash);
    typingSquash = setTimeout(function () { typingSquash = null; }, 600);
  }

  function restore(snapshot) {
    if (!snapshot) return;
    cues = snapshot.map(function (c) { return { start: c.start, end: c.end, text: c.text }; });
    dirty = true;
    if (pointer.cue >= cues.length) pointer.cue = cues.length - 1;
    render();
    if (find.open) refreshFind();
  }

  function doUndo() {
    typingSquash = null;
    restore(history.undo(cues));
    setStatus("실행 취소", "");
  }
  function doRedo() {
    restore(history.redo(cues));
    setStatus("다시 실행", "");
  }

  function updateHistoryButtons() {
    $("btn-undo").disabled = !history.canUndo();
    $("btn-redo").disabled = !history.canRedo();
  }

  // ============ 편집 동작 ============

  function splitCue(i, pos) {
    var c = cues[i];
    var a = c.text.slice(0, pos).replace(/\s+$/, "");
    var b = c.text.slice(pos).replace(/^\s+/, "");
    if (!a || !b) { renderRow(i); return; }
    pushHistory();
    var dur = c.end - c.start;
    var ratio = a.length / (a.length + b.length);
    var mid = c.start + Math.max(0.2, Math.min(dur - 0.2, dur * ratio));
    cues.splice(i + 1, 0, { start: mid, end: c.end, text: b });
    c.end = mid;
    c.text = a;
    dirty = true;
    render(i + 1, 0);
  }

  function mergeUp(i) {
    if (i <= 0 || i >= cues.length) return;
    pushHistory();
    var prev = cues[i - 1];
    var cur = cues[i];
    var joinWord = C.tokenize(prev.text).length; // 병합 지점 단어 인덱스
    prev.text = (prev.text.replace(/\s+$/, "") + " " + cur.text.replace(/^\s+/, "")).trim();
    prev.end = cur.end;
    cues.splice(i, 1);
    dirty = true;
    render(i - 1, Math.min(joinWord, Math.max(0, C.tokenize(prev.text).length - 1)));
  }

  // ============ 전역 키보드 ============

  document.addEventListener("keydown", function (e) {
    var metaK = e.metaKey || e.ctrlKey;
    var t = e.target;
    var inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");

    if (metaK && (e.key === "z" || e.key === "Z")) {
      if (current !== "screen-editor") return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (metaK && (e.key === "f" || e.key === "F")) {
      if (current !== "screen-editor") return;
      e.preventDefault();
      openFind();
      return;
    }
    if (metaK && (e.key === "s" || e.key === "S")) {
      if (current !== "screen-editor") return;
      e.preventDefault();
      saveSrt();
      return;
    }
    if (e.key === "Escape") {
      if (find.open && (!inField || (t.closest && t.closest("#find-drawer")))) {
        closeFind();
      }
      return;
    }

    if (current !== "screen-editor" || mode !== "nav" || inField || !cues.length) return;

    switch (e.code) {
      case "KeyA": e.preventDefault(); moveWord(-1); break;
      case "KeyD": e.preventDefault(); moveWord(1); break;
      case "KeyW": e.preventDefault(); moveCue(-1); break;
      case "KeyS": e.preventDefault(); moveCue(1); break;
      case "Enter":
        e.preventDefault();
        if (pointer.cue >= 0) openWordEdit(pointer.cue, pointer.word);
        break;
    }
  });

  // ============ 검색/바꾸기 드로어 (E) ============

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function openFind() {
    find.open = true;
    $("find-drawer").classList.add("open");
    var input = $("find-input");
    input.focus();
    input.select();
    refreshFind();
  }

  function closeFind() {
    find.open = false;
    $("find-drawer").classList.remove("open");
    refreshFindHits();
  }

  function computeResults(q) {
    var out = [];
    if (!q) return out;
    for (var i = 0; i < cues.length; i++) {
      var text = cues[i].text;
      if (find.whole) {
        var toks = C.tokenize(text);
        for (var w = 0; w < toks.length; w++) {
          // 단어 전체 일치: 구두점 제외 후 비교
          var bare = toks[w].t.replace(/[.,!?…~"'()\[\]]+$/g, "").replace(/^["'(\[]+/g, "");
          if (toks[w].t === q || bare === q) {
            out.push({ cue: i, pos: toks[w].s, len: toks[w].e - toks[w].s, wi: w });
          }
        }
      } else {
        var pos = 0;
        while (true) {
          var at = text.indexOf(q, pos);
          if (at === -1) break;
          var toks2 = C.tokenize(text);
          var wi = 0;
          for (var k = 0; k < toks2.length; k++) {
            if (toks2[k].s <= at && at < toks2[k].e) { wi = k; break; }
            if (toks2[k].s > at) break;
            wi = k;
          }
          out.push({ cue: i, pos: at, len: q.length, wi: wi });
          pos = at + Math.max(1, q.length);
        }
      }
    }
    return out;
  }

  function refreshFind() {
    var q = $("find-input").value;
    find.results = computeResults(q);
    if (find.cur >= find.results.length) find.cur = find.results.length ? 0 : -1;
    if (find.cur < 0 && find.results.length) find.cur = 0;
    $("find-count-line").textContent = find.results.length ? find.results.length + "건 발견" : (q ? "결과 없음" : "0건");
    renderFindResults();
    refreshFindHits();
  }

  var findRefreshTimer = null;
  function scheduleFindRefresh() {
    if (!find.open) return;
    clearTimeout(findRefreshTimer);
    findRefreshTimer = setTimeout(refreshFind, 200);
  }

  function renderFindResults() {
    var box = $("find-results");
    box.innerHTML = "";
    find.results.forEach(function (r, idx) {
      var el = document.createElement("div");
      el.className = "fr" + (idx === find.cur ? " cur" : "");
      var text = cues[r.cue].text;
      var html = escapeHtml(text.slice(0, r.pos)) +
        "<mark>" + escapeHtml(text.slice(r.pos, r.pos + r.len)) + "</mark>" +
        escapeHtml(text.slice(r.pos + r.len));
      el.innerHTML = '<span class="tc mono">' + tcOf(cues[r.cue].start).slice(3) + "</span>" +
        '<span class="txt">' + html + "</span>";
      el.addEventListener("click", function () {
        find.cur = idx;
        renderFindResults();
        setPointer(r.cue, r.wi, { scroll: true });
      });
      box.appendChild(el);
    });
  }

  function refreshFindHits() {
    var hits = $list.querySelectorAll(".w.hit");
    for (var i = 0; i < hits.length; i++) hits[i].classList.remove("hit");
    if (!find.open || !find.results.length) return;
    find.results.forEach(function (r) {
      var row = rowEl(r.cue);
      var sp = row && row.querySelector('.w[data-wi="' + r.wi + '"]');
      if (sp) sp.classList.add("hit");
    });
  }

  function replaceOne() {
    if (!find.results.length || find.cur < 0) return;
    var q = $("find-input").value;
    var rep = $("replace-input").value;
    if (!q) return;
    var r = find.results[find.cur];
    pushHistory();
    var t = cues[r.cue].text;
    cues[r.cue].text = t.slice(0, r.pos) + rep + t.slice(r.pos + r.len);
    dirty = true;
    renderRow(r.cue);
    setPointer(r.cue, r.wi, { scroll: true, noSync: true });
    var keep = find.cur;
    refreshFind();
    if (find.results.length) {
      find.cur = Math.min(keep, find.results.length - 1);
      renderFindResults();
      refreshFindHits();
    }
    setStatus("바꾸기 완료", "ok");
  }

  function replaceAll() {
    var q = $("find-input").value;
    var rep = $("replace-input").value;
    if (!q || !find.results.length) return;
    pushHistory();
    // 뒤에서부터 치환해 오프셋 무효화 방지
    for (var i = find.results.length - 1; i >= 0; i--) {
      var r = find.results[i];
      var t = cues[r.cue].text;
      cues[r.cue].text = t.slice(0, r.pos) + rep + t.slice(r.pos + r.len);
    }
    dirty = true;
    var n = find.results.length;
    render();
    refreshFind();
    setStatus(n + "곳 모두 바꿈", "ok");
  }

  $("btn-find").addEventListener("click", openFind);
  $("btn-find-close-drawer").addEventListener("click", closeFind);
  $("btn-replace-one").addEventListener("click", replaceOne);
  $("btn-replace-all").addEventListener("click", replaceAll);
  $("find-input").addEventListener("input", function () { find.cur = -1; refreshFind(); });
  $("find-input").addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      if (find.results.length) {
        find.cur = (find.cur + 1) % find.results.length;
        renderFindResults();
        var r = find.results[find.cur];
        setPointer(r.cue, r.wi, { scroll: true });
      }
    } else if (e.key === "Escape") { closeFind(); }
  });
  $("replace-input").addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
    else if (e.key === "Escape") { closeFind(); }
  });
  $("sw-whole").addEventListener("click", function () {
    find.whole = !find.whole;
    $("sw-whole").classList.toggle("on", find.whole);
    refreshFind();
  });
  $("sw-replace").addEventListener("click", function () {
    find.rep = !find.rep;
    $("sw-replace").classList.toggle("on", find.rep);
    $("replace-wrap").classList.toggle("open", find.rep);
    $("btn-replace-one").style.display = find.rep ? "block" : "none";
    $("btn-replace-all").style.display = find.rep ? "block" : "none";
  });

  // ============ 파일 입출력 ============

  function loadFile(path) {
    var fs = cepFs();
    if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return; }
    var r = fs.readFile(path, window.cep.encoding.UTF8);
    if (r.err !== 0) { setStatus("파일 읽기 실패 (err " + r.err + ")", "err"); return; }
    var parsed = C.parseSrt(r.data);
    if (!parsed.length) { setStatus("자막을 찾지 못했습니다 — SRT 형식 확인", "err"); return; }
    cues = parsed;
    srtPath = path;
    dirty = false;
    pointer = { cue: -1, word: 0 };
    history = new C.History(120);
    typingSquash = null;
    localStorage.setItem("lastSrtPath", path);
    $("editor-file").textContent = path.split("/").pop();
    $("editor-file").title = path;
    showScreen("screen-editor");
    render(0, 0);
    setStatus("불러오기 완료 — W/S 자막, A/D 단어 이동", "ok");
  }

  function editPath() {
    if (/_edit\.srt$/i.test(srtPath)) return srtPath;
    return srtPath.replace(/\.srt$/i, "_edit.srt");
  }

  function saveSrt() {
    if (!srtPath) { setStatus("먼저 SRT를 불러오세요", "err"); return null; }
    var fs = cepFs();
    if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return null; }
    var out = editPath();
    var r = fs.writeFile(out, C.serializeSrt(cues), window.cep.encoding.UTF8);
    if (r.err !== 0) { setStatus("저장 실패 (err " + r.err + ")", "err"); return null; }
    dirty = false;
    updateSummary();
    setStatus("저장됨: " + out.split("/").pop(), "ok");
    return out;
  }

  function applyToSequence() {
    var out = saveSrt();
    if (!out) return;
    setStatus("시퀀스에 적용 중…");
    var btn = $("btn-apply");
    btn.disabled = true;
    evalScript("bangApplySrt(" + JSON.stringify(out) + ")", function (res) {
      btn.disabled = false;
      res = String(res || "");
      if (res.indexOf("OK") === 0) {
        setStatus(res.replace(/^OK:?/, "") || "캡션 트랙 생성 완료", "ok");
      } else {
        setStatus(res.replace(/^ERR:?/, "적용 실패: "), "err");
      }
    });
  }

  // ============ 버튼 연결 (에디터) ============

  $("btn-open-editor").addEventListener("click", function () {
    if (detectedSrt) loadFile(detectedSrt);
  });
  $("btn-open-manual").addEventListener("click", function () {
    var fs = cepFs();
    if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return; }
    var initDir = localStorage.getItem("lastDir") || "~/Desktop";
    var res = fs.showOpenDialogEx(false, false, "SRT 파일 선택", initDir, ["srt"]);
    if (!res || !res.data || !res.data.length) return;
    localStorage.setItem("lastDir", res.data[0].replace(/\/[^\/]+$/, ""));
    loadFile(res.data[0]);
  });

  $("btn-undo").addEventListener("click", doUndo);
  $("btn-redo").addEventListener("click", doRedo);
  $("btn-save").addEventListener("click", saveSrt);
  $("btn-apply").addEventListener("click", applyToSequence);
  $("btn-split").addEventListener("click", function () {
    if (pointer.cue < 0) return;
    var toks = tokensOf(pointer.cue);
    if (pointer.word > 0 && pointer.word < toks.length) {
      splitCue(pointer.cue, toks[pointer.word].s);
    } else {
      setStatus("나눌 위치의 단어를 선택하세요 (첫 단어 앞은 나눌 수 없음)", "err");
    }
  });
  $("btn-merge-up").addEventListener("click", function () { if (pointer.cue > 0) mergeUp(pointer.cue); });
  $("btn-merge-down").addEventListener("click", function () {
    if (pointer.cue >= 0 && pointer.cue < cues.length - 1) mergeUp(pointer.cue + 1);
  });

  // ============ 초기화 ============

  registerKeys();
  loadSettings();
  buildPresetRow();
  syncCutUi();
  setSrcMode(settings.srcMode);
  showScreen("screen-home");
})();
