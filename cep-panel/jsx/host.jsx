// BangCut — ExtendScript (Premiere Pro 호스트 측)
// 반환 규약: 정보성 함수는 JSON 문자열, 동작 함수는 "OK…"/"ERR:…"

var BANG_TICKS_PER_SEC = 254016000000; // 프리미어 틱/초 상수

// JSON 문자열 이스케이프 (ExtendScript에는 JSON이 없음)
function bangEsc(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i), code = s.charCodeAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (code < 32) out += "\\u" + ("000" + code.toString(16)).slice(-4);
        else out += c;
    }
    return out;
}

function bangErr(msg) { return '{"ok":false,"err":"' + bangEsc(msg) + '"}'; }

// 활성 시퀀스 정보 → {"ok":true,"name":…,"fps":…,"src":…}
function bangGetSeqInfo() {
    try {
        var proj = app.project;
        if (!proj) return bangErr("열린 프로젝트가 없습니다");
        var seq = proj.activeSequence;
        if (!seq) return bangErr("활성 시퀀스가 없습니다");

        var fps = 0;
        try { fps = BANG_TICKS_PER_SEC / Number(seq.timebase); } catch (e0) {}

        var src = "";
        try {
            var vts = seq.videoTracks;
            for (var t = 0; t < vts.numTracks && !src; t++) {
                var clips = vts[t].clips;
                for (var i = 0; i < clips.numItems; i++) {
                    var c = clips[i];
                    if (c && c.projectItem) {
                        var p = "";
                        try { p = c.projectItem.getMediaPath(); } catch (e1) {}
                        if (p) { src = p; break; }
                    }
                }
            }
        } catch (e2) {}

        return '{"ok":true,"name":"' + bangEsc(seq.name) + '","fps":' + fps +
               ',"src":"' + bangEsc(src) + '"}';
    } catch (err) { return bangErr(String(err)); }
}

// 플레이헤드를 지정 초 위치로 이동 (프로그램 모니터·타임라인 실시간 반영)
function bangSetPlayerPosition(sec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERR:활성 시퀀스가 없습니다";
        seq.setPlayerPosition(String(Math.round(Number(sec) * BANG_TICKS_PER_SEC)));
        return "OK";
    } catch (e) { return "ERR:" + e; }
}

// SRT를 프로젝트에 임포트하고 활성 시퀀스에 캡션 트랙 생성
function bangApplySrt(srtPath) {
    try {
        var proj = app.project;
        if (!proj) return "ERR:열린 프로젝트가 없습니다";
        var seq = proj.activeSequence;
        if (!seq) return "ERR:활성 시퀀스가 없습니다. 시퀀스를 연 뒤 다시 시도하세요";

        var f = new File(srtPath);
        if (!f.exists) return "ERR:파일이 없습니다: " + srtPath;
        var wantName = f.displayName;

        // 같은 이름의 기존 임포트 제거(재적용 시 중복 방지)
        var root = proj.rootItem;
        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var c0 = root.children[i];
            if (c0 && c0.name === wantName && c0.type === ProjectItemType.FILE) {
                try { c0.deleteBin ? c0.deleteBin() : proj.deleteItem(c0); } catch (eDel) {}
            }
        }

        var beforeN = root.children.numItems;
        proj.importFiles([srtPath], true, root, false);
        var afterN = root.children.numItems;

        var item = null;
        for (var j = afterN - 1; j >= 0; j--) {
            var c = root.children[j];
            if (c && c.name === wantName) { item = c; break; }
        }
        if (!item && afterN > beforeN) item = root.children[afterN - 1];
        if (!item) return "ERR:SRT 임포트에 실패했습니다";

        // 캡션 트랙 생성 (Premiere 15+). 포맷 인자는 버전에 따라 달라 순차 시도.
        var lastErr = "";
        var made = false;
        try { seq.createCaptionTrack(item, 0, 4); made = true; } catch (e1) { lastErr = String(e1); }
        if (!made) {
            try { seq.createCaptionTrack(item, 0); made = true; } catch (e2) { lastErr = String(e2); }
        }
        if (!made) {
            try { seq.createCaptionTrack(item); made = true; } catch (e3) { lastErr = String(e3); }
        }
        if (!made) return "ERR:캡션 트랙 생성 실패 — " + lastErr;

        return "OK:캡션 트랙 생성 완료 (" + wantName + ")";
    } catch (err) { return "ERR:" + err; }
}

// 컷편집 대상 감지 → {"ok":true,"mode":…,"paths":[…]} 또는 {"ok":true,"mode":"inout","tin":…,"tout":…}
function bangGetCutSource(mode) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return bangErr("활성 시퀀스가 없습니다");
        var out = [];

        if (mode === "selection") {
            var sel = [];
            try { sel = seq.getSelection(); } catch (e0) {}
            for (var i = 0; i < sel.length; i++) {
                var ti = sel[i];
                try {
                    if (ti && ti.projectItem && String(ti.mediaType) === "Video") {
                        var p = ti.projectItem.getMediaPath();
                        if (p) out.push(p);
                    }
                } catch (e1) {}
            }
        } else if (mode === "track") {
            var vt = seq.videoTracks[0];
            for (var j = 0; j < vt.clips.numItems; j++) {
                var c = vt.clips[j];
                try {
                    if (c && c.projectItem) {
                        var p2 = c.projectItem.getMediaPath();
                        if (p2) out.push(p2);
                    }
                } catch (e2) {}
            }
        } else if (mode === "inout") {
            var inSec = -1, outSec = -1;
            try { inSec = parseFloat(seq.getInPoint()); } catch (e3) {}
            try { outSec = parseFloat(seq.getOutPoint()); } catch (e4) {}
            return '{"ok":true,"mode":"inout","tin":' + inSec + ',"tout":' + outSec + "}";
        }

        var seen = {}, ded = [];
        for (var k = 0; k < out.length; k++) {
            if (!seen[out[k]]) { seen[out[k]] = 1; ded.push('"' + bangEsc(out[k]) + '"'); }
        }
        if (!ded.length) return bangErr("감지된 클립이 없습니다");
        return '{"ok":true,"mode":"' + bangEsc(mode) + '","paths":[' + ded.join(",") + "]}";
    } catch (err) { return bangErr(String(err)); }
}

// 패널 연결 확인용
function bangPing() {
    return "PONG " + app.version;
}
