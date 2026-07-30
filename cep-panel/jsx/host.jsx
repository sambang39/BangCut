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

// 파일을 프로젝트 "BangCut" 빈으로 임포트 (빈 없으면 생성, 루트 낙하 시 moveBin 폴백)
function bangImportToBin(filePath) {
    try {
        var proj = app.project;
        if (!proj) return "ERR:열린 프로젝트가 없습니다";
        var f = new File(filePath);
        if (!f.exists) return "ERR:파일이 없습니다: " + filePath;
        var root = proj.rootItem;

        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c && c.name === "BangCut" && c.type === ProjectItemType.BIN) { bin = c; break; }
        }
        if (!bin) bin = root.createBin("BangCut");
        if (!bin) return "ERR:BangCut 빈 생성 실패";

        var want = f.displayName;
        for (var j = 0; j < bin.children.numItems; j++) {
            if (bin.children[j] && bin.children[j].name === want) return "OK:이미 임포트됨";
        }

        proj.importFiles([filePath], true, bin, false);

        // 빈 안에 들어갔는지 확인, 루트로 떨어졌으면 이동
        var item = null;
        for (var k = bin.children.numItems - 1; k >= 0; k--) {
            if (bin.children[k] && bin.children[k].name === want) { item = bin.children[k]; break; }
        }
        if (!item) {
            for (var m = root.children.numItems - 1; m >= 0; m--) {
                var r = root.children[m];
                if (r && r.name === want && r.type !== ProjectItemType.BIN) {
                    try { r.moveBin(bin); item = r; } catch (eMv) {}
                    break;
                }
            }
        }
        return item ? "OK:임포트 완료" : "ERR:임포트 확인 실패 — 프로젝트 창을 확인해 주세요";
    } catch (err) { return "ERR:" + err; }
}

// BangCut 빈 찾기/생성 (공용)
function bangGetBin() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c && c.name === "BangCut" && c.type === ProjectItemType.BIN) return c;
    }
    return root.createBin("BangCut");
}

// 컷편집 결과(XML 시퀀스 + SRT)를 BangCut 빈으로 임포트하고 컷 시퀀스를 타임라인에 연다
function bangOpenCutResult(xmlPath, srtPath) {
    try {
        var proj = app.project;
        if (!proj) return "ERR:열린 프로젝트가 없습니다";
        var fx = new File(xmlPath);
        if (!fx.exists) return "ERR:XML이 없습니다: " + xmlPath;

        var root = proj.rootItem;
        var bin = bangGetBin();
        if (!bin) return "ERR:BangCut 빈 생성 실패";

        // 기존 시퀀스 ID 스냅샷 (새로 생긴 시퀀스를 찾기 위해)
        var beforeIds = {};
        for (var s = 0; s < proj.sequences.numSequences; s++) {
            beforeIds[String(proj.sequences[s].sequenceID)] = 1;
        }
        var beforeN = root.children.numItems;

        proj.importFiles([xmlPath], true, bin, false);

        // XML 임포트가 루트에 떨어뜨린 새 아이템들을 BangCut 빈으로 이동
        var strays = [];
        for (var m = beforeN; m < root.children.numItems; m++) {
            if (root.children[m]) strays.push(root.children[m]);
        }
        for (var t = 0; t < strays.length; t++) {
            try { strays[t].moveBin(bin); } catch (eMv) {}
        }

        // SRT도 빈으로 임포트 (중복 방지)
        var srtNote = "";
        try {
            var fs2 = new File(srtPath);
            if (fs2.exists) {
                var want = fs2.displayName;
                var dup = false;
                for (var j = 0; j < bin.children.numItems; j++) {
                    if (bin.children[j] && bin.children[j].name === want) { dup = true; break; }
                }
                if (!dup) {
                    var bN = root.children.numItems;
                    proj.importFiles([srtPath], true, bin, false);
                    for (var k = bN; k < root.children.numItems; k++) {
                        if (root.children[k] && root.children[k].name === want) {
                            try { root.children[k].moveBin(bin); } catch (eMv2) {}
                        }
                    }
                }
            } else { srtNote = " (SRT 없음)"; }
        } catch (eSrt) { srtNote = " (SRT 임포트 실패)"; }

        // 새로 생긴 시퀀스를 활성화 → 타임라인에 열림
        var newSeq = null;
        for (var s2 = 0; s2 < proj.sequences.numSequences; s2++) {
            if (!beforeIds[String(proj.sequences[s2].sequenceID)]) { newSeq = proj.sequences[s2]; break; }
        }
        if (newSeq) {
            // openSequence가 실제로 타임라인 탭을 연다 (activeSequence 지정만으로는 UI가 안 열림)
            var opened = false;
            try { opened = proj.openSequence(newSeq.sequenceID) === true; } catch (eA) {}
            try { proj.activeSequence = newSeq; } catch (eB) {}
            return "OK:컷 시퀀스가 타임라인에 열렸습니다 — " + newSeq.name + srtNote;
        }
        return "OK:임포트 완료 — 시퀀스는 프로젝트 창 BangCut 폴더에서 열어주세요" + srtNote;
    } catch (err) { return "ERR:" + err; }
}

// 패널 연결 확인용
function bangPing() {
    return "PONG " + app.version;
}
