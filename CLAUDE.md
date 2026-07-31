# BangCut — Premiere Pro AI 컷편집

**구조:** 프리미어 확장 패널(`cep-panel/`, 프론트) + 이 저장소에서 실행되는 Claude Code(백엔드) + 컷편집 엔진(`engine/`).

**핵심 플로우 (컷편집 요청 시):** `cut-editing` 스킬을 사용하라.
1. 프리셋이 정해지지 않았으면 `python3 engine/analyze_video.py "영상"`으로 측정해 보수/표준/공격 추천
2. `./edit.sh "영상.mp4" [--preset ...] [--fhd]` 실행 — 무음·추임새·말더듬 제거 + -14 LUFS + 컷정렬 자막 생성
3. 결과 검수(`edit-direction` 스킬) — 과도한 컷/어미 잘림 확인
- 자막 교정만 요청받으면 `subtitle-editing` 스킬.

**결과물 위치:** 원본 영상이 있는 폴더 안의 **`BangCut/`** (`engine/out_dir.py` 규칙). `<이름>_cut.xml`(시퀀스) / `_cut_audio.wav` / `_cut.srt`(자막) / `_words.json`(전사 캐시).

**설정:** `engine/config.py`(프리셋) + `config.json`(사용자 override, gitignore). VITO 키도 `config.json`(`VITO_CLIENT_ID`/`VITO_CLIENT_SECRET`).

**BangCut 패널이 헤드리스로 호출할 때의 규칙:**
- stdout에 단계 마커를 유지하라 — 패널이 진행률 표시에 사용한다
- 사용자가 지정한 파라미터(공백 길이 수동값·전사 모델·FHD)가 프롬프트에 있으면 그대로 따르고, "자동"이면 분석 기반으로 스스로 판단하라
- 자막 검수 체크리스트(v3 지침): ① 한 자막 20자 안팎(기계적 자르기 금지) ② 조사·서술어·이어지는 표현은 같은 자막에 ③ 긴 문장은 비슷한 호흡으로 균형 분할 ④ 자막 시작이 발화보다 앞서지 않게 ⑤ 연속 발화 구간은 자막 사이 공백 없이
- 제1원칙: **타이트함 우선** — 말 사이 정적·숨·입소리는 과감히 제거하되 말 자체(특히 '-다' 어미 끝)는 온전히 보존
