"""浏览器版引擎（docs/engine.js）与 Python 引擎在同一份数据上的结果必须一致。"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ashare_quant.data import make_synthetic
from ashare_quant.engine import Backtester
from ashare_quant.metrics import summarize
from ashare_quant.strategies import BuyAndHold, DualMA, MomentumRotation

ENGINE_JS = Path(__file__).resolve().parents[1] / "docs" / "engine.js"

RUNNER = """
const AQ = require(process.argv[1]);
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = input.cases.map((c) => {
  const bt = new AQ.Backtester(input.data[c.universe], { rebalanceBand: c.band });
  const S = { buy_hold: AQ.BuyAndHold, dual_ma: AQ.DualMA, momentum: AQ.MomentumRotation }[c.strategy];
  const res = bt.run(new S(c.params));
  const m = AQ.summarize(res);
  delete m._drawdown;
  return { equity: res.equity, trades: res.trades.length, fees: m.total_fees, metrics: m };
});
process.stdout.write(JSON.stringify(out));
"""

UNIVERSES = {
    "etf": ["510300", "510500", "159915", "518880", "511260"],
    "stock": ["600519", "300750", "688981", "000001"],
}
CASES = [
    ("etf", "momentum", MomentumRotation, {"lookback": 60, "top_n": 2, "rebalance": 20}, 0.01),
    ("etf", "momentum", MomentumRotation, {"lookback": 20, "top_n": 1, "rebalance": 5}, 0.0),
    ("stock", "dual_ma", DualMA, {"fast": 5, "slow": 20}, 0.01),
    ("stock", "dual_ma", DualMA, {"fast": 20, "slow": 60}, 0.0),
    ("stock", "buy_hold", BuyAndHold, {}, 0.01),
]
JS_PARAM_NAMES = {"top_n": "topN", "abs_filter": "absFilter"}


def to_js(df):
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "open": df["open"].tolist(),
        "close": df["close"].tolist(),
        "volume": df["volume"].tolist(),
    }


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node.js")
def test_js_engine_matches_python():
    data = {k: make_synthetic(v, "2016-01-01", "2024-12-31", seed=7) for k, v in UNIVERSES.items()}
    payload = {
        "data": {k: {s: to_js(df) for s, df in d.items()} for k, d in data.items()},
        "cases": [
            {
                "universe": u,
                "strategy": name,
                "params": {JS_PARAM_NAMES.get(k, k): v for k, v in params.items()},
                "band": band,
            }
            for u, name, _, params, band in CASES
        ],
    }
    proc = subprocess.run(
        ["node", "-e", RUNNER, str(ENGINE_JS)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    js_results = json.loads(proc.stdout)

    for (u, name, cls, params, band), js in zip(CASES, js_results):
        py = Backtester(data[u], rebalance_band=band).run(cls(**params))
        m = summarize(py)
        assert js["trades"] == len(py.trades), (name, params)
        assert js["equity"] == pytest.approx(py.equity.tolist(), rel=1e-9), (name, params)
        assert js["fees"] == pytest.approx(m["total_fees"], abs=0.01)
        for key in ("total_return", "cagr", "sharpe", "sortino", "max_drawdown", "max_dd_days"):
            assert js["metrics"][key] == pytest.approx(m[key], rel=1e-6), (name, key)
