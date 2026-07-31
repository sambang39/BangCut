<div align="center">

# ✂️ BangCut

**Premiere Pro 안에서 버튼 하나로 끝내는 AI 컷편집**

무음·추임새·말더듬 자동 제거 · 컷 정렬 자막 · 컷백 스타일 자막 편집기

프리미어 확장 패널(프론트) + Claude Code(백엔드) 구조

*by Sam Bang (빵실장)*

</div>

---

## 무엇을 하나요?

촬영본을 시퀀스에 올리고 BangCut 패널에서 **컷편집 시작**을 누르면:

1. 🔍 **영상 분석** — 말 빠르기·무음 비율을 측정해 알맞은 편집 강도를 스스로 결정
2. 🗣 **전사** — Whisper(무료·로컬) 또는 VITO로 단어 단위 받아쓰기
3. ✂️ **자동 컷편집** — 무음·추임새(어/음)·말더듬·반복 테이크 제거, 어미 끝점 보호
4. 🔊 **음량 정리** — -14 LUFS 통일
5. 📺 **결과 임포트** — 컷 시퀀스(XML)와 자막(SRT)이 프로젝트 창 `BangCut` 폴더로
6. 📝 **자막 편집** — 패널에서 바로 자막 검수 → 시퀀스에 캡션 트랙 삽입

## 자막 편집기 (컷백 스타일)

| | |
|---|---|
| `W` `S` / `A` `D` | 자막/단어 이동 — **프리미어 플레이헤드 실시간 연동** |
| 단어 클릭 → 한 번 더 | 그 단어만 수정 |
| 더블클릭 | 문장 전체 수정 |
| `⌘Z` / `⇧⌘Z` | 실행 취소 / 다시 실행 |
| `⌘F` | 검색/바꾸기 (단어 전체 일치·모두 바꾸기) |
| 시퀀스에 적용 | 수정본 SRT → 캡션 트랙 자동 생성 |

타임코드는 시퀀스와 동일한 `00;00;00;00` 드롭프레임 표기.

## 설치

**전제 조건**

1. **Apple Silicon 맥** (M1 이상 — 전사 엔진이 Apple Silicon 전용)
2. Premiere Pro 2022 이상
3. 클로드 **구독 계정**(로그인) 또는 **Claude API 키** 중 하나
   - 구독: [Claude Code](https://claude.com/claude-code) 설치 후 `claude` 실행 → `/login`
   - API 키: [console.anthropic.com](https://console.anthropic.com)에서 발급 (사용량 과금) — BangCut 설정에 입력
4. ffmpeg — 패널의 자동 설치가 Homebrew로 설치를 시도합니다 (없으면 `brew install ffmpeg`)

**설치 — Claude Code에 아래 한 줄을 입력하면 끝**

```
https://github.com/sambang39/BangCut.git 을 클론하고 README의 설치 절차대로 셋업해줘
```

<details>
<summary>수동 설치 절차 (Claude Code가 수행하는 내용)</summary>

```bash
git clone https://github.com/sambang39/BangCut.git
cd BangCut

# 파이썬 환경
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 미서명 확장 로드 허용
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# 확장 등록 (심볼릭 링크)
mkdir -p ~/Library/"Application Support"/Adobe/CEP/extensions
ln -sfn "$(pwd)/cep-panel" ~/Library/"Application Support"/Adobe/CEP/extensions/com.bangcut.panel
```

이후 Premiere Pro 재시작 → **창 → 확장명 → BangCut**

</details>

## 전사 모델

| 모델 | 비용 | 비고 |
|---|---|---|
| **Whisper** (기본) | 무료 | 로컬 실행, Apple Silicon 최적화(mlx) |
| **VITO** (리턴제로) | API 과금 | 한국어 정확도 ↑ — [developers.rtzr.ai](https://developers.rtzr.ai)에서 키 발급 후 패널 '설정'에 입력 |

## 구조

```
BangCut/
├── cep-panel/     # Premiere Pro CEP 확장 (프론트)
├── engine/        # 컷편집 엔진 (Python — 무음/추임새/자막/음량)
├── .claude/       # Claude Code 스킬 (컷편집·자막·검수 플로우)
├── edit.sh        # 엔진 실행 진입점
└── requirements.txt
```

- **프론트**: 패널이 시퀀스에서 소스를 감지하고 옵션(대상·공백 길이·전사 모델·FHD)을 수집
- **백엔드**: Claude Code가 영상을 분석해 파라미터를 판단하고 엔진을 실행·검수
- 엔진은 로컬에서만 동작 — 영상이 외부로 전송되지 않습니다

## 라이선스

[MIT](LICENSE)
