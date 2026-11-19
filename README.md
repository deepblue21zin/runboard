# Runboard

학습 실행(run)을 한곳에서 보고, 비교하고, 기록하는 가벼운 대시보드입니다.

- **설치할 것이 없습니다.** 서버와 로그 기록기는 파이썬 표준 라이브러리만 씁니다 (Python 3.8 이상).
- **어떤 학습 코드에도 붙습니다.** PyTorch, JAX, Stable-Baselines, Isaac Lab 등 무엇이든 두세 줄이면 됩니다.
- **팀이 같이 씁니다.** 즐겨찾기, 태그, 목적, 메모, 폴더, 리포트, 프로젝트 관리 보드가 서버에 저장되어 모두에게 같이 보입니다.

| 화면 | 하는 일 |
|---|---|
| 실행 | 실행 목록(검색, 상태별 보기, 폴더, 보관함), 진행률과 남은 시간, 학습 곡선(여러 실행 겹쳐 보기, 지표 묶음, 스무딩), 실행 비교 표, 설정 차이 |
| 리포트 | 마크다운으로 실험 보고서 작성. 학습 곡선을 고른 실행·지표로 바로 그래프 블록으로 넣기 |
| 프로젝트 관리 | 목표, 학습 로드맵(라운드마다 목적 → 알게 된 것 → 그래서 다음), 할 일, 결정할 것 |
| 플러그인 탭 | 프로젝트 전용 화면을 파일 하나로 추가 (예제: 실행 폴더의 이미지·영상 보기) |

## 빠른 시작

```bash
git clone <이 저장소> runboard && cd runboard
python examples/train_toy.py            # 가짜 학습 실행 3개를 logs/demo 에 만듦
python -m runboard --logs logs/demo     # http://localhost:8790 접속 (설치했다면 runboard --logs logs/demo)
```

실시간으로 갱신되는 모습을 보려면 다른 터미널에서 `python examples/train_toy.py --live`를 실행하세요.

원격 서버에서 돌릴 때는 노트북에서 터널을 열고 `http://localhost:8790`으로 접속합니다.

```bash
ssh -L 8790:localhost:8790 <서버>
```

`pip install -e .`로 설치하면 어느 폴더에서나 `python -m runboard`와 `from runboard import RunLogger`를 쓸 수 있습니다.

## 로그 남기기

```python
from runboard import RunLogger

cfg = {"model": {"width": 256}, "optim": {"lr": 1e-3}, "seed": 1}
with RunLogger("logs/myproj", name="baseline-lr1e-3-s1", config=cfg, total_steps=10_000,
               goal="기준선: 학습률 비교의 출발점") as log:
    for step in range(10_000):
        loss = train_step()
        log.log(step, {"train/loss": loss})
        if step % 500 == 0:
            log.log(step, {"eval/acc": evaluate()})
            log.save_file(f"samples/step{step}.png", png_bytes)   # 파일 탭에 나타남 (선택)
```

- **지표 이름에 `/`를 넣으면** 앞부분으로 묶여서 보입니다(`train/...`, `eval/...`). 지표를 미리 정할 필요는 없고, 기록한 이름이 그대로 나옵니다.
- **`with` 블록을 끝까지 실행하면** 상태가 `완료`로 바뀝니다. 오류가 나면 `실패`, Ctrl+C면 `중단`으로 기록됩니다.
- **기록이 끊긴 실행:** 상태가 `학습 중`인데 일정 시간(기본 10분) 새 기록이 없으면 대시보드에 `멈춤?`으로 표시됩니다.
- **이어서 학습할 때는** `resume=True`를 씁니다. 같은 이름의 폴더가 이미 있으면 기본으로는 오류를 냅니다(덮어쓰기 방지).
- **`config`** 는 JSON으로 저장할 수 있는 dict면 무엇이든 됩니다. "설정 차이" 탭에서 실행끼리 다른 값만 골라 보여 줍니다.

### 직접 파일을 쓰고 싶다면
RunLogger 없이도 아래 형식만 지키면 됩니다. 실행 하나 = 폴더 하나입니다(로그 폴더 아래 두 단계까지 찾습니다).

```
logs/myproj/baseline-s1/
├─ metrics.jsonl   한 줄에 JSON 하나: {"step": 10, "time": 12.3, "train/loss": 0.52, ...}   ← 꼭 필요
├─ meta.json       {"status": "running" | "finished" | "failed" | "stopped", "total_steps": 1000, "start_time": ...}
├─ config.json     설정 (또는 config.yaml, PyYAML이 있으면 표로 비교)
└─ (아무 파일)     이미지·영상·텍스트는 파일 탭에서 보입니다
```

`step`이 없으면 `it`, `iteration`, `epoch` 순서로 찾고, 없으면 줄 번호를 씁니다. `time`(시작 후 초)이 있으면 x축을 시간으로 바꿔 볼 수 있습니다.

## 여러 프로젝트, 설정 파일

```bash
cp runboard.example.json runboard.json   # 고친 뒤
python -m runboard --config runboard.json
```

