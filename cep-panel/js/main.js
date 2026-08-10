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
  var detectedSrt = null;
  var projectPath = null;     // 현재 프리미어 프로젝트 (전환 감지용)
  var editorDismissed = false; // 적용 완료 후 디폴트 복귀 상태 — 자동 재로드 방지

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

  function getProjSrt() {
    return projectPath ? localStorage.getItem(projKey(projectPath)) : null;
  }

  function updateEmptyUi() {
    var rp = getProjSrt();
    var show = !!(rp && statOk(rp) && !cues.length);
    var hint = $("resume-hint");
    if (hint) {
      hint.style.display = show ? "block" : "none";
      if (show) $("resume-name").textContent = rp.split("/").pop();
    }
  }

  // 자막 편집 화면을 디폴트(빈 상태)로 (K)
  function resetEditor() {
    cues = [];
    srtPath = null;
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

  // 자막 편집 탭 진입: 컷편집 결과 SRT 자동 감지·로드 (적용 완료 후에는 자동 로드 안 함)
  function activateEditor() {
    if (cues.length) return;
    updateEmptyUi();
    if (editorDismissed) return;
    refreshSeqInfo(function () {
      if (detectedSrt && !cues.length && !editorDismissed) loadFile(detectedSrt);
      updateEmptyUi();
    });
  }

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
      $("prog-wrap").style.display = "none";
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
    var st = $("vito-status");
    st.textContent = has ? "활성화 (" + maskId(cfg.VITO_CLIENT_ID) + ") — VITO 사용 가능" : "";
    st.className = has ? "ok" : "";
  }

  function saveVitoKeys() {
    var id = $("set-vito-id").value.trim();
    var sec = $("set-vito-secret").value.trim();
    var cfg = readEngineConfig();
    var st = $("vito-status");
    if (!id) {
      st.textContent = "CLIENT ID를 입력해 주세요";
      st.className = "err";
      return;
    }
    if (!sec) {
      st.textContent = "CLIENT SECRET을 입력해 주세요";
      st.className = "err";
      return;
    }
    cfg.VITO_CLIENT_ID = id;
    cfg.VITO_CLIENT_SECRET = sec;
    if (!writeEngineConfig(cfg)) {
      st.textContent = "저장 실패 — 엔진 폴더 쓰기 권한을 확인해 주세요";
      st.className = "err";
      return;
    }
    loadVitoUi();
    st.textContent = "저장됨 (" + maskId(id) + ") — 전사 모델에서 VITO를 선택할 수 있어요";
    st.className = "ok";
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
    $("claude-key-status").textContent = "";
  }

  // 로그인/로그아웃은 브라우저 OAuth가 필요해 터미널을 열어 진행
  function openTerminalCmd(cmd) {
    var cp = nodeReq("child_process");
    if (!cp) return;
    var osa = 'tell application "Terminal"\nactivate\ndo script "' + cmd.replace(/"/g, '\\"') + '"\nend tell';
    try { cp.execFile("/usr/bin/osascript", ["-e", osa]); } catch (e) {}
  }

  $("btn-claude-login").addEventListener("click", function () {
    openTerminalCmd((claudeBin() || "claude") + " /login");
    $("claude-key-status").textContent = "터미널에서 로그인 진행 후, 카드를 다시 열면 반영됩니다";
    $("claude-key-status").className = "";
  });
  $("btn-claude-logout").addEventListener("click", function () {
    openTerminalCmd((claudeBin() || "claude") + " /logout");
    $("claude-key-status").textContent = "터미널에서 로그아웃 진행 후, 카드를 다시 열면 반영됩니다";
    $("claude-key-status").className = "";
  });

  $("btn-save-claude-key").addEventListener("click", function () {
    var k = $("set-claude-key").value.trim();
    var st = $("claude-key-status");
    if (!k) { st.textContent = "키를 입력해 주세요"; st.className = "err"; return; }
    saveClaudeKey(k);
    loadClaudeUi();
    st.textContent = "저장됨 (" + maskKey(k) + ")";
    st.className = "ok";
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
  }

  // 규칙: 로그인이 있으면 로그인(정액) 사용, API 키는 로그인이 없을 때만 주입
  function buildClaudeEnv() {
    var env = extendedEnv();
    var key = claudeApiKey();
    if (!claudeAccount() && key) env.ANTHROPIC_API_KEY = key;
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

  var STEPS = ["준비", "영상 분석", "전사", "컷 계획", "렌더", "자막 정리", "완료"];
  var STEP_PCT = [4, 14, 34, 54, 74, 90, 100];

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
    var last = i === STEPS.length - 1;
    $("prog-title").textContent = last ? "완료!" : STEPS[i] + " 중…";
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
    $("btn-stop-cut").style.display = on ? "inline-block" : "none";
    $("cut-options").classList.toggle("off", on); // 실행 중 옵션 전체 잠금
    if (on) $("prog-wrap").style.display = "block";
  }

  $("btn-log-toggle").addEventListener("click", function () {
    var el = $("run-log");
    var open = !el.classList.contains("open");
    el.classList.toggle("open", open);
    $("btn-log-toggle").textContent = open ? "간단히 보기" : "자세히 보기";
  });

  // ---------- 클로드 요청 프롬프트 ----------

  function buildPrompt() {
    var L = [];
    L.push('영상 자동 컷편집을 수행하라. 대상 원본: "' + source.path + '"');
    if (gapMode === "manual") {
      L.push("- 무음 구간 설정: 사용자가 직접 지정 — config.json에 MIN_SILENCE/PAD_LEAD/PAD_TAIL로 반영돼 있음. --preset 옵션은 쓰지 말 것");
    } else {
      L.push("- 무음 구간 설정: 자동 — engine/analyze_video.py로 영상을 측정해 보수/표준/공격 중 알맞은 프리셋을 스스로 판단해 --preset으로 지정");
    }
    if (settings.sttModel === "vito") {
      L.push("- 전사 모델: VITO — engine/stt_vito.py로 먼저 전사해 _words.json을 만든 뒤 edit.sh 실행 (키는 config.json)");
    } else {
      L.push("- 전사 모델: Whisper — edit.sh가 자체 처리");
    }
    L.push(settings.resolution === "FHD"
      ? "- 시퀀스 해상도: FHD — edit.sh에 --fhd 플래그 추가"
      : "- 시퀀스 해상도: 4K(원본) — --fhd 플래그를 쓰지 말 것");
    L.push("");
    L.push("실행 방식: cut-editing 스킬 플로우를 따르라. edit.sh는 백그라운드로 실행하고 출력을 주기적으로 확인하면서 진행 단계를 보고하라.");
    L.push("진행 보고 규칙(패널 프로그레스용 — 반드시 지켜라): 아래 단계가 시작될 때마다 해당 마커를 텍스트로 정확히 한 줄 출력:");
    L.push("###STEP:2:영상 분석 / ###STEP:3:전사 / ###STEP:4:컷 계획 / ###STEP:5:렌더 / ###STEP:6:자막 정리");
    L.push("(엔진 출력에서 받아쓰기·무음/컷·XML/렌더·자막 단계가 관찰될 때 해당 마커를 출력하면 된다)");
    L.push("결과 검수(과도한 컷·어미 잘림 확인) 후 성공이면 마지막 줄에 ###DONE, 실패면 ###FAIL:<한 줄 사유> 를 출력하라.");
    L.push("");
    L.push("절대 규칙: ###DONE 또는 ###FAIL을 출력하기 전에는 어떤 경우에도 응답을 끝내지 말라.");
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
      cutStatus("컷편집 완료 — 결과를 프로젝트로 가져옵니다", "ok");
      // H6: XML+SRT를 BangCut 빈으로 임포트하고 컷 시퀀스를 타임라인에 연다
      var outdir = source.path.replace(/\/[^\/]+$/, "") + "/BangCut";
      var base = source.path.split("/").pop().replace(/\.[^.]+$/, "");
      var xml = outdir + "/" + base + "_cut.xml";
      var srt = outdir + "/" + base + "_cut.srt";
      editorDismissed = false;
      var importDone = function () {
        refreshSeqInfo(function () {
          if (detectedSrt && detectedSrt !== srtPath) loadFile(detectedSrt); // 새 자막으로 교체 + 자막 편집 탭 전환
        });
      };
      if (statOk(xml)) {
        evalScript("bangOpenCutResult(" + JSON.stringify(xml) + "," + JSON.stringify(srt) + ")", function (res) {
          res = String(res || "");
          if (res.indexOf("OK") === 0) {
            cutStatus(res.replace(/^OK:?/, ""), "ok");
            logLine("== " + res.replace(/^OK:?/, ""));
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
      cutStatus(msg || "실패 — '자세히 보기'에서 로그를 확인하세요", "err");
      $("run-log").classList.add("open");
      $("btn-log-toggle").textContent = "간단히 보기";
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
      if (n >= 1 && n <= 6) setStep(n - 1); // 마커 번호 = STEPS 인덱스 + 1
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
    // H2 게이트: 클로드 코드·프로젝트 설치 확인 후 진행
    checkPrereq(function () {
      if (!prereqOk()) { openOnboard(); return; }
      runCutReady();
    });
  }

  function runCutReady() {
    if (run.running) return;
    var cp = nodeReq("child_process");
    var bin = claudeBin();
    var root = repoRoot();
    if (!cp || !bin) { cutStatus("클로드 코드 실행 환경을 찾지 못했습니다", "err"); return; }
    if (!root || !statOk(root + "/edit.sh")) { cutStatus("엔진(edit.sh)을 찾지 못했습니다: " + root, "err"); return; }
    if (!source.path) { cutStatus("컷편집할 영상을 먼저 선택해 주세요 (드래그 앤 드롭 또는 클릭)", "err"); return; }

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
    var toks = tokensOf(ci);
    if (!toks.length) return 0;
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
      case "NumpadEnter":
        e.preventDefault();
        splitAtPointer();
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
    rememberProjSrt(path);
    editorDismissed = false;
    $("editor-file").textContent = path.split("/").pop();
    $("editor-file").title = path;
    showScreen("screen-editor");
    render(0, 0);
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
    rememberProjSrt(out);
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
        editorDismissed = true; // 적용 완료 → 디폴트 화면 복귀, 자동 재로드 방지
        resetEditor();
      } else {
        setStatus(res.replace(/^ERR:?/, "적용 실패: "), "err");
      }
    });
  }

  // ============ 버튼 연결 (에디터) ============

  function openSrtDialog() {
    var fs = cepFs();
    if (!fs) { setStatus("CEP 환경이 아닙니다", "err"); return; }
    var initDir = localStorage.getItem("lastDir") || "~/Desktop";
    var res = fs.showOpenDialogEx(false, false, "SRT 파일 선택", initDir, ["srt"]);
    if (!res || !res.data || !res.data.length) return;
    localStorage.setItem("lastDir", res.data[0].replace(/\/[^\/]+$/, ""));
    loadFile(res.data[0]);
  }
  $("btn-open-manual").addEventListener("click", openSrtDialog);
  $("btn-open-file").addEventListener("click", openSrtDialog);
  $("btn-resume").addEventListener("click", function () {
    var rp = getProjSrt();
    if (rp && statOk(rp)) loadFile(rp);
    else updateEmptyUi();
  });

  $("btn-undo").addEventListener("click", doUndo);
  $("btn-redo").addEventListener("click", doRedo);
  $("btn-save").addEventListener("click", saveSrt);
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
