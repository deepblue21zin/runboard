"""Runboard server: a small HTTP server for the dashboard (Python standard library only).

    python -m runboard --logs ./logs                 # one project from a log folder
    python -m runboard --config runboard.json        # several projects, plugins, settings

Every run is a folder that holds metrics.jsonl (written by runboard.logger.RunLogger or by hand).
Dashboard data that people edit (notes, folders, reports, the project board) is stored next to the runs
(notes.json in each run folder) and in the data folder (default: <logs>/.runboard/<project>/).
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
NAME_RE = re.compile(r"^[A-Za-z0-9._\-][A-Za-z0-9._\-+=@ ]{0,199}$")
REPORT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
ASSET_RE = re.compile(r"^[A-Za-z0-9._\-]{1,120}$")
MEDIA_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm", ".json", ".txt", ".csv", ".log", ".md"}
DEFAULTS = {"title": "Runboard", "stale_minutes": 10, "plugins": ["files"], "headline": [], "projects": [],
            "tree_sections": []}   # 학습 트리: [{"title": "MuSHR", "match": "^visual"}, ...] (run-name regex)


# ----------------------------------------------------------------------------------------------- helpers

def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def inside(root, path):
    root, path = os.path.realpath(root), os.path.realpath(path)
    return path == root or path.startswith(root + os.sep)


def clean_folder(name):
    """Folder path such as 'baseline' or 'ablation/lr' ('' = no folder)."""
    parts = [re.sub(r"[\x00-\x1f\\]+", "", p).strip()[:60] for p in str(name or "").split("/")]
    return "/".join(p for p in parts if p and p not in (".", ".."))[:200]


class MetricsCache:
    """metrics.jsonl rows per file, re-read only when the file grows or changes."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}

    def rows(self, path):
        try:
            st = os.stat(path)
        except OSError:
            return []
        with self.lock:
            hit = self.cache.get(path)
            if hit and hit["mtime"] == st.st_mtime and hit["size"] == st.st_size:
                return hit["rows"]
            rows, offset = (hit["rows"], hit["offset"]) if hit and st.st_size >= hit["offset"] else ([], 0)
            rows = list(rows)
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read()
            # keep a trailing partial line for the next read
            end = data.rfind(b"\n") + 1
            for line in data[:end].splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
            self.cache[path] = {"mtime": st.st_mtime, "size": st.st_size, "offset": offset + end, "rows": rows}
            return rows


def step_of(row, i):
    for k in ("step", "it", "iteration", "epoch"):
        if isinstance(row.get(k), (int, float)):
            return row[k]
    return i


