import numpy as np
import pandas as pd
import pytest

from ashare_quant.cli import main
from ashare_quant.metrics import equity_metrics
from ashare_quant.strategies import BuyAndHold, DualMA, MomentumRotation


def panel():
    idx = pd.bdate_range("2024-01-01", periods=120)
    t = np.arange(120)
    return pd.DataFrame(
        {"up": 10 + 0.1 * t, "down": 30 - 0.1 * t, "flat": np.full(120, 10.0)}, index=idx
    )


def test_dual_ma_emits_only_on_change():
    sig = DualMA(5, 20).generate(panel())
    emitted = sig.dropna(how="all")
    assert emitted.iloc[-1]["up"] == pytest.approx(1 / 3)
    assert emitted.iloc[-1]["down"] == 0
    assert len(emitted) <= 3


def test_momentum_abs_filter_keeps_cash():
    sig = MomentumRotation(lookback=20, top_n=2, rebalance=10).generate(panel()).dropna(how="all")
    assert (sig["up"] == 0.5).all()
    assert (sig["down"] == 0).all() and (sig["flat"] == 0).all()  # 动量不为正则不持有
    assert (sig.sum(axis=1) <= 1).all()
    unfiltered = MomentumRotation(20, 2, 10, abs_filter=False).generate(panel()).dropna(how="all")
    assert (unfiltered.sum(axis=1) == 1).all()


def test_buy_and_hold_single_signal():
    sig = BuyAndHold().generate(panel()).dropna(how="all")
    assert len(sig) == 1 and sig.iloc[0].sum() == pytest.approx(1)


def test_invalid_params():
    with pytest.raises(ValueError):
        DualMA(60, 20)


def test_equity_metrics_known_values():
    eq = pd.Series([100, 120, 90, 110, 130.0], index=pd.bdate_range("2024-01-01", periods=5))
    m = equity_metrics(eq, rf=0)
    assert m["total_return"] == pytest.approx(0.3)
    assert m["max_drawdown"] == pytest.approx(-0.25)
    assert m["max_dd_days"] == 2
    assert m["daily_win_rate"] == pytest.approx(0.75)


def test_cli_smoke(tmp_path, capsys):
    common = ["--symbols", "510300,510500,159915", "--source", "synthetic",
              "--start", "2018-01-01", "--end", "2021-12-31"]
    main(["backtest", "--strategy", "momentum", "--param", "lookback=40", *common,
          "--out", str(tmp_path)])
    for f in ("summary.md", "report.png", "equity.csv", "trades.csv"):
        assert (tmp_path / f).exists()
    main(["optimize", "--strategy", "dual_ma", "--grid", "fast=5,10", "--grid", "slow=20,60",
          "--split", "2020-06-30", *common])
    assert "oos_sharpe" in capsys.readouterr().out
