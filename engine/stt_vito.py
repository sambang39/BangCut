#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stt_vito.py — 리턴제로(RTZR) VITO STT API 연동.

한국어 특화 전사(컷백류와 같은 계열)로 Whisper 대비 맞춤법·고유명사 품질 개선.
키는 프로젝트 루트 config.json 의 VITO_CLIENT_ID / VITO_CLIENT_SECRET (gitignore됨).

사용(단독 테스트):
  python3 stt_vito.py "<영상또는오디오>"          # 전사 → _vito.json + 텍스트 출력
"""
import sys, os, json, time, subprocess

API = "https://openapi.vito.ai/v1"
FFMPEG = os.path.expanduser("~/bin/ffmpeg")
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"


def load_keys():
    proj = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = os.path.join(proj, "config.json")
    if not os.path.exists(p):
        raise RuntimeError("config.json 없음 — VITO 키를 넣어주세요")
    cfg = json.load(open(p, encoding="utf-8"))
    cid, sec = cfg.get("VITO_CLIENT_ID", ""), cfg.get("VITO_CLIENT_SECRET", "")
    if not cid or "붙여넣기" in cid or not sec or "붙여넣기" in sec:
        raise RuntimeError("config.json 에 VITO_CLIENT_ID/SECRET 이 아직 비어있음")
    return cid, sec


def auth():
    import requests
    cid, sec = load_keys()
    r = requests.post(f"{API}/authenticate",
                      data={"client_id": cid, "client_secret": sec}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def extract_audio(video, out_m4a):
    """업로드용 저용량 오디오(64k 모노 m4a) 추출 — 15분에 ~7MB."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-y", "-i", video,
                        "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", out_m4a],
                       capture_output=True, text=True)
    return os.path.exists(out_m4a) and os.path.getsize(out_m4a) > 0


def transcribe(audio_path, token, keywords=None):
    """파일 전사 요청 → 폴링 → 결과 JSON 반환."""
    import requests
    config = {
        "model_name": "sommers",          # 한국어 특화 모델
        "language": "ko",
        "use_itn": True,                  # 숫자/단위 표기 정규화 (35.8% 등)
        "use_disfluency_filter": False,   # 원말 그대로 (컷 마커 '컷' 보존)
        "use_paragraph_splitter": False,
        "use_word_timestamp": True,       # 단어 타임스탬프 (컷편집 연동 대비)
    }
    if keywords:
        config["keywords"] = keywords
    with open(audio_path, "rb") as f:
        r = requests.post(f"{API}/transcribe",
                          headers={"Authorization": f"Bearer {token}"},
                          data={"config": json.dumps(config, ensure_ascii=False)},
                          files={"file": (os.path.basename(audio_path), f)},
                          timeout=300)
    if r.status_code == 400 and keywords:
        # keywords 형식 미지원 등 — 키워드 없이 재시도
        return transcribe(audio_path, token, keywords=None)
    r.raise_for_status()
    tid = r.json()["id"]
    print(f"   전사 요청됨 (id {tid}) — 처리 대기 중...")
    while True:
        time.sleep(5)
        g = requests.get(f"{API}/transcribe/{tid}",
                         headers={"Authorization": f"Bearer {token}"}, timeout=30)
        g.raise_for_status()
        j = g.json()
        st = j.get("status")
        if st == "completed":
            return j
        if st == "failed":
            raise RuntimeError(f"VITO 전사 실패: {j}")


def to_words(result):
    """결과 JSON → 엔진 표준 [(start, end, text)] (초 단위).
       단어 타임스탬프가 있으면 단어 단위, 없으면 발화 단위로 폴백."""
    words = []
    for u in result.get("results", {}).get("utterances", []):
        w_list = u.get("words") or u.get("word_timestamps")
        if w_list:
            for w in w_list:
                s = w.get("start_at", w.get("start", 0)) / 1000.0
                d = w.get("duration", w.get("dur", 0)) / 1000.0
                txt = w.get("text", w.get("word", w.get("msg", "")))
                words.append((round(s, 3), round(s + d, 3), txt))
        else:
            s = u.get("start_at", 0) / 1000.0
            d = u.get("duration", 0) / 1000.0
            words.append((round(s, 3), round(s + d, 3), u.get("msg", "")))
    return words


def main():
    if len(sys.argv) < 2:
        print('사용: python3 stt_vito.py "<영상또는오디오>"'); sys.exit(1)
    src = sys.argv[1]
    if not os.path.exists(src):
        print("파일 없음:", src); sys.exit(1)

    from out_dir import output_dir_for
    outdir = output_dir_for(src)
    base = os.path.splitext(os.path.basename(src))[0]

    ext = os.path.splitext(src)[1].lower()
    if ext in (".mp4", ".mov", ".m4v", ".mkv"):
        audio = os.path.join(outdir, base + "_vito_upload.m4a")
        print("> 업로드용 오디오 추출 중...")
        if not extract_audio(src, audio):
            print("오디오 추출 실패"); sys.exit(2)
        print(f"   {os.path.getsize(audio)//1024//1024}MB")
    else:
        audio = src

    print("> VITO 인증...")
    token = auth()
    print("> VITO 전사 중... (한국어 특화 sommers)")
    t0 = time.time()
    result = transcribe(audio, token)
    print(f"   완료 ({time.time()-t0:.0f}초)")

    raw_out = os.path.join(outdir, base + "_vito_raw.json")
    json.dump(result, open(raw_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    words = to_words(result)
    words_out = os.path.join(outdir, base + "_vito_words.json")
    json.dump(words, open(words_out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"   단어/발화 {len(words)}개 → {os.path.basename(words_out)} (원본: {os.path.basename(raw_out)})")
    print("\n=== 전사 미리보기 (앞 15발화) ===")
    for u in result.get("results", {}).get("utterances", [])[:15]:
        print(f"  [{u.get('start_at',0)/1000:6.1f}s] {u.get('msg','')}")


if __name__ == "__main__":
    main()