def flatten(d, prefix=""):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(d, list) and len(d) <= 50 and all(not isinstance(x, (dict, list)) for x in d):
        out[prefix] = d
    elif isinstance(d, list):
        for i, v in enumerate(d[:200]):
            out.update(flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = d
    return out


# ----------------------------------------------------------------------------------------------- data

class Project:
    def __init__(self, key, title, logdir, data_dir, metrics, stale_minutes):
        self.key, self.title = key, title
        self.logdir = os.path.realpath(logdir)
        self.data = os.path.realpath(data_dir)
        self.metrics = metrics
        self.stale_s = stale_minutes * 60
        self.lock = threading.Lock()

    # runs
    def run_dirs(self):
        out = {}
        if not os.path.isdir(self.logdir):
            return out
        for root, dirs, files in os.walk(self.logdir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            depth = os.path.relpath(root, self.logdir).count(os.sep)
            if "metrics.jsonl" in files or "meta.json" in files:
                name = os.path.relpath(root, self.logdir).replace(os.sep, "/")
                if name != ".":
                    out[name] = root
                dirs[:] = []           # a run folder is not searched further
            elif depth >= 2:
                dirs[:] = []
        return out

    def run_dir(self, name):
        name = name.strip("/")
        if not name or ".." in name.split("/"):
            return None
        d = os.path.join(self.logdir, *name.split("/"))
        return d if inside(self.logdir, d) and os.path.isdir(d) else None

    def run_info(self, name, d):
        meta = read_json(os.path.join(d, "meta.json"), {}) or {}
        notes = read_json(os.path.join(d, "notes.json"), {}) or {}
        mpath = os.path.join(d, "metrics.jsonl")
        rows = self.metrics.rows(mpath)
        try:
            updated = os.path.getmtime(mpath)
        except OSError:
            updated = meta.get("updated_time") or meta.get("start_time")
        status = meta.get("status") or ("running" if rows else "unknown")
        if status == "running" and updated and time.time() - updated > self.stale_s:
            status = "stale"
        last = {}
        for row in rows[-20:]:
            for k, v in row.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    last[k] = v
        return {"name": name, "status": status, "meta": meta, "notes": notes, "updated_time": updated,
                "summary": {"rows": len(rows), "last_step": step_of(rows[-1], len(rows) - 1) if rows else None,
                            "total_steps": meta.get("total_steps"), "last": last}}

    def runs(self):
        out = [self.run_info(n, d) for n, d in self.run_dirs().items()]
        out.sort(key=lambda r: r.get("updated_time") or 0, reverse=True)
        return out

    def config(self, d):
        for fn in ("config.json", "params.json", "args.json"):
            cfg = read_json(os.path.join(d, fn))
            if cfg is not None:
                return {"file": fn, "flat": flatten(cfg)}
        for fn in ("config.yaml", "config.yml", "hparams.yaml"):
            p = os.path.join(d, fn)
            if os.path.exists(p):
                text = open(p, encoding="utf-8", errors="replace").read()[:500_000]
                try:
                    import yaml  # optional
                    return {"file": fn, "flat": flatten(yaml.safe_load(text))}
                except Exception:
                    return {"file": fn, "text": text}
        return {"file": None, "flat": {}}

    def files(self, d, limit=500):
        out = []
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if not x.startswith(".")]
            if os.path.relpath(root, d).count(os.sep) >= 3:
                dirs[:] = []
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in MEDIA_EXT or fn in ("metrics.jsonl", "meta.json", "notes.json", "config.json"):
                    continue
                p = os.path.join(root, fn)
                st = os.stat(p)
                out.append({"path": os.path.relpath(p, d).replace(os.sep, "/"), "size": st.st_size, "mtime": st.st_mtime})
                if len(out) >= limit:
                    return out
        out.sort(key=lambda f: f["path"])
        return out

    # dashboard data
    def path(self, *parts):
        return os.path.join(self.data, *parts)

    def folders(self):
        return (read_json(self.path("folders.json"), {}) or {}).get("folders", [])

    def save_folders(self, names):
        names = sorted({f for f in (clean_folder(x) for x in names) if f})[:500]
        write_json(self.path("folders.json"), {"folders": names, "updated": time.time()})
        return names

    def board(self):
        return read_json(self.path("board.json"), {"rev": 0, "doc": {}}) or {"rev": 0, "doc": {}}

    def save_board(self, rev, doc):
        with self.lock:
            cur = self.board()
            if int(rev) != int(cur.get("rev") or 0):
                return None, cur
            rec = {"rev": int(cur.get("rev") or 0) + 1, "updated": time.time(), "doc": doc}
            write_json(self.path("board.json"), rec)
            return rec, None

    def reports(self):
        d = self.path("reports")
        out = []
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.endswith(".json"):
                    r = read_json(os.path.join(d, fn))
                    if r:
                        out.append({k: r.get(k) for k in ("id", "title", "author", "created", "updated")})
        out.sort(key=lambda r: r.get("updated") or 0, reverse=True)
        return out

    def report_path(self, rid):
        return self.path("reports", rid + ".json") if REPORT_ID_RE.match(rid or "") else None

    def save_report(self, rid, data):
        now = time.time()
        if rid is None:
            base = re.sub(r"[^a-z0-9]+", "-", str(data.get("title", "")).lower()).strip("-")[:40] or "report"
            rid = time.strftime("%Y%m%d-%H%M%S-") + base
        p = self.report_path(rid)
        if p is None:
            raise ValueError("bad report id")
        old = read_json(p, {}) or {}
        rec = {"id": rid, "title": str(data.get("title") or old.get("title") or "Untitled")[:200],
               "author": str(data.get("author", old.get("author")) or "")[:80],
               "created": old.get("created") or now, "updated": now, "body": str(data.get("body") or "")[:1_000_000]}
        write_json(p, rec)
        return rec


# ----------------------------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    app = None  # set in serve()
    server_version = "Runboard/1.0"

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- responses
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, default=str, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.send_json({"error": message}, status)

    def send_file(self, path, cache=False):
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def body(self, limit):
        n = int(self.headers.get("Content-Length", "0"))
        if n > limit:
            raise ValueError("body too large")
        data = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def project(self):
        q = parse_qs(urlparse(self.path).query).get("project", [""])[0]
        return self.app["projects"].get(q) or next(iter(self.app["projects"].values()))

    # -- routes
    def do_GET(self):
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.strip("/").split("/") if p]
        query = parse_qs(url.query)
        try:
            if not parts:
                return self.send_file(os.path.join(STATIC, "index.html"))
            if parts[0] == "static" and len(parts) >= 2:
                p = os.path.join(STATIC, *parts[1:])
                if not inside(STATIC, p) or not os.path.isfile(p):
                    return self.error(HTTPStatus.NOT_FOUND, "not found")
                return self.send_file(p)
            if parts == ["api", "config"]:
                cfg = self.app["config"]
                projects = []
                for k, pr in self.app["projects"].items():
                    runs = pr.runs()
                    projects.append({"key": k, "title": pr.title, "logdir": pr.logdir, "runs": len(runs),
                                     "running": sum(1 for r in runs if r["status"] == "running")})
                return self.send_json({"title": cfg["title"], "projects": projects, "plugins": cfg["plugins"],
                                       "headline": cfg["headline"], "stale_minutes": cfg["stale_minutes"],
                                       "tree_sections": cfg.get("tree_sections") or [], "now": time.time()})
            pr = self.project()
            if parts == ["api", "runs"]:
                return self.send_json({"project": pr.key, "logdir": pr.logdir, "now": time.time(), "runs": pr.runs()})
            if len(parts) >= 4 and parts[:2] == ["api", "runs"]:
                name, what = "/".join(parts[2:-1]), parts[-1]
                d = pr.run_dir(name)
                if d is None:
                    return self.error(HTTPStatus.NOT_FOUND, f"run not found: {name}")
                if what == "metrics":
                    rows = pr.metrics.rows(os.path.join(d, "metrics.jsonl"))
                    since = max(0, int(query.get("since", ["0"])[0]))
                    return self.send_json({"total": len(rows), "since": since, "rows": rows[since:]})
                if what == "config":
                    return self.send_json(pr.config(d))
                if what == "files":
                    return self.send_json({"files": pr.files(d)})
                return self.error(HTTPStatus.NOT_FOUND, "unknown endpoint")
            if parts[0] == "files" and len(parts) >= 3:
                # /files/<run...>/-/<path...>: '-' separates a nested run name from the file path
                if "-" in parts[1:]:
                    i = parts.index("-", 1)
                    name, rel = "/".join(parts[1:i]), parts[i + 1:]
                else:
                    name, rel = parts[1], parts[2:]
                d = pr.run_dir(name)
                p = os.path.join(d, *rel) if d and rel else None
                if not p or not inside(d, p) or not os.path.isfile(p):
                    return self.error(HTTPStatus.NOT_FOUND, "file not found")
                return self.send_file(p)
            if parts == ["api", "folders"]:
                return self.send_json({"folders": pr.folders()})
            if parts == ["api", "board"]:
                return self.send_json(pr.board())
            if parts == ["api", "reports"]:
                return self.send_json({"reports": pr.reports()})
            if len(parts) == 3 and parts[:2] == ["api", "reports"]:
                p = pr.report_path(parts[2])
                rec = read_json(p) if p else None
                return self.send_json(rec) if rec else self.error(HTTPStatus.NOT_FOUND, "report not found")
            if len(parts) == 2 and parts[0] == "report-assets" and ASSET_RE.match(parts[1]):
                p = pr.path("reports", "assets", parts[1])
                return self.send_file(p, cache=True) if os.path.isfile(p) else self.error(HTTPStatus.NOT_FOUND, "asset not found")
            if parts == ["api", "gpus"]:
                return self.send_json({"gpus": gpus(), "time": time.time()})
            return self.error(HTTPStatus.NOT_FOUND, "not found")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/") if p]
        pr = self.project()
        try:
            if len(parts) >= 4 and parts[:2] == ["api", "runs"] and parts[-1] == "notes":
                d = pr.run_dir("/".join(parts[2:-1]))
                if d is None:
                    return self.error(HTTPStatus.NOT_FOUND, "run not found")
                data = self.body(1 << 16)
                color = data.get("color")
                notes = {"star": bool(data.get("star")), "archived": bool(data.get("archived")),
                         "tags": [str(t)[:40] for t in data.get("tags", []) if str(t).strip()][:20],
                         "goal": str(data.get("goal", ""))[:300], "note": str(data.get("note", ""))[:10000],
                         "folder": clean_folder(data.get("folder", "")),
                         # 학습 트리: which run this one came from, what was changed, and the verdict
                         "parent": str(data.get("parent") or "")[:200], "change": str(data.get("change") or "")[:500],
                         "verdict": str(data.get("verdict") or "")[:2000],
                         # ideas taken from other runs (not the parent): [{"from": run, "note": text}], and the
                         # runs the project finally compares (badge + "final comparison" block in the shared file)
                         "borrowed": [{"from": str(b.get("from") or "")[:200], "note": str(b.get("note") or "")[:300]}
                                      for b in (data.get("borrowed") or []) if isinstance(b, dict) and b.get("from")][:10],
                         "final": bool(data.get("final")),
                         "color": int(color) if str(color or "").isdigit() and 1 <= int(color) <= 8 else None,
                         "updated_time": time.time()}
                write_json(os.path.join(d, "notes.json"), notes)
                return self.send_json(notes)
            if parts == ["api", "folders"]:
                return self.send_json({"folders": pr.save_folders(self.body(1 << 18).get("folders", []))})
            if parts == ["api", "board"]:
                data = self.body(8 << 20)
                if not isinstance(data.get("doc"), dict):
                    return self.error(HTTPStatus.BAD_REQUEST, "body must be {rev, doc}")
                rec, cur = pr.save_board(data.get("rev", -1), data["doc"])
                if rec is None:
                    return self.send_json({"error": "다른 화면에서 먼저 저장했습니다. 최신 내용을 불러왔습니다.", **cur}, HTTPStatus.CONFLICT)
                return self.send_json(rec)
            if parts[:2] == ["api", "reports"] and len(parts) in (2, 3):
                return self.send_json(pr.save_report(parts[2] if len(parts) == 3 else None, self.body(4 << 20)))
            return self.error(HTTPStatus.NOT_FOUND, "not found")
        except PermissionError:
            return self.error(HTTPStatus.FORBIDDEN, "쓰기 권한이 없습니다. 로그 폴더를 쓸 수 있는 사용자로 서버를 실행하세요.")
        except (ValueError, TypeError) as e:
            return self.error(HTTPStatus.BAD_REQUEST, str(e))

    def do_DELETE(self):
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/") if p]
        pr = self.project()
        if len(parts) == 3 and parts[:2] == ["api", "reports"]:
            p = pr.report_path(parts[2])
            if p and os.path.exists(p):
                os.remove(p)
                return self.send_json({"deleted": parts[2]})
            return self.error(HTTPStatus.NOT_FOUND, "report not found")
        return self.error(HTTPStatus.NOT_FOUND, "not found")


