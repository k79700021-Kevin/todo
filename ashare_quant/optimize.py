"""参数网格搜索 + 样本内/样本外检验。

整段回测只跑一次（避免切分后均线等指标需要重新预热），
再把净值曲线按 split 日期切成样本内、样本外两段分别算指标。
只按样本内指标排序选参；样本外指标用于检验是否过拟合。
"""

from __future__ import annotations

import itertools

import pandas as pd

from .engine import Backtester
from .metrics import equity_metrics
from .strategies import Strategy


def grid_search(
    backtester: Backtester,
    strategy_cls: type[Strategy],
    grid: dict[str, list],
    split: str,
    rf: float = 0.02,
    sort_by: str = "sharpe",
) -> pd.DataFrame:
    split_ts = pd.Timestamp(split)
    keys = list(grid)
    rows = []
    for values in itertools.product(*(grid[k] for k in keys)):
        params = dict(zip(keys, values))
        try:
            strategy = strategy_cls(**params)
        except ValueError:
            continue
        equity = backtester.run(strategy).equity
        train = equity[equity.index < split_ts]
        test = equity[equity.index >= (train.index[-1] if len(train) else split_ts)]
        row = dict(params)
        for prefix, seg in (("is", train), ("oos", test)):
            m = equity_metrics(seg, rf)
            for k in ("cagr", "sharpe", "max_drawdown"):
                row[f"{prefix}_{k}"] = m.get(k)
        rows.append(row)
    if not rows:
        raise ValueError("没有合法的参数组合")
    return pd.DataFrame(rows).sort_values(f"is_{sort_by}", ascending=False, ignore_index=True)
