import numpy as np
import pandas as pd
import pytest

from ashare_quant.data import make_synthetic
from ashare_quant.engine import Backtester
from ashare_quant.rules import FeeModel
from ashare_quant.strategies import DualMA, MomentumRotation, Strategy

NO_FEES = FeeModel(commission_rate=0, min_commission=0, transfer_rate=0, stamp_duty_rate=0)


def bars(closes, opens=None, volume=None, start="2024-01-02"):
    idx = pd.bdate_range(start, periods=len(closes), name="date")
    closes = np.asarray(closes, float)
    opens = closes if opens is None else np.asarray(opens, float)
    vol = np.full(len(closes), 1e6) if volume is None else np.asarray(volume, float)
    return pd.DataFrame(
        {"open": opens, "high": np.maximum(opens, closes), "low": np.minimum(opens, closes),
         "close": closes, "volume": vol},
        index=idx,
    )


class Fixed(Strategy):
    """在指定日期（位置）发出固定目标权重。"""

    name = "fixed"

    def __init__(self, schedule):
        self.schedule = schedule

    def generate(self, close):
        out = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
        for i, weights in self.schedule.items():
            out.iloc[i] = pd.Series(weights).reindex(close.columns).fillna(0.0)
        return out


def test_signal_executes_at_next_open_in_lots():
    df = bars([10, 10, 10, 10], opens=[10, 10.5, 10, 10])
    res = Backtester({"600000": df}, 100_000, NO_FEES, slippage=0).run(Fixed({0: {"600000": 1.0}}))
    t = res.trades.iloc[0]
    assert t["date"] == df.index[1] and t["price"] == 10.5
    assert t["shares"] == 9500  # 100000 / 10.5 = 9523 -> 9500
    assert res.positions["600000"].iloc[0] == 0


def test_limit_up_open_blocks_buy_then_retries():
    # 第 1 日开盘一字涨停（10 -> 11），第 2 日开盘可买
    df = bars([10, 11, 11.5, 11.5], opens=[10, 11, 11.2, 11.5])
    res = Backtester({"600000": df}, 100_000, NO_FEES, slippage=0).run(Fixed({0: {"600000": 1.0}}))
    assert len(res.trades) == 1
    assert res.trades.iloc[0]["date"] == df.index[2]


def test_suspended_blocks_sell_then_retries():
    df = bars([10, 10, 10, 10, 10], volume=[1e6, 1e6, 1e6, 0, 1e6])
    sched = {0: {"600000": 1.0}, 2: {"600000": 0.0}}
    res = Backtester({"600000": df}, 100_000, NO_FEES, slippage=0).run(Fixed(sched))
    sells = res.trades[res.trades["side"] == "sell"]
    assert list(sells["date"]) == [df.index[4]]
    assert res.positions["600000"].iloc[-1] == 0


def test_limit_down_blocks_sell():
    df = bars([10, 10, 9, 9], opens=[10, 10, 9, 9])
    sched = {0: {"600000": 1.0}, 1: {"600000": 0.0}}
    res = Backtester({"600000": df}, 100_000, NO_FEES, slippage=0).run(Fixed(sched))
    sells = res.trades[res.trades["side"] == "sell"]
    assert list(sells["date"]) == [df.index[3]]


def test_accounting_consistency_with_fees():
    data = make_synthetic(["600000", "000001", "300750"], "2019-01-01", "2021-12-31", seed=1)
    bt = Backtester(data, 1_000_000, FeeModel(), slippage=0.001)
    res = bt.run(DualMA(5, 20))
    trades = res.trades
    cash = 1_000_000 + trades.loc[trades.side == "sell", "amount"].sum() - trades.loc[
        trades.side == "buy", "amount"
    ].sum() - trades["fee"].sum()
    last_close = bt.close.ffill().iloc[-1]
    expected = cash + (res.positions.iloc[-1] * last_close).sum()
    assert res.equity.iloc[-1] == pytest.approx(expected, rel=1e-9)
    assert cash >= -1e-6
    assert (res.positions % 100 == 0).all().all()
    assert len(trades) > 0 and (trades["fee"] >= 5).all()


def test_no_lookahead():
    data = make_synthetic(["510300", "510500", "159915"], "2018-01-01", "2020-12-31", seed=3)
    cut = pd.Timestamp("2019-06-28")
    strategy = MomentumRotation(lookback=20, top_n=1, rebalance=5)
    base = Backtester(data, 1_000_000).run(strategy).equity
    tampered = {s: df.copy() for s, df in data.items()}
    for df in tampered.values():
        df.loc[df.index > cut, ["open", "high", "low", "close"]] *= 3
    changed = Backtester(tampered, 1_000_000).run(strategy).equity
    pd.testing.assert_series_equal(base[base.index <= cut], changed[changed.index <= cut])


def test_rejects_invalid_weights():
    df = bars([10, 10, 10])
    with pytest.raises(ValueError):
        Backtester({"600000": df}).run(Fixed({0: {"600000": 1.5}}))
    with pytest.raises(ValueError):
        Backtester({"600000": df}).run(Fixed({0: {"600000": -0.5}}))


