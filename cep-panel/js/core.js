/* BangCut core — SRT 파싱/직렬화, 타임코드, 편집 이력, 컷편집 프리셋 (DOM 비의존) */
(function (root) {
  "use strict";

  var MAX_LINE = 40; // 한 줄 글자수 경고 기준

  // ---------- SRT ----------

  function parseSrt(text) {
    var out = [];
    var blocks = text.replace(/\r/g, "").split(/\n\s*\n+/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split("\n").filter(function (l) { return l !== ""; });
      if (!lines.length) continue;
      var idx = 0;
      if (/^\d+$/.test(lines[0].trim())) idx = 1;
      var m = lines[idx] && lines[idx].match(
        /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) continue;
      out.push({
        start: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000,
        end:   (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000,
        text: lines.slice(idx + 1).join("\n")
      });
    }
    return out;
  }

  function pad(n, w) {
    n = String(n);
    while (n.length < w) n = "0" + n;
    return n;
  }

  function srtTime(t) {
    if (t < 0) t = 0;
    var ms = Math.round(t * 1000);
    var h = Math.floor(ms / 3600000);
    var m = Math.floor(ms % 3600000 / 60000);
    var s = Math.floor(ms % 60000 / 1000);
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms % 1000, 3);
  }

  // 편집 규칙: 줄 끝 마침표 제거(? ! 유지)
  function applyRules(text) {
    return text.split("\n").map(function (line) {
      return line.replace(/\s+$/, "").replace(/\.+$/, "");
    }).join("\n");
  }

  function serializeSrt(cues) {
    var out = [];
    var n = 1;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var text = applyRules(c.text).trim();
      if (!text) continue;
      out.push(n + "\n" + srtTime(c.start) + " --> " + srtTime(c.end) + "\n" + text + "\n");
      n++;
    }
    return out.join("\n") + "\n";
  }

  function maxLineLen(text) {
    var lines = text.split("\n");
    var mx = 0;
    for (var i = 0; i < lines.length; i++) mx = Math.max(mx, lines[i].length);
    return mx;
  }

  // ---------- 타임코드 (시퀀스 트랙과 동일 포맷) ----------
  // fps: 실제 값(29.97002997…). 드롭프레임은 29.97/59.94에서만 사용(SMPTE 규정)

  function isDropFrame(fps) {
    var nominal = Math.round(fps);
    return (nominal === 30 || nominal === 60) && Math.abs(fps - nominal) > 0.001;
  }

  function secondsToTimecode(sec, fps) {
    if (!fps || fps <= 0) fps = 30000 / 1001;
    if (sec < 0) sec = 0;
    var drop = isDropFrame(fps);
    var nominal = Math.round(fps);
    var frameNumber = Math.round(sec * fps);
    if (drop) {
      var dropFrames = nominal === 30 ? 2 : 4;
      var framesPer10Min = Math.round(fps * 600);
      var framesPerMin = nominal * 60 - dropFrames;
      var tenMins = Math.floor(frameNumber / framesPer10Min);
      var rem = frameNumber % framesPer10Min;
      if (rem > dropFrames) {
        frameNumber += dropFrames * 9 * tenMins +
          dropFrames * Math.floor((rem - dropFrames) / framesPerMin);
      } else {
        frameNumber += dropFrames * 9 * tenMins;
      }
    }
    var fr = frameNumber % nominal;
    var s = Math.floor(frameNumber / nominal) % 60;
    var m = Math.floor(frameNumber / (nominal * 60)) % 60;
    var h = Math.floor(frameNumber / (nominal * 3600));
    var sep = drop ? ";" : ":";
    return pad(h, 2) + sep + pad(m, 2) + sep + pad(s, 2) + sep + pad(fr, 2);
  }

  // ---------- 편집 이력 (실행 취소 / 다시 실행) ----------

  function History(limit) {
    this.limit = limit || 100;
    this.undoStack = [];
    this.redoStack = [];
  }
  History.prototype.snapshot = function (cues) {
    return cues.map(function (c) {
      return {
        start: c.start, end: c.end, text: c.text,
        atext: c.atext != null ? c.atext : null,
        ldel: !!c.ldel,
        anchors: (c.anchors || []).slice(),
        marks: (c.marks || []).slice()
      };
    });
  };
  History.prototype.push = function (cues) {
    this.undoStack.push(this.snapshot(cues));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  };
  History.prototype.undo = function (cues) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(this.snapshot(cues));
    return this.undoStack.pop();
  };
  History.prototype.redo = function (cues) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(this.snapshot(cues));
    return this.redoStack.pop();
  };
  History.prototype.canUndo = function () { return this.undoStack.length > 0; };
  History.prototype.canRedo = function () { return this.redoStack.length > 0; };

  // ---------- 컷편집 프리셋 (엔진 config.py 파라미터와 1:1) ----------
  // PAD_LEAD = 말 끝나고 남길 여백 / MIN_SILENCE = 최소 공백 제거 길이 / PAD_TAIL = 다음 말 시작 전 여백

  // 09 수동 편집 실측 캘리브레이션(2026-08-10) — 엔진 공격/표준/보수 스케일과 동일
  var CUT_PRESETS = [
    { id: "veryshort", label: "매우 짧게", MIN_SILENCE: 0.10, PAD_LEAD: 0.02, PAD_TAIL: 0.02 },
    { id: "short",     label: "짧게",     MIN_SILENCE: 0.12, PAD_LEAD: 0.04, PAD_TAIL: 0.03 },
    { id: "medium",    label: "중간",     MIN_SILENCE: 0.15, PAD_LEAD: 0.10, PAD_TAIL: 0.05 },
    { id: "long",      label: "길게",     MIN_SILENCE: 0.25, PAD_LEAD: 0.18, PAD_TAIL: 0.08 }
  ];

  // 텍스트를 단어 토큰으로 분해 (문자 오프셋 보존 — 공백/줄바꿈 복원용)
  function tokenize(text) {
    var out = [];
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text))) out.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
    return out;
  }

  // 자막 구간 안에서 단어 시작 시간을 글자수 비례로 보간
  function wordTime(cue, tokens, wi) {
    if (!tokens.length) return cue.start;
    var total = Math.max(1, cue.text.length);
    var ratio = tokens[Math.min(wi, tokens.length - 1)].s / total;
    return cue.start + (cue.end - cue.start) * ratio;
  }

  // ---------- 단어 앵커 (Q) ----------

  // 구두점 무시 단어 비교용 정규화
  function normWord(s) {
    return String(s).replace(/[.,!?…~"'()\[\]]/g, "");
  }

  // 이전 토큰들의 앵커를 새 토큰 배열에 재정렬 (그리디 텍스트 매칭, lookahead 3)
  function realignAnchors(oldToks, oldAnchors, oldMarks, newToks) {
    var A = [], M = [];
    var j = 0;
    for (var i = 0; i < newToks.length; i++) {
      var found = -1;
      for (var l = j; l < Math.min(j + 3, oldToks.length); l++) {
        if (normWord(oldToks[l].t) === normWord(newToks[i].t)) { found = l; break; }
      }
      if (found >= 0) {
        A.push(oldAnchors[found] || null);
        M.push(!!(oldMarks && oldMarks[found]));
        j = found + 1;
      } else {
        A.push(null);
        M.push(false);
      }
    }
    return { anchors: A, marks: M };
  }

  // 겹치는 구간 병합 ([ [s,e], ... ] 정렬+병합)
  function mergeRanges(ranges) {
    var rs = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (out.length && r[0] <= out[out.length - 1][1] + 0.001) {
        out[out.length - 1][1] = Math.max(out[out.length - 1][1], r[1]);
      } else {
        out.push([r[0], r[1]]);
      }
    }
    return out;
  }

  // 제거 구간(병합·정렬됨)을 뺀 새 타임라인에서의 시각
  function remapTime(t, removed) {
    var cut = 0;
    for (var i = 0; i < removed.length; i++) {
      var s = removed[i][0], e = removed[i][1];
      if (s >= t) break;
      cut += Math.min(e, t) - s;
    }
    return Math.max(0, t - cut);
  }

  // 연속 발화 자막 사이 공백 메움 (엔진 fill_gaps와 동일 규칙, in-place)
  function fillGapsCues(cues, maxGap) {
    // 컷 타임라인은 무음이 이미 제거된 상태 — 자막은 빈 공간 없이 다음 자막 시작까지 연장
    var mg = maxGap == null ? Infinity : maxGap;
    for (var i = 0; i < cues.length - 1; i++) {
      var gap = cues[i + 1].start - cues[i].end;
      if (gap > 0 && gap <= mg) cues[i].end = cues[i + 1].start;
    }
    return cues;
  }

  // ── 현재 시퀀스 재투영 + 컷 스냅 자막 (SRT 없이 시퀀스에서 직접) ──
  var IDEAL_CHARS = 18; // 한 줄 이상적 글자수
  var MAX_CHARS = 24;   // 한 줄 최대(초과 시 강제 나눔)

  // 원본 전사를 현재 시퀀스 클립에 재투영.
  //  words: [[orig_s, orig_e, word], ...] (원본 영상 시간)
  //  cs:    [[srcIn, srcOut, tlStart], ...] (타임라인 start 오름차순 정렬된 클립)
  // 반환: 살아남은 단어 [{tl_s, tl_e, os, oe, word, clip}], 타임라인 시간 오름차순
  function reprojectWords(words, cs) {
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var os = words[i][0], oe = words[i][1], word = words[i][2];
      for (var j = 0; j < cs.length; j++) {
        var ci = cs[j][0], co = cs[j][1], st = cs[j][2];
        if (os >= ci - 0.0005 && os < co - 0.0005) { // 단어 시작이 이 클립 안
          var endOrig = oe < co ? oe : co;           // 단어가 컷을 넘으면 클램프(단어 중간 컷)
          out.push({ tl_s: st + (os - ci), tl_e: st + (endOrig - ci),
                     os: os, oe: oe, word: word, clip: j });
          break;
        }
      }
    }
    out.sort(function (a, b) { return a.tl_s - b.tl_s; });
    return out;
  }

  // 재투영 단어들을 "컷에서만 나눔 + 시작은 컷 스냅 + 끝은 다음 시작(wall-to-wall)"으로 큐 생성.
  //  clips: 원본 클립 배열(정렬 전) [[srcIn, srcOut, tlStart], ...]
  function buildCuesFromSequence(words, clips, opts) {
    opts = opts || {};
    var IDEAL = opts.ideal || IDEAL_CHARS, MAX = opts.max || MAX_CHARS;
    var cs = clips.slice().sort(function (a, b) { return a[2] - b[2]; });
    var clipStart = cs.map(function (c) { return c[2]; });
    var pw = reprojectWords(words, cs);
    if (!pw.length) return [];

    // 단어를 클립(세그먼트) 단위로 묶은 뒤, 세그먼트 단위로 줄에 패킹 →
    // 나눔이 항상 컷(클립 경계)에 오게 한다. 한 클립이 MAX보다 길 때만 내부 강제 분할.
    function wlen(ws) { var n = 0; for (var x = 0; x < ws.length; x++) n += (x ? 1 : 0) + ws[x].word.length; return n; }
    var segs = [];
    for (var i = 0; i < pw.length; i++) {
      if (!segs.length || pw[i].clip !== segs[segs.length - 1][0].clip) segs.push([pw[i]]);
      else segs[segs.length - 1].push(pw[i]);
    }
    // lines: {ws, atCut} — atCut=줄 시작이 컷 경계인가(내부 강제 분할 청크만 false)
    var lines = [], cur = [], chars = 0;
    function flush() { if (cur.length) { lines.push({ ws: cur, atCut: true }); cur = []; chars = 0; } }
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s], sc = wlen(seg);
      if (cur.length && (chars >= IDEAL || chars + 1 + sc > MAX)) flush();
      if (!cur.length && sc > MAX) {
        // 한 클립이 MAX 초과 → 단어 경계로 내부 분할(첫 청크만 컷 시작)
        var chunk = [], cch = 0, firstChunk = true;
        for (var g = 0; g < seg.length; g++) {
          var wl = (chunk.length ? 1 : 0) + seg[g].word.length;
          if (chunk.length && cch + wl > MAX) { lines.push({ ws: chunk, atCut: firstChunk }); firstChunk = false; chunk = []; cch = 0; }
          chunk.push(seg[g]); cch += (chunk.length > 1 ? 1 : 0) + seg[g].word.length;
        }
        if (chunk.length) lines.push({ ws: chunk, atCut: firstChunk });
        continue;
      }
      chars += (cur.length ? 1 : 0) + sc;
      cur = cur.concat(seg);
    }
    flush();

    var cues = [];
    for (var L = 0; L < lines.length; L++) {
      var ws = lines[L].ws, first = ws[0], last = ws[ws.length - 1];
      // 줄 시작이 컷이면 clip.start로 스냅(프레임 정확), 내부 강제 분할이면 단어 시작
      var startSec = lines[L].atCut ? clipStart[first.clip] : first.tl_s;
      var text = ws.map(function (x) { return x.word; }).join(" ");
      cues.push({
        start: startSec, end: last.tl_e, text: text, atext: text, ldel: false,
        anchors: ws.map(function (x) { return { cs: x.tl_s, ce: x.tl_e, os: x.os, oe: x.oe }; }),
        marks: ws.map(function () { return false; })
      });
    }
    // wall-to-wall: 각 큐 끝 = 다음 큐 시작 (빈 공간 0, 컷에서 자막 전환)
    for (var k = 0; k < cues.length - 1; k++) cues[k].end = cues[k + 1].start;
    return cues;
  }

  var api = {
    fillGapsCues: fillGapsCues,
    reprojectWords: reprojectWords,
    buildCuesFromSequence: buildCuesFromSequence,
    MAX_LINE: MAX_LINE,
    tokenize: tokenize,
    wordTime: wordTime,
    normWord: normWord,
    realignAnchors: realignAnchors,
    mergeRanges: mergeRanges,
    remapTime: remapTime,
    parseSrt: parseSrt,
    serializeSrt: serializeSrt,
    srtTime: srtTime,
    applyRules: applyRules,
    maxLineLen: maxLineLen,
    isDropFrame: isDropFrame,
    secondsToTimecode: secondsToTimecode,
    History: History,
    CUT_PRESETS: CUT_PRESETS
  };

  // CEP는 Node 통합으로 module이 존재하므로, 양쪽 모두에 내보낸다
  if (typeof window !== "undefined") window.BangCore = api;
  else if (root) root.BangCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(this);
