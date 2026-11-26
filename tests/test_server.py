"""End-to-end test of the server API with a temporary log folder:  python -m unittest discover tests"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from runboard import RunLogger  # noqa: E402
from runboard import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        logs = os.path.join(cls.tmp, "logs")
        with RunLogger(logs, name="a-s1", config={"lr": 1e-3, "net": {"depth": 4}}, total_steps=5, goal="test") as log:
            for i in range(5):
                log.log(i, {"train/loss": 1.0 / (i + 1), "eval/acc": i / 5, "bad": float("nan")})
            log.save_file("samples/x.txt", "hello")
        with RunLogger(os.path.join(logs, "group"), name="b-s2", config={"lr": 3e-4, "net": {"depth": 4}}, parent="a-s1", change="lr") as log:
            log.log(0, loss=2.0)
        args = server.argparse.Namespace(logs=logs, config=None, title=None)
        cfg, projects = server.load_config(args)
        server.Handler.app = {"config": cfg, "projects": projects}
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = "http://127.0.0.1:%d/" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp)

    def get(self, path):
        with urllib.request.urlopen(self.base + path) as r:
            return json.loads(r.read())

    def post(self, path, body, method="POST"):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_runs_and_metrics(self):
        runs = {r["name"]: r for r in self.get("api/runs")["runs"]}
        self.assertEqual(set(runs), {"a-s1", "group/b-s2"})
        self.assertEqual(runs["a-s1"]["status"], "finished")
        self.assertEqual(runs["a-s1"]["summary"]["last_step"], 4)
        m = self.get("api/runs/a-s1/metrics?since=2")
        self.assertEqual((m["total"], len(m["rows"])), (5, 3))
        self.assertIsNone(m["rows"][0]["bad"])                       # NaN is stored as null
        self.assertEqual(self.get("api/runs/group/b-s2/metrics")["total"], 1)
        self.assertEqual(self.get("api/runs/a-s1/config")["flat"]["net.depth"], 4)
        self.assertEqual((runs["group/b-s2"]["notes"]["parent"], runs["group/b-s2"]["notes"]["change"]), ("a-s1", "lr"))   # logger writes lineage
        self.assertIn("tree_sections", self.get("api/config"))

    def test_files_and_traversal(self):
        files = self.get("api/runs/a-s1/files")["files"]
        self.assertEqual([f["path"] for f in files], ["samples/x.txt"])
        with urllib.request.urlopen(self.base + "files/a-s1/-/samples/x.txt") as r:
            self.assertEqual(r.read(), b"hello")
        for bad in ("files/a-s1/-/../../etc/passwd", "files/a-s1/-/%2e%2e/%2e%2e/etc/passwd", "static/../server.py"):
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(self.base + bad)

    def test_notes_folders_board_reports(self):
        st, n = self.post("api/runs/a-s1/notes", {"star": True, "folder": "base/../x", "tags": ["t"], "color": 3,
                                                 "parent": "group/b-s2", "change": "lr 1e-3 -> 3e-4", "verdict": "ok"})
        self.assertEqual((st, n["star"], n["folder"], n["color"]), (200, True, "base/x", 3))
        self.assertEqual((n["parent"], n["change"], n["verdict"]), ("group/b-s2", "lr 1e-3 -> 3e-4", "ok"))   # 학습 트리
        self.assertEqual(self.post("api/folders", {"folders": ["z", "a/b", "a/b"]})[1]["folders"], ["a/b", "z"])
        st, rec = self.post("api/board", {"rev": 0, "doc": {"goal": "g"}})
        self.assertEqual((st, rec["rev"]), (200, 1))
        st, cur = self.post("api/board", {"rev": 0, "doc": {"goal": "stale"}})
        self.assertEqual((st, cur["doc"]["goal"]), (409, "g"))         # stale revision is refused
        st, r = self.post("api/reports", {"title": "Hello Report", "body": "# x"})
        self.assertEqual(st, 200)
        self.assertEqual(self.get("api/reports/" + r["id"])["body"], "# x")
        self.assertEqual(self.post("api/reports/" + r["id"], None, "DELETE")[0], 200)


if __name__ == "__main__":
    unittest.main()