def gpus():
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    res = []
    for line in out.strip().splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) >= 6:
            try:
                res.append({"index": int(p[0]), "name": p[1], "used": int(p[2]), "total": int(p[3]), "util": int(p[4]), "temp": int(p[5])})
            except ValueError:
                pass
    return res


# ----------------------------------------------------------------------------------------------- startup

def load_config(args):
    cfg = dict(DEFAULTS)
    base = os.getcwd()
    if args.config:
        user = read_json(args.config)
        if user is None:
            raise SystemExit(f"[runboard] cannot read config: {args.config}")
        cfg.update(user)
        base = os.path.dirname(os.path.abspath(args.config))
    if args.logs:
        cfg["projects"] = [{"key": os.path.basename(os.path.abspath(args.logs)) or "default", "logdir": args.logs}]
    if not cfg["projects"]:
        raise SystemExit("[runboard] no project: pass --logs <folder> or --config runboard.json")
    if args.title:
        cfg["title"] = args.title
    projects, metrics = {}, MetricsCache()
    for p in cfg["projects"]:
        key = re.sub(r"[^A-Za-z0-9_-]+", "-", str(p.get("key") or "default"))
        logdir = os.path.join(base, p["logdir"]) if not os.path.isabs(p["logdir"]) else p["logdir"]
        data = p.get("data_dir") or os.path.join(logdir, ".runboard")
        data = os.path.join(base, data) if not os.path.isabs(data) else data
        projects[key] = Project(key, p.get("title") or key, logdir, data, metrics, cfg["stale_minutes"])
    plugins = []
    for name in cfg.get("plugins") or []:
        if re.match(r"^[a-z0-9_-]+$", name) and os.path.isfile(os.path.join(STATIC, "plugins", name + ".js")):
            plugins.append(name)
        else:
            print(f"[runboard] plugin not found, skipped: {name}")
    cfg["plugins"] = plugins
    return cfg, projects


def main(argv=None):
    ap = argparse.ArgumentParser(prog="runboard", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--logs", help="Log folder of one project (each run = a subfolder with metrics.jsonl)")
    ap.add_argument("--config", help="runboard.json with several projects and settings")
    ap.add_argument("--title", help="Title shown in the header")
    ap.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 to allow other machines (no login: trusted networks only)")
    ap.add_argument("--port", type=int, default=8790)
    args = ap.parse_args(argv)
    cfg, projects = load_config(args)
    Handler.app = {"config": cfg, "projects": projects}
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    for p in projects.values():
        print(f"[runboard] project '{p.key}': runs in {p.logdir}, dashboard data in {p.data}")
    print(f"[runboard] open http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
