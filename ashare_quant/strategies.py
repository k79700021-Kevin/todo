"""策略。

每个策略实现 generate(close) -> 目标权重 DataFrame：
    - 输入 close：日期 x 标的的收盘价（停牌日已前向填充）
    - 输出与 close 同形状；某一行只要有非 NaN 值，即视为当日收盘后的完整目标仓位
      （该行 NaN 视为 0），引擎在下一交易日开盘执行；全 NaN 行表示不调仓
策略只能使用 rolling/shift 等向后看的计算，引擎保证信号在次日才成交。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np
import pandas as pd


class Strategy(ABC):
    name = "base"

    @abstractmethod
    def generate(self, close: pd.DataFrame) -> pd.DataFrame: ...

    def params(self) -> dict:
        return {}


class BuyAndHold(Strategy):
    """所有标的都有行情后等权买入并持有，用作基准。"""

    name = "buy_hold"

    def generate(self, close: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
        ready = close.notna().all(axis=1)
        if ready.any():
            out.loc[ready.idxmax()] = 1.0 / close.shape[1]
        return out


class DualMA(Strategy):
    """双均线趋势：快线在慢线上方时持有该标的（各标的等分资金），否则空仓。"""

    name = "dual_ma"

    def __init__(self, fast: int = 20, slow: int = 60):
        if not 0 < fast < slow:
            raise ValueError("需要 0 < fast < slow")
        self.fast, self.slow = fast, slow

    def params(self) -> dict:
        return {"fast": self.fast, "slow": self.slow}

    def generate(self, close: pd.DataFrame) -> pd.DataFrame:
        fast = close.rolling(self.fast).mean()
        slow = close.rolling(self.slow).mean()
        raw = (fast > slow).astype(float) / close.shape[1]
        changed = raw.ne(raw.shift()).any(axis=1)
        return raw.where(changed, np.nan)


class MomentumRotation(Strategy):
    """动量轮动：每 rebalance 个交易日，持有过去 lookback 日涨幅最高的 top_n 个标的。

    abs_filter=True 时只持有动量为正的标的，其余仓位留现金（绝对动量，控制熊市回撤）。
    适合在一篮子风格差异大的 ETF（宽基、行业、黄金、债券）之间轮动。
    """

    name = "momentum"

    def __init__(self, lookback: int = 60, top_n: int = 2, rebalance: int = 20, abs_filter: bool = True):
        if lookback <= 0 or top_n <= 0 or rebalance <= 0:
            raise ValueError("lookback/top_n/rebalance 必须为正")
        self.lookback, self.top_n, self.rebalance, self.abs_filter = lookback, top_n, rebalance, abs_filter

    def params(self) -> dict:
        return {
            "lookback": self.lookback,
            "top_n": self.top_n,
            "rebalance": self.rebalance,
            "abs_filter": self.abs_filter,
        }

    def generate(self, close: pd.DataFrame) -> pd.DataFrame:
        mom = close / close.shift(self.lookback) - 1
        out = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
        top_n = min(self.top_n, close.shape[1])
        for i in range(self.lookback, len(close), self.rebalance):
            score = mom.iloc[i].dropna()
            if self.abs_filter:
                score = score[score > 0]
            row = pd.Series(0.0, index=close.columns)
            row[score.nlargest(top_n).index] = 1.0 / top_n
            out.iloc[i] = row
        return out


STRATEGIES: dict[str, type[Strategy]] = {
    cls.name: cls for cls in (BuyAndHold, DualMA, MomentumRotation)
}
