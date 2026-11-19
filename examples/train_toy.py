"""Make a few fake training runs so you can try the dashboard right away (no GPU, no extra packages).

    python examples/train_toy.py            # writes ./logs/demo/<run>
    python -m runboard --logs logs/demo     # open http://localhost:8790

Each run "trains" for a few hundred steps with a different learning rate and seed, logs grouped metrics
(train/..., eval/...), saves its config, and writes a small SVG "sample" every 100 steps (files tab).
Pass --live to keep one run going slowly so you can watch it update.
"""
import argparse
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from runboard import RunLogger  # noqa: E402


def sample_svg(step, acc):
    w = int(20 + 260 * acc)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80" viewBox="0 0 300 80">'
            f'<rect width="300" height="80" fill="#eef1f4"/><rect x="10" y="30" width="{w}" height="20" fill="#2a78d6"/>'
            f'<text x="10" y="20" font-family="monospace" font-size="12">step {step}  acc {acc:.3f}</text></svg>')


def fake_run(logdir, name, lr, seed, steps, delay=0.0, goal=None):
    rnd = random.Random(seed)
    cfg = {"model": {"width": 128, "depth": 4}, "optim": {"name": "adam", "lr": lr}, "seed": seed, "steps": steps}
    with RunLogger(logdir, name=name, config=cfg, total_steps=steps, goal=goal, resume=True) as log:
        loss, acc = 2.5, 0.1
        for step in range(steps):
            speed = min(1.0, lr / 1e-3)
            loss = max(0.05, loss * (1 - 0.01 * speed) + rnd.gauss(0, 0.02))
            acc = min(0.99, acc + (0.95 - acc) * 0.008 * speed + rnd.gauss(0, 0.004))
            row = {"train/loss": loss, "train/grad_norm": abs(rnd.gauss(1.0 / (1 + step / 200), 0.1)), "lr": lr * (0.5 + 0.5 * math.cos(math.pi * step / steps))}
            if step % 10 == 0:
                row["eval/acc"] = acc
                row["eval/loss"] = loss * 1.1 + rnd.gauss(0, 0.03)
            log.log(step, row)
            if step % 100 == 0:
                log.save_file(f"samples/step{step:04d}.svg", sample_svg(step, acc))
            if delay:
                time.sleep(delay)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logdir", default="logs/demo")
    ap.add_argument("--live", action="store_true", help="keep one extra run going (0.5 s per step)")
    a = ap.parse_args()
    for name, lr, seed in (("baseline-lr1e-3-s1", 1e-3, 1), ("baseline-lr1e-3-s2", 1e-3, 2), ("lr3e-4-s1", 3e-4, 1)):
        if not os.path.exists(os.path.join(a.logdir, name, "metrics.jsonl")):
            fake_run(a.logdir, name, lr, seed, 400, goal="데모: 학습률 비교")
            print("[demo] wrote", os.path.join(a.logdir, name))
    if a.live:
        print("[demo] live run: Ctrl+C to stop")
        fake_run(a.logdir, time.strftime("live-%H%M%S"), 1e-3, 3, 2000, delay=0.5, goal="데모: 실시간 갱신")


if __name__ == "__main__":
    main()
