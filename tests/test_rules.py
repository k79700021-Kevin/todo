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


def test_fee_rule_history():
    fees = FeeModel(commission_rate=0.0, min_commission=0.0)
    # 2007-05-30 ~ 2008-04-23：印花税 0.3%，买卖双向
    assert fees.cost("600519", pd.Timestamp("2008-01-10"), "buy", 100_000, 1000) == 300 + 1.0
    # 2008-09-19 起仅卖方征收
    assert fees.cost("000001", pd.Timestamp("2010-06-01"), "buy", 100_000, 10_000) == 0.0
    assert fees.cost("000001", pd.Timestamp("2010-06-01"), "sell", 100_000, 10_000) == 100.0
    # 2015-08-01 前沪市过户费按股数：每股 0.001 元，最低 1 元
    assert fees.cost("600000", pd.Timestamp("2012-03-01"), "buy", 100_000, 20_000) == 20.0
    # 2015-08-01 起按成交额 0.02‰，2022-04-29 起 0.01‰
    assert fees.cost("000001", pd.Timestamp("2018-03-01"), "buy", 100_000, 10_000) == 2.0
    assert fees.cost("000001", pd.Timestamp("2023-03-01"), "buy", 100_000, 10_000) == 1.0
