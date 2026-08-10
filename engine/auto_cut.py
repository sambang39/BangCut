#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
auto_cut.py — 통합 자동 편집 엔진
  무음 제거 + 추임새/망설임/더듬 제거 + 음량 정리 + 자막 을 한 번에.

사용:
  python3 auto_cut.py "<원본영상.mp4>" [--preset 보수|표준|공격]

설정은 engine/config.py(프리셋) + 프로젝트 루트 config.json(사용자)에서 관리.
원본은 건드리지 않음(비파괴). 불러온 시퀀스는 전부 수정 가능.
"""

import sys, os, json, difflib, bisect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import silence_cut as SC
from silence_cut import (probe_media, detect_silence, keep_ranges_from_silence,
                         make_clean_audio, build_fcp7_xml, measure_loudness,
                         compute_gain_db, fmt)
from make_subtitles import (transcribe, build_mapper, regroup, write_srt, srt_time)
import config as CONFIG

CFG = {}   # main()에서 config.load 결과로 채움


def norm(tok):
    return tok.strip(" .,!?…·\"'`~\n\t")


def is_filler(tok):
    t = norm(tok)
    if not t:
        return False
    if t in set(CFG["FILLER_PHRASES"]):
        return True
    sounds = set(CFG["FILLER_SOUND_CHARS"])
    if len(t) == 1 and t in sounds:
        return True
    if len(t) >= 2 and len(set(t)) == 1 and t[0] in sounds:
        return True
    return False


# '좀'이 '조금'의 뜻으로 쓰일 때(좀 더/좀 많이/좀 빨리…) 뒤에 오는 정도 표현
DEGREE_STEMS = ("더", "덜", "많", "적", "크", "작", "빨", "천천", "일찍", "늦",
                "높", "낮", "자주", "오래", "길", "짧", "세게", "약하", "쉽",
                "어렵", "멀", "가까", "느리", "조용", "급")


def keep_filler_in_context(i, sw):
    """문맥상 살려야 할 필러면 True. 지금은 '좀=조금' 케이스."""
    if not CFG.get("CONTEXT_FILLER"):
        return False
    t = norm(sw[i][2])
    if t == "좀" and i + 1 < len(sw):
        nxt = norm(sw[i + 1][2])
        if nxt.startswith(DEGREE_STEMS):     # "좀 더", "좀 많이", "좀 빨리" → 의미 있음
            return True
    return False


# 한글 초성 인덱스: ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ (0~18)
# 치찰음(마찰/파찰) = ㅅ(9) ㅆ(10) ㅈ(12) ㅉ(13) ㅊ(14)
SIBILANT_CHOSEONG = {9, 10, 12, 13, 14}


def starts_with_sibilant(tok):
    """어절 첫 글자의 초성이 치찰음이면 True (ㅅ/ㅆ/ㅈ/ㅉ/ㅊ)."""
    t = norm(tok)
    if not t:
        return False
    c = ord(t[0])
    if 0xAC00 <= c <= 0xD7A3:                 # 완성형 한글
        return ((c - 0xAC00) // 588) in SIBILANT_CHOSEONG
    return False


def extend_sibilant_starts(sil_keeps, words, base_lead, sib_lead, total):
    """치찰음으로 시작하는 구간은 시작점 여유를 sib_lead로 넓힌다(자음 유실 방지).
       sil_keeps는 이미 base_lead(PAD_TAIL)만큼 앞이 당겨진 상태 → 부족분만 더 당김.
       앞 구간과 겹치지 않게 clamp. 반환: (조정된 keeps, 조정 건수)."""
    extra = sib_lead - base_lead
    if extra <= 0 or not words:
        return sil_keeps, 0
    sw = sorted(words, key=lambda w: w[0])
    wstarts = [w[0] for w in sw]
    out = []
    n_adj = 0
    for a, b in sil_keeps:
        # 이 구간에서 실제 말이 시작되는 첫 단어(현재 시작점 a 이후 처음 등장)
        idx = bisect.bisect_left(wstarts, a)
        if idx < len(sw) and sw[idx][0] < b and starts_with_sibilant(sw[idx][2]):
            prev_end = out[-1][1] if out else 0.0
            new_a = max(0.0, prev_end, a - extra)
            if new_a < a - 1e-4:
                a = new_a
                n_adj += 1
        out.append([a, b])
    return [tuple(x) for x in out], n_adj


# 한국어 문장어미로 흔히 끝나는 끝음절 — 뒤에 트레일링 릴리스('-다'의 여린 꼬리 등)가 이어져
# 잘리면 '입니드'처럼 뭉개진다. 이런 단어 뒤엔 tail 여유를 크게 준다.
EOMI_END_SYLLABLES = set("다까요죠네지나라자데어아야봐함슴음죵께")


def ends_with_eomi(tok):
    """어절이 문장부호(.?!…)나 흔한 종결 어미 음절로 끝나면 True."""
    t = norm(tok)
    if not t:
        return False
    if str(tok).rstrip().endswith((".", "?", "!", "…")):
        return True
    return t[-1] in EOMI_END_SYLLABLES


def extend_eomi_ends(sil_keeps, words, min_tail):
    """어미(다/까/요/죠…)로 끝나는 발화의 keep 끝점을 최소 여유(min_tail)까지 연장.
       무음 감지가 촘촘해지면(MIN_SILENCE↓) 어미 릴리스의 여린 감쇠부를 무음으로
       판정해 '입니다→입니드'가 재발할 수 있다 — 치찰음 시작 보호의 끝점 대칭.
       반환: (조정된 keeps, 조정 건수)."""
    if not words:
        return sil_keeps, 0
    sw = sorted(words, key=lambda w: w[0])
    wends = [w[1] for w in sw]
    out = []
    n_adj = 0
    for idx, (a, b) in enumerate(sil_keeps):
        j = bisect.bisect_right(wends, b + 0.05) - 1
        if j >= 0 and sw[j][1] > a and ends_with_eomi(sw[j][2]):
            want = sw[j][1] + min_tail
            nxt_start = sil_keeps[idx + 1][0] if idx + 1 < len(sil_keeps) else float("inf")
            new_b = min(max(b, want), nxt_start - 0.02)
            if new_b > b + 1e-4:
                b = new_b
                n_adj += 1
        out.append((a, b))
    return out, n_adj


def tighten_word_gaps(sw, lead_pad, tail_pad, eomi_tail_pad):
    """단어와 단어 '사이'(비발화: 숨/들숨/쩝/정적/화이트노이즈)를 짧게 캡핑.
       비대칭 여유: 방금 끝난 단어 뒤(tail)는 넉넉히(어미 릴리스 보호), 다음 단어 앞(lead)은 짧게.
       어미(다/까/요/죠…)로 끝나면 tail을 더 크게 → '-다' 릴리스가 안 잘린다.
       각 단어 경계 안쪽 여유는 절대 안 자른다 → 말 무결. 반환: 잘라낼 (start,end) 리스트."""
    removes = []
    for i in range(len(sw) - 1):
        # 유령 타임스탬프(0.1s 미만) 단어는 경계를 신뢰할 수 없다 — 실발음이
        # 그 주변 어딘가에 있으므로 인접 gap은 캡핑하지 않음 ("라고→으고" 방지)
        if (sw[i][1] - sw[i][0]) < 0.10 or (sw[i + 1][1] - sw[i + 1][0]) < 0.10:
            continue
        g0, g1 = sw[i][1], sw[i + 1][0]
        gap = g1 - g0
        if gap <= 0:
            continue
        tp = eomi_tail_pad if ends_with_eomi(sw[i][2]) else tail_pad
        if gap - (tp + lead_pad) > 0.05:           # 잘라낼 가치가 있을 때만
            cut0 = g0 + tp                         # 방금 끝난 단어 뒤 여유(어미 릴리스 보호)
            cut1 = g1 - lead_pad                   # 다음 단어 시작 전 여유(작게)
            if cut1 - cut0 > 0.05:
                removes.append([round(cut0, 3), round(cut1, 3)])
    return removes


def find_repeats(sw):
    """말 더듬기·중복 감지. 반복된 앞 시도를 제거하고 마지막만 남긴다."""
    gap_max = CFG["REPEAT_GAP"]
    pad = CFG["FILLER_PAD"]
    toks = [norm(t) for (_, _, t) in sw]
    n = len(sw)
    removed = [False] * n
    def gap(i):
        return sw[i + 1][0] - sw[i][1]

    i = 0
    while i < n:                                   # A) 같은 단어 연속 반복
        j = i
        while j + 1 < n and toks[j + 1] and toks[j + 1] == toks[i] and gap(j) <= gap_max:
            j += 1
        if j > i:
            for k in range(i, j):
                removed[k] = True
        i = j + 1

    for i in range(n - 1):                          # B) 더듬 조각 "그"→"그게"
        if removed[i] or removed[i + 1]:
            continue
        a, b = toks[i], toks[i + 1]
        if a and b and a != b and len(a) <= 2 and b.startswith(a) and gap(i) <= gap_max:
            removed[i] = True

    for k in (3, 2):                                # C) 여러 단어 통째 반복
        i = 0
        while i + 2 * k <= n:
            if any(removed[i:i + 2 * k]):
                i += 1; continue
            s1, s2 = toks[i:i + k], toks[i + k:i + 2 * k]
            inner = sw[i + k][0] - sw[i + k - 1][1]
            if all(s1) and s1 == s2 and inner <= gap_max:
                for x in range(i, i + k):
                    removed[x] = True
                i += 2 * k
            else:
                i += 1

    # D) false-start: '비슷한 말 다시하기' (정확 일치 아님) → 유사도로 앞 시도 제거
    if CFG.get("FUZZY_REPEAT"):
        ratio_min = CFG.get("FUZZY_RATIO", 0.7)
        for k in (3, 2):
            i = 0
            while i + 2 * k <= n:
                if any(removed[i:i + 2 * k]):
                    i += 1; continue
                a = "".join(toks[i:i + k]); b = "".join(toks[i + k:i + 2 * k])
                inner = sw[i + k][0] - sw[i + k - 1][1]
                if a and b and a != b and len(a) >= 2 and inner <= gap_max \
                        and difflib.SequenceMatcher(None, a, b).ratio() >= ratio_min:
                    for x in range(i, i + k):
                        removed[x] = True
                    i += 2 * k
                else:
                    i += 1

    ranges, rep = [], []
    i = 0
    while i < n:
        if removed[i]:
            j = i
            while j + 1 < n and removed[j + 1]:
                j += 1
            s, e = sw[i][0], sw[j][1]
            ranges.append([max(0.0, s - pad), e + pad])
            rep.append((s, e, " ".join(sw[x][2] for x in range(i, j + 1))))
            i = j + 1
        else:
            i += 1
    return ranges, rep


def count_korean_syllables(tok):
    """완성형 한글 글자 수 = 음절 수. 한글 외 발음성 문자(숫자/영문/%/기호)가
       섞이면 -1(발음 길이를 글자수로 셀 수 없음 → 트리밍 제외)."""
    t = norm(tok)
    syl = 0
    for ch in t:
        c = ord(ch)
        if 0xAC00 <= c <= 0xD7A3:
            syl += 1
        else:
            return -1     # '%가', '35', 'MRI' 등 — 예산 계산 불가 → 제외
    return syl


def find_drags(db, hop_s, speech_db, sw, syl_max, min_excess, eomi_extra,
               cut_vowel=False):
    """단어 스팬 내부의 ①늘어진 발화(장음) ②Whisper가 스팬에 흡수한 앞/뒤 침묵을 잡는다.
       ("최근에~ 알게 된~" 장음 + 스팬 속 침묵 — 둘 다 무음컷/캡핑이 못 보는 사각지대.)

       발음 경계는 '스팬 내 최대 음량 코어에서 바깥으로 확장'해 잡는다(코어-15dB).
       — 절대/평균 임계는 이전 단어 꼬리·숨(-44~-58dB)을 발음으로 오인해 위험.
       — 반드시 '원본' 오디오로 분석 (정제 WAV는 loudnorm 게인 라이딩으로
         발화 주변 룸톤까지 올라와 레벨 구분이 불가능).
       반환: (removes[[s,e]], log[(s,e,설명)])."""
    import numpy as _np
    n = len(db)
    removes, log = [], []
    for i, (ostart, oend, txt) in enumerate(sw):
        dur = oend - ostart
        if dur < 0.50 or dur > 15.0:
            continue
        i0, i1 = max(0, int(ostart / hop_s)), min(n, int(oend / hop_s))
        if i1 - i0 < 4:
            continue
        seg = db[i0:i1]
        span_max = float(seg.max())
        if span_max < speech_db - 12:
            continue                     # 발음이 스팬에 사실상 없음(심한 오차) → 안 건드림
        voiced = seg > (span_max - 15.0)  # 코어 기준 상대 확장
        onset = ostart + float(_np.argmax(voiced)) * hop_s
        offset = ostart + float(len(voiced) - _np.argmax(voiced[::-1])) * hop_s
        eff = offset - onset
        nxt = sw[i + 1][0] if i + 1 < len(sw) else oend + 99
        end_lim = min(oend, nxt)
        tail_keep = 0.28 if ends_with_eomi(txt) else 0.15
        prev_end = sw[i - 1][1] if i > 0 else 0.0
        prev_ghost = i > 0 and (sw[i - 1][1] - sw[i - 1][0]) < 0.10
        prev_eomi = i > 0 and ends_with_eomi(sw[i - 1][2])

        # ① 발화 내부 장음 컷 — 기본 OFF (끄는 음절 위치를 알 수 없어 발음 손상 위험,
        #    "일단은→일으" 사례). 켜져 있을 때만 수행, 꺼져 있으면 로그(수동 컷 참고)만.
        syl = count_korean_syllables(txt)
        if syl > 0:
            budget = syl * syl_max + (eomi_extra if ends_with_eomi(txt) else 0.0)
            if eff - budget >= min_excess:
                if cut_vowel:
                    cut0, cut1 = onset + budget, end_lim - 0.05
                    if cut1 - cut0 >= 0.15:
                        removes.append([round(cut0, 3), round(cut1, 3)])
                        log.append((cut0, cut1, f"{txt} (장음 {eff:.2f}s→{budget:.2f}s)"))
                    continue
                else:
                    log.append((onset, offset, f"{txt} (장음 의심 {eff:.2f}s — 수동 컷 참고)"))

        # ② 스팬 뒤 흡수침묵: 발음 끝(offset) 이후가 길게 조용 → 침묵만 컷
        if end_lim - offset > 0.28:
            cut0, cut1 = offset + tail_keep, end_lim - 0.07
            if cut1 - cut0 >= 0.15:
                removes.append([round(cut0, 3), round(cut1, 3)])
                log.append((cut0, cut1, f"{txt} (뒤 흡수침묵 {end_lim-offset:.2f}s)"))

        # ③ 스팬 앞 흡수침묵: 발음 시작(onset) 전이 길게 조용 → 침묵만 컷.
        #    시작 여유는 이전 단어의 어미 릴리스를 보호(0.28/0.15) — '많으셨즈' 재발 방지.
        #    이전 단어가 유령(0.1s 미만)이면 경계를 신뢰할 수 없어 스킵.
        if onset - ostart > 0.25 and not prev_ghost:
            lead = 0.16 if starts_with_sibilant(txt) else 0.12
            head = 0.28 if prev_eomi else 0.15
            cut0, cut1 = max(ostart, prev_end) + head, onset - lead
            if cut1 - cut0 >= 0.15:
                removes.append([round(cut0, 3), round(cut1, 3)])
                log.append((cut0, cut1, f"{txt} (앞 흡수침묵 {onset-ostart:.2f}s)"))
    return removes, log


def carve_out(ranges, protect):
    """ranges(제거 목록)에서 protect 구간을 도려내 보존한다.
       extra_cuts의 'keep' 항목용 — 엔진의 자동 제거(반복/캡핑 등)보다 우선."""
    out = []
    for a, b in ranges:
        segs = [(a, b)]
        for c, d in protect:
            new = []
            for s, e in segs:
                if d <= s or c >= e:
                    new.append((s, e))
                else:
                    if c > s:
                        new.append((s, c))
                    if d < e:
                        new.append((d, e))
            segs = new
        out.extend(segs)
    return [list(x) for x in out if x[1] - x[0] > 0.01]


def merge_ranges(ranges):
    ranges = sorted(ranges)
    out = []
    for a, b in ranges:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def subtract(keeps, removes):
    """keeps 구간에서 removes 구간을 빼서 잘게 쪼갠다."""
    removes = merge_ranges(removes)
    min_keep = CFG["MIN_KEEP"]
    out = []
    for a, b in keeps:
        segs = [(a, b)]
        for c, d in removes:
            new = []
            for s, e in segs:
                if d <= s or c >= e:
                    new.append((s, e))
                else:
                    if c > s:
                        new.append((s, min(c, e)))
                    if d < e:
                        new.append((max(d, s), e))
            segs = new
        out.extend(segs)
    return [(s, e) for s, e in out if e - s >= min_keep]


def complement(keeps, total):
    """keeps의 여집합 = 제거된 구간(버린 컷용)."""
    keeps = sorted(keeps)
    out = []
    cur = 0.0
    for a, b in keeps:
        if a > cur:
            out.append((cur, a))
        cur = max(cur, b)
    if cur < total:
        out.append((cur, total))
    return [(a, b) for a, b in out if b - a > 0.02]


def backup_outputs(outdir, base):
    """덮어쓰기 전 이전 결과(가벼운 것만)를 _backup/타임스탬프/ 로 보관. WAV는 제외(용량)."""
    import datetime, shutil
    names = [base + s for s in ["_cut.xml", "_cut.srt", "_cut_report.txt",
                                "_words.json", "_rejected.xml"]]
    existing = [n for n in names if os.path.exists(os.path.join(outdir, n))]
    if not existing:
        return None
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    bdir = os.path.join(outdir, "_backup", ts)
    os.makedirs(bdir, exist_ok=True)
    for n in existing:
        shutil.copy2(os.path.join(outdir, n), os.path.join(bdir, n))
    return bdir


def verify_keeps(keeps):
    """컷 구간의 길이오류/겹침을 검사. 정상이면 빈 리스트."""
    issues = []
    prev = None
    for idx, (a, b) in enumerate(keeps):
        if b <= a:
            issues.append(f"길이오류 #{idx}: {a:.3f}~{b:.3f}")
        if prev is not None and a < prev - 1e-6:
            issues.append(f"겹침 #{idx}: 이전끝 {prev:.3f} > 시작 {a:.3f}")
        prev = b
    return issues


def find_choppy(keeps, window, max_cuts):
    """컷이 너무 촘촘해 부자연스러울 수 있는 구간을 '출력(컷 후) 타임라인' 기준으로 찾는다.
       자연스러움 > 최대 제거 원칙을 위한 가드. 반환: [(시작, 끝, 컷수), ...]"""
    cps, acc = [], 0.0
    for a, b in keeps[:-1]:
        acc += b - a
        cps.append(acc)          # 출력 타임라인상 컷(점프)이 일어나는 지점
    flagged, i, n = [], 0, len(cps)
    while i < n:
        j = i
        while j < n and cps[j] - cps[i] <= window:
            j += 1
        if j - i >= max_cuts:
            flagged.append([cps[i], cps[j - 1], j - i])
            i = j
        else:
            i += 1
    merged = []
    for s, e, c in flagged:
        if merged and s - merged[-1][1] <= window:
            merged[-1][1] = e; merged[-1][2] += c
        else:
            merged.append([s, e, c])
    return merged


def get_transcript(video, audio_src, cache):
    if os.path.exists(cache):
        print("> 받아쓰기 캐시 사용 (재전사 생략)")
        return [tuple(w) for w in json.load(open(cache, encoding="utf-8"))]
    words = transcribe(audio_src, model=CFG["STT_MODEL"],
                       initial_prompt=CFG["VERBATIM_PROMPT"], condition=True)
    json.dump(words, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    return words


def apply_config_to_modules():
    """무음/음량/자막 파라미터를 각 모듈에 주입."""
    SC.NOISE_DB = CFG["NOISE_DB"]
    SC.MIN_SILENCE = CFG["MIN_SILENCE"]
    SC.PAD_LEAD = CFG["PAD_LEAD"]
    SC.PAD_TAIL = CFG["PAD_TAIL"]
    SC.MIN_KEEP = CFG["MIN_KEEP"]
    SC.TARGET_LUFS = CFG["TARGET_LUFS"]
    SC.TARGET_PEAK_DB = CFG["TARGET_PEAK_DB"]
    import make_subtitles as MS
    MS.MAX_CHARS = CFG.get("SUBTITLE_MAX_CHARS", 24)
    MS.MIN_CHARS = CFG.get("SUBTITLE_MIN_CHARS", 12)
    MS.IDEAL_CHARS = CFG.get("SUBTITLE_IDEAL", 20)
    MS.KEEP_WHOLE = CFG.get("SUBTITLE_KEEP_WHOLE", 28)
    MS.GAP_FILL = CFG.get("SUBTITLE_GAP_FILL", 1.2)
    MS.SNAP_CUT = CFG.get("SUBTITLE_SNAP_CUT", 0.30)
    MS.NO_PERIOD = CFG.get("SUBTITLE_NO_PERIOD", True)


def main():
    global CFG
    args = [a for a in sys.argv[1:]]
    preset = "표준"
    if "--preset" in args:
        i = args.index("--preset")
        preset = args[i + 1]
        del args[i:i + 2]
    # 출력 해상도: --fhd/--1080 = 1920x1080 시퀀스(4K 소스는 스케일로 맞춤). 기본은 소스 해상도.
    out_w = out_h = None
    for flag in ("--fhd", "--1080", "--1080p"):
        if flag in args:
            args.remove(flag)
            out_w, out_h = 1920, 1080
    # 의미 기반 추가 컷(반복 테이크/비화자 음성 등)을 담은 JSON 파일 경로.
    # 형식: [[start, end, "사유"], ...] (초 단위). AI/사용자가 만들어 주입.
    extra_cuts_path = None
    if "--extra-cuts" in args:
        i = args.index("--extra-cuts")
        extra_cuts_path = args[i + 1]
        del args[i:i + 2]
    # 플랜 전용: 컷 계획+통계만 계산하고 XML/자막 생성은 생략 (설정·의미컷 검증용, 캐시와 함께 초 단위)
    plan_only = False
    if "--plan-only" in args:
        args.remove("--plan-only")
        plan_only = True
    if not args:
        print("사용: python3 auto_cut.py \"<원본영상>\" [--preset 보수|표준|공격] [--fhd] [--extra-cuts cuts.json] [--plan-only]"); sys.exit(1)
    video = args[0]
    if not os.path.exists(video):
        print("파일 없음:", video); sys.exit(1)

    proj = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    CFG = CONFIG.load(preset, project_dir=proj)
    apply_config_to_modules()

    base = os.path.splitext(os.path.basename(video))[0]
    # 결과물은 원본 영상 폴더 안 BangCut/ 에 저장 (영상과 함께 다니도록)
    from out_dir import output_dir_for
    outdir = output_dir_for(video)
    print(f"> 결과 폴더: {outdir}")
    xml_out = os.path.join(outdir, base + "_cut.xml")
    srt_out = os.path.join(outdir, base + "_cut.srt")
    wav_out = os.path.join(outdir, base + "_cut_audio.wav")
    rej_out = os.path.join(outdir, base + "_rejected.xml")
    words_cache = os.path.join(outdir, base + "_words.json")

    if CFG.get("BACKUP_OUTPUTS"):
        bdir = backup_outputs(outdir, base)
        if bdir:
            print(f"> 이전 결과 백업 → _backup/{os.path.basename(bdir)}/")

    src = "config.json" if CFG.get("_config_json") else f"프리셋:{CFG['_preset']}"
    print(f"> 미디어 분석 중...  (설정 {src})")
    info = probe_media(video)
    print(f"   길이 {fmt(info['duration'])} · {info['width']}x{info['height']} · {info['fps']}fps")

    # ── 분석 캐시 — 원본이 안 바뀌었으면 무음감지/음량측정/정리오디오를 재사용.
    #    재실행(설정·의미컷 수정) 비용을 분 단위 → 초 단위로 줄인다.
    ana_cache = os.path.join(outdir, base + "_analysis.json")
    src_sig = {"size": os.path.getsize(video), "mtime": int(os.path.getmtime(video))}
    ana = {}
    if os.path.exists(ana_cache):
        try:
            _a = json.load(open(ana_cache, encoding="utf-8"))
            if _a.get("src") == src_sig:
                ana = _a
        except Exception:
            ana = {}

    print("> 무음 감지 중...")
    sil_key = f"{CFG['NOISE_DB']}|{CFG['MIN_SILENCE']}"
    if ana.get("sil_key") == sil_key and "silences" in ana:
        silences = [(s, e) for s, e in ana["silences"]]
        print("   캐시 재사용 (원본·무음설정 변경 없음)")
    else:
        silences = detect_silence(video)
        ana["src"] = src_sig
        ana["sil_key"] = sil_key
        ana["silences"] = silences
    sil_keeps = keep_ranges_from_silence(silences, info["duration"])
    kept_sil = sum(b - a for a, b in sil_keeps)

    print("> 음량 분석 + 오디오 정리 중...")
    extra = []
    if CFG.get("DENOISE"):
        extra.append("afftdn")
    if CFG.get("DEESS"):
        extra.append("deesser")
    extra_filters = (",".join(extra) + ",") if extra else ""
    filt_key = f"{extra_filters}|{CFG['TARGET_LUFS']}"
    if (ana.get("filt_key") == filt_key and "loud" in ana and "after" in ana
            and os.path.exists(wav_out) and os.path.getsize(wav_out) > 0):
        loud, after = ana["loud"], ana["after"]
        clean_audio = wav_out
        print("   캐시 재사용: 정리 오디오·음량 측정 생략")
        print(f"   음량 {loud['I']}→{after['I']} LUFS / 피크 {loud['TP']}→{after['TP']} dB")
    else:
        loud = measure_loudness(video)
        if extra:
            print(f"   오디오 후처리: {', '.join(extra)}")
        ok = make_clean_audio(video, wav_out, info, extra_filters=extra_filters)
        clean_audio = wav_out if ok else None
        if clean_audio:
            after = measure_loudness(wav_out)
            print(f"   음량 {loud['I']}→{after['I']} LUFS / 피크 {loud['TP']}→{after['TP']} dB")
            ana["src"] = src_sig
            ana["filt_key"] = filt_key
            ana["loud"] = loud
            ana["after"] = after
    try:
        json.dump(ana, open(ana_cache, "w", encoding="utf-8"))
    except Exception:
        pass
    audio_for_stt = clean_audio or video

    words = get_transcript(video, audio_for_stt, words_cache)
    print(f"   받아쓴 단어 {len(words)}개")

    # ── 치찰음 시작점 보호: 첫 단어 초성이 ㅅ/ㅆ/ㅈ/ㅉ/ㅊ이면 시작 여유↑ ──
    sil_keeps, n_sib = extend_sibilant_starts(
        sil_keeps, words, CFG["PAD_TAIL"], CFG.get("SIBILANT_LEAD", CFG["PAD_TAIL"]),
        info["duration"])
    if n_sib:
        print(f"   치찰음 시작 보호: {n_sib}곳 시작점 여유 확장 "
              f"({CFG['PAD_TAIL']}→{CFG.get('SIBILANT_LEAD')}초)")

    # ── 어미 끝점 보호: keep 끝이 어미(다/까/요/죠…)면 릴리스 여유 확보 ──
    sil_keeps, n_eomi = extend_eomi_ends(sil_keeps, words,
                                         CFG.get("EOMI_KEEP_TAIL", 0.20))
    if n_eomi:
        print(f"   어미 끝점 보호: {n_eomi}곳 끝점 여유 확장 (릴리스 ≥{CFG.get('EOMI_KEEP_TAIL', 0.20)}초)")

    # ── 제거 구간 계산 ──
    keeps = sil_keeps
    removes = []
    report = {"추임새": [], "망설임": [], "더듬/중복": [], "숨소리": [], "늘어짐": [], "추가컷": []}
    sw = sorted(words, key=lambda w: w[0])
    fpad = CFG["FILLER_PAD"]

    n_kept_ctx = 0
    if CFG["REMOVE_FILLERS"]:
        for i, (s, e, t) in enumerate(sw):
            if is_filler(t):
                if keep_filler_in_context(i, sw):   # '좀 더' 등 의미 있는 건 살림
                    n_kept_ctx += 1
                    continue
                removes.append([max(0.0, s - fpad), e + fpad])
                report["추임새"].append((s, e, t))

    if CFG["REMOVE_HESITATION"]:
        hmin, hpad = CFG["HESITATION_MIN"], CFG["HESITATION_PAD"]
        for i in range(len(sw) - 1):
            g0, g1 = sw[i][1], sw[i + 1][0]
            if g1 - g0 < hmin:
                continue
            for a, b in sil_keeps:
                lo, hi = max(g0, a) + hpad, min(g1, b) - hpad
                if hi - lo >= hmin:
                    removes.append([lo, hi])
                    report["망설임"].append((lo, hi, "(어/음 등)"))

    if CFG["REMOVE_REPEATS"]:
        rep_ranges, rep_log = find_repeats(sw)
        removes += rep_ranges
        report["더듬/중복"] = rep_log

    # ── 단어-간격 캡핑: 말 사이 비발화(숨/쩝/정적/노이즈)를 짧게 유지 (타이트 핵심) ──
    if CFG.get("TIGHTEN_WORD_GAPS"):
        wg = tighten_word_gaps(sw, CFG.get("WORD_GAP_LEAD_PAD", 0.07),
                               CFG.get("WORD_GAP_TAIL_PAD", 0.12),
                               CFG.get("WORD_GAP_EOMI_TAIL_PAD", 0.22))
        wg_cut = sum(b - a for a, b in wg)
        removes += wg
        print(f"   단어사이 캡핑: {len(wg)}곳 (말 사이 정적/숨/입소리, 약 {fmt(wg_cut)})")

    if CFG.get("ACOUSTIC_FILLER") and clean_audio:
        try:
            import acoustic_filler as AF
            AF.MIN_DUR = CFG.get("ACOUSTIC_MIN_DUR", 0.20)   # 프리셋으로 민감도 조절
            print("> 어/음 음향 검출 중...")
            r_, f_, v_ = AF.analyze(AF.load_audio(clean_audio))
            checked = AF.cross_check(AF.detect(r_, f_, v_), words)
            wstarts = sorted(x[0] for x in sw)
            follow_max = CFG.get("ACOUSTIC_FOLLOW_MAX", 1.0)
            n_ac = n_tail = 0
            for s, e, d, conf, txt in checked:
                if conf != "높음(빈구간)":     # 글자 없는 지속음만 = 가장 안전
                    continue
                # 끝음 보호: 어/음 뒤에 말이 곧 이어지면 컷(=말 중간), 한참 침묵이면 보존(=문장 끝 꼬리)
                idx = bisect.bisect_left(wstarts, e)
                nxt = wstarts[idx] if idx < len(wstarts) else e + 99
                if nxt - e <= follow_max:
                    removes.append([s, e])
                    report["망설임"].append((s, e, "(음향 어/음)"))
                    n_ac += 1
                else:
                    n_tail += 1
            print(f"   음향 어/음 {n_ac}개 추가" + (f" (끝음 꼬리 {n_tail}개 보존)" if n_tail else ""))
        except Exception as ex:
            print(f"   [주의] 음향 검출 건너뜀: {ex}")

    if CFG.get("BREATH_REDUCE") and clean_audio:
        try:
            import breath_reduce as BR
            print("> 숨소리 축소 중...")
            aud, asr = BR.load_audio(clean_audio)
            br = BR.detect_breaths(
                aud, asr, words, sil_keeps,
                min_dur=CFG.get("BREATH_MIN_DUR", 0.15),
                rel_lo=CFG.get("BREATH_REL_LO", -40.0),
                rel_hi=CFG.get("BREATH_REL_HI", -12.0),
                flatness=CFG.get("BREATH_FLATNESS", 0.35),
                frac=CFG.get("BREATH_FRAC", 0.40),
                keep=CFG.get("BREATH_KEEP", 0.12),
                pad=CFG.get("BREATH_PAD", 0.04))
            cut = sum(b - a for a, b in br)
            removes += [list(r) for r in br]
            report["숨소리"] = [(a, b, "(숨소리)") for a, b in br]
            print(f"   숨소리 {len(br)}곳 축소 (약 {fmt(cut)})")

            # ── 늘어짐(장음)+스팬 흡수침묵 트리밍 — 반드시 '원본' 오디오로 분석
            #    (정제 WAV는 loudnorm 게인 라이딩으로 정적/발음 레벨 구분 불가)
            if CFG.get("TRIM_DRAG"):
                aud_o, asr_o = BR.load_audio(video)
                fr = BR.framewise(aud_o, asr_o)
                if fr is not None:
                    db_, _flat, hop_s = fr
                    spd = BR._speech_db(db_, hop_s, words)
                    drags, dlog = find_drags(
                        db_, hop_s, spd, sw,
                        CFG.get("DRAG_SYL_MAX", 0.32),
                        CFG.get("DRAG_MIN_EXCESS", 0.30),
                        CFG.get("DRAG_EOMI_EXTRA", 0.15),
                        cut_vowel=CFG.get("DRAG_CUT_VOWEL", False))
                    dcut = sum(b - a for a, b in drags)
                    removes += drags
                    report["늘어짐"] = [(a, b, t) for (a, b, t) in dlog]
                    print(f"   늘어짐/스팬침묵 트리밍: {len(drags)}곳 (약 {fmt(dcut)})")
        except Exception as ex:
            print(f"   [주의] 숨소리 축소 건너뜀: {ex}")

    # ── 의미 기반 추가 컷 주입 (반복 테이크 재촬영분 / 비화자(감독) 음성 등) ──
    # 항목 4번째 필드가 "keep"이면 반대로 '강제 보존' — 그 구간과 겹치는
    # 모든 자동 제거(반복/캡핑/추가컷)를 무효화한다 (Whisper 유령 타임스탬프 등으로
    # 엔진이 살려야 할 발화를 지울 때 사용).
    keep_forced = []
    if extra_cuts_path and os.path.exists(extra_cuts_path):
        try:
            ex = json.load(open(extra_cuts_path, encoding="utf-8"))
            n_ex = 0
            for item in ex:
                s, e = float(item[0]), float(item[1])
                why = item[2] if len(item) > 2 else "(추가컷)"
                if e <= s:
                    continue
                if len(item) > 3 and str(item[3]).lower() == "keep":
                    keep_forced.append([s, e])
                    continue
                removes.append([s, e])
                report["추가컷"].append((s, e, why))
                n_ex += 1
            cut_t = sum(b - a for a, b, _ in report["추가컷"])
            print(f"   추가컷 {n_ex}개 주입 (반복/비화자 등, 약 {fmt(cut_t)})"
                  + (f" + 강제보존 {len(keep_forced)}곳" if keep_forced else ""))
        except Exception as ex_:
            print(f"   [주의] 추가컷 파일 읽기 실패: {ex_}")

    if keep_forced and removes:
        removes = carve_out(removes, keep_forced)

    if removes:
        keeps = subtract(sil_keeps, removes)
        kept_now = sum(b - a for a, b in keeps)
        nf, nh, nr, nb = (len(report["추임새"]), len(report["망설임"]),
                          len(report["더듬/중복"]), len(report["숨소리"]))
        nx = len(report["추가컷"])
        ctx = f" (문맥상 '좀' {n_kept_ctx}개 살림)" if n_kept_ctx else ""
        parts = []
        if nf or nh: parts.append(f"추임새 {nf} + 망설임 {nh}")
        if nr: parts.append(f"더듬/중복 {nr}")
        if nb: parts.append(f"숨소리 {nb}")
        if nx: parts.append(f"추가컷 {nx}")
        print(f"   {' + '.join(parts) or '제거 없음'} 제거{ctx} "
              f"→ 추가로 {fmt(kept_sil - kept_now)} 단축")
        rep_out = os.path.join(outdir, base + "_cut_report.txt")
        with open(rep_out, "w", encoding="utf-8") as f:
            for cat in ("추임새", "망설임", "더듬/중복", "숨소리", "늘어짐", "추가컷"):
                f.write(f"━━━ {cat} ({len(report[cat])}개) ━━━\n")
                for s, e, t in report[cat]:
                    f.write(f"  {srt_time(s)}  {t}\n")
                f.write("\n")

    kept = sum(b - a for a, b in keeps)
    removed = info["duration"] - kept
    print(f"\n   총 제거: {fmt(removed)} ({removed/info['duration']*100:.1f}%)  "
          f"| 컷 {len(keeps)}개 | 최종 {fmt(kept)}")

    # ── 플랜 전용 모드: 계획만 저장하고 종료 (XML/자막/리포트 생략) ──
    if plan_only:
        plan_out = os.path.join(outdir, base + "_plan.json")
        json.dump([[round(a, 3), round(b, 3)] for a, b in keeps],
                  open(plan_out, "w", encoding="utf-8"))
        issues = verify_keeps(keeps)
        print(f"   검증: {'문제 ' + str(len(issues)) + '건' if issues else '갭/겹침/길이오류 0'}")
        print(f"\n플랜 전용 완료 — 컷 계획 저장: {os.path.basename(plan_out)}")
        print("   확인 후 --plan-only 빼고 다시 실행하면 XML/자막 생성 (분석은 캐시 재사용).")
        return

    # ── XML 생성 ──
    print("> 프리미어 시퀀스(XML) 생성 중...")
    gain = compute_gain_db(loud)
    xml, seq_dur = build_fcp7_xml(video, info, keeps, gain, base + " [러프컷]",
                                  clean_audio=clean_audio,
                                  fade_frames=CFG.get("AUDIO_FADE_FRAMES", 0),
                                  out_w=out_w, out_h=out_h)
    open(xml_out, "w", encoding="utf-8").write(xml)
    if out_w:
        print(f"   시퀀스 해상도: {out_w}x{out_h} (원본 {info['width']}x{info['height']} → {round(out_w/info['width']*100)}% 스케일)")

    # ── 프레임 무결성 검증 ──
    issues = verify_keeps(keeps)
    if issues:
        print(f"   [주의] 검증: 문제 {len(issues)}건 발견")
    else:
        print(f"   검증: 갭/겹침/길이오류 0 (컷 {len(keeps)}개)")

    # ── 자연스러움 가드: 컷이 촘촘한 구간 경고 (잘라낸 뒤 부자연스러움 방지) ──
    choppy = find_choppy(keeps, CFG["CHOPPY_WINDOW"], CFG["CHOPPY_MAX"])
    if choppy:
        print(f"   [주의] 자연스러움 주의: 컷이 촘촘한 구간 {len(choppy)}곳 → 리포트에서 확인 권장")
    rep_path = os.path.join(outdir, base + "_cut_report.txt")
    with open(rep_path, "a", encoding="utf-8") as f:
        f.write(f"━━━ 검증 ━━━\n")
        f.write("  프레임: " + ("정상(갭/겹침 0)\n" if not issues else "; ".join(issues) + "\n"))
        f.write(f"━━━ 자연스러움 주의 (컷 촘촘 = 부자연 위험, {len(choppy)}곳) ━━━\n")
        for s, e, c in choppy:
            f.write(f"  {srt_time(s)}~{srt_time(e)}  {c}컷 (확인 권장)\n")
        f.write("\n")

    # ── 버린 컷 시퀀스 (잘려나간 구간만) ──
    rej_made = False
    if CFG.get("MAKE_REJECTED"):
        rej = complement(keeps, info["duration"])
        if rej:
            rej_xml, _ = build_fcp7_xml(video, info, rej, gain, base + " [버린컷]",
                                        clean_audio=clean_audio,
                                        out_w=out_w, out_h=out_h)
            open(rej_out, "w", encoding="utf-8").write(rej_xml)
            rej_made = True

    # ── 자막 생성 ──
    print("> 자막(SRT) 생성 중...")
    # 프레임 반올림 누적(fps) — XML 타임라인과 자막 타임을 정확히 정합
    mapper = build_mapper(keeps, fps=info["fps"])
    sub_words = [w for w in words if not is_filler(w[2])]
    from make_subtitles import cut_points_of
    cut_points = cut_points_of(keeps, fps=info["fps"])
    lines = regroup(sub_words, mapper, cut_points=cut_points)
    write_srt(lines, srt_out)

    # 단어 앵커 파일 (BangCut 패널용): [컷타임s, 컷타임e, 단어, 원본s, 원본e]
    # 패널이 자막 편집·삭제 마킹 시 실측 단어 시간을 쓰기 위한 데이터.
    try:
        _cw = []
        for _ws, _we, _wt in sub_words:
            _m0, _m1 = mapper(_ws), mapper(_we)
            if _m0 is None or _m1 is None or _m1 <= _m0:
                continue  # 컷에 걸쳐 잘린 단어는 앵커 제외(패널은 보간 폴백)
            _cw.append([round(_m0, 3), round(_m1, 3), _wt,
                        round(_ws, 3), round(_we, 3)])
        json.dump(_cw, open(os.path.join(outdir, base + "_cut_words.json"), "w",
                            encoding="utf-8"), ensure_ascii=False)
        print(f"   앵커   : {os.path.basename(base + '_cut_words.json')}  ({len(_cw)}단어)")
    except Exception as _e_cw:
        print(f"   [주의] 단어 앵커 파일 생성 실패: {_e_cw}")

    # 자막 마감(한 줄 30자) + .vtt/.ass(빵 스타일) 한 번에
    sub_extra = ""
    if CFG.get("POLISH_SUBTITLES"):
        try:
            import subtitle_polish as SP
            SP.FILL_GAPS = CFG.get("SUBTITLE_FILL_GAPS", True)   # 자막 빈칸 제거 여부
            SP.SNAP_POINTS = cut_points                          # 전환=컷 동시화
            SP.SNAP_DIST = CFG.get("SUBTITLE_SNAP_CUT", 0.30)
            cues = SP.polish(SP.parse_srt(srt_out))
            stem = os.path.splitext(srt_out)[0]
            SP.write_srt(cues, srt_out)
            SP.write_vtt(cues, stem + ".vtt")
            SP.write_ass(cues, stem + ".ass")
            lines = cues
            sub_extra = " (+ .vtt / .ass)"
        except Exception as ex:
            print(f"   [주의] 자막 마감 건너뜀: {ex}")

    print(f"\n완료  (설정 {src})")
    print(f"   시퀀스 : {os.path.basename(xml_out)}")
    print(f"   오디오 : {os.path.basename(wav_out)}")
    print(f"   자막   : {os.path.basename(srt_out)}{sub_extra}  ({len(lines)}줄)")
    if rej_made:
        print(f"   버린컷 : {os.path.basename(rej_out)}  (잘린 부분 검토용)")
    if CFG.get("HTML_REPORT"):
        try:
            import html_report
            summary = {"duration": info["duration"], "kept": kept, "removed": removed,
                       "pct": removed / info["duration"] * 100, "cuts": len(keeps),
                       "preset": CFG["_preset"]}
            hp = html_report.generate(os.path.join(outdir, base + "_report.html"),
                                      base, summary, choppy, report)
            print(f"   리포트 : {os.path.basename(hp)}  (브라우저로 열어 검토)")
        except Exception as ex:
            print(f"   [주의] HTML 리포트 건너뜀: {ex}")
    print(f"\n   프리미어 > 파일 > 가져오기 로 .xml 불러오세요.")
    if len(keeps) > 1:
        print(f"   자연스러움 팁: 타임라인 전체 선택 → Cmd+Shift+D 하면")
        print(f"      모든 컷에 기본 오디오 전환이 적용돼 클릭음 없이 부드러워집니다.")
        rep_path2 = os.path.join(outdir, base + "_cut_report.txt")
        with open(rep_path2, "a", encoding="utf-8") as f:
            f.write("━━━ 다듬기 팁 ━━━\n")
            f.write("  컷 부드럽게: 프리미어 타임라인 전체 선택 → Cmd+Shift+D (모든 컷에 기본 오디오 전환)\n")
            f.write("  자연스러움 주의 구간은 위 목록 참고 — 너무 촘촘하면 일부 컷 되돌려 호흡 살리기\n\n")


if __name__ == "__main__":
    main()
