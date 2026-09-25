"""A 股交易规则：交易单位、涨跌停、交易费用。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

import pandas as pd

LOT_SIZE = 100  # 一手 = 100 股
CHINEXT_REFORM = pd.Timestamp("2020-08-24")  # 创业板注册制，涨跌幅 10% -> 20%
STAMP_DUTY_CUT = pd.Timestamp("2023-08-28")  # 印花税减半，0.1% -> 0.05%
# 历史规则表（规则本身也是时点数据）：按生效日期排列，取不晚于成交日的最后一条
# 印花税：(生效日, 税率, 是否买卖双向征收)
STAMP_DUTY_HISTORY = (
    (pd.Timestamp("1900-01-01"), 0.002, True),
    (pd.Timestamp("2005-01-24"), 0.001, True),
    (pd.Timestamp("2007-05-30"), 0.003, True),
    (pd.Timestamp("2008-04-24"), 0.001, True),
    (pd.Timestamp("2008-09-19"), 0.001, False),  # 改为仅卖方征收
    (pd.Timestamp("2023-08-28"), 0.0005, False),
)
# 过户费：2015-08-01 前仅沪市股票收取，按股数每股 0.001 元、最低 1 元；之后沪深统一按成交额
TRANSFER_PER_SHARE_UNTIL = pd.Timestamp("2015-08-01")
TRANSFER_HISTORY = (
    (pd.Timestamp("2015-08-01"), 0.00002),
    (pd.Timestamp("2022-04-29"), 0.00001),
)
ETF_PREFIXES = ("51", "15", "56", "58")
# 前复权价格不满足"涨停价 = 前收 * 1.1 四舍五入到分"，因此额外给 0.1% 的相对容差
LIMIT_REL_TOL = 0.001


def is_etf(symbol: str) -> bool:
    return symbol.startswith(ETF_PREFIXES)


def _regime(table, date):
    out = None
    for row in table:
        if row[0] <= date:
            out = row
    return out


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
    - 过户费：双向，仅股票；默认按日期取历史口径（TRANSFER_HISTORY），给定 transfer_rate 时按成交额固定比例
    - 印花税：仅股票；默认按日期取历史税率与征收方向（STAMP_DUTY_HISTORY，2008-09-19 前买卖双向）；
      给定 stamp_duty_rate 时按固定税率、仅卖出
    ETF 免印花税和过户费。
    """

    commission_rate: float = 0.00025
    min_commission: float = 5.0
    transfer_rate: float | None = None
    stamp_duty_rate: float | None = None

    def stamp_duty(self, date: pd.Timestamp, side: str = "sell") -> float:
        if self.stamp_duty_rate is not None:
            return self.stamp_duty_rate if side == "sell" else 0.0
        _, rate, both = _regime(STAMP_DUTY_HISTORY, date)
        return rate if (side == "sell" or both) else 0.0

    def transfer(self, symbol: str, date: pd.Timestamp, amount: float, shares: float | None) -> float:
        if self.transfer_rate is not None:
            return amount * self.transfer_rate
        if date < TRANSFER_PER_SHARE_UNTIL:
            if not symbol.startswith(("6", "9")):
                return 0.0
            return max((shares or 0) * 0.001, 1.0)
        return amount * _regime(TRANSFER_HISTORY, date)[1]

    def cost(self, symbol: str, date: pd.Timestamp, side: str, amount: float, shares: float | None = None) -> float:
        if amount <= 0:
            return 0.0
        fee = max(amount * self.commission_rate, self.min_commission)
        if not is_etf(symbol):
            fee += self.transfer(symbol, date, amount, shares)
            fee += amount * self.stamp_duty(date, side)
        return round(fee, 2)
