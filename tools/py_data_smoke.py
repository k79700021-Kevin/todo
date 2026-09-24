"""Python 数据路径冒烟测试：直接请求东方财富拉取真实行情、跑命令行回测，并与网页版取到的数据逐日核对。
akshare 作为可选数据源只报告是否可用，不影响结果。

用法：python tools/py_data_smoke.py [data_smoke.js 输出的 JSON]
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ashare_quant.data import load_akshare, load_eastmoney  # noqa: E402

SYMBOLS = ["510300", "600519", "000333"]
START, END = "2020-01-01", "2024-12-31"


def main() -> None:
    lines = ["", "## Python 数据路径", ""]
    with tempfile.TemporaryDirectory() as cache:
        frames = {s: load_eastmoney(s, START, END, "qfq", cache) for s in SYMBOLS}
        for s, df in frames.items():
            assert len(df) > 900, f"{s} 只有 {len(df)} 天"
            assert df.index.is_monotonic_increasing
            lines.append(f"- 东方财富 {s}: {len(df)} 天，{df.index[0].date()} ~ {df.index[-1].date()}")

        out = subprocess.run(
            [sys.executable, "-m", "ashare_quant", "backtest", "--strategy", "momentum",
             "--symbols", ",".join(SYMBOLS), "--start", START, "--end", END,
             "--data-dir", cache, "--out", os.path.join(cache, "out")],
            capture_output=True, text=True, check=True, cwd=ROOT,
        ).stdout
        lines += ["", "命令行回测（读取上面缓存的真实数据）：", "```", out.strip(), "```"]

    if len(sys.argv) > 1:
        em = json.loads(Path(sys.argv[1]).read_text())
        for s, df in frames.items():
            if s not in em:
                continue
            ref = dict(zip(em[s]["dates"], em[s]["close"]))
            common = [d for d in df.index.strftime("%Y-%m-%d") if d in ref]
            diff = np.max(np.abs(df.loc[common, "close"].to_numpy() / np.array([ref[d] for d in common]) - 1))
            lines.append(f"- {s} 与网页版取到的数据核对：{len(common)} 个交易日，最大相对差 {diff:.1e}")
            # 两边都是等比前复权（同一算法），同一时点拉取应完全一致
            assert len(common) > 900 and diff < 1e-9, f"{s} Python 与网页版数据不一致"

    try:
        with tempfile.TemporaryDirectory() as cache:
            df = load_akshare("510300", START, END, "qfq", cache, retries=2)
        lines.append(f"- akshare（可选）：可用，510300 {len(df)} 天")
    except Exception as exc:  # noqa: BLE001 — 只报告，不影响结果
        lines.append(f"- akshare（可选）：本次不可用（{type(exc).__name__}），不影响默认的东方财富数据源")

    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(report + "\n")


if __name__ == "__main__":
    main()
