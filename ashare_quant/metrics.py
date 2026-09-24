"""绩效指标。"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .engine import BacktestResult

TRADING_DAYS = 244  # A 股每年交易日约 242~244


def equity_metrics(equity: pd.Series, rf: float = 0.02) -> dict:
    equity = equity.dropna()
    ret = equity.pct_change().dropna()
    if len(ret) < 2:
        return {}
    total = equity.iloc[-1] / equity.iloc[0] - 1
    years = len(ret) / TRADING_DAYS
    cagr = (1 + total) ** (1 / years) - 1 if total > -1 else -1.0
    excess = ret - rf / TRADING_DAYS
    std = ret.std(ddof=1)
    vol = std * math.sqrt(TRADING_DAYS)
    sharpe = excess.mean() / std * math.sqrt(TRADING_DAYS) if std > 0 else np.nan
    downside = math.sqrt((np.minimum(excess, 0) ** 2).mean()) * math.sqrt(TRADING_DAYS)
    sortino = excess.mean() * TRADING_DAYS / downside if downside > 0 else np.nan
    drawdown = equity / equity.cummax() - 1
    mdd = drawdown.min()
    underwater = (drawdown < 0).astype(int)
    longest = int(underwater.groupby((underwater == 0).cumsum()).sum().max())
    m = {
        "total_return": total,
        "cagr": cagr,
        "volatility": vol,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": mdd,
        "calmar": cagr / abs(mdd) if mdd < 0 else np.nan,
        "max_dd_days": longest,
        "daily_win_rate": (ret > 0).mean(),
    }
    return {k: v if isinstance(v, int) else float(v) for k, v in m.items()}


def summarize(result: BacktestResult, rf: float = 0.02) -> dict:
    m = equity_metrics(result.equity, rf)
    trades = result.trades
    years = max(len(result.equity) - 1, 1) / TRADING_DAYS
    m.update(
        {
            "final_equity": float(result.equity.iloc[-1]),
            "trades": len(trades),
            "total_fees": float(trades["fee"].sum()) if len(trades) else 0.0,
            "annual_turnover": float(trades["amount"].sum() / result.equity.mean() / years)
            if len(trades)
            else 0.0,
        }
    )
    return m


PERCENT_KEYS = {"total_return", "cagr", "volatility", "max_drawdown", "daily_win_rate"}


def format_metrics(m: dict) -> dict[str, str]:
    out = {}
    for k, v in m.items():
        if isinstance(v, float) and math.isnan(v):
            out[k] = "-"
        elif k in PERCENT_KEYS:
            out[k] = f"{v:.2%}"
        elif isinstance(v, float):
            out[k] = f"{v:,.2f}"
        else:
            out[k] = str(v)
    return out
