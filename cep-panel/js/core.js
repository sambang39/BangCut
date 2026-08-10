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

  var CUT_PRESETS = [
    { id: "veryshort", label: "매우 짧게", MIN_SILENCE: 0.15, PAD_LEAD: 0.15, PAD_TAIL: 0.06 },
    { id: "short",     label: "짧게",     MIN_SILENCE: 0.18, PAD_LEAD: 0.18, PAD_TAIL: 0.08 },
    { id: "medium",    label: "중간",     MIN_SILENCE: 0.30, PAD_LEAD: 0.22, PAD_TAIL: 0.10 },
    { id: "long",      label: "길게",     MIN_SILENCE: 0.45, PAD_LEAD: 0.30, PAD_TAIL: 0.14 }
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

  var api = {
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
