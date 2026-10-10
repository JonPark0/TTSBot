# Supertonic 3 → LLM-8850 변환 기록

`server/`가 쓰는 `st_est.axmodel`(추정기)과 `st_voc.axmodel`(보코더)을 만드는 과정입니다.
Pulsar2 7.0-patch1(lite), 대상 AX650(NPU3), U16 양자화, MinMax 보정으로 빌드했습니다.
카드에서는 추정기 8단계와 보코더가 돌고, 길이 예측기와 텍스트 인코더, rope, 오일러 갱신은 호스트 CPU에 남습니다.

## 순서

```bash
export ST_ROOT=... ST_ONNX=<supertonic-3/onnx> ST_WORK=<작업 폴더>
python st_export.py export --T 96 --L 96   # 정적 크기 추정기·보코더, rope 그래프, time_table.npy
python st_export.py voc4d  --T 96 --L 96   # 보코더 1D conv → 2D
python st_export.py check  --T 96 --L 96   # 동적 원본과 비교 (같은 잡음)
python st_export.py calib  --T 96 --L 96   # 보정 데이터 (추정기 256개, 보코더 32개)
PULSAR2=<pulsar2 경로> bash build.sh       # 보코더 약 6분, 추정기 약 35분 (CPU 1코어 기준)
```

## 그래프에서 고친 것 (Pulsar2/NPU 제약)

| 문제 | 증상 | 고친 방법 |
|---|---|---|
| 3D `Pad(mode=edge)` | 양자화 단계 오류 "Padding size … not supported for 3D input" | Slice(첫·끝 프레임) + Tile + Concat으로 대체 |
| 길이를 96으로 채운 뒤 가장자리 채움 | 정적 그래프 출력이 원본과 달라짐 | 채움 전에 패딩 프레임을 마지막 유효 프레임으로 채움 (`fill_edges`, 입력 `lat_last`·`voc_last`) |
| rope sin/cos, 시간 임베딩이 실제 길이·단계에 따라 바뀜 | 상수로 접히지 않음 | 호스트에서 계산해 입력으로 (`st_rope_T96_L96.onnx`, `time_table.npy`) |
| 보코더 1D conv | 컴파일 TileFail | 1×K 2D conv로 변환 (`voc4d`) |
| **컴파일된 `Erf`(GELU)가 NPU에서 틀림** | 양자화 참조는 cos 0.9999인데 NPU 결과는 첫 Erf에서 cos 0.02, 카드 출력이 거의 무음 | `erf(u) ≈ tanh(1.1283792·u·(1 + 0.08943·u²))`, u는 ±4로 자름 (최대 오차 3.6e-4) |

`pulsar2 run`으로 컴파일된 모델을 시뮬레이션한 결과는 카드 출력과 비트 단위로 같았습니다. 카드에 올리기 전에 시뮬레이터로 확인할 수 있습니다.

## 결과 (60문장: 한국어 표준 20, 채팅 20, 일본어 10, 영어 10, whisper-large-v3-turbo 받아쓰기)

| | 한국어 표준 CER | 한국어 채팅 CER | 일본어 CER | 영어 WER | UTMOS | 문장당 생성 |
|---|---|---|---|---|---|---|
| 원본 ONNX (CPU) | 0.0% | 3.9% | 1.7% | 1.4% | 4.00 | – |
| 정적 그래프 + Erf 근사 (CPU float, 같은 잡음) | 0.3% | 5.5% | 1.7% | 1.4% | 3.99 | – |
| 카드 추정기 + CPU 보코더 | 0.3% | 5.5% | 2.2% | 1.4% | 4.00 | 0.53초 |
| **카드 추정기 + 카드 보코더** | **0.3%** | **6.5%** | **2.2%** | **1.4%** | **3.95** | **0.18초** |

카드 결과가 같은 잡음의 float 결과와 다르게 읽힌 문장은 두 개뿐입니다. 카드 메모리(CMM)는 두 모델에 약 99 MiB를 씁니다.
