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
  var source = { path: null, meta: null }; // 컷편집 대상 (드롭/선택한 원테이크 파일)
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
    if (id === "screen-settings") loadVitoUi();
  }

  (function () {
    var items = document.querySelectorAll(".side-item");
    for (var i = 0; i < items.length; i++) {
      (function (el) {
        el.addEventListener("click", function () { showScreen(el.dataset.screen); });
      })(items[i]);
    }
  })();

  function updateSrtHint(msg) {
    var el = $("srt-hint");
    if (el) el.textContent = msg;
  }

  // 자막 편집 탭 진입: 컷편집 결과 SRT 자동 감지·로드
  function activateEditor() {
    if (cues.length) return;
    updateSrtHint("컷편집 결과 자막을 찾는 중…");
    refreshSeqInfo(function () {
      if (detectedSrt && !cues.length) loadFile(detectedSrt);
    });
  }

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
    var last = localStorage.getItem("lastSrtPath");
    if (last) candidates.push(last);

    for (var i = 0; i < candidates.length; i++) {
      if (statOk(candidates[i])) { detectedSrt = candidates[i]; break; }
    }
    if (!cues.length) {
      updateSrtHint(detectedSrt
        ? "감지됨: " + detectedSrt.split("/").pop()
        : "컷편집 결과가 아직 없습니다 — 컷편집을 먼저 실행하거나 SRT를 직접 여세요");
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

  function showDropzone() {
    source.path = null;
    source.meta = null;
    $("dropzone").style.display = "block";
    $("src-card").style.display = "none";
    srcErr("");
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
      if (res.indexOf("OK") === 0) {
        cutStatus("프로젝트 창 BangCut 폴더에 임포트됨", "ok");
      } else {
        cutStatus(res.replace(/^ERR:?/, "임포트 실패: "), "err");
      }
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
      if (!p) { srcErr("드롭에서 경로를 읽지 못했습니다 — 클릭해서 파일을 선택해 주세요"); return; }
      selectSource(p);
    });
    // 패널 전역에서 드롭존 밖 드롭으로 페이지가 파일로 이동하는 것 방지
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) { e.preventDefault(); });

    $("btn-src-change").addEventListener("click", showDropzone);
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
        });
      })(cards[i]);
    }
  })();

  function loadVitoUi() {
    var cfg = readEngineConfig();
    var has = !!(cfg.VITO_CLIENT_ID && cfg.VITO_CLIENT_SECRET);
    var badge = $("vito-head-badge");
    if (badge) {
      badge.textContent = has ? "등록됨" : "미등록";
      badge.className = "badge" + (has ? " ok" : "");
    }
    $("set-vito-id").value = cfg.VITO_CLIENT_ID || "";
    $("set-vito-secret").value = "";
    $("set-vito-secret").placeholder = has ? "저장됨 — 변경할 때만 입력" : "발급받은 CLIENT_SECRET";
    var st = $("vito-status");
    st.textContent = has ? "등록됨 (" + maskId(cfg.VITO_CLIENT_ID) + ") — VITO 사용 가능" : "";
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
    if (!sec && !cfg.VITO_CLIENT_SECRET) {
      st.textContent = "CLIENT SECRET을 입력해 주세요";
      st.className = "err";
      return;
    }
    cfg.VITO_CLIENT_ID = id;
    if (sec) cfg.VITO_CLIENT_SECRET = sec;
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
          : '<span class="bad">✗ 미설치 — 온보딩 2단계를 진행해 주세요</span>');
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

  // ============ 전제조건 감지 + 온보딩 (H2) ============

  var prereq = { claude: false, claudePath: null, repo: false, venv: false, checked: false };

  function checkPrereq(cb) {
    var fsN = nodeReq("fs");
    var cp = nodeReq("child_process");
    var root = repoRoot();
    prereq.repo = !!(root && fsN && fsN.existsSync(root + "/edit.sh"));
    prereq.venv = !!(root && fsN && fsN.existsSync(root + "/.venv/bin/python"));
    prereq.claude = false;
    prereq.claudePath = null;

    var home = "";
    try { home = nodeReq("process").env.HOME || ""; } catch (e) {}
    var candidates = [
      home + "/.local/bin/claude",
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude"
    ];
    if (fsN) {
      for (var i = 0; i < candidates.length; i++) {
        try {
          if (fsN.existsSync(candidates[i])) { prereq.claude = true; prereq.claudePath = candidates[i]; break; }
        } catch (e2) {}
      }
    }
    function done() {
      prereq.checked = true;
      if (prereq.claudePath) localStorage.setItem("bangcutClaudePath", prereq.claudePath);
      cb(prereq);
    }
    if (prereq.claude || !cp) { done(); return; }
    // 후보 경로에 없으면 셸 PATH에서 탐색
    var env = {};
    try {
      var pe = nodeReq("process").env;
      for (var k in pe) env[k] = pe[k];
    } catch (e3) {}
    env.PATH = (env.PATH || "") + ":/usr/local/bin:/opt/homebrew/bin:" + home + "/.local/bin";
    cp.exec("command -v claude", { env: env }, function (err, stdout) {
      var p = String(stdout || "").trim();
      if (!err && p) { prereq.claude = true; prereq.claudePath = p; }
      done();
    });
  }

  function renderObStatus() {
    function line(ok, label) {
      return '<span class="' + (ok ? "ok" : "bad") + '">' + (ok ? "✓" : "✗") + " " + label +
        (ok ? "" : " — 위 단계를 진행해 주세요") + "</span><br>";
    }
    $("ob-status").innerHTML =
      line(prereq.claude, "클로드 코드 " + (prereq.claude ? "설치됨" : "미설치")) +
      line(prereq.repo && prereq.venv, "BangCut 프로젝트 " + (prereq.repo ? (prereq.venv ? "설치 완료" : "클론됨 (설치 미완료)") : "미설치"));
    $("ob-num1").classList.toggle("done", prereq.claude);
    $("ob-num1").textContent = prereq.claude ? "✓" : "1";
    var step2ok = prereq.repo && prereq.venv;
    $("ob-num2").classList.toggle("done", step2ok);
    $("ob-num2").textContent = step2ok ? "✓" : "2";
  }

  function prereqOk() { return prereq.claude && prereq.repo && prereq.venv; }

  function openOnboard() {
    renderObStatus();
    $("onboard-overlay").classList.add("open");
  }
  function closeOnboard() { $("onboard-overlay").classList.remove("open"); }

  $("btn-ob-close").addEventListener("click", closeOnboard);
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

  (function () {
    var btns = document.querySelectorAll(".copybtn");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          var src = $(b.dataset.copy);
          if (!src) return;
          copyText(src.textContent);
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
    // H2 게이트: 클로드 코드·프로젝트 설치 확인 후 진행
    checkPrereq(function () {
      if (!prereqOk()) { openOnboard(); return; }
      runCutReady();
    });
  }

  function runCutReady() {
    if (run.running) return;
    var cp = nodeReq("child_process");
    if (!cp) { cutStatus("Node 실행 환경을 찾지 못했습니다 (패널 재시작 필요)", "err"); return; }
    var root = repoRoot();
    if (!root || !statOk(root + "/edit.sh")) {
      cutStatus("엔진(edit.sh)을 찾지 못했습니다: " + root, "err");
      return;
    }
    if (!source.path) {
      cutStatus("컷편집할 영상을 먼저 선택해 주세요 (드래그 앤 드롭 또는 클릭)", "err");
      return;
    }
    run.sources = [source.path];
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
    if (settings.resolution === "FHD") args.push("--fhd");

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

  // ============ 초기화 ============

  registerKeys();
  loadSettings();
  buildPresetRow();
  syncCutUi();
  setGapMode("auto");
  setModel(settings.sttModel || "whisper", true);
  showScreen("screen-cutedit");
})();
