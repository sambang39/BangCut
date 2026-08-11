#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
config.py — 모든 편집 파라미터 + 공격성 프리셋 한 곳에서 관리.

우선순위:  내장 기본값(표준)  <  프리셋(보수/표준/공격)  <  config.json(사용자)
사용:
  python3 auto_cut.py "영상.mp4" --preset 공격
  또는 프로젝트 루트에 config.json 두면 자동 적용.
"""

import json, os

# ── 표준(기본) 설정 — 제1원칙: 타이트함 우선 (촘촘·빡빡, 호흡/정적 최소화) ──
# 말과 말 사이 빈 구간, 들숨/날숨, 입 다심(쩝), 무발화 화이트노이즈를 최대한 제거해
# 처음부터 끝까지 화자가 촘촘하게 멘트를 쏟아내는 러드를 만든다. (사용자 방향)
DEFAULTS = {
    # 무음 — 룸톤/정적을 안전하게 컷(말은 안 건드림). 실측: 룸톤 평균 -55dB, 말 평균 -27dB.
    # -42면 룸톤은 확실히 컷하고 말의 여린 부분(어미·어택)은 지킨다.
    "NOISE_DB": -42.0,       # 이보다 조용하면 무음.
    "MIN_SILENCE": 0.20,     # 이 길이(초) 이상 조용하면 컷 — 파열음 폐쇄(~0.15s)보다 커야 단어 내부를 안 자름
    # 비대칭 패딩:
    #   PAD_TAIL = 시작점(말 시작 전) 여유 — 빡빡하되 어택 유실은 방지. 치찰음은 SIBILANT_LEAD.
    #   PAD_LEAD = 끝점(말 끝 뒤) 여유 — 흐리는 어미('-다' 등) 유실 방지. 실측상 어미 릴리스가
    #             Whisper/무음판정 지점보다 0.1~0.15s 더 이어져, 넉넉히 둔다.
    "PAD_LEAD": 0.16,        # 끝점: 말 끝 뒤 여유(초) — STT 끝 스탬프가 릴리스보다 이르게 찍혀 넉넉히 필요
    "PAD_TAIL": 0.09,        # 시작점: 말 시작 전 여유(초) — 어택 유실 방지
    # 치찰음(ㅅ/ㅆ/ㅈ/ㅉ/ㅊ)으로 시작하는 말은 자음 앞부분이 조용해 시작점을 확 자르면
    # ㅅ→ㅌ, ㅈ→ㅇ, ㅊ 유실이 생긴다. 그런 구간만 시작점 여유를 이만큼(초)으로 늘림.
    "SIBILANT_LEAD": 0.16,   # 치찰음 시작 구간의 시작점 여유(초). PAD_TAIL 대신 적용
    "EOMI_KEEP_TAIL": 0.16,  # 어미(다/까/요/죠) keep 끝점 최소 여유(초) — 릴리스 보호
    "MIN_KEEP": 0.20,        # 이보다 짧은 토막은 버림 — 잘게 쪼개 튀는 소리 방지

    # ── 단어-간격 캡핑 (타이트함의 핵심) ──
    # 단어와 단어 '사이'는 정의상 비발화(숨/들숨/쩝/정적/화이트노이즈)다. 그 사이를 잘라
    # 촘촘하게 유지하되, 각 단어 경계엔 여유(패딩)를 둬 말은 절대 안 자른다.
    # 비대칭: 방금 끝난 단어 뒤(tail)는 넉넉히(어미 릴리스 보호), 다음 단어 앞(lead)은 짧게.
    # 어미(다/까/요/죠…)로 끝나면 '-다'류 트레일링 릴리스가 길어 tail을 더 크게 준다.
    "TIGHTEN_WORD_GAPS": True,
    "WORD_GAP_LEAD_PAD": 0.07,       # 다음 단어 시작 전 남기는 여유(초) — 작게
    "WORD_GAP_TAIL_PAD": 0.13,       # 방금 끝난 단어 뒤 남기는 여유(초) — 어미 유실 방지
    "WORD_GAP_EOMI_TAIL_PAD": 0.20,  # 문장어미 뒤 여유(초) — 릴리스 긴 어미 보호

    # 음량
    "TARGET_LUFS": -14.0,
    "TARGET_PEAK_DB": -6.0,

    # 오디오 후처리 (기본 OFF — 깨끗한 녹음엔 불필요. 노이즈 많으면 켜기)
    "DENOISE": False,        # afftdn FFT 노이즈 제거 (배경 험·에어컨)
    "DEESS": False,          # deesser 치찰음(ㅅ,ㅊ) 완화

    # 추임새 — 기본 OFF. 아/어/음/뭐 등을 자르면 말맛이 사라져 부자연스러움(빵 피드백).
    # 추임새까지 타이트하게 빼려면 '공격' 프리셋을 쓴다.
    "REMOVE_FILLERS": False,
    "FILLER_SOUND_CHARS": "아어엄음으에",
    "FILLER_PHRASES": ["그러니까", "그니까", "그러니깐", "그니깐", "그까",
                       "뭐", "뭔가", "막", "약간", "좀"],
    "FILLER_PAD": 0.03,

    # 망설임 빈틈(어/음) — 기본 OFF(추임새와 함께 살림)
    "REMOVE_HESITATION": False,
    "HESITATION_MIN": 0.55,  # 짧은 어/음 꼬리(작은 어미 포함)는 보존, 긴 망설임만 컷
    "HESITATION_PAD": 0.06,

    # 숨소리/입소리 축소 — 단어 사이 '들숨/날숨·쩝(입 다심)·화이트노이즈'(노이즈성)을 제거.
    # 타이트 우선: 공격적으로 잡고, 줄인 뒤 남기는 쉼도 거의 0에 가깝게.
    "BREATH_REDUCE": True,
    "BREATH_MIN_DUR": 0.10,   # 이 길이(초) 이상 단어 간격만 검사 (짧은 입소리도 잡게 낮춤)
    "BREATH_REL_LO": -46.0,   # 말소리 기준 이만큼 아래~ (더 넓게)
    "BREATH_REL_HI": -8.0,    # ~이만큼 아래(말소리보다 조금만 작아도 노이즈면 잡게)
    "BREATH_FLATNESS": 0.28,  # 스펙트럼 평탄도(노이즈성) 임계 — 낮출수록 공격적(입소리까지)
    "BREATH_FRAC": 0.30,      # 간격에서 숨/입소리 프레임 비율이 이 이상이면 줄임
    "BREATH_KEEP": 0.04,      # 줄인 뒤 남길 쉼(초) — 거의 0 (촘촘하게)
    "BREATH_PAD": 0.02,       # 앞뒤 여유(초)

    # 늘어짐(장음) 트리밍 — "최근에~ 알게 된~" 처럼 모음을 길게 끄는 발화를
    # 음절 예산(음절수×DRAG_SYL_MAX) 기준으로 잘라 템포감 있게 붙인다.
    # 무음이 아니라 발화 자체가 늘어지는 것이라 무음컷/캡핑으로는 안 잡힘.
    # 안전장치: 실제 오디오 RMS로 발음 시작/끝을 앵커링(Whisper 침묵흡수 오차 보정),
    #           초과분이 DRAG_MIN_EXCESS 이상일 때만 발동, 숫자/영문 포함 단어는 제외.
    "TRIM_DRAG": True,        # 스팬 흡수침묵(앞/뒤) 컷 — 침묵만 잘라 안전
    # 발화 내부(모음 중간) 장음 컷 — 끄는 위치를 오디오만으로 알 수 없어
    # '일단은→일으' 같은 발음 손상이 확인됨(06 검증). 기본 OFF.
    # 진짜 장음("그럼~")은 리포트 '늘어짐 의심' 목록으로 수동 컷 참고 제공.
    "DRAG_CUT_VOWEL": False,
    "DRAG_SYL_MAX": 0.32,     # 음절당 허용 길이(초) — 이 예산 안은 정상 발화로 봄
    "DRAG_MIN_EXCESS": 0.30,  # 예산 초과가 이 이상일 때만 트리밍 (확실히 끈 것만)
    "DRAG_EOMI_EXTRA": 0.15,  # 문장어미(다/까/요/죠…) 단어는 예산 추가 (릴리스 보호)

    # 어/음 음향 검출 — voiced 지속음을 잘라 작은 어미까지 날리고 미세컷을 늘려 choppy 유발.
    # 표준/보수는 기본 OFF(자연스러움). 더 타이트하게 어/음까지 빼려면 공격 프리셋.
    "ACOUSTIC_FILLER": False,
    "ACOUSTIC_MIN_DUR": 0.28,   # 음향 어/음 최소 길이(초). 짧은 미세컷이 튀는 소리 유발 → 0.28로 절제
    # 어/음 뒤 이 시간(초) 안에 말이 이어지면 컷(=말 중간 어/음), 한참 침묵이면 보존(=문장 끝 꼬리)
    "ACOUSTIC_FOLLOW_MAX": 1.0,

    # 말더듬·중복
    "REMOVE_REPEATS": True,
    "REPEAT_GAP": 0.8,
    "FUZZY_REPEAT": True,    # 똑같은 말뿐 아니라 '비슷한 말 다시하기'(false-start)도 검출
    "FUZZY_RATIO": 0.7,      # 두 구절 유사도가 이 이상이면 앞 시도 제거

    # 문맥 기반 필러 — '좀'이 '조금'의 뜻(좀 더/좀 많이)이면 살림(과제거 방지)
    "CONTEXT_FILLER": True,

    # 받아쓰기
    "STT_MODEL": "mlx-community/whisper-large-v3-turbo",
    "VERBATIM_PROMPT": "음... 어... 그러니까, 아 그게, 좀, 뭐, 약간, 막, 그래서, 어어, 음음, 이제, 뭔가. 네, 자.",

    # 컷 다듬기 — 클릭/팝 제거는 프리미어 Cmd+Shift+D(기본 오디오 전환)로.
    # XML 페이드(키프레임)는 프리미어가 잘못 읽어 오디오를 음소거하는 버그가 있어 기본 끔.
    "AUDIO_FADE_FRAMES": 0,  # 0=끔(권장). 컷 클릭은 Cmd+Shift+D로 제거.

    # 안전망
    "MAKE_REJECTED": False,  # 잘려나간 구간만 모은 '버린 컷' 시퀀스 생성 여부 (기본 끔)
    "BACKUP_OUTPUTS": True,  # 덮어쓰기 전 이전 결과(xml/srt/report/words)를 _backup/에 보관
    "HTML_REPORT": False,     # 빵 다크 톤 시각 리포트(클릭 타임코드) HTML 생성
    "POLISH_SUBTITLES": True, # 자막 마감 + .vtt/.ass(빵 스타일) 까지 한 번에 생성
    # 자막 한 줄 길이 — 프리미어 말자막 템플릿(폰트 48)에서 2줄 래핑 방지.
    # 분할은 한국어 문법 경계(종결>연결어미>조사, 수식어 끝 금지) DP가 처리.
    "SUBTITLE_MAX_CHARS": 24,  # 한 줄 최대 글자수(공백 포함) — v3: 20자 안팎 목표
    "SUBTITLE_MIN_CHARS": 12,  # 이보다 짧으면 다음과 묶음
    "SUBTITLE_IDEAL": 20,      # 균형 분할 목표 길이 — v3
    "SUBTITLE_KEEP_WHOLE": 28, # 이 길이까지의 한 문장은 자르지 않고 통째로 — v3(기계적 자르기 방지)
    "SUBTITLE_GAP_FILL": 9999.0,  # 자막 빈 공간 금지 — 다음 자막 시작까지 무조건 연장 (컷 타임라인엔 의도된 정적이 없음)
    "SUBTITLE_IDEAL": 22,      # 균형 분할 목표 길이 (길이 균형보다 문법 경계 우선)
    "SUBTITLE_SNAP_CUT": 0.30, # 자막 전환을 컷 지점에 스냅하는 최대 거리(초)
    "SUBTITLE_NO_PERIOD": True, # 자막에서 마침표(.) 제거 — ?·!·소수점(35.8%)은 유지
    "SUBTITLE_FILL_GAPS": True, # 자막 사이 빈칸 제거 — 각 자막 끝을 다음 자막 시작까지 연장(연속 표시)

    # 컷 밀집 가드 — 이제는 '경고용'일 뿐(타이트 우선이라 촘촘함은 의도된 결과).
    # 리포트에만 표시하고 되돌리지 않는다.
    "CHOPPY_WINDOW": 8.0,    # 이 길이(초) 창 안에
    "CHOPPY_MAX": 12,        # 컷이 이 개수 이상일 때만 참고 표시 (타이트가 기본이라 상향)
}

# ── 프리셋: 표준 대비 바뀌는 값만 ──
# 방향: 표준=타이트(기본). 보수=조금 여유(그래도 옛날 표준보다 촘촘). 공격=극한.
PRESETS = {
    "보수": {   # 타이트가 부담스러울 때 — 어미/사이를 조금 더 남김 (그래도 촘촘한 편)
        "NOISE_DB": -44.0,
        "MIN_SILENCE": 0.28,
        "PAD_LEAD": 0.22,              # 끝점(어미) 더 넉넉
        "PAD_TAIL": 0.10,
        "SIBILANT_LEAD": 0.18,
        "MIN_KEEP": 0.20,
        "WORD_GAP_LEAD_PAD": 0.09,
        "WORD_GAP_TAIL_PAD": 0.16,     # 사이 조금 더 허용
        "WORD_GAP_EOMI_TAIL_PAD": 0.26,
        "TRIM_DRAG": False,            # 보수는 늘어짐도 살림
        "REPEAT_GAP": 0.5,
        "ACOUSTIC_FILLER": False,
        "FILLER_PHRASES": ["그러니까", "그니까", "그러니깐", "그니깐"],
    },
    "표준": {},  # DEFAULTS 그대로 — 타이트(촘촘·빡빡)가 기본
    "공격": {   # 극한 타이트 — 추임새/망설임/어·음까지 제거, 사이 거의 0 (단 어미 릴리스는 보호)
        "NOISE_DB": -40.0,
        "MIN_SILENCE": 0.16,
        "PAD_LEAD": 0.12,             # 타이트해도 어미 릴리스는 보호
        "PAD_TAIL": 0.07,
        "SIBILANT_LEAD": 0.13,   # 그래도 치찰음 유실은 방지
        "MIN_KEEP": 0.18,
        "WORD_GAP_LEAD_PAD": 0.05,     # 다음 단어 앞
        "WORD_GAP_TAIL_PAD": 0.10,     # 어미 유실 방지
        "WORD_GAP_EOMI_TAIL_PAD": 0.15,
        "DRAG_SYL_MAX": 0.26,          # 늘어짐도 더 타이트하게
        "DRAG_MIN_EXCESS": 0.22,
        "REMOVE_FILLERS": True,
        "REMOVE_HESITATION": True,
        "HESITATION_MIN": 0.24,
        "REPEAT_GAP": 1.0,
        "ACOUSTIC_FILLER": True,
        "FILLER_PHRASES": ["그러니까", "그니까", "그러니깐", "그니깐", "그까",
                           "뭐", "뭔가", "막", "약간", "좀",
                           "그래서", "이제", "그냥", "근데"],
    },
}


def load(preset="표준", project_dir=None):
    cfg = dict(DEFAULTS)
    cfg.update(PRESETS.get(preset, {}))
    cfg["_preset"] = preset if preset in PRESETS else "표준"

    # config.json 사용자 override
    if project_dir:
        p = os.path.join(project_dir, "config.json")
        if os.path.exists(p):
            try:
                user = json.load(open(p, encoding="utf-8"))
                user = {k: v for k, v in user.items() if not k.startswith("_")}
                cfg.update(user)
                cfg["_config_json"] = True
            except Exception as e:
                print(f"   [주의] config.json 읽기 실패({e}) — 무시")
    return cfg
