"""命令行入口：python -m ashare_quant {backtest,optimize} ..."""

from __future__ import annotations

import argparse
import sys

import pandas as pd

from .data import load_universe
from .engine import Backtester
from .metrics import format_metrics, summarize
from .optimize import grid_search
from .report import write_report
from .rules import FeeModel
from .strategies import STRATEGIES, BuyAndHold


def _parse_value(text: str):
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            pass
    return text


def _parse_pairs(items: list[str], multi: bool) -> dict:
    out = {}
    for item in items or []:
        key, sep, value = item.partition("=")
        if not sep:
            raise SystemExit(f"参数格式应为 key=value: {item}")
        out[key] = [_parse_value(v) for v in value.split(",")] if multi else _parse_value(value)
    return out


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--strategy", choices=sorted(STRATEGIES), required=True)
    p.add_argument("--symbols", required=True, help="逗号分隔，如 510300,510500,159915")
    p.add_argument("--start", default="2016-01-01")
    p.add_argument("--end", default="2024-12-31")
    p.add_argument("--source", choices=["eastmoney", "akshare", "csv", "synthetic"], default="eastmoney")
    p.add_argument("--data-dir", default="data", help="在线数据缓存目录 / CSV 目录")
    p.add_argument("--adjust", default="qfq", choices=["qfq", "hfq", ""], help="复权方式")
    p.add_argument("--cash", type=float, default=1_000_000)
    p.add_argument("--commission", type=float, default=0.00025)
    p.add_argument("--min-commission", type=float, default=5.0)
    p.add_argument("--slippage", type=float, default=0.0005)
    p.add_argument("--band", type=float, default=0.01, help="调仓容差（占总资产比例）")
    p.add_argument("--rf", type=float, default=0.02, help="无风险利率（年化）")


def _backtester(args) -> Backtester:
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    data = load_universe(symbols, args.start, args.end, args.source, args.data_dir, args.adjust)
    fees = FeeModel(commission_rate=args.commission, min_commission=args.min_commission)
    return Backtester(data, args.cash, fees, args.slippage, args.band)


def cmd_backtest(args) -> None:
    bt = _backtester(args)
    strategy = STRATEGIES[args.strategy](**_parse_pairs(args.param, multi=False))
    result = bt.run(strategy)
    bench = bt.run(BuyAndHold())
    m, bm = summarize(result, args.rf), summarize(bench, args.rf)
    out = write_report(result, m, args.out, bench, bm)
    fm, fb = format_metrics(m), format_metrics(bm)
    print(f"{'指标':<16}{'策略':>16}{'基准':>16}")
    for k in fm:
        print(f"{k:<16}{fm[k]:>16}{fb.get(k, '-'):>16}")
    print(f"\n报告已输出到 {out}/（summary.md, report.png, equity.csv, trades.csv）")


def cmd_optimize(args) -> None:
    bt = _backtester(args)
    grid = _parse_pairs(args.grid, multi=True)
    if not grid:
        raise SystemExit("至少提供一个 --grid key=v1,v2,...")
    table = grid_search(bt, STRATEGIES[args.strategy], grid, args.split, args.rf, args.sort_by)
    with pd.option_context("display.width", 200, "display.max_columns", 20):
        print(table.head(args.top).to_string(float_format=lambda x: f"{x:.3f}"))
    print(f"\n按样本内（< {args.split}）{args.sort_by} 排序；请重点看样本外（oos_*）是否依然成立。")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="ashare_quant", description="A 股日线回测框架")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("backtest", help="运行单次回测并输出报告")
    _add_common(p)
    p.add_argument("--param", action="append", help="策略参数 key=value，可重复")
    p.add_argument("--out", default="output")
    p.set_defaults(func=cmd_backtest)

    p = sub.add_parser("optimize", help="参数网格搜索 + 样本外检验")
    _add_common(p)
    p.add_argument("--grid", action="append", help="参数网格 key=v1,v2,...，可重复")
    p.add_argument("--split", required=True, help="样本内/样本外分界日期")
    p.add_argument("--sort-by", default="sharpe", choices=["sharpe", "cagr"])
    p.add_argument("--top", type=int, default=10)
    p.set_defaults(func=cmd_optimize)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
