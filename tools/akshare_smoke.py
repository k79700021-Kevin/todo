"""akshare 数据路径冒烟测试：拉取真实行情、跑命令行回测，并与网页版（东方财富接口）数据交叉核对。

用法：python tools/akshare_smoke.py [data_smoke.js 输出的 JSON]
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ashare_quant.data import load_akshare  # noqa: E402

SYMBOLS = ["510300", "600519"]
START, END = "2020-01-01", "2024-12-31"


def main() -> None:
    lines = ["", "## akshare 冒烟测试", ""]
    with tempfile.TemporaryDirectory() as cache:
        frames = {s: load_akshare(s, START, END, "qfq", cache) for s in SYMBOLS}
        for s, df in frames.items():
            assert len(df) > 900, f"{s} 只有 {len(df)} 天"
            assert df.index.is_monotonic_increasing
            lines.append(f"- {s}: {len(df)} 天，{df.index[0].date()} ~ {df.index[-1].date()}")

        out = subprocess.run(
            [sys.executable, "-m", "ashare_quant", "backtest", "--strategy", "momentum",
             "--symbols", ",".join(SYMBOLS), "--start", START, "--end", END,
             "--data-dir", cache, "--out", os.path.join(cache, "out")],
            capture_output=True, text=True, check=True, cwd=Path(__file__).resolve().parents[1],
        ).stdout
        lines += ["", "命令行回测输出：", "```", out.strip(), "```"]

    if len(sys.argv) > 1:
        em = json.loads(Path(sys.argv[1]).read_text())
        for s, df in frames.items():
            if s not in em:
                continue
            ref = dict(zip(em[s]["dates"], em[s]["close"]))
            common = [d for d in df.index.strftime("%Y-%m-%d") if d in ref]
            a = df.loc[common, "close"].to_numpy()
            b = np.array([ref[d] for d in common])
            # 前复权价会随拉取时点的新分红变化，两边同一天拉取应一致
            diff = np.max(np.abs(a / b - 1))
            lines.append(f"- {s} 与东方财富网页接口对比：{len(common)} 个共同交易日，最大相对差 {diff:.2e}")
            assert len(common) > 900 and diff < 1e-3, f"{s} 两个数据源不一致"

    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(report + "\n")


if __name__ == "__main__":
    main()
