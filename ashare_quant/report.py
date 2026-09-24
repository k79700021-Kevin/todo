"""输出回测报告：净值/回撤图、指标汇总、净值与成交明细 CSV。"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from .engine import BacktestResult  # noqa: E402
from .metrics import format_metrics  # noqa: E402


def write_report(
    result: BacktestResult,
    metrics: dict,
    out_dir: str | Path,
    benchmark: BacktestResult | None = None,
    benchmark_metrics: dict | None = None,
) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result.equity.to_csv(out / "equity.csv")
    result.trades.to_csv(out / "trades.csv", index=False)

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(11, 7), sharex=True, gridspec_kw={"height_ratios": [3, 1]}
    )
    nav = result.equity / result.initial_cash
    ax1.plot(nav.index, nav, label=result.strategy, lw=1.5)
    if benchmark is not None:
        bnav = benchmark.equity / benchmark.initial_cash
        ax1.plot(bnav.index, bnav, label="benchmark (buy & hold)", lw=1, alpha=0.7)
    ax1.set_ylabel("NAV")
    ax1.legend(loc="upper left")
    ax1.grid(alpha=0.3)
    dd = result.equity / result.equity.cummax() - 1
    ax2.fill_between(dd.index, dd, 0, color="tab:red", alpha=0.4)
    ax2.set_ylabel("Drawdown")
    ax2.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out / "report.png", dpi=120)
    plt.close(fig)

    fm = format_metrics(metrics)
    fb = format_metrics(benchmark_metrics) if benchmark_metrics else {}
    lines = [
        f"# 回测报告：{result.strategy}",
        "",
        f"参数：`{result.params}`  ",
        f"区间：{result.equity.index[0].date()} ~ {result.equity.index[-1].date()}",
        "",
        "| 指标 | 策略 | 基准 |" if fb else "| 指标 | 策略 |",
        "|---|---|---|" if fb else "|---|---|",
    ]
    for k, v in fm.items():
        lines.append(f"| {k} | {v} | {fb.get(k, '-')} |" if fb else f"| {k} | {v} |")
    lines += ["", "![report](report.png)", ""]
    (out / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return out
