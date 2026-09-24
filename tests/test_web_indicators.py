"""网页版技术指标（docs/indicators.js）与 pandas 独立实现逐点比对。"""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ashare_quant.data import make_synthetic

DOCS = Path(__file__).resolve().parents[1] / "docs"

RUNNER = """
const I = require(process.argv[1] + '/indicators.js');
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const a = (x) => Array.from(x, (v) => (Number.isFinite(v) ? v : null));
const m = I.macd(d.c, 12, 26, 9), b = I.boll(d.c, 20, 2), k = I.kdj(d.h, d.l, d.c, 9, 3, 3);
process.stdout.write(JSON.stringify({
  sma: a(I.sma(d.c, 20)), ema: a(I.ema(d.c, 12)), std: a(I.stdev(d.c, 20, 0)),
  hh: a(I.highest(d.h, 20)), ll: a(I.lowest(d.l, 20)), roc: a(I.roc(d.c, 5)),
  dif: a(m.dif), dea: a(m.dea), hist: a(m.hist), rsi: a(I.rsi(d.c, 14)),
  upper: a(b.upper), lower: a(b.lower), pctb: a(b.pctB),
  K: a(k.K), D: a(k.D), J: a(k.J), atr: a(I.atr(d.h, d.l, d.c, 14)),
}));
"""


def reference(df: pd.DataFrame) -> dict:
    c, h, l = df["close"], df["high"], df["low"]
    ema = lambda s, n: s.ewm(span=n, adjust=False).mean()  # noqa: E731
    dif = ema(c, 12) - ema(c, 26)
    dea = ema(dif, 9)
    d = c.diff()
    su = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    sm = d.abs().ewm(alpha=1 / 14, adjust=False).mean()
    rsi = 100 * su / sm
    rsi.iloc[:14] = np.nan
    mid, sd = c.rolling(20).mean(), c.rolling(20).std(ddof=0)
    hh, ll = h.rolling(9).max(), l.rolling(9).min()
    rsv = ((c - ll) / (hh - ll) * 100).where(hh.isna() | (hh > ll), 50.0)
    K, D = [], []
    k = dd = 50.0
    for v in rsv:
        if np.isnan(v):
            K.append(np.nan)
            D.append(np.nan)
            continue
        k = (v + 2 * k) / 3
        dd = (k + 2 * dd) / 3
        K.append(k)
        D.append(dd)
    K, D = np.array(K), np.array(D)
    prev = c.shift(1)
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    tr.iloc[0] = h.iloc[0] - l.iloc[0]
    return {
        "sma": c.rolling(20).mean(), "ema": ema(c, 12), "std": sd,
        "hh": h.rolling(20).max(), "ll": l.rolling(20).min(), "roc": c / c.shift(5) - 1,
        "dif": dif, "dea": dea, "hist": 2 * (dif - dea), "rsi": rsi,
        "upper": mid + 2 * sd, "lower": mid - 2 * sd, "pctb": (c - (mid - 2 * sd)) / (4 * sd),
        "K": K, "D": D, "J": 3 * K - 2 * D, "atr": tr.rolling(14).mean(),
    }


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node.js")
def test_indicators_match_pandas():
    df = make_synthetic(["600000"], "2018-01-01", "2020-12-31", seed=5)["600000"]
    payload = {"c": df["close"].tolist(), "h": df["high"].tolist(), "l": df["low"].tolist()}
    out = subprocess.run(
        ["node", "-e", RUNNER, str(DOCS)], input=json.dumps(payload),
        capture_output=True, text=True, check=True,
    ).stdout
    js = json.loads(out)
    for name, ref in reference(df).items():
        ref = np.asarray(ref, dtype=float)
        got = np.array([np.nan if v is None else v for v in js[name]], dtype=float)
        assert np.array_equal(np.isnan(got), np.isnan(ref)), f"{name}: NaN 位置不一致"
        mask = ~np.isnan(ref)
        np.testing.assert_allclose(got[mask], ref[mask], rtol=1e-9, atol=1e-9, err_msg=name)


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node.js")
def test_web_research_suite():
    proc = subprocess.run(
        ["node", "--test", *map(str, sorted((Path(__file__).parent / "web").glob("*.test.js")))],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
