"""日线级别事件驱动回测引擎（仅做多）。

时序约定（杜绝未来函数）：
    第 t 日收盘后，策略基于截至 t 日的收盘价给出目标权重；
    第 t+1 日开盘按开盘价（含滑点）调仓；随后以收盘价计算净值。

A 股规则：
    - 以 100 股为单位买入，清仓时全部卖出
    - T+1：每日只在开盘调仓一次，且先卖后买，当日买入的股份不会在当日卖出
    - 停牌（无行情或成交量为 0）不可交易；开盘涨停不可买，开盘跌停不可卖
    - 调仓容差：对已持有且目标非 0 的标的，调整金额小于总资产 rebalance_band 时不交易
    - 受上述限制未成交的标的，保留目标并在之后每日开盘重试，直到成交或出现新信号
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .rules import LOT_SIZE, FeeModel, is_limit_down, is_limit_up, is_star, lot_round


@dataclass
class BacktestResult:
    strategy: str
    equity: pd.Series
    positions: pd.DataFrame
    trades: pd.DataFrame
    initial_cash: float
    params: dict = field(default_factory=dict)


TRADE_COLUMNS = ["date", "symbol", "side", "shares", "price", "amount", "fee"]


class Backtester:
    def __init__(
        self,
        data: dict[str, pd.DataFrame],
        initial_cash: float = 1_000_000.0,
        fees: FeeModel | None = None,
        slippage: float = 0.0005,
        rebalance_band: float = 0.01,
    ):
        if not data:
            raise ValueError("data 不能为空")
        self.symbols = sorted(data)
        self.initial_cash = float(initial_cash)
        self.fees = fees or FeeModel()
        self.slippage = slippage
        self.rebalance_band = rebalance_band

        def panel(col: str) -> pd.DataFrame:
            return pd.DataFrame({s: data[s][col] for s in self.symbols}).sort_index()

        self.open = panel("open")
        self.close = panel("close")
        volume = panel("volume")
        # 价格非正（坏数据）也视为不可交易，避免按 0 价买入无穷多股
        self.tradable = (self.open > 0) & (self.close > 0) & (volume.fillna(0) > 0)
        self.prev_close = self.close.ffill().shift(1)

    def run(self, strategy) -> BacktestResult:
        signals = strategy.generate(self.close.ffill())
        signals = signals.reindex(index=self.close.index, columns=self.symbols)
        _validate_signals(signals)

        cash = self.initial_cash
        shares = dict.fromkeys(self.symbols, 0)
        last_close = pd.Series(np.nan, index=self.symbols)
        pending: dict[str, float] | None = None
        equity, positions, trades = [], [], []

        for d in self.close.index:
            if pending:
                cash, pending = self._rebalance(d, pending, cash, shares, last_close, trades)

            closes = self.close.loc[d]
            last_close = last_close.where(closes.isna(), closes)
            value = sum(shares[s] * last_close[s] for s in self.symbols if shares[s])
            equity.append(cash + value)
            positions.append(dict(shares))

            row = signals.loc[d]
            if row.notna().any():
                pending = row.fillna(0.0).to_dict()

        index = self.close.index
        return BacktestResult(
            strategy=getattr(strategy, "name", type(strategy).__name__),
            equity=pd.Series(equity, index=index, name="equity"),
            positions=pd.DataFrame(positions, index=index),
            trades=pd.DataFrame(trades, columns=TRADE_COLUMNS),
            initial_cash=self.initial_cash,
            params=strategy.params() if hasattr(strategy, "params") else {},
        )

    def _rebalance(self, d, targets, cash, shares, last_close, trades):
        opens = self.open.loc[d]
        tradable = self.tradable.loc[d]
        prev = self.prev_close.loc[d]

        def mark(s):
            return opens[s] if tradable[s] else last_close[s]

        equity = cash + sum(shares[s] * mark(s) for s in self.symbols if shares[s])
        unfilled: dict[str, float] = {}
        sells, buys = [], []
        for s, w in targets.items():
            if not tradable[s]:
                if w > 0 or shares[s] > 0:
                    unfilled[s] = w
                continue
            price = opens[s]
            target = lot_round(s, w * equity / price) if w > 0 else 0
            delta = target - shares[s]
            # 非清仓/建仓的小幅调整不值得付最低佣金，跳过
            if target and shares[s] and abs(delta) * price < self.rebalance_band * equity:
                continue
            if delta < 0:
                sells.append((s, -delta, price, w))
            elif delta > 0:
                buys.append((s, delta, price, w))

        for s, qty, price, w in sells:
            if is_limit_down(s, d, price, prev[s]):
                unfilled[s] = w
                continue
            # 科创板：卖出后剩余不足 200 股的须一次卖完
            if is_star(s) and 0 < shares[s] - qty < 200:
                qty = shares[s]
            fill = price * (1 - self.slippage)
            amount = qty * fill
            fee = self.fees.cost(s, d, "sell", amount, qty)
            cash += amount - fee
            shares[s] -= qty
            trades.append((d, s, "sell", qty, fill, amount, fee))

        # 还有卖单没成交（跌停、停牌）：因现金不足少买的部分次日继续
        cash_coming = any(shares[k] > 0 and w_ * equity < shares[k] * mark(k) - 1e-6 for k, w_ in unfilled.items())
        for s, want, price, w in sorted(buys, key=lambda o: -o[1] * o[2]):
            if is_limit_up(s, d, price, prev[s]):
                unfilled[s] = w
                continue
            fill = price * (1 + self.slippage)
            qty = self._affordable(s, d, want, fill, cash)
            if qty < want and cash_coming:
                unfilled[s] = w
            if qty <= 0:
                continue
            amount = qty * fill
            fee = self.fees.cost(s, d, "buy", amount, qty)
            cash -= amount + fee
            shares[s] += qty
            trades.append((d, s, "buy", qty, fill, amount, fee))

        return cash, (unfilled or None)

    def _affordable(self, s, d, qty, price, cash) -> int:
        step = 1 if is_star(s) else LOT_SIZE
        qty = lot_round(s, min(qty, cash / price))
        while qty > 0 and qty * price + self.fees.cost(s, d, "buy", qty * price, qty) > cash + 1e-9:
            qty = lot_round(s, qty - step)
        return max(qty, 0)


def _validate_signals(signals: pd.DataFrame) -> None:
    if (signals < 0).any().any():
        raise ValueError("仅支持做多，目标权重不能为负")
    if (signals.fillna(0).sum(axis=1) > 1 + 1e-9).any():
        raise ValueError("目标权重之和不能超过 1（不支持杠杆）")
