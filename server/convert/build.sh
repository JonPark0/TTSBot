#!/bin/bash
# Pulsar2로 추정기·보코더를 카드용 axmodel로 빌드한다. ST_WORK 폴더에서 st_export.py export/voc4d/calib를 먼저 돌려 둘 것.
#   PULSAR2=~/p2env/ax_pulsar2_7.0_patch1_lite_package/bin/pulsar2 ST_WORK=... bash build.sh
# 결과: $ST_WORK/out_est/st_est, $ST_WORK/out_voc4d/st_voc (확장자 없이 나옴 → st_est.axmodel, st_voc.axmodel로 복사)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cd "${ST_WORK:?ST_WORK를 지정하세요}"
P=${PULSAR2:?PULSAR2 경로를 지정하세요}
for m in voc est; do
  if [ $m = est ]; then in=st_est_T96_L96.onnx; out=out_est; else in=st_voc4d_L96.onnx; out=out_voc4d; fi
  s=$(date +%s)
  $P build --input $in --config "$HERE/cfg_$m.json" --output_dir $out --output_name st_$m > build_$m.log 2>&1
  echo "BUILD $m rc=$? $(( $(date +%s) - s ))s"
done
cp out_est/st_est st_est.axmodel && cp out_voc4d/st_voc st_voc.axmodel && sha256sum st_est.axmodel st_voc.axmodel
