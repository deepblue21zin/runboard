"""RunLogger: write a run folder that Runboard can show. Standard library only, works with any training loop.

    from runboard import RunLogger

    with RunLogger("logs", name="baseline-s42", config=cfg, total_steps=1000, goal="baseline for the lr sweep") as log:
        for step in range(1000):
            ...
            log.log(step, loss=loss, **{"eval/acc": acc})      # "group/name" metrics are grouped in the dashboard
        log.save_file("samples/step1000.png", png_bytes)       # optional: images, videos, json for the files tab

Folder layout (logs/<name>/):
    meta.json       name, status (running / finished / failed / stopped), start/end time, total_steps, host, pid, command
    metrics.jsonl   one JSON object per log() call: {"step": ..., "time": ..., "<metric>": number, ...}
    config.json     the config you pass (any JSON-serialisable dict)
    notes.json      written by the dashboard (star, tags, goal, folder, notes) - created on demand
"""
import json
import math
import os
import socket
import sys
import time

__all__ = ["RunLogger"]


def _jsonable(v):
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    item = getattr(v, "item", None)           # numpy / torch scalars
    if callable(item):
        try:
            return _jsonable(item())
        except Exception:
            pass
    return str(v)


class RunLogger:
    def __init__(self, logdir, name=None, config=None, total_steps=None, goal=None, tags=None, resume=False):
        name = name or time.strftime("run-%Y%m%d-%H%M%S")
        self.dir = os.path.join(logdir, name)
        if os.path.exists(os.path.join(self.dir, "metrics.jsonl")) and not resume:
            raise FileExistsError(f"{self.dir} already has metrics.jsonl; use a new name or resume=True")
        os.makedirs(self.dir, exist_ok=True)
        self.name, self._t0 = name, time.time()
        self.meta = {"name": name, "status": "running", "start_time": self._t0, "total_steps": total_steps,
                     "host": socket.gethostname(), "pid": os.getpid(), "command": " ".join([sys.executable] + sys.argv)}
        if resume:
            old = self._read("meta.json") or {}
            self.meta = {**old, **{k: v for k, v in self.meta.items() if k != "start_time"}, "status": "running"}
        self._write("meta.json", self.meta)
        if config is not None:
            self._write("config.json", _jsonable(config))
        if goal or tags:
            notes = self._read("notes.json") or {}
            notes.update({k: v for k, v in (("goal", goal), ("tags", list(tags or []))) if v})
            self._write("notes.json", notes)
        self._f = open(os.path.join(self.dir, "metrics.jsonl"), "a", encoding="utf-8")

    # -- logging
    def log(self, step, metrics=None, **kw):
        """Append one row. Non-numeric values are dropped; NaN/inf become null."""
        row = {"step": _jsonable(step), "time": round(time.time() - self._t0, 3)}
        for k, v in {**(metrics or {}), **kw}.items():
            v = _jsonable(v)
            if isinstance(v, (int, float)) and not isinstance(v, bool) or v is None:
                row[str(k)] = v
        self._f.write(json.dumps(row) + "\n")
        self._f.flush()

    def save_file(self, relpath, data):
        """Save bytes or text inside the run folder (shown by the files plugin)."""
        p = os.path.join(self.dir, relpath)
        if not os.path.realpath(p).startswith(os.path.realpath(self.dir) + os.sep):
            raise ValueError("path must stay inside the run folder")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb" if isinstance(data, (bytes, bytearray)) else "w") as f:
            f.write(data)
        return p

    def finish(self, status="finished"):
        if self._f.closed:
            return
        self._f.close()
        self.meta.update(status=status, end_time=time.time())
        self._write("meta.json", self.meta)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is KeyboardInterrupt:
            self.finish("stopped")
        else:
            self.finish("failed" if exc_type else "finished")
        if exc_type:
            self.meta["error"] = repr(exc)[:500]
            self._write("meta.json", self.meta)
        return False

    # -- files
    def _write(self, fn, obj):
        p = os.path.join(self.dir, fn)
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(p + ".tmp", p)

    def _read(self, fn):
        try:
            with open(os.path.join(self.dir, fn), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None
