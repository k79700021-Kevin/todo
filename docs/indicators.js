/* 技术指标。输入为按日期排列的数组，输出 Float64Array，数据不足处为 NaN。
 * 口径与通达信一致：EMA 以首个值为种子；RSI、KDJ 用 SMA(X,N,1) 递推平滑；MACD 柱 = 2*(DIF-DEA)。
 * 由 tests/test_web_indicators.py 与 pandas 的独立实现逐点比对。 */
(function (root) {
  'use strict';

  const nan = (n) => new Float64Array(n).fill(NaN);
  const ok = Number.isFinite;

  function sma(x, n) {
    const out = nan(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      let valid = true;
      for (let j = i - n + 1; j <= i; j++) {
        if (!ok(x[j])) { valid = false; break; }
        s += x[j];
      }
      if (valid) out[i] = s / n;
    }
    return out;
  }

  // 指数平滑：y = a*x + (1-a)*y'，以第一个有效值为种子（pandas ewm(adjust=False)）
  function smooth(x, a, seed) {
    const out = nan(x.length);
    let prev = seed === undefined ? NaN : seed;
    for (let i = 0; i < x.length; i++) {
      if (!ok(x[i])) continue;
      prev = ok(prev) ? a * x[i] + (1 - a) * prev : x[i];
      out[i] = prev;
    }
    return out;
  }

  const ema = (x, n) => smooth(x, 2 / (n + 1));

  function stdev(x, n, ddof = 0) {
    const out = nan(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      let valid = true;
      for (let j = i - n + 1; j <= i; j++) {
        if (!ok(x[j])) { valid = false; break; }
        s += x[j];
      }
      if (!valid) continue;
      const m = s / n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) ** 2;
      out[i] = Math.sqrt(v / (n - ddof));
    }
    return out;
  }

  function rolling(x, n, pick) {
    const out = nan(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let v = x[i - n + 1];
      let valid = ok(v);
      for (let j = i - n + 2; j <= i && valid; j++) {
        if (!ok(x[j])) valid = false;
        else v = pick(v, x[j]);
      }
      if (valid) out[i] = v;
    }
    return out;
  }
  const highest = (x, n) => rolling(x, n, Math.max);
  const lowest = (x, n) => rolling(x, n, Math.min);

  function shift(x, k) {
    const out = nan(x.length);
    for (let i = k; i < x.length; i++) out[i] = x[i - k];
    return out;
  }

  function roc(x, n) {
    const out = nan(x.length);
    for (let i = n; i < x.length; i++) out[i] = x[i] / x[i - n] - 1;
    return out;
  }

  function macd(x, fast = 12, slow = 26, signal = 9) {
    const ef = ema(x, fast);
    const es = ema(x, slow);
    const dif = ef.map((v, i) => v - es[i]);
    const dea = ema(dif, signal);
    const hist = dif.map((v, i) => 2 * (v - dea[i]));
    return { dif, dea, hist };
  }

  // RSI = SMA(MAX(C-LC,0),N,1) / SMA(ABS(C-LC),N,1) * 100，前 n 个值视为预热置 NaN
  function rsi(x, n = 14) {
    const up = nan(x.length);
    const mv = nan(x.length);
    for (let i = 1; i < x.length; i++) {
      const d = x[i] - x[i - 1];
      if (!ok(d)) continue;
      up[i] = Math.max(d, 0);
      mv[i] = Math.abs(d);
    }
    const su = smooth(up, 1 / n);
    const sm = smooth(mv, 1 / n);
    const out = nan(x.length);
    let seen = 0;
    for (let i = 0; i < x.length; i++) {
      if (!ok(sm[i])) continue;
      seen++;
      if (seen < n) continue;
      out[i] = sm[i] > 0 ? (100 * su[i]) / sm[i] : 50;
    }
    return out;
  }

  function boll(x, n = 20, k = 2) {
    const mid = sma(x, n);
    const sd = stdev(x, n, 0);
    return {
      mid,
      upper: mid.map((m, i) => m + k * sd[i]),
      lower: mid.map((m, i) => m - k * sd[i]),
      pctB: mid.map((m, i) => (sd[i] > 0 ? (x[i] - (m - k * sd[i])) / (2 * k * sd[i]) : NaN)),
    };
  }

  // KDJ：RSV 区间为 0 时取 50；K、D 以 50 为种子
  function kdj(high, low, close, n = 9, m1 = 3, m2 = 3) {
    const hh = highest(high, n);
    const ll = lowest(low, n);
    const len = close.length;
    const K = nan(len), D = nan(len), J = nan(len);
    let k = 50, d = 50;
    for (let i = 0; i < len; i++) {
      if (!ok(hh[i]) || !ok(ll[i]) || !ok(close[i])) continue;
      const range = hh[i] - ll[i];
      const rsv = range > 0 ? ((close[i] - ll[i]) / range) * 100 : 50;
      k = (rsv + (m1 - 1) * k) / m1;
      d = (k + (m2 - 1) * d) / m2;
      K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d;
    }
    return { K, D, J };
  }

  // ATR = MA(TR, N)
  function atr(high, low, close, n = 14) {
    const tr = nan(close.length);
    for (let i = 0; i < close.length; i++) {
      const hl = high[i] - low[i];
      tr[i] = i && ok(close[i - 1]) ? Math.max(hl, Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])) : hl;
    }
    return sma(tr, n);
  }

  function rollingSum(x, n) {
    const out = nan(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      let valid = true;
      for (let j = i - n + 1; j <= i; j++) {
        if (!ok(x[j])) { valid = false; break; }
        s += x[j];
      }
      if (valid) out[i] = s;
    }
    return out;
  }

  // DMI（通达信口径）：TR、+DM、-DM 取 N 日累加，ADX 为 DX 的 M 日均值
  function dmi(high, low, close, n = 14, m = 6) {
    const len = close.length;
    const tr = nan(len), dp = nan(len), dm = nan(len);
    for (let i = 1; i < len; i++) {
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(close[i - 1] - low[i]));
      const hd = high[i] - high[i - 1];
      const ld = low[i - 1] - low[i];
      dp[i] = hd > 0 && hd > ld ? hd : 0;
      dm[i] = ld > 0 && ld > hd ? ld : 0;
    }
    const str = rollingSum(tr, n), sdp = rollingSum(dp, n), sdm = rollingSum(dm, n);
    const pdi = str.map((t, i) => (t > 0 ? (sdp[i] * 100) / t : NaN));
    const mdi = str.map((t, i) => (t > 0 ? (sdm[i] * 100) / t : NaN));
    const dx = pdi.map((p, i) => (p + mdi[i] > 0 ? (Math.abs(mdi[i] - p) / (mdi[i] + p)) * 100 : ok(p) ? 0 : NaN));
    return { pdi, mdi, adx: sma(dx, m) };
  }

  // CCI = (TP - MA(TP,N)) / (0.015 × 平均绝对偏差)，TP = (H+L+C)/3
  function cci(high, low, close, n = 14) {
    const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
    const ma = sma(tp, n);
    const out = nan(close.length);
    for (let i = n - 1; i < close.length; i++) {
      if (!ok(ma[i])) continue;
      let md = 0;
      for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
      md /= n;
      out[i] = md > 0 ? (tp[i] - ma[i]) / (0.015 * md) : 0;
    }
    return out;
  }

  // 威廉指标（通达信口径）：100 × (N 日最高 - 收盘) / (N 日最高 - N 日最低)，0 为最强、100 为最弱
  function willr(high, low, close, n = 14) {
    const hh = highest(high, n), ll = lowest(low, n);
    return close.map((c, i) => (!ok(hh[i]) || !ok(ll[i]) ? NaN : hh[i] > ll[i] ? (100 * (hh[i] - c)) / (hh[i] - ll[i]) : 50));
  }

  // 能量潮：收盘上涨累加成交量、下跌累减
  function obv(close, volume) {
    const out = nan(close.length);
    let acc = 0;
    for (let i = 0; i < close.length; i++) {
      if (i && ok(close[i]) && ok(close[i - 1]) && ok(volume[i])) acc += Math.sign(close[i] - close[i - 1]) * volume[i];
      out[i] = acc;
    }
    return out;
  }

  const api = { sma, ema, smooth, stdev, highest, lowest, shift, roc, macd, rsi, boll, kdj, atr, rollingSum, dmi, cci, willr, obv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).ind = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
