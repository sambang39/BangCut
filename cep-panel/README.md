# BangCut — Premiere Pro CEP 패널

빵(Sam Bang)의 자동 컷편집 파이프라인 전용 프리미어 확장 패널.
플로우: **① 자동 컷편집(무음 제거) → ② 자막 편집 → 시퀀스에 적용**

## 열기

프리미어 재시작 후 **창(Window) → 확장명(Extensions) → BangCut**

## 화면 구성

### 홈
- 스텝 1 · 자동 컷편집 → 컷편집 설정 화면
- 스텝 2 · 자막 편집 — 활성 시퀀스의 소스 영상에서 엔진 결과물(`<원본 폴더>/BangCut/<base>_cut.srt`, `_edit` 우선)을 자동 감지해 연결. [SRT 직접 열기]도 지원

### 자동 컷편집 설정
- 컷편집 대상: 선택한 클립 / V1 트랙 전체 / In/Out 구간(엔진 구간 지원 전까지 소스 전체 기준) — 감지 상태 표시
- 공백 길이 프리셋: 매우 짧게 / 짧게 / 중간 / 길게 — 선택 시 잘림 예시 웨이브폼 변화
- 상세: 말 끝나고 남길 여백(PAD_LEAD) / 최소 공백 제거 길이(MIN_SILENCE) / 다음 말 시작 전 여백(PAD_TAIL)
- FHD 출력 토글(`--fhd`), 설정은 `~/Library/Application Support/BangCut/settings.json`에 저장
- **`컷편집 시작` = 패널에서 엔진 실행** — 실행 직전 저장소 `config.json`에 설정 3종 병합, `/bin/bash edit.sh <소스> [--fhd]`를 소스별 순차 실행, 진행 로그 표시, 완료 시 자막 자동 연결. [중단] 버튼 지원

### 자막 편집 (컷백식 단어 내비게이션)

| 동작 | 방법 |
|---|---|
| 단어 이동 | `A`/`D` (자막 경계 넘어감) — **플레이헤드 실시간 연동** |
| 자막 이동 | `W`/`S` — 플레이헤드 연동 |
| 단어 선택 | 단어 클릭 (포인트된 단어만 파랗게 하이라이트) |
| 단어 수정 | 포인트된 단어 **한 번 더 클릭** 또는 `Enter` → 단어만 수정 박스 |
| 문장 수정 | **더블클릭** → 문장 전체 수정 박스 (드래그 선택·삭제·타이핑) |
| 줄 나누기 | 문장 수정 중 커서 위치에서 `Enter`, 또는 [나누기](포인트 단어 앞) |
| 위/아래와 병합 | `▲`/`▼`, 액션 바 버튼, 문장 수정 중 맨 앞 `Backspace` |
| 실행 취소 / 다시 실행 | 버튼 또는 `⌘Z` / `⇧⌘Z` |
| 검색/바꾸기 | 돋보기 또는 `⌘F` — **우측 드로어**: 단어 전체 일치·바꾸기 토글, 결과 리스트 클릭 시 점프 |
| 저장 | `⌘S` — `<base>_edit.srt`로 저장(원본 보존), 줄 끝 마침표 자동 제거(?! 유지) |
| 시퀀스에 적용 | 저장 → SRT 임포트 → 활성 시퀀스에 캡션 트랙 생성 |

- 타임코드는 시퀀스 트랙과 동일 포맷(`00;00;00;00`, 시퀀스 fps 기반 드롭프레임 자동 판별)
- 한 줄 40자 초과 시 경고 표시

## 설치 상태 (이 맥에 설정 완료)

- 심볼릭 링크: `~/Library/Application Support/Adobe/CEP/extensions/com.bangcut.panel` → 이 폴더
- PlayerDebugMode: `com.adobe.CSXS.11/12`에 `1` (미서명 패널 로드용)
- 안 보이면: 프리미어 완전 재시작 → `killall cfprefsd` 후 재시작

## 디버깅

패널 연 상태에서 Chrome → `http://localhost:8095`

## 구조

```
cep-panel/
├── CSXS/manifest.xml   # CEP 9, id com.bangcut.panel, 메뉴 "BangCut"
├── .debug              # 원격 디버그 포트 8095
├── index.html          # 3화면(홈/컷편집 설정/자막 편집) UI
├── js/core.js          # SRT·타임코드(DF)·이력·프리셋 (DOM 비의존, node로 테스트 가능)
├── js/main.js          # UI 로직, CEP 브리지, 키 등록(registerKeyEventsInterest)
├── jsx/host.jsx        # bangGetSeqInfo / bangSetPlayerPosition / bangApplySrt
└── PLAN.md             # 수정 계획서 (진행 상태 관리)
```

## 로드맵 (PLAN.md 참고)

- 2차: 패널에서 엔진 실행(진행 로그·결과 자동 연결), `_words.json` 기반 단어 단위 내비게이션, VITO/LLM 연동
