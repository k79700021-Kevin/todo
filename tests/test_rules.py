import pandas as pd
import pytest

from ashare_quant.rules import FeeModel, is_limit_down, is_limit_up, price_limit

D = pd.Timestamp("2024-01-02")


@pytest.mark.parametrize(
    "symbol,date,expected",
    [
        ("600519", D, 0.10),
        ("000001", D, 0.10),
        ("300750", D, 0.20),
        ("300750", pd.Timestamp("2020-08-21"), 0.10),
        ("688981", D, 0.20),
        ("830799", D, 0.30),
        ("510300", D, 0.10),
    ],
)
def test_price_limit(symbol, date, expected):
    assert price_limit(symbol, date) == expected


def test_limit_detection_uses_cent_rounding():
    # 3.33 * 1.1 = 3.663 -> 涨停价 3.66（涨幅仅 9.91%）
    assert is_limit_up("600000", D, 3.66, 3.33)
    assert not is_limit_up("600000", D, 3.65, 3.33)
    assert is_limit_down("600000", D, 3.00, 3.33)
    assert not is_limit_down("600000", D, 3.01, 3.33)
    assert not is_limit_up("600000", D, 3.66, float("nan"))


def test_fees_min_commission_and_stamp_duty():
    fees = FeeModel()
    # 1 万元买入：佣金 2.5 元 < 5 元，按 5 元收；过户费 0.1 元
    assert fees.cost("600519", D, "buy", 10_000) == 5.10
    # 卖出 10 万元：佣金 25 + 过户 1 + 印花税（2023-08-28 前 0.1%）100
    assert fees.cost("600519", pd.Timestamp("2023-01-03"), "sell", 100_000) == 126.0
    # 减半后 0.05%
    assert fees.cost("600519", D, "sell", 100_000) == 76.0
    # ETF 免印花税和过户费
    assert fees.cost("510300", D, "sell", 100_000) == 25.0
