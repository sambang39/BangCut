/* BangCut — 패널 메인 로직
   화면: 홈 / 컷편집 설정(소스 선택·엔진 실행) / 자막 편집(단어 내비·검색 드로어) */
(function () {
  "use strict";

  var C = window.BangCore;
  var PANEL_VERSION = "0.2.0";

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
      { keyCode: 36 }, { keyCode: 51 }, { keyCode: 117 },
      { keyCode: 6 }, { keyCode: 7 },
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
    sttModel: "whisper", resolution: "FHD"
  };
  var source = { path: null, meta: null, imported: false }; // 컷편집 대상 (드롭/선택한 원테이크 파일)
  var scriptText = "";  // 등록된 대본 (자막 정렬·NG 보조에 사용, 프로젝트별 기억)
  var detectedSrt = null;
  var xmlBasis = null; // 현재 시퀀스의 기준 XML (마킹 수술의 입력)
  var projectPath = null;     // 현재 프리미어 프로젝트 (전환 감지용)
  var editorDismissed = false; // 적용 완료 후 디폴트 복귀 상태 — 자동 재로드 방지

  var cues = [];
  var srtPath = null;
  var seqSource = null;  // 재투영 소스(전사된 원본 영상 경로) — 시퀀스에서 불러온 경우
  var seqName = null;    // 현재 자막 편집 대상 시퀀스 이름
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
  var $summary = $("summary");

  // ============ 화면 전환 ============

  var current = "screen-cutedit";

  function showScreen(id) {
    current = id;
    ["screen-cutedit", "screen-editor", "screen-settings"].forEach(function (s) {
      $(s).classList.toggle("active", s === id);
    });
    var items = document.querySelectorAll(".side-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("on", items[i].dataset.screen === id);
    }
    if (id === "screen-cutedit") refreshSeqInfo();
    if (id === "screen-editor") activateEditor();
    if (id === "screen-settings") {
      loadVitoUi();
      loadClaudeUi();
      checkPrereq(setEnvBadge);
    }
  }

  (function () {
    var items = document.querySelectorAll(".side-item");
    for (var i = 0; i < items.length; i++) {
      (function (el) {
        el.addEventListener("click", function () { showScreen(el.dataset.screen); });
      })(items[i]);
    }
  })();

  // ---------- 프로젝트별 작업 기억 (J) ----------

  function projKey(p) { return "bangcutProj:" + p; }

  function rememberProjSrt(path) {
    if (projectPath) localStorage.setItem(projKey(projectPath), path);
  }

  function setXmlBasis(path) {
    xmlBasis = path;
    if (projectPath) localStorage.setItem("bangcutXmlBasis:" + projectPath, path);
  }

  function getProjSrt() {
    return projectPath ? localStorage.getItem(projKey(projectPath)) : null;
  }

  function updateEmptyUi() {
    // 빈/편집 상태에 따라 빈 화면 안내 표시 (시퀀스 불러오기 UI는 activateEditor가 관리)
    var empty = $("empty");
    if (empty) empty.style.display = cues.length ? "none" : "";
  }

  // 자막 편집 화면을 디폴트(빈 상태)로 (K)
  function resetEditor() {
    cues = [];
    srtPath = null;
    seqSource = null;
    seqName = null;
    dirty = false;
    pointer = { cue: -1, word: 0 };
    history = new C.History(120);
    typingSquash = null;
    if (find.open) closeFind();
    $("editor-file").textContent = "—";
    $("editor-file").title = "";
    render();
    updateEmptyUi();
    updateHistoryButtons();
  }

  // 자막 편집 탭 진입: 현재 시퀀스 감지 → 불러오기 버튼/드롭다운 준비 (SRT 자동로드 폐지)
  var seqPoll = null;
  function activateEditor() {
    updateEmptyUi();
    if (cues.length) { stopSeqPoll(); return; }
    refreshSeqTarget();
    populateSeqPick();
    startSeqPoll();
  }
  // 빈 상태에서 활성 시퀀스 변화를 주기적으로 감지 (CEP는 실시간 푸시가 없음)
  function startSeqPoll() {
    if (seqPoll) return;
    seqPoll = setInterval(function () {
      if (current !== "screen-editor" || cues.length) { stopSeqPoll(); return; }
      refreshSeqTarget();
    }, 1500);
  }
  function stopSeqPoll() { if (seqPoll) { clearInterval(seqPoll); seqPoll = null; } }

  // 프로젝트 전환 감지 (J): 다른 프로젝트가 열리면 패널을 디폴트로 초기화
  function pollProject() {
    if (run.running) return;
    evalScript("bangGetProjectPath()", function (res) {
      var p = String(res || "").trim();
      if (!p || p === "ERR") return;
      if (p === projectPath) return;
      var first = projectPath === null;
      projectPath = p;
      if (first) { updateEmptyUi(); return; }
      // 잔여물 제거: 컷편집·자막 편집 모두 디폴트로
      showDropzone();
      cutStatus("", "");
      $("cut-overlay").classList.remove("open");
      editorDismissed = false;
      resetEditor();
      refreshSeqInfo();
    });
  }
  setInterval(pollProject, 4000);

  // ============ 상태바 ============

  var toastTimer = null;
  function setStatus(msg, kind) {
    var t = $("toast");
    if (!msg) { t.classList.remove("show"); return; }
    t.textContent = msg;
    t.className = (kind || "") + " show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); },
      kind === "err" ? 5000 : 2500);
  }

  function updateSummary() {
    if (!cues.length) { $summary.textContent = ""; return; }
    var over = 0;
    for (var i = 0; i < cues.length; i++) {
      if (C.maxLineLen(cues[i].text) > C.MAX_LINE) over++;
    }
    var delN = 0;
    for (var d = 0; d < cues.length; d++) {
      if (cues[d].ldel) delN++;
      else if (cues[d].marks) for (var w = 0; w < cues[d].marks.length; w++) if (cues[d].marks[w]) delN++;
    }
    $summary.textContent = (dirty ? "수정됨 · " : "") + "자막 " + cues.length + "개" +
      (over ? " · " + C.MAX_LINE + "자 초과 " + over + "개" : "") +
      (delN ? " · 삭제 표시 " + delN + "개" : "");
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
    var srcForSrt = source.path || seqInfo.src; // 드롭한 소스 우선, 없으면 시퀀스에서 감지
    if (srcForSrt) {
      var dir = srcForSrt.replace(/\/[^\/]+$/, "");
      var base = srcForSrt.split("/").pop().replace(/\.[^.]+$/, "");
      candidates = [];
      outDirsOf(srcForSrt).forEach(function (od) {
        candidates.push(od + "/" + base + "_edit.srt");
        candidates.push(od + "/" + base + "_cut.srt");
      });
      candidates.push(dir + "/" + base + "_edit.srt");
      candidates.push(dir + "/" + base + "_cut.srt");
    }
    for (var i = 0; i < candidates.length; i++) {
      if (statOk(candidates[i])) { detectedSrt = candidates[i]; break; }
    }
  }

  // ============ 컷편집 대상: 드래그 앤 드롭 / 파일 선택 (F2) ============

  var VIDEO_EXT = /\.(mp4|mov|m4v|mkv|mts|m2ts|mxf|avi)$/i;

  function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  function extendedEnv() {
    var env = {};
    try {
      var pe = nodeReq("process").env;
      for (var k in pe) env[k] = pe[k];
    } catch (e) {}
    env.PATH = (env.PATH || "") + ":/usr/local/bin:/opt/homebrew/bin";
    return env;
  }

  function probeVideo(path, cb) {
    var cp = nodeReq("child_process");
    if (!cp) { cb(null); return; }
    cp.exec("ffprobe -v quiet -print_format json -show_format -show_streams " + shellQuote(path),
      { env: extendedEnv(), maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout) {
        if (err) { cb(null); return; }
        try {
          var j = JSON.parse(String(stdout));
          var v = null;
          for (var i = 0; i < (j.streams || []).length; i++) {
            if (j.streams[i].codec_type === "video") { v = j.streams[i]; break; }
          }
          cb({
            width: v ? v.width : 0,
            height: v ? v.height : 0,
            duration: parseFloat(j.format && j.format.duration) || 0
          });
        } catch (e) { cb(null); }
      });
  }

  function resLabel(w, h) {
    var mx = Math.max(w || 0, h || 0);
    if (mx >= 3800) return "4K";
    if (mx >= 2500) return "QHD";
    if (mx >= 1900) return "FHD";
    if (!mx) return "";
    return w + "×" + h;
  }

  function durLabel(sec) {
    if (!sec) return "";
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    return m ? m + "분 " + s + "초" : s + "초";
  }

  function srcErr(msg) { $("src-err").textContent = msg || ""; }

  // 임포트 완료 전에는 컷편집 시작 비활성 (사용자 확정)
  function updateRunButton() {
    if (!run.running) $("btn-run-cut").disabled = !(source.path && source.imported);
  }

  function showDropzone() {
    source.path = null;
    source.meta = null;
    source.imported = false;
    $("dropzone").style.display = "block";
    $("src-card").style.display = "none";
    srcErr("");
    cutStatus("", "");
    updateRunButton();
  }

  function selectSource(path) {
    srcErr("");
    if (!path) return;
    if (!VIDEO_EXT.test(path)) {
      srcErr("영상 파일이 아닙니다: " + path.split("/").pop());
      return;
    }
    if (!statOk(path)) {
      srcErr("파일을 찾을 수 없습니다: " + path);
      return;
    }
    source.path = path;
    source.meta = null;
    source.imported = false;
    updateRunButton();
    localStorage.setItem("lastVideoDir", path.replace(/\/[^\/]+$/, ""));
    // 이 소스로 등록해둔 대본이 있으면 컴포저에 복원(버튼·안내·창 높이 동기화)
    scriptText = scriptFor(path);
    if ($("script-input")) {
      $("script-input").value = scriptText;
      if ($("script-composer")) $("script-composer").classList.toggle("has", !!scriptText);
      if (typeof updateScState === "function") updateScState();
      if (scriptText && isReadableScript(scriptText))
        showScHint("✓ 대본 등록됨 (" + scriptText.replace(/\s+/g, "").length + "자) — 자막에 반영됩니다", "ok");
      else hideScHint();
    }

    $("dropzone").style.display = "none";
    $("src-card").style.display = "flex";
    $("src-card-name").textContent = path.split("/").pop();
    $("src-card-name").title = path;
    $("src-card-meta").textContent = "정보 읽는 중…";

    probeVideo(path, function (meta) {
      if (source.path !== path) return;
      source.meta = meta;
      var parts = [];
      if (meta) {
        var r = resLabel(meta.width, meta.height);
        if (r) parts.push(r);
        var d = durLabel(meta.duration);
        if (d) parts.push(d);
      }
      $("src-card-meta").textContent = parts.length ? parts.join(" · ") : "정보를 읽지 못했습니다";
    });

    // 프로젝트 창 BangCut 빈으로 임포트
    evalScript("bangImportToBin(" + JSON.stringify(path) + ")", function (res) {
      res = String(res || "");
      if (source.path !== path) return;
      if (res.indexOf("OK") === 0) {
        source.imported = true;
        cutStatus("프로젝트 창 BangCut 폴더에 임포트됨", "ok");
      } else {
        source.imported = false;
        cutStatus(res.replace(/^ERR:?/, "임포트 실패: "), "err");
      }
      updateRunButton();
    });

    detectSrt();
  }

  (function () {
    var dz = $("dropzone");
    dz.addEventListener("click", function () {
      var fs = cepFs();
      if (!fs) { srcErr("CEP 환경이 아닙니다"); return; }
      var initDir = localStorage.getItem("lastVideoDir") || "~/Desktop";
      var res = fs.showOpenDialogEx(false, false, "컷편집할 영상 선택", initDir,
        ["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "mxf", "avi"]);
      if (res && res.data && res.data.length) selectSource(res.data[0].replace(/^file:\/\//, ""));
    });
    dz.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", function () { dz.classList.remove("dragover"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove("dragover");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) srcErr("한 번에 한 개의 원테이크 영상만 — 첫 번째 파일을 사용합니다");
      var p = files[0].path;
      if (!p) { srcErr("드래그 앤 드롭 경로를 읽지 못했습니다 — 클릭해서 파일을 선택해 주세요"); return; }
      selectSource(p);
    });
    // 패널 전역에서 드롭존 밖 드롭으로 페이지가 파일로 이동하는 것 방지
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) { e.preventDefault(); });

    $("btn-src-change").addEventListener("click", function () {
      var name = source.path ? source.path.split("/").pop() : "";
      $("change-msg").textContent = "기존 '" + name + "' 영상본이 아닌 새로운 영상본으로 교체하시겠어요?";
      $("change-overlay").classList.add("open");
    });
    $("btn-change-yes").addEventListener("click", function () {
      $("change-overlay").classList.remove("open");
      showDropzone();
    });
    $("btn-change-no").addEventListener("click", function () {
      $("change-overlay").classList.remove("open");
    });
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
    syncResRow();
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
    $("wave-cut-v").textContent = "> " + settings.MIN_SILENCE + "s";
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

  // 상세 3필드 세모 스피너 (▲▼)
  (function () {
    var btns = document.querySelectorAll('#detail-grid .spin button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          var input = $(b.dataset.for);
          try { b.className.indexOf("up") === 0 ? input.stepUp() : input.stepDown(); } catch (e) {}
          readCutInputs();
        });
      })(btns[i]);
    }
  })();

  // 시퀀스 해상도 (FHD/4K 투버튼)
  function syncResRow() {
    var btns = $("res-row").children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].dataset.res === settings.resolution);
    }
    $("res-hint").textContent = settings.resolution === "FHD"
      ? "FHD — 4K 소스를 1080p 시퀀스에 맞춰 배치"
      : "4K — 원본 해상도 그대로의 시퀀스";
  }

  (function () {
    var btns = $("res-row").children;
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          settings.resolution = b.dataset.res;
          syncResRow();
          saveSettings(true);
        });
      })(btns[i]);
    }
  })();

  // ============ 공백 길이 자동/수동 (H3) ============

  var gapMode = "auto"; // 세션 한정 — 저장하지 않음, 열 때마다 자동+디폴트

  function setGapMode(m) {
    gapMode = m;
    var btns = $("gapmode-row").children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].dataset.gap === m);
    }
    $("manual-wrap").classList.toggle("off", m === "auto");
    $("auto-note").style.display = m === "auto" ? "block" : "none";
  }

  (function () {
    var btns = $("gapmode-row").children;
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { setGapMode(b.dataset.gap); });
      })(btns[i]);
    }
  })();

  // ============ 전사 모델 토글 (H3) ============

  function readEngineConfig() {
    var fsN = nodeReq("fs");
    var root = repoRoot();
    if (!fsN || !root) return {};
    try { return JSON.parse(fsN.readFileSync(root + "/config.json", "utf8")); }
    catch (e) { return {}; }
  }

  function writeEngineConfig(cfg) {
    var fsN = nodeReq("fs");
    var root = repoRoot();
    if (!fsN || !root) return false;
    try { fsN.writeFileSync(root + "/config.json", JSON.stringify(cfg, null, 2)); return true; }
    catch (e) { return false; }
  }

  function vitoKeysPresent() {
    var cfg = readEngineConfig();
    return !!(cfg.VITO_CLIENT_ID && cfg.VITO_CLIENT_SECRET);
  }

  function whisperInstalled() {
    var fsN = nodeReq("fs");
    var root = repoRoot();
    if (!fsN || !root) return false;
    try { return fsN.existsSync(root + "/.venv/bin/mlx_whisper"); } catch (e) { return false; }
  }

  function setModel(m, silent) {
    var vitoAsked = m === "vito";
    if (vitoAsked && !vitoKeysPresent()) {
      if (!silent) $("vito-overlay").classList.add("open");
      $("model-hint").textContent = "VITO — API 키 미등록. 설정 패널에서 API 키 등록 진행";
      m = "whisper";
    }
    settings.sttModel = m;
    var btns = $("model-row").children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].dataset.model === m);
    }
    if (m === "vito") {
      $("model-hint").textContent = "VITO — API 키 등록됨";
    } else if (!vitoAsked || vitoKeysPresent()) {
      $("model-hint").textContent = whisperInstalled()
        ? "Whisper — 무료 로컬 실행"
        : "Whisper — 미설치 상태. 설치해야 사용 가능";
    }
    saveSettings(true);
  }

  (function () {
    var btns = $("model-row").children;
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { setModel(b.dataset.model, false); });
      })(btns[i]);
    }
  })();

  $("btn-vito-close").addEventListener("click", function () {
    $("vito-overlay").classList.remove("open");
  });
  $("btn-vito-goto-settings").addEventListener("click", function () {
    $("vito-overlay").classList.remove("open");
    showScreen("screen-settings");
    $("card-vito").classList.add("open");
    setTimeout(function () { $("set-vito-id").focus(); }, 50);
  });
  $("btn-vito-site").addEventListener("click", function () {
    try { window.cep.util.openURLInDefaultBrowser("https://developers.rtzr.ai"); } catch (e) {}
  });

  // ============ 설정 화면 (H3) ============

  function maskId(s) {
    if (!s) return "";
    return s.length <= 6 ? s : s.slice(0, 4) + "…" + s.slice(-2);
  }

  (function () {
    var cards = document.querySelectorAll(".set-card");
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        var head = card.querySelector(".set-head");
        head.addEventListener("click", function () {
          var opening = !card.classList.contains("open");
          card.classList.toggle("open", opening);
          if (opening && card.id === "card-env") loadEnvInfo();
          if (opening && card.id === "card-vito") loadVitoUi();
          if (opening && card.id === "card-claude") loadClaudeUi();
        });
      })(cards[i]);
    }
  })();

  // 저장 알림: 부드럽게 떠올랐다가 성공이면 2.5초 뒤 스르륵 사라짐(오류는 유지)
  var noteTimers = {};
  function flashNote(id, msg, kind) {
    var el = $(id);
    if (!el) return;
    clearTimeout(noteTimers[id]);
    el.textContent = msg;
    el.className = kind || "";
    // 리플로우 강제 후 .show 부여 → 페이드/상승 트랜지션 발동
    void el.offsetWidth;
    el.classList.add("show");
    if (kind !== "err") {
      noteTimers[id] = setTimeout(function () {
        el.classList.remove("show");
        setTimeout(function () { if (!el.classList.contains("show")) el.textContent = ""; }, 300);
      }, 2500);
    }
  }

  // 설정 카드 내용을 튀지 않게 부드럽게 새로고침(짧은 페이드 후 갱신)
  function smoothRefresh(anyElInCard, updateFn) {
    var body = anyElInCard && anyElInCard.closest ? anyElInCard.closest(".set-body") : null;
    if (!body) { updateFn(); return; }
    body.style.opacity = "0.35";
    setTimeout(function () { try { updateFn(); } finally { body.style.opacity = "1"; } }, 180);
  }

  function loadVitoUi() {
    var cfg = readEngineConfig();
    var has = !!(cfg.VITO_CLIENT_ID && cfg.VITO_CLIENT_SECRET);
    var badge = $("vito-head-badge");
    if (badge) {
      badge.textContent = has ? "활성화" : "비활성화";
      badge.className = "badge " + (has ? "ok" : "warn");
    }
    $("set-vito-id").value = cfg.VITO_CLIENT_ID || "";
    $("set-vito-secret").value = cfg.VITO_CLIENT_SECRET || "";
  }

  function saveVitoKeys() {
    var id = $("set-vito-id").value.trim();
    var sec = $("set-vito-secret").value.trim();
    var cfg = readEngineConfig();
    if (!id) { flashNote("vito-status", "CLIENT ID를 입력해 주세요", "err"); return; }
    if (!sec) { flashNote("vito-status", "CLIENT SECRET을 입력해 주세요", "err"); return; }
    cfg.VITO_CLIENT_ID = id;
    cfg.VITO_CLIENT_SECRET = sec;
    if (!writeEngineConfig(cfg)) { flashNote("vito-status", "저장 실패 — 엔진 폴더 쓰기 권한을 확인해 주세요", "err"); return; }
    smoothRefresh($("vito-status"), loadVitoUi);
    flashNote("vito-status", "VITO 키 저장됨 (" + maskId(id) + ")", "ok");
  }

  $("btn-save-vito").addEventListener("click", saveVitoKeys);

  function loadClaudeUi() {
    var email = claudeAccount();
    var key = claudeApiKey();
    var badge = $("claude-head-badge");
    badge.textContent = (email || key) ? "활성화" : "비활성화";
    badge.className = "badge " + ((email || key) ? "ok" : "warn");
    $("claude-conn-desc").innerHTML = email
      ? "구독 계정: <b>" + email + "</b>"
      : (key ? "API 키(<b>" + maskKey(key) + "</b>)로 실행됩니다 — 사용량만큼 과금"
             : '<span class="bad">클로드와 연결되어 있지 않습니다</span>');
    $("set-claude-key").value = key || "";
    // 로그인 상태별 버튼 토글: 로그인 시 [계정 전환][로그아웃], 로그아웃 시 [로그인]만(계정 전환 자리)
    $("btn-claude-signin").style.display = email ? "none" : "";
    $("btn-claude-login").style.display = email ? "" : "none";
    $("btn-claude-logout").style.display = email ? "" : "none";
  }

  // 로그인/로그아웃은 브라우저 OAuth가 필요해 터미널을 열어 진행
  function openTerminalCmd(cmd) {
    var cp = nodeReq("child_process");
    if (!cp) return;
    var osa = 'tell application "Terminal"\nactivate\ndo script "' + cmd.replace(/"/g, '\\"') + '"\nend tell';
    try { cp.execFile("/usr/bin/osascript", ["-e", osa]); } catch (e) {}
  }

  function startLogin() {
    openTerminalCmd((claudeBin() || "claude") + " /login");
    flashNote("claude-key-status", "터미널에서 로그인 진행 후, 카드를 다시 열면 반영됩니다", "err");
  }
  $("btn-claude-signin").addEventListener("click", startLogin);
  $("btn-claude-login").addEventListener("click", startLogin);
  $("btn-claude-logout").addEventListener("click", function () {
    openTerminalCmd((claudeBin() || "claude") + " /logout");
    flashNote("claude-key-status", "터미널에서 로그아웃 진행 후, 카드를 다시 열면 반영됩니다", "err");
  });

  $("btn-save-claude-key").addEventListener("click", function () {
    var k = $("set-claude-key").value.trim();
    if (!k) { flashNote("claude-key-status", "키를 입력해 주세요", "err"); return; }
    saveClaudeKey(k);
    smoothRefresh($("claude-key-status"), loadClaudeUi);
    flashNote("claude-key-status", "저장됨 (" + maskKey(k) + ") — 이제 API 키만으로 컷편집이 실행됩니다", "ok");
  });

  function setEnvBadge() {
    var badge = $("env-head-badge");
    if (!badge) return;
    var ok = prereq.claude && prereq.repo && prereq.venv && prereq.ffmpeg;
    badge.textContent = ok ? "정상" : "확인 필요";
    badge.className = "badge " + (ok ? "ok" : "warn");
  }

  function loadEnvInfo() {
    $("env-info").innerHTML = "확인 중…";
    checkPrereq(function () {
      var root = repoRoot();
      $("env-info").innerHTML =
        "클로드 코드: " + (prereq.claude
          ? '<span class="ok">✓ 설치됨</span> <span style="color:var(--text-faint)">(' + prereq.claudePath + ")</span>"
          : '<span class="bad">✗ 미설치</span>') + "<br>" +
        "엔진: " + (prereq.repo
          ? '<span class="ok">✓</span> <b>' + (root || "") + "</b>"
          : '<span class="bad">✗ 찾을 수 없음</span>') + "<br>" +
        "파이썬 환경(.venv): " + (prereq.venv
          ? '<span class="ok">✓ 준비됨</span>'
          : '<span class="bad">✗ 미설치 — 온보딩의 자동 설치를 진행해 주세요</span>') + "<br>" +
        "ffmpeg: " + (prereq.ffmpeg
          ? '<span class="ok">✓ 설치됨</span>'
          : '<span class="bad">✗ 미설치 — brew install ffmpeg</span>');
      setEnvBadge();
    });
  }

  $("btn-recheck-env").addEventListener("click", loadEnvInfo);

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
        // 비율 값은 복원하지 않음 — 항상 디폴트(자동 모드)로 시작 (사용자 확정)
        if (typeof s.sttModel === "string") settings.sttModel = s.sttModel;
        if (typeof s.resolution === "string") settings.resolution = s.resolution;
        if (typeof s.fhd === "boolean") settings.resolution = s.fhd ? "FHD" : "4K";
      } catch (e) {}
    }
  }

  function cutStatus(msg, kind) {
    var el = $("cut-status");
    el.textContent = msg;
    el.className = kind || "";
  }

  // ============ Claude 연결 (M) ============

  function homeDir() {
    try { return nodeReq("process").env.HOME || ""; } catch (e) { return ""; }
  }

  function claudeAccount() {
    var fsN = nodeReq("fs");
    if (!fsN) return null;
    try {
      var j = JSON.parse(fsN.readFileSync(homeDir() + "/.claude.json", "utf8"));
      return (j.oauthAccount && j.oauthAccount.emailAddress) || null;
    } catch (e) { return null; }
  }

  function claudeApiKey() {
    return localStorage.getItem("bangcutClaudeKey") || "";
  }

  function saveClaudeKey(k) {
    localStorage.setItem("bangcutClaudeKey", k);
    var cfg = readEngineConfig();
    cfg.ANTHROPIC_API_KEY = k;
    writeEngineConfig(cfg); // 저장소 있으면 미러 (없으면 조용히 실패 — localStorage가 원본)
    approveApiKey(k); // 헤드리스 CLI가 첫 사용 승인 프롬프트에서 막히지 않게 미리 승인
  }

  // 클로드 CLI는 env ANTHROPIC_API_KEY 최초 사용 시 대화형 승인을 요구한다
  // (~/.claude.json의 customApiKeyResponses.approved에 키 끝 20자가 있으면 통과).
  // claude -p 헤드리스 모드는 그 프롬프트에 답할 수 없어 무한 대기/실패한다.
  // → 키 저장 시점에 승인 토큰을 미리 기록해 프롬프트 자체를 건너뛴다.
  function approveApiKey(k) {
    if (!k) return;
    var fsN = nodeReq("fs");
    if (!fsN) return;
    var token = String(k).trim().slice(-20); // CLI의 CZ(key) = trim().slice(-20)
    var path = homeDir() + "/.claude.json";
    var j = {};
    try { j = JSON.parse(fsN.readFileSync(path, "utf8")) || {}; } catch (e) { j = {}; }
    if (j.oauthAccount && j.oauthAccount.emailAddress) return; // 로그인 계정은 건드리지 않음
    var c = j.customApiKeyResponses || {};
    var approved = (c.approved || []).slice();
    if (approved.indexOf(token) === -1) approved.push(token);
    j.customApiKeyResponses = { approved: approved, rejected: c.rejected || [] };
    if (typeof j.hasCompletedOnboarding === "undefined") j.hasCompletedOnboarding = true;
    try { fsN.writeFileSync(path, JSON.stringify(j, null, 2)); } catch (e) {}
  }

  // 규칙: 로그인이 있으면 로그인(정액) 사용, API 키는 로그인이 없을 때만 주입
  function buildClaudeEnv() {
    var env = extendedEnv();
    var key = claudeApiKey();
    if (!claudeAccount() && key) { approveApiKey(key); env.ANTHROPIC_API_KEY = key; }
    return env;
  }

  function maskKey(k) {
    if (!k) return "";
    return k.length <= 10 ? "•••" : k.slice(0, 7) + "…" + k.slice(-4);
  }

  // ============ 전제조건 감지 + 온보딩 (H2) ============

  var prereq = { claude: false, claudePath: null, repo: false, venv: false,
                 ffmpeg: false, connected: false, checked: false };

  function findBin(fsN, cands) {
    for (var i = 0; i < cands.length; i++) {
      try { if (fsN.existsSync(cands[i])) return cands[i]; } catch (e) {}
    }
    return null;
  }

  function checkPrereq(cb) {
    var fsN = nodeReq("fs");
    var cp = nodeReq("child_process");
    var root = repoRoot();
    prereq.repo = !!(root && fsN && fsN.existsSync(root + "/edit.sh"));
    prereq.venv = !!(root && fsN && fsN.existsSync(root + "/.venv/bin/python"));
    prereq.connected = !!(claudeAccount() || claudeApiKey());
    var home = homeDir();
    prereq.claudePath = fsN ? findBin(fsN, [
      home + "/.local/bin/claude", "/usr/local/bin/claude", "/opt/homebrew/bin/claude"
    ]) : null;
    prereq.claude = !!prereq.claudePath;
    prereq.ffmpeg = !!(fsN && findBin(fsN, [
      "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"
    ]));

    function done() {
      prereq.checked = true;
      if (prereq.claudePath) localStorage.setItem("bangcutClaudePath", prereq.claudePath);
      cb(prereq);
    }
    if ((prereq.claude && prereq.ffmpeg) || !cp) { done(); return; }
    cp.exec("command -v claude || true; command -v ffmpeg || true", { env: extendedEnv() },
      function (err, stdout) {
        String(stdout || "").split("\n").forEach(function (l) {
          l = l.trim();
          if (/\/claude$/.test(l)) { prereq.claude = true; prereq.claudePath = l; }
          if (/\/ffmpeg$/.test(l)) prereq.ffmpeg = true;
        });
        done();
      });
  }

  function renderObStatus() {
    var email = claudeAccount();
    var key = claudeApiKey();
    $("ob-conn-status").textContent = "현재: " + (email
      ? "구독 로그인됨 — " + email
      : (key ? "API 키 저장됨 (" + maskKey(key) + ")" : "미연결"));
    function line(ok, label) {
      return '<span class="' + (ok ? "ok" : "bad") + '">' + (ok ? "✓ " : "✗ ") + label + "</span><br>";
    }
    $("ob-status").innerHTML =
      line(prereq.connected, "Claude 연결") +
      line(prereq.claude, "클로드 코드 CLI") +
      line(prereq.ffmpeg, "ffmpeg") +
      line(prereq.repo && prereq.venv, "엔진 + 파이썬 환경");
    $("ob-num1").classList.toggle("done", prereq.connected);
    $("ob-num1").textContent = prereq.connected ? "✓" : "1";
    var step2ok = prereq.claude && prereq.ffmpeg && prereq.repo && prereq.venv;
    $("ob-num2").classList.toggle("done", step2ok);
    $("ob-num2").textContent = step2ok ? "✓" : "2";
  }

  function prereqOk() {
    return prereq.claude && prereq.repo && prereq.venv && prereq.connected && prereq.ffmpeg;
  }

  function openOnboard() {
    renderObStatus();
    $("onboard-overlay").classList.add("open");
  }
  function closeOnboard() { $("onboard-overlay").classList.remove("open"); }

  $("btn-ob-close").addEventListener("click", closeOnboard);

  $("btn-ob-save-key").addEventListener("click", function () {
    var k = $("ob-claude-key").value.trim();
    if (!k) return;
    saveClaudeKey(k);
    $("ob-claude-key").value = "";
    $("ob-claude-key").placeholder = "저장됨 (" + maskKey(k) + ") — 변경할 때만 입력";
    checkPrereq(renderObStatus);
  });

  var installing = false;
  function autoInstall() {
    if (installing) return;
    installing = true;
    var cp = nodeReq("child_process");
    var btn = $("btn-ob-auto");
    btn.disabled = true;
    btn.textContent = "설치 중…";
    var st = $("ob-status");
    st.innerHTML = "";
    function log(m) { st.innerHTML += m + "<br>"; st.scrollTop = st.scrollHeight; }

    function fin(errMsg) {
      installing = false;
      btn.disabled = false;
      btn.textContent = "자동 설치 시작";
      checkPrereq(function () {
        if (prereqOk()) {
          log('<span class="ok">✓ 모든 준비 완료 — 바로 사용할 수 있어요!</span>');
          updateRunButton();
          setTimeout(closeOnboard, 1500);
        } else {
          renderObStatus();
          if (errMsg) $("ob-status").innerHTML += '<span class="bad">' + errMsg + "</span>";
        }
      });
    }

    function stepEngine() {
      if (prereq.repo && prereq.venv) { fin(null); return; }
      if (!(claudeAccount() || claudeApiKey())) { fin("1단계에서 Claude를 먼저 연결해 주세요"); return; }
      var target = homeDir() + "/BangCut";
      log("▸ 엔진 설치 중… (클론 + 파이썬 환경, 수 분 소요)");
      var prompt = "https://github.com/sambang39/BangCut.git 을 " + target +
        " 에 클론하고(이미 있으면 git -C 로 pull), 그 폴더에서 python3 -m venv .venv 와 " +
        ".venv/bin/pip install -r requirements.txt 를 순서대로 수행하라. " +
        "확장 설치(심볼릭 링크·defaults)는 건너뛰어라. 전부 성공하면 DONE만 출력하라.";
      var child;
      try {
        child = cp.spawn(claudeBin(), ["-p", prompt, "--dangerously-skip-permissions"],
          { env: buildClaudeEnv(), cwd: homeDir(), stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) { fin("엔진 설치 실행 오류: " + e.message); return; }
      child.on("error", function (e) { fin("엔진 설치 오류: " + e.message); });
      child.on("close", function (code) {
        localStorage.setItem("bangcutEngineRoot", target);
        if (code === 0) { log("✓ 엔진 설치 단계 종료"); fin(null); }
        else fin("엔진 설치 실패 (코드 " + code + ") — 다시 시도해 주세요");
      });
    }

    function stepFfmpeg() {
      if (prereq.ffmpeg) { stepEngine(); return; }
      var fsN = nodeReq("fs");
      var brew = findBin(fsN, ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
      if (!brew) {
        log('<span class="bad">✗ ffmpeg 없음 — Homebrew(brew.sh) 설치 후 brew install ffmpeg 를 실행해 주세요</span>');
        stepEngine();
        return;
      }
      log("▸ ffmpeg 설치 중… (Homebrew, 수 분 소요)");
      cp.exec(brew + " install ffmpeg", { env: extendedEnv(), maxBuffer: 16 * 1024 * 1024 },
        function (err) {
          log(err ? '<span class="bad">✗ ffmpeg 설치 실패 — 수동: brew install ffmpeg</span>' : "✓ ffmpeg 설치 완료");
          checkPrereq(stepFfmpegDone);
        });
      function stepFfmpegDone() { stepEngine(); }
    }

    function stepCli() {
      if (prereq.claude) { stepFfmpeg(); return; }
      log("▸ 클로드 코드 CLI 설치 중…");
      cp.exec("curl -fsSL https://claude.ai/install.sh | bash",
        { env: extendedEnv(), maxBuffer: 16 * 1024 * 1024 }, function (err) {
          if (err) { fin("CLI 설치 실패 — 네트워크 확인 후 다시 시도해 주세요"); return; }
          log("✓ 클로드 코드 CLI 설치 완료");
          checkPrereq(stepFfmpeg);
        });
    }

    checkPrereq(stepCli);
  }
  $("btn-ob-auto").addEventListener("click", autoInstall);
  $("btn-ob-recheck").addEventListener("click", function () {
    var b = $("btn-ob-recheck");
    b.disabled = true;
    b.textContent = "확인 중…";
    checkPrereq(function () {
      b.disabled = false;
      b.textContent = "다시 확인";
      renderObStatus();
      if (prereqOk()) {
        $("ob-status").innerHTML += '<span class="ok">모든 준비 완료 — 컷편집을 시작할 수 있습니다!</span>';
        setTimeout(closeOnboard, 1200);
      }
    });
  });

  // 복사 버튼: 클릭 → ✓ 아이콘 2.5초 → 원복
  var COPY_SVG = '<svg viewBox="0 0 16 16"><path d="M4 2h7a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm2 4v7h7V6H6zM5 5h6V3H4v8h1V6a1 1 0 0 1 1-1z"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 16 16"><path d="M6.4 12.4 2.3 8.3l1.4-1.4 2.7 2.7 5.9-5.9 1.4 1.4z"/></svg>';

  function copyText(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  // 비밀값 보기/가리기 토글 (VITO·Claude 키 공용)
  (function () {
    var eyes = document.querySelectorAll(".pw-wrap .eye");
    for (var i = 0; i < eyes.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          var input = b.parentElement.querySelector("input");
          var show = input.type === "password";
          input.type = show ? "text" : "password";
          b.querySelector(".eye-on").style.display = show ? "none" : "block";
          b.querySelector(".eye-off").style.display = show ? "block" : "none";
        });
      })(eyes[i]);
    }
  })();

  (function () {
    var btns = document.querySelectorAll(".copybtn");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          var text = b.dataset.copyText;
          if (!text) {
            var srcEl = $(b.dataset.copy);
            if (!srcEl) return;
            text = srcEl.textContent;
          }
          copyText(text);
          b.innerHTML = CHECK_SVG;
          b.classList.add("copied");
          setTimeout(function () {
            b.innerHTML = COPY_SVG;
            b.classList.remove("copied");
          }, 2500);
        });
      })(btns[i]);
    }
  })();

  // ============ 컷편집: 클로드 코드 실행 브리지 (H4) + 쉬운 터미널 프로그레스 (H5) ============

  var STEPS = ["영상 분석", "전사", "컷 편집", "렌더", "완료"];
  var STEP_TITLES = ["영상 분석 중…", "전사 중…", "NG 및 무음 구간 컷 편집 중", "렌더 중", "완료!"];
  var STEP_PCT = [12, 40, 70, 95, 100];

  function claudeBin() {
    return prereq.claudePath || localStorage.getItem("bangcutClaudePath");
  }

  function repoRoot() {
    var fsN = nodeReq("fs");
    var pathN = nodeReq("path");
    if (!fsN || !pathN) return null;
    var cands = [];
    var ext = extensionDir();
    if (ext) {
      try { cands.push(pathN.dirname(fsN.realpathSync(ext))); } catch (e) {}
    }
    var saved = localStorage.getItem("bangcutEngineRoot");
    if (saved) cands.push(saved);
    cands.push(homeDir() + "/BangCut"); // pkg 설치 유저의 관례 클론 경로
    for (var i = 0; i < cands.length; i++) {
      try { if (cands[i] && fsN.existsSync(cands[i] + "/edit.sh")) return cands[i]; } catch (e2) {}
    }
    return cands[0] || null;
  }

  function writeEngineOverride(root) {
    // 수동 모드: 패널 설정 3종을 config.json에 주입 / 자동 모드: 잔여 override 제거(클로드가 판단)
    var cfg = readEngineConfig();
    if (gapMode === "manual") {
      cfg.MIN_SILENCE = settings.MIN_SILENCE;
      cfg.PAD_LEAD = settings.PAD_LEAD;
      cfg.PAD_TAIL = settings.PAD_TAIL;
    } else {
      delete cfg.MIN_SILENCE;
      delete cfg.PAD_LEAD;
      delete cfg.PAD_TAIL;
    }
    if (!writeEngineConfig(cfg)) throw new Error("config.json 쓰기 실패");
  }

  // ---------- 프로그레스 ----------

  function kfmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function clockFmt(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    return (m < 10 ? "0" + m : m) + ":" + ((s % 60) < 10 ? "0" + (s % 60) : s % 60);
  }

  function durFmt(ms) {
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    return m ? m + "분 " + (s % 60) + "초" : s + "초";
  }

  function updateProgMeta() {
    if (!run.startedAt) return;
    var t = clockFmt(Date.now() - run.startedAt);
    $("prog-meta").textContent = t + (run.tokens ? " · " + kfmt(run.tokens) + " 토큰" : "");
  }

  function addUsage(u) {
    if (!u) return;
    run.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
      (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    updateProgMeta();
  }

  function logLine(s) {
    s = String(s || "").trim();
    if (!s) return;
    run.logLines.push(s);
    if (run.logLines.length > 500) run.logLines = run.logLines.slice(-400);
    var el = $("run-log");
    el.textContent = run.logLines.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  function renderSteps() {
    var box = $("prog-steps");
    box.innerHTML = "";
    STEPS.forEach(function (name, i) {
      var d = document.createElement("div");
      d.className = "pstep" + (i < run.step ? " done" : i === run.step ? " cur" : "");
      d.textContent = (i < run.step ? "✓ " : i === run.step ? "▸ " : "· ") + name;
      box.appendChild(d);
    });
  }

  function setPct(p) {
    p = Math.max(run.pct, Math.min(100, Math.round(p)));
    run.pct = p;
    $("prog-pct").textContent = p + "%";
    $("prog-fill").style.width = p + "%";
  }

  function setStep(i) {
    if (i <= run.step) return; // 뒤로는 안 감 (마커 중복/순서 흔들림 방어)
    run.step = i;
    $("prog-title").textContent = STEP_TITLES[i] || (STEPS[i] + " 중…");
    setPct(i === 0 ? 3 : STEP_PCT[i - 1]);
    renderSteps();
  }

  function startCreep() {
    clearInterval(run.creepTimer);
    run.creepTimer = setInterval(function () {
      if (run.step < 0 || run.step >= STEPS.length - 1) return;
      var cap = STEP_PCT[run.step] - 2;
      if (run.pct < cap) setPct(run.pct + 1);
    }, 2500);
  }

  function setRunningUi(on) {
    $("btn-run-cut").disabled = on || !(source.path && source.imported);
    $("btn-run-cut").textContent = on ? "실행 중…" : "컷편집 시작";
    $("cut-options").classList.toggle("off", on); // 실행 중 옵션 전체 잠금
    if (on) {
      $("cut-overlay").classList.add("open");
      $("btn-stop-cut").style.display = "block";
      $("btn-co-close").style.display = "none";
    }
  }

  $("btn-co-close").addEventListener("click", function () {
    $("cut-overlay").classList.remove("open");
  });

  $("btn-log-toggle").addEventListener("click", function () {
    var el = $("run-log");
    var open = !el.classList.contains("open");
    el.classList.toggle("open", open);
    $("btn-log-toggle").textContent = open ? "간단히 보기" : "자세히 보기";
  });

  // ---------- 클로드 요청 프롬프트 ----------

  // ── 대본 컴포저 (채팅형) — 붙여넣기/임포트 → 프로젝트별 기억 → 자막 정렬·NG 보조 ──
  function scriptSidecar(src) {
    if (!src) return null;
    var dirs = outDirsOf(src);
    var base = src.split("/").pop().replace(/\.[^.]+$/, "");
    for (var i = 0; i < dirs.length; i++) if (statOk(dirs[i])) return dirs[i] + "/" + base + "_script.txt";
    return dirs[0] + "/" + base + "_script.txt";
  }
  function scriptFor(src) {
    if (!src) return "";
    var v = localStorage.getItem("bangcutScript:" + src);
    if (v != null) return v;
    var sc = scriptSidecar(src), fs = cepFs();
    if (sc && fs && statOk(sc)) { var r = fs.readFile(sc, window.cep.encoding.UTF8); if (r.err === 0) return r.data; }
    return "";
  }
  function saveScriptFor(src, text) {
    if (!src) return;
    localStorage.setItem("bangcutScript:" + src, text);
    // 사이드카로도 기록(엔진 NG 참조 + 세션 넘어 보존). 폴더 없으면 조용히 스킵.
    var sc = scriptSidecar(src), fs = cepFs();
    if (sc && fs) { try { fs.writeFile(sc, text, window.cep.encoding.UTF8); } catch (e) {} }
  }
  function showScHint(msg, kind) {
    var el = $("sc-hint");
    if (!el) return;
    el.textContent = msg; el.className = kind || "";
    void el.offsetWidth; el.classList.add("show");
  }
  function hideScHint() { var el = $("sc-hint"); if (el) { el.classList.remove("show"); el.textContent = ""; } }

  // 실제 읽을 수 있는 대본인지 판정 — 자판 난타(ㅂㅈㄷㄹ 미완성 자모)·특수문자만 거부
  function isReadableScript(text) {
    var t = String(text).replace(/\s/g, "");
    if (t.length < 2) return false;
    var real = (t.match(/[가-힣a-zA-Z0-9]/g) || []).length;   // 완성 글자/영문/숫자
    var jamo = (t.match(/[ㄱ-ㅎㅏ-ㅣ]/g) || []).length;        // 미완성 자모(난타)
    if (real < 2) return false;
    if (jamo > real) return false;          // 자모 난타가 우세
    if (real / t.length < 0.4) return false; // 특수문자·자모만 잔뜩
    return true;
  }

  function registerScript() {
    var text = ($("script-input").value || "").trim();
    if (!text) {  // 싹 지우면 안내도 사라지고 등록 해제
      scriptText = ""; if (source.path) saveScriptFor(source.path, "");
      var c0 = $("script-composer"); if (c0) c0.classList.remove("has");
      hideScHint();
      return;
    }
    if (!isReadableScript(text)) {  // 무의미 입력 → 역으로 안내(유지), 등록 안 함
      showScHint("문장이나 단어로 된 대본을 입력해 주세요", "warn");
      return;
    }
    scriptText = text;
    if (source.path) saveScriptFor(source.path, text);
    var comp = $("script-composer"); if (comp) comp.classList.add("has");
    // 컷편집 시작 전까지 계속 표시 (자동으로 사라지지 않음)
    showScHint("✓ 대본 등록됨 (" + text.replace(/\s+/g, "").length + "자) — 자막에 반영됩니다", "ok");
  }

  // 입력 유무에 따라 등록 버튼 활성/비활성 + 입력창 자동 확장
  function updateScState() {
    var input = $("script-input"), reg = $("sc-register");
    if (!input) return;
    var has = !!input.value.trim();
    if (reg) reg.disabled = !has;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 320) + "px";
  }
  function importScriptFile() {
    var fs = cepFs();
    if (!fs) return;
    var initDir = localStorage.getItem("lastVideoDir") || "~/Desktop";
    var res = fs.showOpenDialogEx(false, false, "대본 문서 선택", initDir, ["txt", "md", "rtf", "docx"]);
    if (!res || !res.data || !res.data.length) return;
    readScriptDoc(res.data[0]);
  }
  // txt/md는 그대로, docx는 XML에서 텍스트 추출(간이)
  function readScriptDoc(path) {
    var fs = cepFs();
    if (!fs) return;
    if (/\.docx$/i.test(path)) { flashScHint("docx는 텍스트로 저장해 붙여넣어 주세요 (간이 지원 준비중)", false); return; }
    var r = fs.readFile(path, window.cep.encoding.UTF8);
    if (r.err !== 0) { flashScHint("문서를 읽지 못했습니다", false); return; }
    $("script-input").value = r.data;
    registerScript();
  }
  (function initScriptComposer() {
    var input = $("script-input"), comp = $("script-composer");
    if (!input || !comp) return;
    $("sc-register").addEventListener("click", registerScript);
    $("sc-import").addEventListener("click", importScriptFile);
    updateScState();
    // 입력 즉시: 버튼 활성/비활성 + 창 자동확장. 잠깐 멈추면 자동 등록(유효성 판정)
    var t = null;
    input.addEventListener("input", function () {
      updateScState();
      clearTimeout(t); t = setTimeout(registerScript, 700);
    });
    // 드래그 앤 드롭(문서)
    comp.addEventListener("dragover", function (e) { e.preventDefault(); comp.classList.add("dragover"); });
    comp.addEventListener("dragleave", function () { comp.classList.remove("dragover"); });
    comp.addEventListener("drop", function (e) {
      e.preventDefault(); comp.classList.remove("dragover");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.path) readScriptDoc(f.path);
    });
  })();

  // 엔진(백엔드 클로드)이 읽을 대본 파일을 소스 폴더에 기록(항상 존재하는 경로)
  function writeScriptForEngine() {
    if (!scriptText || !source.path) return null;
    var fs = cepFs();
    if (!fs) return null;
    var dir = source.path.replace(/\/[^\/]+$/, "");
    var base = source.path.split("/").pop().replace(/\.[^.]+$/, "");
    var p = dir + "/" + base + "_script.txt";
    var w = fs.writeFile(p, scriptText, window.cep.encoding.UTF8);
    return w.err === 0 ? p : null;
  }

  function buildPrompt() {
    var L = [];
    L.push('영상 자동 컷편집을 수행하라. 대상 원본: "' + source.path + '"');
    if (gapMode === "manual") {
      L.push("- 무음 구간 설정: 사용자가 직접 지정 — config.json에 MIN_SILENCE/PAD_LEAD/PAD_TAIL로 반영돼 있음. --preset 옵션은 쓰지 말 것");
    } else {
      L.push("- 무음 구간 설정: 자동 — 고정 캘리브레이션값 사용. **--preset 표준** 을 그대로 쓰라. engine/analyze_video.py는 실행하지 말 것(분석·프리셋 선택 금지). 표준 프리셋이 이미 사용자 스타일에 맞춰 조정돼 있다.");
    }
    if (settings.sttModel === "vito") {
      L.push("- 전사 모델: VITO — engine/stt_vito.py로 먼저 전사해 _words.json을 만든 뒤 edit.sh 실행 (키는 config.json)");
    } else {
      L.push("- 전사 모델: Whisper — edit.sh가 자체 처리");
    }
    L.push(settings.resolution === "FHD"
      ? "- 시퀀스 해상도: FHD — edit.sh에 --fhd 플래그 추가"
      : "- 시퀀스 해상도: 4K(원본) — --fhd 플래그를 쓰지 말 것");
    if (scriptText) {
      var sp = writeScriptForEngine();
      if (sp) L.push('- 대본 제공됨: "' + sp + '" — NG 스윕에서 참고하라. 같은 대사를 여러 번 말한 재테이크는 대본과 대조해 완성 테이크를 남기고 실수 테이크를 --extra-cuts로 제거. (대본은 참고용 — 무음/추임새 컷을 대본으로 덮어쓰지 말 것)');
    }
    L.push("");
    L.push("실행 방식: cut-editing 스킬 플로우를 따르라. edit.sh는 백그라운드로 실행하고 출력을 주기적으로 확인하면서 진행 단계를 보고하라.");
    L.push("실행 횟수(정확히 2회, 필수): 1차는 --plan-only로 전사·컷 계획만 생성(렌더 없음) → _words.json을 읽고 '컷' 마커 규약(스킬 참조)대로 버리는 테이크·비화자 음성을 --extra-cuts JSON으로 작성 → 2차 풀 실행 1회(--extra-cuts 포함)로 최종 산출. NG 스윕(컷 마커 처리)은 생략 금지.");
    L.push("진행 보고 규칙(패널 프로그레스용 — 반드시 지켜라): 아래 단계가 시작될 때마다 해당 마커를 텍스트로 정확히 한 줄 출력:");
    L.push("###STEP:2:전사 / ###STEP:3:컷 편집 / ###STEP:4:렌더");
    L.push("(전사 시작=STEP:2, 무음/NG 컷 계획 시작=STEP:3, 렌더·자막 생성 시작=STEP:4)");
    L.push("결과 검수(과도한 컷·어미 잘림 확인) 후 성공이면 마지막 줄에 ###DONE, 실패면 ###FAIL:<한 줄 사유> 를 출력하라.");
    L.push("");
    L.push("절대 규칙: ###DONE 또는 ###FAIL을 출력하기 전에는 어떤 경우에도 응답을 끝내지 말라.");
    L.push("효율 규칙: 엔진 소스 코드는 읽기 전용 — 수정·개선 시도 금지. 각 단계 보고는 마커+한 줄 요약만.");
    L.push("검수는 *_cut_report.txt 확인과 산출물 존재 확인으로 끝내라 — 위의 2회(plan-only+최종) 외 추가 재실행·반복 검증 금지.");
    L.push("분석·전사·렌더가 수십 분 걸려도 백그라운드 출력을 계속 폴링하며 끝까지 기다려라.");
    L.push("'기다리는 중입니다', '분석이 끝나면 실행합니다' 같은 중간 보고로 턴을 마치는 것은 실패다.");
    L.push("최종 산출물(_cut.xml과 _cut.srt)이 결과 폴더에 실제로 존재하는 것을 ls로 확인한 뒤에만 ###DONE을 출력하라.");
    return L.join("\n");
  }

  // ---------- 실행 ----------

  function finishRun(ok, msg) {
    if (!run.running) return;
    run.running = false;
    clearInterval(run.creepTimer);
    clearInterval(run.timerInt);
    $("prog-wrap").classList.add("finished");
    if (run.startedAt) {
      var parts = [(ok ? "총 " : "경과 ") + durFmt(Date.now() - run.startedAt)];
      if (run.tokens) parts.push(kfmt(run.tokens) + " 토큰");
      if (run.cost != null) parts.push("$" + run.cost.toFixed(2));
      $("prog-meta").textContent = parts.join(" · ");
    }
    try { if (run.proc) killTree(run.proc); } catch (e) {}
    run.proc = null;
    setRunningUi(false);
    if (ok) {
      run.step = STEPS.length; // 전부 done 표시
      renderSteps();
      $("prog-title").textContent = "완료!";
      setPct(100);
      $("cut-overlay").classList.remove("open");
      cutStatus("컷편집 완료 (" + $("prog-meta").textContent + ") — 결과를 프로젝트로 가져옵니다", "ok");
      // H6: XML+SRT를 BangCut 빈으로 임포트하고 컷 시퀀스를 타임라인에 연다
      var outdir = source.path.replace(/\/[^\/]+$/, "") + "/BangCut";
      var base = source.path.split("/").pop().replace(/\.[^.]+$/, "");
      var xml = outdir + "/" + base + "_cut.xml";
      var srt = outdir + "/" + base + "_cut.srt";
      editorDismissed = false;
      var importDone = function () {
        // 컷편집 완료 후 자막 자동로드 안 함 — 사용자가 타임라인에서 다듬은 뒤
        // 자막 편집 탭에서 "현재 시퀀스 불러오기"로 그 시점 타임라인에 맞춰 생성한다.
        refreshSeqInfo();
      };
      if (statOk(xml)) {
        // 회차 스냅샷 사본(기준 XML) — 같은 경로 재임포트 문제 회피 + 수술 기준 확보
        var dd = new Date();
        var st2 = ("0" + dd.getHours()).slice(-2) + ("0" + dd.getMinutes()).slice(-2) + ("0" + dd.getSeconds()).slice(-2);
        var xmlSnap = xml.replace(/\.xml$/i, "_" + st2 + ".xml");
        try { nodeReq("fs").copyFileSync(xml, xmlSnap); } catch (eCp) { xmlSnap = xml; }
        evalScript("bangImportRun(" + JSON.stringify(xmlSnap) + "," + JSON.stringify(srt) + ",\"러프컷\")", function (res) {
          res = String(res || "");
          if (res.indexOf("OK") === 0) {
            cutStatus(res.replace(/^OK:?/, ""), "ok");
            logLine("== " + res.replace(/^OK:?/, ""));
            setXmlBasis(xmlSnap);
          } else {
            cutStatus(res.replace(/^ERR:?/, "결과 임포트 실패: "), "err");
            logLine("== " + res);
          }
          importDone();
        });
      } else {
        cutStatus("완료됐지만 XML을 찾지 못했습니다: " + xml, "err");
        importDone();
      }
    } else {
      $("prog-title").textContent = "중단됨";
      cutStatus(msg || "실패 — 로그를 확인하세요", "err");
      $("run-log").classList.add("open");
      $("btn-log-toggle").textContent = "간단히 보기";
      $("btn-stop-cut").style.display = "none";
      $("btn-co-close").style.display = "block";
    }
    if (msg) logLine((ok ? "== 완료: " : "== 실패: ") + msg);
  }

  function killTree(child) {
    try {
      var proc = nodeReq("process");
      proc.kill(-child.pid, "SIGTERM"); // detached 프로세스 그룹 전체 종료 (엔진 포함)
    } catch (e) {
      try { child.kill("SIGTERM"); } catch (e2) {}
    }
  }

  function scanText(text) {
    var m;
    var re = /###STEP:(\d+):/g;
    while ((m = re.exec(text))) {
      var n = parseInt(m[1], 10);
      if (n >= 2 && n <= 4) setStep(n - 1); // 마커 번호 = STEPS 인덱스 + 1 (전사=2/컷편집=3/렌더=4)
    }
    if (text.indexOf("###DONE") !== -1) run.sawDone = true;
    var f = text.match(/###FAIL:([^\n]*)/);
    if (f) run.failReason = f[1].trim() || "원인 미상";
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === "assistant" && ev.message && ev.message.content) {
      addUsage(ev.message.usage);
      for (var i = 0; i < ev.message.content.length; i++) {
        var c = ev.message.content[i];
        if (c.type === "text" && c.text) {
          scanText(c.text);
          logLine(c.text.replace(/###(STEP:[^\n]*|DONE|FAIL:[^\n]*)/g, "").trim());
        } else if (c.type === "tool_use") {
          var cmd = c.input && (c.input.command || c.input.file_path || "");
          logLine("▸ " + c.name + (cmd ? ": " + String(cmd).slice(0, 90) : ""));
        }
      }
    } else if (ev.type === "result") {
      if (ev.usage) {
        run.tokens = (ev.usage.input_tokens || 0) + (ev.usage.output_tokens || 0) +
          (ev.usage.cache_creation_input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0);
      }
      if (typeof ev.total_cost_usd === "number") run.cost = ev.total_cost_usd;
      var resText = String(ev.result || "");
      if (ev.is_error && /not logged in|log ?in/i.test(resText)) {
        finishRun(false, "클로드 코드 로그인이 필요합니다 — 터미널에서 claude 를 실행해 로그인한 뒤 다시 시도하세요");
      } else if (run.failReason) {
        finishRun(false, run.failReason);
      } else if (ev.subtype === "success" && !ev.is_error && run.sawDone) {
        finishRun(true, "");
      } else if (ev.subtype === "success" && !ev.is_error) {
        finishRun(false, "클로드가 작업을 끝까지 완료하지 않고 종료했습니다 — 다시 시도해 주세요 (자세히 보기에서 마지막 상태 확인)");
      } else {
        finishRun(false, resText.slice(0, 160) || "클로드 실행 실패 (" + (ev.subtype || "오류") + ")");
      }
    }
  }

  function runCut() {
    if (run.running) return;
    // 컷편집 시작 → 대본 입력창 비우기 (등록된 대본은 이번 실행·자막에 계속 사용됨)
    hideScHint();
    if ($("script-input")) { $("script-input").value = ""; $("script-input").style.height = ""; }
    if ($("script-composer")) $("script-composer").classList.remove("has");
    if ($("sc-register")) $("sc-register").disabled = true;
    // H2 게이트: 클로드 코드·프로젝트 설치 확인 후 진행
    checkPrereq(function () {
      if (!prereqOk()) { openOnboard(); return; }
      runCutReady();
    });
  }

  // STT 모델(VITO↔Whisper)이 직전 실행과 다르면 전사 캐시를 삭제한다.
  // 엔진 get_transcript는 _words.json이 있으면 모델 무관하게 재사용하므로,
  // 모델을 바꿔도 이전 전사가 그대로 쓰이는 캐시 버그를 패널에서 차단.
  function invalidateTranscriptIfModelChanged() {
    if (!source.path) return;
    var key = "bangcutStt:" + source.path;
    var prev = localStorage.getItem(key);
    var cur = settings.sttModel || "whisper";
    if (prev && prev !== cur) {
      var fs = cepFs();
      var dirs = outDirsOf(source.path);
      var base = source.path.split("/").pop().replace(/\.[^.]+$/, "");
      var files = [];
      for (var i = 0; i < dirs.length; i++) {
        files.push(dirs[i] + "/" + base + "_words.json");
        files.push(dirs[i] + "/" + base + "_vito_words.json");
        files.push(dirs[i] + "/" + base + "_cut_words.json");
      }
      for (var f = 0; f < files.length; f++) {
        if (fs && statOk(files[f])) { try { fs.deleteFile(files[f]); } catch (e) {} }
      }
    }
    localStorage.setItem(key, cur);
  }

  function runCutReady() {
    if (run.running) return;
    var cp = nodeReq("child_process");
    var bin = claudeBin();
    var root = repoRoot();
    if (!cp || !bin) { cutStatus("클로드 코드 실행 환경을 찾지 못했습니다", "err"); return; }
    if (!root || !statOk(root + "/edit.sh")) { cutStatus("엔진(edit.sh)을 찾지 못했습니다: " + root, "err"); return; }
    if (!source.path) { cutStatus("컷편집할 영상을 먼저 선택해 주세요 (드래그 앤 드롭 또는 클릭)", "err"); return; }

    invalidateTranscriptIfModelChanged(); // STT 모델 바뀌면 전사 캐시 삭제(모델 무관 재사용 방지)
    saveSettings(true);
    try { writeEngineOverride(root); } catch (e) {
      cutStatus("엔진 설정 전달 실패: " + e.message, "err");
      return;
    }

    run.running = true;
    run.step = -1;
    run.pct = 0;
    run.logLines = [];
    run.buf = "";
    run.sawDone = false;
    run.failReason = null;
    run.startedAt = Date.now();
    run.tokens = 0;
    run.cost = null;
    clearInterval(run.timerInt);
    run.timerInt = setInterval(updateProgMeta, 1000);
    $("prog-wrap").classList.remove("finished");
    updateProgMeta();
    $("run-log").textContent = "";
    $("run-log").classList.remove("open");
    $("btn-log-toggle").textContent = "자세히 보기";
    setRunningUi(true);
    cutStatus("", "");
    setStep(0);
    renderSteps();
    startCreep();
    logLine("== BangCut × Claude Code 실행 ==");
    logLine("대상: " + source.path.split("/").pop());

    var args = [
      "-p", buildPrompt(),
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions"
    ];
    var child;
    try {
      child = cp.spawn(bin, args, { cwd: root, env: buildClaudeEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finishRun(false, "클로드 실행 오류: " + e.message);
      return;
    }
    run.proc = child;

    child.stdout.on("data", function (d) {
      run.buf += String(d);
      var lines = run.buf.split("\n");
      run.buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch (e) {}
      }
    });
    child.stderr.on("data", function (d) {
      String(d).split("\n").forEach(function (l) { if (l.trim()) logLine("! " + l.trim()); });
    });
    child.on("error", function (e) { finishRun(false, "클로드 실행 오류: " + e.message); });
    child.on("close", function (code) {
      if (!run.running) return;
      if (run.failReason) finishRun(false, run.failReason);
      else if (run.sawDone) finishRun(true, "");
      else finishRun(false, code === 0
        ? "클로드가 작업을 끝까지 완료하지 않고 종료했습니다 — 다시 시도해 주세요"
        : "클로드가 예기치 않게 종료됨 (코드 " + code + ")");
    });
  }

  function stopCut() {
    if (!run.running) return;
    finishRun(false, "사용자 중단");
  }

  $("btn-run-cut").addEventListener("click", runCut);
  $("btn-stop-cut").addEventListener("click", stopCut);

  // ============ 단어 앵커 (Q2) ============

  function ensureCueMeta(c) {
    if (!c.anchors) { c.anchors = []; c.marks = []; c.atext = null; c.ldel = false; }
  }

  // 텍스트가 바뀌었으면 앵커·마크를 현재 토큰에 재정렬
  function syncAnchors(i) {
    var c = cues[i];
    ensureCueMeta(c);
    if (c.atext === c.text) return;
    var oldT = c.atext != null ? C.tokenize(c.atext) : [];
    var r = C.realignAnchors(oldT, c.anchors, c.marks, C.tokenize(c.text));
    c.anchors = r.anchors;
    c.marks = r.marks;
    c.atext = c.text;
  }

  function anchorFileFor(path) {
    var dir = path.replace(/\/[^\/]+$/, "");
    var base = path.split("/").pop().replace(/(_cut)?(_edit)?\.srt$/i, "");
    return dir + "/" + base + "_cut_words.json";
  }

  function mkA(w) { return { cs: w[0], ce: w[1], os: w[3], oe: w[4] }; }

  // 로드 시: 실측 단어 파일을 큐 토큰에 부착
  var anchorRaw = null; // 현재 컷의 실측 단어 목록 (마이그레이션 매칭용)

  function attachAnchors(awPath) {
    var fs = cepFs();
    if (!fs) return 0;
    var r = fs.readFile(awPath, window.cep.encoding.UTF8);
    if (r.err !== 0) return 0;
    var aw;
    try { aw = JSON.parse(r.data); } catch (e) { return 0; }
    if (!aw || !aw.length) return 0;
    anchorRaw = aw;
    var attached = 0;
    cues.forEach(function (c) {
      ensureCueMeta(c);
      var toks = C.tokenize(c.text);
      var cand = [];
      for (var k = 0; k < aw.length; k++) {
        var mid = (aw[k][0] + aw[k][1]) / 2;
        if (mid >= c.start - 0.06 && mid < c.end + 0.06) cand.push(aw[k]);
      }
      var A = [], M = [];
      if (cand.length === toks.length) {
        for (var t = 0; t < toks.length; t++) A.push(mkA(cand[t]));
      } else {
        var j = 0;
        for (var t2 = 0; t2 < toks.length; t2++) {
          var f = -1;
          for (var l = j; l < Math.min(j + 3, cand.length); l++) {
            if (C.normWord(cand[l][2]) === C.normWord(toks[t2].t)) { f = l; break; }
          }
          if (f >= 0) { A.push(mkA(cand[f])); j = f + 1; } else A.push(null);
        }
      }
      for (var m = 0; m < toks.length; m++) M.push(false);
      attached += A.filter(Boolean).length;
      c.anchors = A;
      c.marks = M;
      c.atext = c.text;
      c.ldel = false;
    });
    return attached;
  }

  // 실측 앵커 우선 단어 시간 (없으면 이웃 앵커 보간 → 글자수 비례 폴백)
  function anchoredWordTime(ci, wi) {
    syncAnchors(ci);
    var c = cues[ci];
    var a = c.anchors[wi];
    if (a) return a.cs;
    var toks = C.tokenize(c.text);
    var p = wi - 1, n = wi + 1;
    while (p >= 0 && !c.anchors[p]) p--;
    while (n < toks.length && !c.anchors[n]) n++;
    if (p >= 0 && n < toks.length && toks[n].s > toks[p].s) {
      var ratio = (toks[wi].s - toks[p].s) / (toks[n].s - toks[p].s);
      return c.anchors[p].cs + (c.anchors[n].cs - c.anchors[p].cs) * ratio;
    }
    return C.wordTime(c, toks, wi);
  }

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
    syncAnchors(i);
    var row = document.createElement("div");
    row.className = "row" + (i === pointer.cue ? " selected" : "") + (c.ldel ? " ldel" : "");
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
      sp.className = "w" + (i === pointer.cue && wi === pointer.word ? " pt" : "") +
        (c.marks && c.marks[wi] ? " del" : "");
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

  var CHEV_UP = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 4l6 7H2z"/></svg>';
  var CHEV_DN = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 12 2 5h12z"/></svg>';

  function miniBtn(label, title, enabled, onClick) {
    var b = document.createElement("button");
    if (label === "▲") b.innerHTML = CHEV_UP;
    else if (label === "▼") b.innerHTML = CHEV_DN;
    else b.textContent = label;
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
    if (!opts.noSync) syncPlayhead(anchoredWordTime(ci, wi));
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
        syncAnchors(i);
        pushHistory();
        var c2 = cues[i];
        var t = c2.text;
        var newText;
        var nToks = nv ? nv.split(" ").length : 0;
        if (nv) {
          newText = t.slice(0, tk.s) + nv + t.slice(tk.e);
          // 단어 수 유지되면 앵커 그대로(글자만 교정), 늘면 첫 단어만 앵커 유지
          if (nToks > 1) {
            var ins = [c2.anchors[wi]];
            var insM = [c2.marks[wi]];
            for (var x = 1; x < nToks; x++) { ins.push(null); insM.push(false); }
            c2.anchors = c2.anchors.slice(0, wi).concat(ins, c2.anchors.slice(wi + 1));
            c2.marks = c2.marks.slice(0, wi).concat(insM, c2.marks.slice(wi + 1));
          }
        } else {
          newText = (t.slice(0, tk.s) + t.slice(tk.e)).replace(/ {2,}/g, " ").replace(/^ +| +$/g, "");
          c2.anchors = c2.anchors.slice(0, wi).concat(c2.anchors.slice(wi + 1));
          c2.marks = c2.marks.slice(0, wi).concat(c2.marks.slice(wi + 1));
        }
        c2.text = newText;
        c2.atext = newText;
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
  var followLast = -1;      // 마지막으로 관측/전송한 플레이헤드(초)
  var followMuteUntil = 0;  // 패널發 이동 직후 역싱크 억제 시한

  function syncPlayhead(sec) {
    syncPending = sec;
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      if (syncPending == null) return;
      var s = syncPending;
      syncPending = null;
      followLast = s;
      followMuteUntil = Date.now() + 900;
      evalScript("bangSetPlayerPosition(" + (s + 0.0001) + ")");
    }, 120);
  }

  // 역방향 싱크: 타임라인 플레이헤드를 따라 자막·단어 포인트 이동
  function cueAt(t) {
    for (var i = 0; i < cues.length; i++) {
      if (t < cues[i].start) return Math.max(0, i - 1) === i ? i : (i > 0 && t <= cues[i - 1].end + 0.001 ? i - 1 : i);
      if (t <= cues[i].end) return i;
    }
    return cues.length - 1;
  }

  function wordAt(ci, t) {
    var c = cues[ci];
    syncAnchors(ci);
    var toks = tokensOf(ci);
    if (!toks.length) return 0;
    for (var w = 0; w < toks.length; w++) {
      var a = c.anchors[w];
      if (a && t >= a.cs && t < a.ce) return w;
    }
    var dur = Math.max(0.001, c.end - c.start);
    var charPos = Math.max(0, Math.min(1, (t - c.start) / dur)) * c.text.length;
    for (var w = 0; w < toks.length; w++) {
      if (charPos < toks[w].e) return w;
    }
    return toks.length - 1;
  }

  setInterval(function () {
    if (current !== "screen-editor" || !cues.length || mode !== "nav" || run.running) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (Date.now() < followMuteUntil) return;
    evalScript("bangGetPlayerPosition()", function (res) {
      var t = parseFloat(res);
      if (!isFinite(t)) return;
      if (Date.now() < followMuteUntil) return;
      if (Math.abs(t - followLast) < 0.05) return;
      followLast = t;
      var ci = cueAt(t);
      if (ci < 0) return;
      var wi = wordAt(ci, t);
      if (ci === pointer.cue && wi === pointer.word) return;
      setPointer(ci, wi, { scroll: true, noSync: true });
    });
  }, 400);

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
    cues = snapshot.map(function (c) {
      return {
        start: c.start, end: c.end, text: c.text,
        atext: c.atext, ldel: !!c.ldel,
        anchors: (c.anchors || []).slice(),
        marks: (c.marks || []).slice()
      };
    });
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
    syncAnchors(i);
    var a = c.text.slice(0, pos).replace(/\s+$/, "");
    var b = c.text.slice(pos).replace(/^\s+/, "");
    if (!a || !b) { renderRow(i); return; }
    pushHistory();
    var toks = C.tokenize(c.text);
    var k = 0;
    while (k < toks.length && toks[k].e <= pos) k++;
    // 실측 앵커 경계에서 나누기 (드리프트 방지) — 없으면 글자수 비례 폴백
    var aEnd = null, bStart = null;
    for (var p = k - 1; p >= 0; p--) if (c.anchors[p]) { aEnd = c.anchors[p].ce; break; }
    for (var n = k; n < toks.length; n++) if (c.anchors[n]) { bStart = c.anchors[n].cs; break; }
    var tA, tB;
    if (aEnd != null && bStart != null && bStart >= aEnd - 0.001) {
      // 단어 사이 소공백(<=1.2s)은 붙여서 나눔 — 캡션 빈틈 방지. 긴 정적만 남김
      tA = (bStart - aEnd <= 1.2) ? bStart : aEnd;
      tB = bStart;
    } else {
      var dur = c.end - c.start;
      var ratio = a.length / (a.length + b.length);
      tA = tB = c.start + Math.max(0.2, Math.min(dur - 0.2, dur * ratio));
    }
    var second = {
      start: Math.min(tB, c.end), end: c.end, text: b, atext: b,
      anchors: c.anchors.slice(k), marks: c.marks.slice(k), ldel: c.ldel
    };
    c.end = Math.max(c.start + 0.1, tA);
    c.text = a;
    c.atext = a;
    c.anchors = c.anchors.slice(0, k);
    c.marks = c.marks.slice(0, k);
    cues.splice(i + 1, 0, second);
    dirty = true;
    render(i + 1, 0);
  }

  function mergeUp(i) {
    if (i <= 0 || i >= cues.length) return;
    syncAnchors(i - 1);
    syncAnchors(i);
    pushHistory();
    var prev = cues[i - 1];
    var cur = cues[i];
    var joinWord = C.tokenize(prev.text).length; // 병합 지점 단어 인덱스
    prev.text = (prev.text.replace(/\s+$/, "") + " " + cur.text.replace(/^\s+/, "")).trim();
    prev.atext = prev.text;
    prev.anchors = prev.anchors.concat(cur.anchors);
    prev.marks = prev.marks.concat(cur.marks);
    prev.ldel = prev.ldel && cur.ldel;
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

    // 입력창 밖 Backspace는 CEP 브라우저의 '뒤로 가기'로 동작해 패널이 리셋됨 — 무조건 차단
    if (e.code === "Backspace" && !inField) e.preventDefault();

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
      if (seqSource) applyToSequence(); // 재투영 모드: 저장 개념 대신 시퀀스에 적용
      else saveSrt();
      return;
    }
    if (e.key === "Escape") {
      if (find.open && (!inField || (t.closest && t.closest("#find-drawer")))) {
        closeFind();
      }
      return;
    }

    if (current !== "screen-editor" || mode !== "nav" || inField || !cues.length || run.running) return;

    switch (e.code) {
      case "KeyA": e.preventDefault(); moveWord(-1); break;
      case "KeyD": e.preventDefault(); moveWord(1); break;
      case "KeyW": e.preventDefault(); moveCue(-1); break;
      case "KeyS": e.preventDefault(); moveCue(1); break;
      case "Enter":
      case "NumpadEnter":
        e.preventDefault();
        splitAtPointer();
        break;
      case "KeyZ":
        e.preventDefault();
        if (pointer.cue >= 0) toggleWordMark(pointer.cue, pointer.word);
        break;
      case "KeyX":
        e.preventDefault();
        if (pointer.cue >= 0) toggleLineMark(pointer.cue);
        break;
      case "Backspace":
        e.preventDefault();
        if (pointer.cue > 0) mergeUp(pointer.cue);
        break;
      case "Delete":
        e.preventDefault();
        if (pointer.cue >= 0 && pointer.cue < cues.length - 1) mergeUp(pointer.cue + 1);
        break;
    }
  });

  // ============ 삭제 마킹 (Q3) ============

  function toggleWordMark(ci, wi) {
    syncAnchors(ci);
    var c = cues[ci];
    if (wi >= c.marks.length) return;
    if (!c.marks[wi] && !c.anchors[wi]) {
      setStatus("새로 입력된 단어라 실측 시간이 없습니다 — 삭제 시 추정 구간으로 잘립니다", "err");
    }
    pushHistory();
    c.marks[wi] = !c.marks[wi];
    dirty = true;
    renderRow(ci);
    setPointer(ci, wi, { scroll: false, noSync: true });
    updateSummary();
  }

  function toggleLineMark(ci) {
    syncAnchors(ci);
    pushHistory();
    cues[ci].ldel = !cues[ci].ldel;
    dirty = true;
    renderRow(ci);
    setPointer(ci, pointer.word, { scroll: false, noSync: true });
    updateSummary();
  }

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
    anchorRaw = null;
    var anchored = attachAnchors(anchorFileFor(path));
    if (anchored) setStatus("단어 앵커 " + anchored + "개 연결됨 — 정밀 싱크·삭제 마킹 사용 가능", "ok");
    pointer = { cue: -1, word: 0 };
    history = new C.History(120);
    typingSquash = null;
    rememberProjSrt(path);
    editorDismissed = false;
    $("editor-file").textContent = path.split("/").pop();
    $("editor-file").title = path;
    showScreen("screen-editor");
    render(0, 0);
    setTimeout(maybeOfferMigration, 300);
  }

  function editPath() {
    if (/_edit\.srt$/i.test(srtPath)) return srtPath;
    return srtPath.replace(/\.srt$/i, "_edit.srt");
  }

  // ── 현재 시퀀스 불러오기 (SRT 없이 재투영) ──
  // 미디어 경로 → 전사(_words.json) 경로 (존재하는 것)
  function wordsPathFor(mediaPath) {
    if (!mediaPath) return null;
    var dir = mediaPath.replace(/\/[^\/]+$/, "");
    var base = mediaPath.split("/").pop().replace(/\.[^.]+$/, "");
    var cands = [dir + "/BangCut/" + base + "_words.json",
                 dir + "/Premiere-Pro-edit-bang/" + base + "_words.json"];
    for (var i = 0; i < cands.length; i++) if (statOk(cands[i])) return cands[i];
    return null;
  }

  // 활성 시퀀스를 읽어 재투영 자막 생성
  function loadFromSequence() {
    if (dirty && cues.length &&
        !confirm("저장 안 된 자막 편집이 있습니다. 새로 불러올까요?")) return;
    setStatus("현재 시퀀스 읽는 중…");
    evalScript("bangReadSeqClips()", function (res) {
      var info = parseJson(res);
      if (!info || !info.ok) { setStatus((info && info.err) || "시퀀스를 읽지 못했습니다", "err"); return; }
      // 소스별로 클립을 모으고, 전사가 있는 소스를 선택 (경로 정규화: 프리미어가 ///로 줌)
      var bySrc = {};
      for (var i = 0; i < info.clips.length; i++) {
        var cl = info.clips[i], mp = String(cl[3] || "").replace(/^\/{2,}/, "/");
        if (!mp) continue;
        if (!bySrc[mp]) bySrc[mp] = [];
        bySrc[mp].push([cl[0], cl[1], cl[2]]);
      }
      var chosen = null, wpath = null;
      for (var p in bySrc) { var wp = wordsPathFor(p); if (wp) { chosen = p; wpath = wp; break; } }
      if (!chosen) {
        setStatus("이 시퀀스에는 전사된 원본 클립이 없습니다 — 컷편집한 시퀀스를 여세요", "err");
        return;
      }
      var fs = cepFs();
      var r = fs.readFile(wpath, window.cep.encoding.UTF8);
      if (r.err !== 0) { setStatus("전사 파일을 읽지 못했습니다", "err"); return; }
      var words;
      try { words = JSON.parse(r.data); } catch (e) { setStatus("전사 파일 형식 오류", "err"); return; }
      var scr = scriptFor(chosen); // 이 소스로 등록한 대본이 있으면 교정·부호·나눔에 반영
      var built = C.buildCuesFromSequence(words, bySrc[chosen], scr ? { script: scr } : null);
      if (!built.length) { setStatus("자막을 만들지 못했습니다 (클립과 전사가 맞지 않음)", "err"); return; }

      cues = built;
      seqSource = chosen;
      seqName = info.name;
      srtPath = null;
      dirty = false;
      anchorRaw = null;
      pointer = { cue: -1, word: 0 };
      history = new C.History(120);
      typingSquash = null;
      editorDismissed = false;
      $("editor-file").textContent = info.name;
      $("editor-file").title = "현재 시퀀스: " + info.name;
      showScreen("screen-editor");
      render(0, 0);
      setStatus("현재 시퀀스에서 자막 " + cues.length + "개 생성 — 컷에 맞춰 정렬됨", "ok");
    });
  }

  // 프로젝트 시퀀스 드롭다운 채우기
  function populateSeqPick() {
    var sel = $("seq-pick");
    if (!sel) return;
    evalScript("bangListSequences()", function (res) {
      var info = parseJson(res);
      sel.innerHTML = "";
      var ph = document.createElement("option");
      ph.value = ""; ph.textContent = "시퀀스 선택…";
      sel.appendChild(ph);
      if (!info || !info.ok) return;
      for (var i = 0; i < info.sequences.length; i++) {
        var s = info.sequences[i], o = document.createElement("option");
        o.value = s.id;
        o.textContent = (s.active ? "● " : "") + s.name;   // 열린 시퀀스 = 점+색상 강조
        if (s.active) { o.style.color = "#3fa9f5"; o.style.fontWeight = "600"; }
        sel.appendChild(o);
      }
    });
  }

  // 활성 시퀀스 감지 → 불러오기 버튼 활성/비활성 + 이름 표시
  function refreshSeqTarget() {
    evalScript("bangGetSeqInfo()", function (res) {
      var info = parseJson(res), has = !!(info && info.ok);
      var btn = $("btn-load-seq");
      if (btn) btn.disabled = !has;
      var hint = $("seq-hint");
      if (hint) hint.textContent = has
        ? "“" + info.name + "” 시퀀스를 자막 편집합니다"
        : "타임라인에 자막 편집할 시퀀스를 여세요";
    });
  }

  function saveSrt() {
    if (!srtPath) { setStatus("먼저 SRT를 불러오세요", "err"); return null; }
    var fs = cepFs();
    if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return null; }
    var out = editPath();
    C.fillGapsCues(cues);
    var r = fs.writeFile(out, C.serializeSrt(cues), window.cep.encoding.UTF8);
    if (r.err !== 0) { setStatus("저장 실패 (err " + r.err + ")", "err"); return null; }
    dirty = false;
    updateSummary();
    rememberProjSrt(out);
    saveEditMeta(out);
    setStatus("저장됨: " + out.split("/").pop(), "ok");
    return out;
  }

  // 마킹된 삭제 구간 수집 (원본/컷 타임라인 각각, 병합 정렬)
  function collectMarkRanges() {
    var orig = [], cut = [], skipped = 0;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      syncAnchors(i);
      var anch = (c.anchors || []).filter(Boolean);
      if (c.ldel) {
        if (anch.length) {
          orig.push([anch[0].os, anch[anch.length - 1].oe]);
          cut.push([anch[0].cs, anch[anch.length - 1].ce]);
        } else skipped++;
      } else if (c.marks) {
        for (var w = 0; w < c.marks.length; w++) {
          if (!c.marks[w]) continue;
          var a = c.anchors[w];
          if (a) { orig.push([a.os, a.oe]); cut.push([a.cs, a.ce]); }
          else skipped++;
        }
      }
    }
    return { orig: C.mergeRanges(orig), cut: C.mergeRanges(cut), skipped: skipped };
  }

  function videoForSrt(path) {
    // <영상폴더>/BangCut/x_cut.srt → <영상폴더>/x.<ext>
    var outdir = path.replace(/\/[^\/]+$/, "");
    var parent = outdir.replace(/\/[^\/]+$/, "");
    var base = path.split("/").pop().replace(/(_cut)?(_edit)?\.srt$/i, "");
    var exts = [".MP4", ".mp4", ".mov", ".MOV", ".m4v", ".mkv", ".mts", ".mxf"];
    for (var i = 0; i < exts.length; i++) {
      if (statOk(parent + "/" + base + exts[i])) return parent + "/" + base + exts[i];
    }
    return null;
  }

  // ============ XML 수술 (Q4 v2) ============
  // 엔진이 만든 FCP7 XML에서 컷타임 구간을 직접 제거 — 재실행 없이 결정적으로.
  // 구조 전제(엔진 생성 규칙): cv/ca 1:1 쌍, 연속 타임라인, 파일 정의는 첫 클립에만.

  function surgeryCutXml(xmlText, rangesSec) {
    function nums(block, tag) {
      var m = block.match(new RegExp("<" + tag + ">(-?\\d+)</" + tag + ">"));
      return m ? parseInt(m[1], 10) : null;
    }
    function setTag(block, tag, v) {
      return block.replace(new RegExp("<" + tag + ">-?\\d+</" + tag + ">"), "<" + tag + ">" + v + "</" + tag + ">");
    }
    var tbM = xmlText.match(/<timebase>(\d+)<\/timebase>/);
    var ntsc = /<ntsc>TRUE<\/ntsc>/.test(xmlText);
    if (!tbM) throw new Error("타임베이스를 찾지 못했습니다");
    var fps = ntsc ? parseInt(tbM[1], 10) * 1000 / 1001 : parseInt(tbM[1], 10);

    // 클립 블록 추출 (문서 순서: 비디오 전부 → 오디오 전부)
    var blockRe = /<clipitem id="(c[va]\d+)">[\s\S]*?<\/clipitem>/g;
    var vBlocks = [], aBlocks = [], m0;
    var firstIdx = -1, lastIdx = -1;
    while ((m0 = blockRe.exec(xmlText))) {
      if (firstIdx < 0) firstIdx = m0.index;
      lastIdx = m0.index + m0[0].length;
      if (m0[1].charAt(1) === "v") vBlocks.push(m0[0]);
      else aBlocks.push(m0[0]);
    }
    if (!vBlocks.length || vBlocks.length !== aBlocks.length) {
      throw new Error("클립 구조 인식 실패 (v:" + vBlocks.length + " a:" + aBlocks.length + ")");
    }

    // 비디오/오디오 사이 구분자(비디오 마지막 블록 뒤 ~ 오디오 첫 블록 앞)
    var lastVEnd = xmlText.indexOf(vBlocks[vBlocks.length - 1]) + vBlocks[vBlocks.length - 1].length;
    var firstAStart = xmlText.indexOf(aBlocks[0]);
    var header = xmlText.slice(0, firstIdx);
    var middle = xmlText.slice(lastVEnd, firstAStart);
    var footer = xmlText.slice(lastIdx);

    // 전체 파일 정의 추출(첫 클립에만 존재) → 이후 자기닫힘 참조로 정규화
    function fullFileDef(block) {
      var fm = block.match(/<file id="(file-\d+)">[\s\S]*?<\/file>/);
      return fm ? { id: fm[1], xml: fm[0] } : null;
    }
    var vFile = fullFileDef(vBlocks[0]);
    var aFile = fullFileDef(aBlocks[0]);
    if (!vFile || !aFile) throw new Error("파일 정의를 찾지 못했습니다");

    // 쌍 목록
    var pairs = [];
    for (var i = 0; i < vBlocks.length; i++) {
      pairs.push({
        vT: vBlocks[i], aT: aBlocks[i],
        start: nums(vBlocks[i], "start"), end: nums(vBlocks[i], "end"),
        vin: nums(vBlocks[i], "in"), ain: nums(aBlocks[i], "in")
      });
    }

    // 프레임 구간 (병합·정렬 후 뒤에서부터 적용)
    var fr = rangesSec.map(function (g) { return [Math.round(g[0] * fps), Math.round(g[1] * fps)]; })
      .filter(function (g) { return g[1] > g[0]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var totalD = 0;
    for (var r0 = 0; r0 < fr.length; r0++) totalD += fr[r0][1] - fr[r0][0];

    for (var r = fr.length - 1; r >= 0; r--) {
      var rs = fr[r][0], re = fr[r][1], D = re - rs;
      var out = [];
      for (var p = 0; p < pairs.length; p++) {
        var c = pairs[p];
        if (c.end <= rs) { out.push(c); continue; }
        if (c.start >= re) { c.start -= D; c.end -= D; out.push(c); continue; }
        var leftLen = Math.max(0, rs - c.start);
        var rightLen = Math.max(0, c.end - re);
        if (leftLen > 0) {
          out.push({ vT: c.vT, aT: c.aT, start: c.start, end: c.start + leftLen,
                     vin: c.vin, ain: c.ain });
        }
        if (rightLen > 0) {
          var skip = re - c.start; // 소스에서 건너뛸 양
          out.push({ vT: c.vT, aT: c.aT, start: rs, end: rs + rightLen,
                     vin: c.vin + skip, ain: c.ain + skip });
        }
      }
      pairs = out;
    }
    if (!pairs.length) throw new Error("모든 클립이 삭제됩니다 — 마킹을 확인해 주세요");

    // 검증 1: 연속성·시작 0
    pairs.sort(function (a, b) { return a.start - b.start; });
    if (pairs[0].start !== 0) throw new Error("검증 실패: 시작이 0이 아님 (" + pairs[0].start + ")");
    for (var q = 0; q < pairs.length - 1; q++) {
      if (pairs[q].end !== pairs[q + 1].start) {
        throw new Error("검증 실패: 클립 불연속 @" + pairs[q].end + "→" + pairs[q + 1].start);
      }
    }
    var newDur = pairs[pairs.length - 1].end;

    // 블록 재조립
    function rebuild(tmpl, isVideo, k, c) {
      var dur = c.end - c.start;
      var srcIn = isVideo ? c.vin : c.ain;
      var b = tmpl;
      b = b.replace(/<clipitem id="c[va]\d+">/, '<clipitem id="' + (isVideo ? "cv" : "ca") + k + '">');
      b = setTag(b, "start", c.start);
      b = setTag(b, "end", c.end);
      b = setTag(b, "in", srcIn);
      b = setTag(b, "out", srcIn + dur);
      // 파일 참조 정규화(자기닫힘) → 첫 클립에만 전체 정의 재주입
      var fid = isVideo ? vFile.id : aFile.id;
      b = b.replace(/<file id="file-\d+">[\s\S]*?<\/file>/, '<file id="' + fid + '"/>');
      b = b.replace(/<file id="file-\d+"\/>/, '<file id="' + fid + '"/>');
      if (k === 0) b = b.replace('<file id="' + fid + '"/>', isVideo ? vFile.xml : aFile.xml);
      // 링크 재생성 (쌍 상호 참조 + clipindex)
      b = b.replace(/<link>[\s\S]*?<\/link>\s*<link>[\s\S]*?<\/link>/,
        "<link><linkclipref>cv" + k + "</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>" + (k + 1) + "</clipindex></link>" +
        "<link><linkclipref>ca" + k + "</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>" + (k + 1) + "</clipindex></link>");
      // 오디오 페이드 키프레임 재계산(있을 때만): [0, f, dur-f, dur]
      if (!isVideo && /<keyframe><when>/.test(b)) {
        var kfs = b.match(/<keyframe><when>\d+<\/when>/g);
        if (kfs && kfs.length === 4) {
          var oldF = parseInt(kfs[1].match(/\d+/)[0], 10);
          var f = Math.max(1, Math.min(oldF, Math.floor(dur / 2)));
          var whens = [0, f, dur - f, dur];
          var idx = 0;
          b = b.replace(/<keyframe><when>\d+<\/when>/g, function () {
            return "<keyframe><when>" + whens[idx++] + "</when>";
          });
        }
      }
      return b;
    }

    var vOut = [], aOut = [];
    for (var k2 = 0; k2 < pairs.length; k2++) {
      vOut.push(rebuild(pairs[k2].vT, true, k2, pairs[k2]));
      aOut.push(rebuild(pairs[k2].aT, false, k2, pairs[k2]));
    }

    // 시퀀스 duration 갱신 (시퀀스 레벨 첫 duration)
    var newXml = header + vOut.join("\n") + middle + aOut.join("\n") + footer;
    var seqDurRe = /(<sequence[^>]*>\s*<name>[^<]*<\/name>\s*<duration>)(\d+)(<\/duration>)/;
    var sd = newXml.match(seqDurRe);
    if (sd) newXml = newXml.replace(seqDurRe, "$1" + newDur + "$3");

    // 검증 2: out-in == end-start 전수
    var chk = /<clipitem id="c[va]\d+">[\s\S]*?<\/clipitem>/g, cm;
    while ((cm = chk.exec(newXml))) {
      var bs = nums(cm[0], "start"), be = nums(cm[0], "end");
      var bi = nums(cm[0], "in"), bo = nums(cm[0], "out");
      if (bo - bi !== be - bs) throw new Error("검증 실패: in/out 불일치 @" + bs);
    }
    return { xml: newXml, removedFrames: totalD, newDurFrames: newDur, clips: pairs.length };
  }

  // 마킹 삭제 반영 v2: XML 수술 — 엔진·클로드·재실행 없이 즉시 (토큰 0, 1초 미만)
  function applyWithCuts(r) {
    if (run.running) { setStatus("컷편집 실행 중에는 반영할 수 없습니다", "err"); return; }
    var fsN = nodeReq("fs");
    if (!fsN) { setStatus("Node 환경을 찾지 못했습니다", "err"); return; }

    // 기준 XML(현재 시퀀스의 원본) — 컷편집/이전 반영 시 기록됨
    var basis = xmlBasis || (projectPath && localStorage.getItem("bangcutXmlBasis:" + projectPath));
    if (!basis || !statOk(basis)) {
      setStatus("이 시퀀스의 기준 XML을 찾을 수 없습니다 — 컷편집을 새로 실행한 결과에서 마킹해 주세요", "err");
      return;
    }

    var outdir = srtPath.replace(/\/[^\/]+$/, "");
    var base = srtPath.split("/").pop().replace(/(_cut)?(_edit)?\.srt$/i, "");

    var btn = $("btn-apply");
    btn.disabled = true;
    $("apply-overlay").classList.add("open");
    $("ao-time").textContent = "00:00";
    run.running = true;

    function fail(msg) {
      run.running = false;
      btn.disabled = false;
      $("apply-overlay").classList.remove("open");
      setStatus(msg, "err");
    }

    var result;
    try {
      var xmlText = fsN.readFileSync(basis, "utf8");
      result = surgeryCutXml(xmlText, r.cut);
    } catch (e) {
      fail("컷 수술 실패: " + e.message);
      return;
    }

    // 사용자 텍스트 보존 SRT: 마킹 단어 제거 + 시간 리맵 (수술과 동일 구간 → 정합 보장)
    var newCues = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (c.ldel) continue;
      syncAnchors(i);
      var toks = C.tokenize(c.text);
      var kept = [];
      for (var w = 0; w < toks.length; w++) if (!c.marks[w]) kept.push(toks[w].t);
      var text = kept.join(" ").trim();
      if (!text) continue;
      var ns = C.remapTime(c.start, r.cut);
      var ne = C.remapTime(c.end, r.cut);
      if (ne - ns < 0.15) continue;
      newCues.push({ start: ns, end: ne, text: text });
    }
    C.fillGapsCues(newCues);

    var d = new Date();
    var stamp = ("0" + d.getHours()).slice(-2) + ("0" + d.getMinutes()).slice(-2) + ("0" + d.getSeconds()).slice(-2);
    var xmlFile = outdir + "/" + base + "_cut_" + stamp + ".xml";
    var srtFile = outdir + "/" + base + "_cut_" + stamp + ".srt";
    try {
      fsN.writeFileSync(xmlFile, result.xml);
      fsN.writeFileSync(srtFile, C.serializeSrt(newCues));
    } catch (e2) {
      fail("결과 파일 쓰기 실패: " + e2.message);
      return;
    }
    logLine("== XML 수술: " + r.cut.length + "구간 · " + Math.round(result.removedFrames / seqInfo.fps * 10) / 10 + "초 제거, 클립 " + result.clips + "쌍");

    evalScript("bangImportRun(" + JSON.stringify(xmlFile) + "," + JSON.stringify(srtFile) + ",\"삭제반영\")",
      function (res2) {
        res2 = String(res2 || "");
        if (res2.indexOf("OK") !== 0) {
          fail(res2.replace(/^ERR:?/, "임포트 실패: "));
          return;
        }
        evalScript("bangApplySrt(" + JSON.stringify(srtFile) + ")", function (res3) {
          run.running = false;
          btn.disabled = false;
          $("apply-overlay").classList.remove("open");
          res3 = String(res3 || "");
          setStatus(res3.indexOf("OK") === 0
            ? "삭제 반영 완료 — 새 러프컷과 자막이 타임라인에 적용됐습니다"
            : "새 러프컷은 열렸지만 캡션 삽입 실패: " + res3.replace(/^ERR:?/, ""),
            res3.indexOf("OK") === 0 ? "ok" : "err");
          setXmlBasis(xmlFile);
          loadFile(srtFile);
        });
      });
  }

  // 편집 메타 사이드카: 자막 나눔·수정을 원본 시간 앵커와 함께 보존 → 재컷편집 후 이어서 적용
  function saveEditMeta(srtOut) {
    var fsN = nodeReq("fs");
    if (!fsN) return;
    srtOut = editMetaPathFor(srtPath).replace(/\.meta\.json$/, ""); // 영상별 고정 경로
    var meta = [];
    for (var i = 0; i < cues.length; i++) {
      syncAnchors(i);
      var c = cues[i];
      meta.push({
        text: c.text,
        anchors: (c.anchors || []).map(function (a) { return a ? { os: a.os, oe: a.oe } : null; })
      });
    }
    try { fsN.writeFileSync(srtOut + ".meta.json", JSON.stringify(meta)); } catch (e) {}
  }

  function editMetaPathFor(srtLoaded) {
    var outdir = srtLoaded.replace(/\/[^\/]+$/, "");
    var base = srtLoaded.split("/").pop().replace(/_cut(?:_\d+)?(?:_edit)?\.srt$/i, "").replace(/\.srt$/i, "");
    return outdir + "/" + base + "_cut_edit.srt.meta.json";
  }

  // 이전 편집을 새 컷 타임라인으로 이관 (원본 시간으로 단어 매칭)
  function applyMigration(meta) {
    if (!anchorRaw || !anchorRaw.length) return 0;
    // 원본 시작시간 → 새 컷 항목 인덱스 (0.06s 허용)
    var byOs = anchorRaw.slice().sort(function (a, b) { return a[3] - b[3]; });
    function findByOs(os) {
      var lo = 0, hi = byOs.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (byOs[mid][3] < os - 0.06) lo = mid + 1;
        else if (byOs[mid][3] > os + 0.06) hi = mid - 1;
        else return byOs[mid];
      }
      return null;
    }
    var migrated = [], dropped = 0;
    for (var i = 0; i < meta.length; i++) {
      var mc = meta[i];
      var toks = C.tokenize(mc.text);
      var keepToks = [], A = [], first = null, last = null;
      for (var w = 0; w < toks.length; w++) {
        var a = mc.anchors && mc.anchors[w];
        if (a) {
          var hit = findByOs(a.os);
          if (!hit) { dropped++; continue; } // 새 컷에서 잘려나간 단어
          keepToks.push(toks[w].t);
          A.push({ cs: hit[0], ce: hit[1], os: hit[3], oe: hit[4] });
          if (first === null) first = hit[0];
          last = hit[1];
        } else {
          keepToks.push(toks[w].t); // 사용자가 새로 넣은 단어 — 유지(보간)
          A.push(null);
        }
      }
      var text = keepToks.join(" ").trim();
      if (!text || first === null) continue;
      var cue = { start: first, end: last, text: text, atext: text, ldel: false,
                  anchors: [], marks: [] };
      // atext 토큰과 A 재정렬 (join으로 재토큰화된 순서와 동일)
      var newToks = C.tokenize(text);
      for (var k = 0; k < newToks.length; k++) {
        cue.anchors.push(A[k] || null);
        cue.marks.push(false);
      }
      migrated.push(cue);
    }
    if (!migrated.length) return 0;
    migrated.sort(function (a, b) { return a.start - b.start; });
    C.fillGapsCues(migrated);
    cues = migrated;
    history = new C.History(120);
    dirty = true;
    pointer = { cue: -1, word: 0 };
    render(0, 0);
    return dropped;
  }

  function maybeOfferMigration() {
    var fsN = nodeReq("fs");
    if (!fsN || !srtPath) return;
    if (/_edit(_\d+)?\.srt$/i.test(srtPath)) return; // 편집본 자체를 연 경우는 제외
    var metaPath = editMetaPathFor(srtPath);
    var meta;
    try { meta = JSON.parse(fsN.readFileSync(metaPath, "utf8")); } catch (e) { return; }
    if (!meta || !meta.length || !anchorRaw) return;
    $("migrate-msg").textContent = "이 영상에서 작업했던 자막 " + meta.length +
      "개(나눔·수정 포함)가 있습니다. 새 컷에 맞춰 그대로 옮겨올까요?";
    $("migrate-overlay").classList.add("open");
    window.__pendingMigration = meta;
  }

  $("btn-migrate-yes").addEventListener("click", function () {
    $("migrate-overlay").classList.remove("open");
    var meta = window.__pendingMigration;
    window.__pendingMigration = null;
    if (!meta) return;
    var dropped = applyMigration(meta);
    setStatus("이전 편집 " + cues.length + "개 자막을 새 컷에 이어서 적용했습니다" +
      (dropped ? " (잘린 단어 " + dropped + "개 제외)" : ""), "ok");
  });
  $("btn-migrate-no").addEventListener("click", function () {
    $("migrate-overlay").classList.remove("open");
    window.__pendingMigration = null;
  });

  // 시퀀스 재투영 자막을 캡션 트랙으로 적용 (이미 컷된 시퀀스 — 삭제 수술 없음)
  function captionSrtPath() {
    if (!seqSource) return null;
    var dirs = outDirsOf(seqSource);
    var base = seqSource.split("/").pop().replace(/\.[^.]+$/, "");
    for (var i = 0; i < dirs.length; i++) if (statOk(dirs[i])) return dirs[i] + "/" + base + "_caption.srt";
    return dirs[0] + "/" + base + "_caption.srt";
  }

  function applyToSequence() {
    // 재투영으로 불러온 자막: 삭제 마킹 경로 없이 캡션만 생성
    if (seqSource) {
      var fs = cepFs();
      if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return; }
      var outc = captionSrtPath();
      if (!outc) { setStatus("출력 경로를 만들 수 없습니다", "err"); return; }
      C.fillGapsCues(cues);
      var wr = fs.writeFile(outc, C.serializeSrt(cues), window.cep.encoding.UTF8);
      if (wr.err !== 0) { setStatus("자막 파일 저장 실패 (err " + wr.err + ")", "err"); return; }
      dirty = false;
      setStatus("시퀀스에 적용 중…");
      var btnc = $("btn-apply");
      btnc.disabled = true;
      evalScript("bangApplySrt(" + JSON.stringify(outc) + ")", function (res) {
        btnc.disabled = false;
        res = String(res || "");
        if (res.indexOf("OK") === 0) {
          setStatus(res.replace(/^OK:?/, "") || "캡션 트랙 생성 완료", "ok");
          editorDismissed = true;
          resetEditor();
        } else {
          setStatus(res.replace(/^ERR:?/, "적용 실패: "), "err");
        }
      });
      return;
    }
    // (구) SRT 기반 경로 — 하위호환
    var r = collectMarkRanges();
    if (r.skipped) setStatus("실측 시간이 없는 삭제 표시 " + r.skipped + "개는 건너뜁니다", "err");
    if (r.orig.length) {
      if (!saveSrt()) return;
      applyWithCuts(r);
      return;
    }
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
        editorDismissed = true; // 적용 완료 → 디폴트 화면 복귀, 자동 재로드 방지
        resetEditor();
      } else {
        setStatus(res.replace(/^ERR:?/, "적용 실패: "), "err");
      }
    });
  }

  // ============ 버튼 연결 (에디터) ============

  // 현재 시퀀스 불러오기 (빈 상태 버튼 + 툴바 새로고침 버튼)
  $("btn-load-seq").addEventListener("click", loadFromSequence);
  $("btn-open-file").addEventListener("click", loadFromSequence); // 툴바: 현재 시퀀스 다시 불러오기
  // 드롭다운 선택 → 해당 시퀀스를 실제로 열고 불러오기
  $("seq-pick").addEventListener("change", function () {
    var id = this.value;
    if (!id) return;
    var self = this;
    setStatus("시퀀스 여는 중…");
    evalScript("bangOpenSeq(" + JSON.stringify(id) + ")", function (res) {
      res = String(res || "");
      if (res.indexOf("OK") === 0) { loadFromSequence(); }
      else setStatus(res.replace(/^ERR:?/, "시퀀스 열기 실패: "), "err");
      self.value = "";
    });
  });

  $("btn-undo").addEventListener("click", doUndo);
  $("btn-redo").addEventListener("click", doRedo);
  $("btn-apply").addEventListener("click", applyToSequence);
  function splitAtPointer() {
    if (pointer.cue < 0) return;
    var toks = tokensOf(pointer.cue);
    if (pointer.word > 0 && pointer.word < toks.length) {
      splitCue(pointer.cue, toks[pointer.word].s);
    } else {
      setStatus("나눌 위치의 단어를 선택하세요 (첫 단어 앞은 나눌 수 없음)", "err");
    }
  }

  $("btn-split").addEventListener("click", splitAtPointer);
  $("btn-merge-up").addEventListener("click", function () { if (pointer.cue > 0) mergeUp(pointer.cue); });
  $("btn-merge-down").addEventListener("click", function () {
    if (pointer.cue >= 0 && pointer.cue < cues.length - 1) mergeUp(pointer.cue + 1);
  });

  // ============ 업데이트 확인 (N) ============

  function semverGt(a, b) {
    var pa = String(a).replace(/^v/, "").split(".").map(Number);
    var pb = String(b).replace(/^v/, "").split(".").map(Number);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function checkUpdate() {
    var last = parseInt(localStorage.getItem("bangcutUpdCheck") || "0", 10);
    if (Date.now() - last < 20 * 3600 * 1000) return; // 하루 1회
    localStorage.setItem("bangcutUpdCheck", String(Date.now()));
    fetch("https://api.github.com/repos/sambang39/BangCut/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.tag_name) return;
      var latest = j.tag_name.replace(/^v/, "");
      if (!semverGt(latest, PANEL_VERSION)) return;
      if (localStorage.getItem("bangcutDismissedVer") === latest) return;
      var dl = j.html_url;
      for (var i = 0; i < (j.assets || []).length; i++) {
        if (/\.pkg$/i.test(j.assets[i].name)) { dl = j.assets[i].browser_download_url; break; }
      }
      $("ub-text").textContent = "새 버전 v" + latest + " 사용 가능";
      $("update-banner").style.display = "flex";
      $("ub-dl").onclick = function () {
        try { window.cep.util.openURLInDefaultBrowser(dl); } catch (e) {}
      };
      $("ub-close").onclick = function () {
        localStorage.setItem("bangcutDismissedVer", latest);
        $("update-banner").style.display = "none";
      };
    }).catch(function () {});
  }

  // 엔진 업데이트: git pull + 의존성 갱신
  $("btn-engine-update").addEventListener("click", function () {
    var cp = nodeReq("child_process");
    var root = repoRoot();
    var btn = $("btn-engine-update");
    if (!cp || !root) return;
    btn.disabled = true;
    btn.textContent = "업데이트 중…";
    var cmd = "cd " + shellQuote(root) + " && git pull --ff-only && " +
      "(test -x .venv/bin/pip && .venv/bin/pip install -q -r requirements.txt || true)";
    cp.exec(cmd, { env: extendedEnv(), maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
      btn.disabled = false;
      btn.textContent = "업데이트";
      var out = String(stdout || "") + String(stderr || "");
      var info = $("env-info");
      if (err) info.innerHTML += '<br><span class="bad">업데이트 실패: ' + out.slice(-120) + "</span>";
      else info.innerHTML += '<br><span class="ok">엔진 업데이트 완료' +
        (out.indexOf("Already up to date") !== -1 ? " (이미 최신)" : "") + "</span>";
    });
  });

  // ============ 초기화 ============

  // 수술 검증 훅 (개발용): 실제 XML에 테스트 구간을 적용하고 무결성 리포트
  window.__bangSurgeryTest = function (xmlPath, ranges) {
    var fsN = nodeReq("fs");
    var xml = fsN.readFileSync(xmlPath, "utf8");
    var oldDur = parseInt(xml.match(/<sequence[^>]*>\s*<name>[^<]*<\/name>\s*<duration>(\d+)<\/duration>/)[1], 10);
    var res = surgeryCutXml(xml, ranges);
    // DOM 파싱 무결성
    var doc = new DOMParser().parseFromString(res.xml, "text/xml");
    var perr = doc.getElementsByTagName("parsererror").length;
    // 재검증: 새 XML의 시퀀스 duration
    var nd = parseInt(res.xml.match(/<sequence[^>]*>\s*<name>[^<]*<\/name>\s*<duration>(\d+)<\/duration>/)[1], 10);
    var fullFiles = (res.xml.match(/<file id="file-\d+">/g) || []).length;
    return {
      oldDur: oldDur, newDurTag: nd, newDurCalc: res.newDurFrames,
      removed: res.removedFrames, clips: res.clips,
      parseErrors: perr, fullFileDefs: fullFiles,
      links: (res.xml.match(/<link>/g) || []).length
    };
  };

  // 개발 디버그 훅 (내부 상태 점검용)
  window.__bangDebug = function () {
    return {
      cueCount: cues.length,
      srtPath: srtPath,
      anchorFile: srtPath ? anchorFileFor(srtPath) : null,
      cue0: cues[0] ? {
        start: cues[0].start, end: cues[0].end, text: cues[0].text,
        anchors: (cues[0].anchors || []).map(function (a) { return a ? a.cs : null; })
      } : null
    };
  };

  registerKeys();
  loadSettings();
  buildPresetRow();
  syncCutUi();
  setGapMode("auto");
  setModel(settings.sttModel || "whisper", true);
  updateRunButton();
  showScreen("screen-cutedit");
  checkUpdate();
  checkPrereq(function () {
    if (!prereqOk()) openOnboard(); // 최초/미설치 상태 — 열자마자 안내 (세션당 1회)
  });
})();
