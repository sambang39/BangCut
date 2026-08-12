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

        // 대상 빈: 최신 "N트" 회차 빈 → 없으면 BangCut 빈
        var root = proj.rootItem;
        var bin = bangGetBin();
        var target = bin, maxN = 0;
        for (var b = 0; b < bin.children.numItems; b++) {
            var cb = bin.children[b];
            if (cb && cb.type === ProjectItemType.BIN) {
                var mm = String(cb.name).match(/^(\d+)트/);
                if (mm && parseInt(mm[1], 10) >= maxN) { maxN = parseInt(mm[1], 10); target = cb; }
            }
        }
        // 같은 이름의 기존 임포트 제거(루트·대상 빈 — 재적용 시 중복 방지)
        function purge(container) {
            for (var i = container.children.numItems - 1; i >= 0; i--) {
                var c0 = container.children[i];
                if (c0 && c0.name === wantName && c0.type === ProjectItemType.FILE) {
                    try { c0.deleteBin ? c0.deleteBin() : proj.deleteItem(c0); } catch (eDel) {}
                }
            }
        }
        purge(root);
        purge(target);

        var beforeN = root.children.numItems;
        proj.importFiles([srtPath], true, target, false);

        var item = null;
        for (var j = target.children.numItems - 1; j >= 0; j--) {
            if (target.children[j] && target.children[j].name === wantName) { item = target.children[j]; break; }
        }
        if (!item) {
            // 루트로 떨어졌으면 회수
            for (var r2 = root.children.numItems - 1; r2 >= beforeN - 1 && r2 >= 0; r2--) {
                var rc = root.children[r2];
                if (rc && rc.name === wantName) {
                    try { rc.moveBin(target); } catch (eMv3) {}
                    item = rc;
                    break;
                }
            }
        }
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

// 현재 프로젝트 경로 — 프로젝트 전환 감지용
function bangGetProjectPath() {
    try { return String(app.project.path || app.project.name || ""); } catch (e) { return "ERR"; }
}

// 현재 플레이헤드 위치(초) — 역방향 싱크용
function bangGetPlayerPosition() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERR";
        return String(seq.getPlayerPosition().seconds);
    } catch (e) { return "ERR"; }
}

// BangCut 빈 안의 "N트_" 하위 빈 중 다음 번호 계산
function bangNextRunNo(bin) {
    var n = 0;
    for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        if (c && c.type === ProjectItemType.BIN) {
            var m = String(c.name).match(/^(\d+)트/);
            if (m && parseInt(m[1], 10) > n) n = parseInt(m[1], 10);
        }
    }
    return n + 1;
}

// 실행 결과(XML+SRT)를 "N트_라벨" 하위 빈으로 임포트하고 시퀀스를 연다
function bangImportRun(xmlPath, srtPath, label) {
    try {
        var proj = app.project;
        if (!proj) return "ERR:열린 프로젝트가 없습니다";
        var fx = new File(xmlPath);
        if (!fx.exists) return "ERR:XML이 없습니다: " + xmlPath;
        var root = proj.rootItem;
        var bin = bangGetBin();
        if (!bin) return "ERR:BangCut 빈 생성 실패";

        var runNo = bangNextRunNo(bin);
        var runBin = bin.createBin(runNo + "트");   // 직관적으로 "1트","2트"만
        if (!runBin) return "ERR:회차 빈 생성 실패";

        // 트라이 넘버를 파일명에 새긴 사본으로 임포트 → 식별 쉽고, 같은 경로 캐시로 옛 자막이 재삽입되던 문제 차단
        function tryNamed(p) {
            if (!p) return p;
            var f = new File(p);
            if (!f.exists) return p;
            var nm = f.name.replace(/(_cut)(_\d+)?(\.(?:xml|srt))$/i, "$1_" + runNo + "트$3");
            if (nm === f.name) return p;                 // 패턴 불일치면 원본 유지
            var dst = f.parent.fsName + "/" + nm;
            try { if (f.copy(dst)) return dst; } catch (eCopy) {}
            return p;
        }
        xmlPath = tryNamed(xmlPath);
        srtPath = tryNamed(srtPath);

        var beforeIds = {};
        for (var s = 0; s < proj.sequences.numSequences; s++) {
            beforeIds[String(proj.sequences[s].sequenceID)] = 1;
        }

        // XML 임포트 + 루트로 떨어진 항목 전부 회차 빈으로
        var beforeN = root.children.numItems;
        proj.importFiles([xmlPath], true, runBin, false);
        var strays = [];
        for (var m = beforeN; m < root.children.numItems; m++) {
            if (root.children[m]) strays.push(root.children[m]);
        }
        for (var t = 0; t < strays.length; t++) {
            try { strays[t].moveBin(runBin); } catch (eMv) {}
        }

        // SRT도 같은 회차 빈으로
        var fsrt = srtPath ? new File(srtPath) : null;
        if (fsrt && fsrt.exists) {
            var b2 = root.children.numItems;
            proj.importFiles([srtPath], true, runBin, false);
            for (var k = b2; k < root.children.numItems; k++) {
                if (root.children[k]) { try { root.children[k].moveBin(runBin); } catch (eMv2) {} }
            }
        }

        // 새 시퀀스 → 이름에 회차 표기 + 타임라인 오픈
        var newSeq = null;
        for (var s2 = 0; s2 < proj.sequences.numSequences; s2++) {
            if (!beforeIds[String(proj.sequences[s2].sequenceID)]) { newSeq = proj.sequences[s2]; break; }
        }
        if (newSeq) {
            try { newSeq.name = newSeq.name.replace(/ · \d+트.*$/, "") + " · " + runNo + "트"; } catch (eNm) {}
            try { proj.openSequence(newSeq.sequenceID); } catch (eA) {}
            try { proj.activeSequence = newSeq; } catch (eB) {}
            return "OK:" + runNo + "트 폴더로 임포트 — 시퀀스가 타임라인에 열렸습니다";
        }
        return "OK:" + runNo + "트 폴더로 임포트 완료 (시퀀스는 프로젝트 창에서 열어주세요)";
    } catch (err) { return "ERR:" + err; }
}

