"""A 股交易规则：交易单位、涨跌停、交易费用。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

import pandas as pd

LOT_SIZE = 100  # 一手 = 100 股
CHINEXT_REFORM = pd.Timestamp("2020-08-24")  # 创业板注册制，涨跌幅 10% -> 20%
STAMP_DUTY_CUT = pd.Timestamp("2023-08-28")  # 印花税减半，0.1% -> 0.05%
ETF_PREFIXES = ("51", "15", "56", "58")
# 前复权价格不满足"涨停价 = 前收 * 1.1 四舍五入到分"，因此额外给 0.1% 的相对容差
LIMIT_REL_TOL = 0.001


def is_etf(symbol: str) -> bool:
    return symbol.startswith(ETF_PREFIXES)


def price_limit(symbol: str, date: pd.Timestamp) -> float:
    """返回涨跌幅限制比例。未处理 ST（5%）与新股上市首日（无限制）。"""
    if is_etf(symbol):
        return 0.10
    if symbol.startswith(("688", "689")):  # 科创板
        return 0.20
    if symbol.startswith(("300", "301")):  # 创业板
        return 0.20 if date >= CHINEXT_REFORM else 0.10
    if symbol.startswith(("4", "8", "92")):  # 北交所
        return 0.30
    return 0.10


def _round_cent(x: float) -> float:
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def is_limit_up(symbol: str, date: pd.Timestamp, price: float, prev_close: float) -> bool:
    if not prev_close or pd.isna(prev_close) or prev_close <= 0:
        return False
    raw = prev_close * (1 + price_limit(symbol, date))
    threshold = min(_round_cent(raw), raw * (1 - LIMIT_REL_TOL))
    return price >= threshold - 1e-9


def is_limit_down(symbol: str, date: pd.Timestamp, price: float, prev_close: float) -> bool:
    if not prev_close or pd.isna(prev_close) or prev_close <= 0:
        return False
    raw = prev_close * (1 - price_limit(symbol, date))
    threshold = max(_round_cent(raw), raw * (1 + LIMIT_REL_TOL))
    return price <= threshold + 1e-9


@dataclass(frozen=True)
class FeeModel:
    """交易费用。

    - 佣金：双向，按成交额比例收取，不足最低佣金按最低收
    - 过户费：双向，仅股票
    - 印花税：仅卖出、仅股票；默认按日期取历史税率（2008-09-19 之后的单边征收口径）
    ETF 免印花税和过户费。
    """

    commission_rate: float = 0.00025
    min_commission: float = 5.0
    transfer_rate: float = 0.00001
    stamp_duty_rate: float | None = None

    def stamp_duty(self, date: pd.Timestamp) -> float:
        if self.stamp_duty_rate is not None:
            return self.stamp_duty_rate
        return 0.0005 if date >= STAMP_DUTY_CUT else 0.001

    def cost(self, symbol: str, date: pd.Timestamp, side: str, amount: float) -> float:
        if amount <= 0:
            return 0.0
        fee = max(amount * self.commission_rate, self.min_commission)
        if not is_etf(symbol):
            fee += amount * self.transfer_rate
            if side == "sell":
                fee += amount * self.stamp_duty(date)
        return round(fee, 2)