def test_rebalance_band_skips_small_adjustments():
    df = bars([10, 10, 10.2, 10.2, 10.2])
    sched = {0: {"600000": 0.5}, 2: {"600000": 0.5}}
    res = Backtester({"600000": df}, 1_000_000, NO_FEES, slippage=0).run(Fixed(sched))
    assert len(res.trades) == 1
    res = Backtester({"600000": df}, 1_000_000, NO_FEES, slippage=0, rebalance_band=0).run(Fixed(sched))
    assert len(res.trades) == 2


def test_load_akshare_retries_network_errors(tmp_path, monkeypatch):
    import sys
    import types

    from ashare_quant.data import load_akshare

    calls = []

    def flaky(**kwargs):
        calls.append(kwargs)
        if len(calls) < 3:
            raise ConnectionError("Remote end closed connection without response")
        return pd.DataFrame(
            {"日期": ["2024-01-02", "2024-01-03"], "开盘": [1.0, 1.1], "收盘": [1.1, 1.2],
             "最高": [1.2, 1.3], "最低": [0.9, 1.0], "成交量": [100, 200]}
        )

    monkeypatch.setitem(sys.modules, "akshare", types.SimpleNamespace(fund_etf_hist_em=flaky, stock_zh_a_hist=flaky))
    df = load_akshare("510300", "2024-01-01", "2024-01-31", cache_dir=tmp_path, retry_wait=0)
    assert len(calls) == 3 and len(df) == 2 and list(df.columns) == ["open", "high", "low", "close", "volume"]

    monkeypatch.setitem(sys.modules, "akshare", types.SimpleNamespace(fund_etf_hist_em=flaky, stock_zh_a_hist=flaky))
    calls.clear()
    with pytest.raises(ConnectionError):
        load_akshare("600519", "2024-01-01", "2024-01-31", cache_dir=tmp_path, retries=2, retry_wait=0)


def test_load_eastmoney_parses_and_retries(tmp_path, monkeypatch):
    import io
    import json
    import urllib.request

    from ashare_quant import data as data_mod

    payload = {"data": {"code": "600519", "klines": [
        "2024-01-02,1700.0,1685.0,1710.0,1680.0,30000,0,0",
        "2024-01-03,1681.0,1694.0,1699.0,1675.0,28000,0,0",
    ]}}
    seen = []

    def fake_urlopen(req, timeout):
        seen.append(req)
        if len(seen) == 1:
            raise ConnectionResetError("Remote end closed connection without response")
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    df = data_mod.load_eastmoney("600519", "2024-01-01", "2024-01-31", adjust="hfq", cache_dir=tmp_path, retry_wait=0)
    assert len(seen) == 2
    url = seen[0].full_url
    assert "secid=1.600519" in url and "fqt=2" in url and "beg=20240101" in url
    assert seen[0].get_header("Referer") == "https://quote.eastmoney.com/"
    assert df.loc["2024-01-03", "close"] == 1694.0 and df.loc["2024-01-02", "high"] == 1710.0
    # 第二次读缓存，不再请求
    data_mod.load_eastmoney("600519", "2024-01-01", "2024-01-31", adjust="hfq", cache_dir=tmp_path)
    assert len(seen) == 2
    assert data_mod.eastmoney_market("159915") == 0 and data_mod.eastmoney_market("510300") == 1

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: io.BytesIO(b'{"data": null}'))
    with pytest.raises(ValueError, match="没有数据"):
        data_mod.load_eastmoney("000000", "2024-01-01", "2024-01-31", adjust="hfq", cache_dir=tmp_path)


def test_eastmoney_qfq_is_proportional_and_positive(tmp_path, monkeypatch):
    """等比前复权 = 后复权按最新真实价缩放：涨跌幅与后复权一致、价格恒正、最新价等于真实价。"""
    import io
    import json
    import urllib.parse
    import urllib.request

    from ashare_quant import data as data_mod

    # 后复权（比例调整）与不复权：2024-01-03 除权，每股分红 5 元
    hfq = ["2024-01-02,100,100,101,99,10", "2024-01-03,98,97.5,99,97,10", "2024-01-04,98,99,100,97,10"]
    raw = ["2024-01-02,40,40,41,39,10", "2024-01-03,34,34,35,33,10", "2024-01-04,34.2,34.5,35,34,10"]

    def fake_urlopen(req, timeout):
        fqt = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)["fqt"][0]
        return io.BytesIO(json.dumps({"data": {"klines": hfq if fqt == "2" else raw}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    df = data_mod.load_eastmoney("000333", "2024-01-01", "2024-01-31", cache_dir=tmp_path)
    assert df["close"].iloc[-1] == pytest.approx(34.5)
    ret = df["close"].pct_change().dropna().to_numpy()
    assert ret == pytest.approx(np.array([97.5 / 100 - 1, 99 / 97.5 - 1]))
    assert (df[["open", "high", "low", "close"]] > 0).all().all()


def test_non_positive_prices_are_rejected():
    from ashare_quant.data import normalize_bars

    bad = pd.DataFrame({"date": ["2014-01-02", "2014-01-03"], "open": [-1.2, 3.0], "high": [1, 3.1],
                        "low": [-1.5, 2.9], "close": [-0.3, 3.05], "volume": [1, 1]})
    with pytest.raises(ValueError, match="价格 ≤ 0"):
        normalize_bars(bad)
