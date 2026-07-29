#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
out_dir.py — 결과물 저장 위치 규칙 (한 곳에서 관리)

규칙: 결과물은 도구 저장소가 아니라 **원본 영상이 있는 폴더** 안의
      `BangCut/` 폴더에 저장한다. (영상과 결과물이 함께 다니도록)

  입력:  /…/Source/영상.MP4
  결과:  /…/Source/BangCut/영상_cut.xml …

영상 폴더에 쓰기가 불가능하면(읽기전용 드라이브 등) 저장소의 output/ 으로 폴백.
"""
import os

OUT_DIRNAME = "BangCut"


def repo_output_dir():
    """저장소 안의 기존 output/ (폴백용)."""
    proj = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    d = os.path.join(proj, "output")
    os.makedirs(d, exist_ok=True)
    return d


def output_dir_for(video_path, subdir=None):
    """원본 영상 옆의 BangCut/ 결과 폴더 경로를 만들어 반환.
       subdir 지정 시 그 하위 폴더(예: 'shorts')까지 생성."""
    try:
        vdir = os.path.dirname(os.path.abspath(video_path))
        outdir = os.path.join(vdir, OUT_DIRNAME)
        os.makedirs(outdir, exist_ok=True)
        if not os.access(outdir, os.W_OK):
            raise PermissionError(outdir)
    except Exception:
        outdir = repo_output_dir()
        print("   [주의] 영상 폴더에 쓰기 불가 → 저장소 output/ 으로 폴백")
    if subdir:
        outdir = os.path.join(outdir, subdir)
        os.makedirs(outdir, exist_ok=True)
    return outdir