// 활성 시퀀스의 비디오 클립을 [원본in, 원본out, 타임라인start, 미디어경로]로 읽어 재투영에 사용.
// → {"ok":true,"name":…,"fps":…,"clips":[[inSec,outSec,startSec,"path"],…]}
function bangReadSeqClips() {
    try {
        var proj = app.project;
        if (!proj) return bangErr("열린 프로젝트가 없습니다");
        var seq = proj.activeSequence;
        if (!seq) return bangErr("활성 시퀀스가 없습니다. 자막 편집할 시퀀스를 타임라인에 여세요");
        var fps = 0;
        try { fps = BANG_TICKS_PER_SEC / Number(seq.timebase); } catch (e0) {}
        var arr = [];
        var vts = seq.videoTracks;
        for (var t = 0; t < vts.numTracks; t++) {
            var clips = vts[t].clips;
            for (var i = 0; i < clips.numItems; i++) {
                var c = clips[i];
                if (!c || !c.projectItem) continue;
                var mp = "";
                try { mp = c.projectItem.getMediaPath(); } catch (e1) {}
                var inS, outS, stS;
                try {
                    inS = Number(c.inPoint.seconds);
                    outS = Number(c.outPoint.seconds);
                    stS = Number(c.start.seconds);
                } catch (e2) { continue; }
                if (!(outS > inS)) continue;
                arr.push('[' + inS + ',' + outS + ',' + stS + ',"' + bangEsc(mp) + '"]');
            }
        }
        return '{"ok":true,"name":"' + bangEsc(seq.name) + '","fps":' + fps +
               ',"clips":[' + arr.join(',') + ']}';
    } catch (err) { return bangErr(String(err)); }
}

// 프로젝트 내 모든 시퀀스 목록 → {"ok":true,"sequences":[{"id","name","active"},…]}
function bangListSequences() {
    try {
        var proj = app.project;
        if (!proj) return bangErr("열린 프로젝트가 없습니다");
        var active = proj.activeSequence;
        var activeId = active ? String(active.sequenceID) : "";
        var out = [];
        for (var s = 0; s < proj.sequences.numSequences; s++) {
            var sq = proj.sequences[s];
            out.push('{"id":"' + bangEsc(String(sq.sequenceID)) + '","name":"' + bangEsc(sq.name) +
                     '","active":' + (String(sq.sequenceID) === activeId ? "true" : "false") + '}');
        }
        return '{"ok":true,"sequences":[' + out.join(',') + ']}';
    } catch (err) { return bangErr(String(err)); }
}

// 지정 시퀀스를 타임라인에 실제로 열고 활성화 (드롭다운 선택 시)
function bangOpenSeq(id) {
    try {
        var proj = app.project;
        if (!proj) return "ERR:열린 프로젝트가 없습니다";
        for (var s = 0; s < proj.sequences.numSequences; s++) {
            var sq = proj.sequences[s];
            if (String(sq.sequenceID) === String(id)) {
                try { proj.openSequence(String(sq.sequenceID)); } catch (eO) {} // 타임라인 탭 실제 오픈
                try { proj.activeSequence = sq; } catch (eA) {}
                return "OK:" + sq.name;
            }
        }
        return "ERR:시퀀스를 찾을 수 없습니다";
    } catch (err) { return "ERR:" + err; }
}

// 패널 연결 확인용
function bangPing() {
    return "PONG " + app.version;
}