```json
{
  "title": "우리 팀 실험",
  "projects": [
    {"key": "vision", "title": "이미지 분류", "logdir": "/data/logs/vision"},
    {"key": "rl", "title": "강화학습", "logdir": "/data/logs/rl"}
  ],
  "headline": ["eval/acc", "train/loss"],
  "stale_minutes": 10,
  "plugins": ["files"]
}
```

| 항목 | 뜻 |
|---|---|
| `projects` | 프로젝트마다 이름(`key`), 표시 이름(`title`), 로그 폴더(`logdir`). 상대 경로는 설정 파일 기준 |
| `headline` | 실행 요약 카드에 크게 보여 줄 지표. 비우면 처음 4개 |
| `stale_minutes` | 이 시간 동안 새 기록이 없으면 `멈춤?`으로 표시 |
| `plugins` | 켤 플러그인 (`runboard/static/plugins/<이름>.js`) |
| `data_dir` (프로젝트별, 선택) | 폴더 목록·리포트·관리 보드를 저장할 곳. 기본은 `<logdir>/.runboard/` |

## 대시보드 데이터는 어디에 저장되나

| 데이터 | 위치 |
|---|---|
| 즐겨찾기, 보관, 태그, 목적, 메모, 폴더, 그래프 색 | 각 실행 폴더의 `notes.json` |
| 빈 폴더 목록 | `<logdir>/.runboard/folders.json` |
| 리포트 | `<logdir>/.runboard/reports/<id>.json` |
| 리포트에 넣을 이미지 | `<logdir>/.runboard/reports/assets/` 에 파일을 두고 `![설명](report-assets/파일이름.png)` |
| 프로젝트 관리 보드 | `<logdir>/.runboard/board.json` (동시에 고치면 나중 저장이 거절되고 최신 내용을 다시 불러옴) |

서버를 실행하는 사용자가 로그 폴더에 쓸 수 있어야 이 기능들이 저장됩니다.

## 리포트의 그래프 블록

리포트 편집기의 "그래프 블록 만들기"로 고른 실행·지표의 학습 곡선을 넣을 수 있습니다. 직접 쓸 때는 이 형식입니다.

````markdown
```chart
{"title": "그림 1. 검증 정확도", "caption": "설명", "x": {"label": "step"},
 "panels": [{"title": "eval/acc", "unit": "%", "better": "up", "y": {"min": 0, "max": 100},
   "series": [{"name": "baseline", "color": 1, "points": [[0, 10], [100, 55]]},
              {"name": "lr3e-4", "color": 2, "dash": true, "points": [[0, 8], [100, 40]]}],
   "refs": [{"y": 90, "label": "목표 90%"}]}]}
```
````

- `type: "scatter"`면 점 그래프가 됩니다.
- `color`는 1~8(팔레트), 0(회색 기준선)입니다.
- `region: {"x": [a, b], "y": [c, d], "label": "목표"}`로 영역을 칠할 수 있고, `xrefs`로 세로 기준선을 넣을 수 있습니다.
- 리포트 안의 HTML은 글자로 표시됩니다(스크립트 실행 방지).

## 플러그인 만들기

프로젝트 전용 탭이 필요하면 `runboard/static/plugins/<이름>.js` 파일 하나를 만들고 설정의 `plugins`에 이름을 넣습니다.

```js
Runboard.registerTab({
  id: "samples",
  title: "예측 샘플",
  async render(el, { run, selected, api, esc }) {
    // run: 지금 고른 실행, selected: 비교로 체크한 실행들
    const { files } = await api.files(run.name);
    el.innerHTML = files.filter((f) => f.path.startsWith("pred/"))
      .map((f) => `<img src="${api.fileUrl(run.name, f.path)}" alt="${esc(f.path)}">`).join("");
  },
});
```

`api`에는 `runs()`, `metrics(name, since)`, `runConfig(name)`, `files(name)`, `fileUrl(name, path)`가 있습니다. 예제는 `runboard/static/plugins/files.js`를 보세요.

## 주의

- **로그인 기능이 없습니다.** 기본으로 `127.0.0.1`에서만 열리고, `--host 0.0.0.0`은 믿을 수 있는 내부망에서만 쓰세요. 원격에서는 SSH 터널을 권장합니다.
- **인터넷 연결이 필요합니다.** 화면이 Chart.js(그래프), marked(마크다운), 글꼴을 CDN에서 불러옵니다. 오프라인에서는 그래프와 리포트 렌더링이 안 됩니다.
- **GPU 표시:** `nvidia-smi`가 있으면 머리글에 GPU 사용량이 나옵니다. 없으면 숨겨집니다.

## 개발

```bash
python -m unittest discover tests      # 서버 API 시험 (임시 폴더 사용)
```

```
runboard/
├─ server.py          HTTP 서버와 데이터 저장 (표준 라이브러리만)
├─ logger.py          RunLogger
└─ static/
   ├─ index.html, app.js, app.css   화면 (빌드 과정 없음)
   └─ plugins/files.js              예제 플러그인
examples/train_toy.py               예제 학습
tests/test_server.py                API 시험
```
