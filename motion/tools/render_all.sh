#!/bin/bash
# Render all new comps -> alpha MOV, composite boards over paper loop, deliver to Motion_v2.
set -e
LAB="/Users/apple/Desktop/Bang's Work/Coding/BangCut_Motion_Lab/keyword-pop"
OUT="/Users/apple/Desktop/Bang's Work/VideoGraphy/Youtube/보험의정석 도종민/09/(Footage)/Motion_v2"
BG="/Users/apple/Desktop/Bang's Work/VideoGraphy/_템플릿/배경소스/Loop paper Texture/11.mp4"
cd "$LAB"

for c in a4 a6 a7 a8 bb1 bb2 bb3 bb4 bb5 bb6 bb7 so1 so2 so3; do
  echo "=== render $c $(date +%H:%M:%S)"
  npx hyperframes@0.7.107 render . -c "compositions/v2/$c.html" --format mov --fps 30000/1001 -q high -o "renders/v2/$c.mov" < /dev/null
done

declare -A NAME=( [a4]=MG_T4_숫자로 [a6]=MG_T6_면책확대 [a7]=MG_T7_계약재매입 [a8]=MG_T8_현금대신할인 )
declare -A DUR=( [a4]=46.5 [a6]=28.9 [a7]=33.2 [a8]=32.8 )
for c in a4 a6 a7 a8; do
  echo "=== composite $c $(date +%H:%M:%S)"
  ffmpeg -y -stream_loop -1 -i "$BG" -i "renders/v2/$c.mov" -filter_complex \
    "[0:v]scale=1920:1080,fps=30000/1001,format=yuv420p[bg];[bg][1:v]overlay=0:0:shortest=1[v]" \
    -map "[v]" -t "${DUR[$c]}" -c:v prores_ks -profile:v 2 "$OUT/${NAME[$c]}.mov" 2>/dev/null
done

for c in bb1 bb2 bb3 bb4 bb5 bb6 bb7 so1 so2 so3; do
  cp "renders/v2/$c.mov" "$OUT/${c^^}.mov"
done
echo "ALL DONE $(date +%H:%M:%S)"
ls -la "$OUT"
