/* 规则组合策略：每条规则把指标翻译成每日信号（+1 看多 / -1 看空 / 0 中性），
 * 再按入场、出场逻辑和风控规则，生成每只标的的持仓状态。 */
(function (root) {
  'use strict';

  const ind = typeof module !== 'undefined' && module.exports ? require('./indicators.js') : root.AQ.ind;
  const EPS = 1e-9;

  // 按"标的 + 指标 + 参数"缓存指标结果：调参时同一指标会被反复用到
  function cached(bars, sym, key, fn) {
    const k = sym + '|' + key;
    let v = bars.cache.get(k);
    if (v === undefined) {
      v = fn();
      bars.cache.set(k, v);
    }
    return v;
  }

  const sig = (n, warm, f) => {
    const out = new Int8Array(n);
    for (let i = warm; i < n; i++) out[i] = f(i);
    return out;
  };
  const cmp = (a, b) => (a > b * (1 + EPS) ? 1 : a < b * (1 - EPS) ? -1 : 0);
  const fin = Number.isFinite;

  const RULES = {
    ma_cross: {
      label: '均线交叉',
      desc: '快线（SMA）在慢线上方看多，下方看空',
      params: {
        fast: { label: '快线', def: 10, min: 2, max: 120, step: 1, range: [5, 30, 5] },
        slow: { label: '慢线', def: 30, min: 3, max: 250, step: 5, range: [20, 120, 20] },
      },
      check: (p) => p.fast < p.slow || '快线要小于慢线',
      signal(b, s, p) {
        const c = b.close[s];
        const f = cached(b, s, 'sma' + p.fast, () => ind.sma(c, p.fast));
        const l = cached(b, s, 'sma' + p.slow, () => ind.sma(c, p.slow));
        return sig(c.length, p.slow - 1, (i) => (fin(f[i]) && fin(l[i]) ? cmp(f[i], l[i]) : 0));
      },
    },
    ema_cross: {
      label: 'EMA 交叉',
      desc: '快 EMA 在慢 EMA 上方看多，下方看空；比 SMA 反应更快',
      params: {
        fast: { label: '快线', def: 12, min: 2, max: 120, step: 1, range: [5, 30, 5] },
        slow: { label: '慢线', def: 50, min: 3, max: 250, step: 5, range: [20, 120, 20] },
      },
      check: (p) => p.fast < p.slow || '快线要小于慢线',
      signal(b, s, p) {
        const c = b.close[s];
        const f = cached(b, s, 'ema' + p.fast, () => ind.ema(c, p.fast));
        const l = cached(b, s, 'ema' + p.slow, () => ind.ema(c, p.slow));
        return sig(c.length, p.slow, (i) => cmp(f[i], l[i]));
      },
    },
    price_ma: {
      label: '价格与均线',
      desc: '收盘价在 N 日均线上方看多，下方看空；常用作趋势过滤',
      params: { n: { label: '均线天数', def: 60, min: 5, max: 250, step: 5, range: [20, 120, 20] } },
      signal(b, s, p) {
        const c = b.close[s];
        const m = cached(b, s, 'sma' + p.n, () => ind.sma(c, p.n));
        return sig(c.length, p.n - 1, (i) => (fin(m[i]) ? cmp(c[i], m[i]) : 0));
      },
    },
    macd: {
      label: 'MACD',
      desc: 'DIF 在 DEA 上方（金叉后）看多，下方（死叉后）看空',
      params: {
        fast: { label: '快线', def: 12, min: 2, max: 50, step: 1, range: [8, 16, 2] },
        slow: { label: '慢线', def: 26, min: 5, max: 120, step: 1, range: [20, 34, 2] },
        signal: { label: '信号线', def: 9, min: 2, max: 50, step: 1, range: [5, 13, 2] },
      },
      check: (p) => p.fast < p.slow || '快线要小于慢线',
      signal(b, s, p) {
        const c = b.close[s];
        const m = cached(b, s, `macd${p.fast},${p.slow},${p.signal}`, () => ind.macd(c, p.fast, p.slow, p.signal));
        const d = m.dif, e = m.dea;
        return sig(c.length, p.slow + p.signal, (i) => (d[i] > e[i] + EPS ? 1 : d[i] < e[i] - EPS ? -1 : 0));
      },
    },
    rsi: {
      label: 'RSI 超买超卖',
      desc: 'RSI 低于下限（超卖）看多，高于上限（超买）看空；均值回归思路',
      params: {
        n: { label: '周期', def: 14, min: 2, max: 60, step: 1, range: [6, 24, 6] },
        low: { label: '超卖线', def: 30, min: 5, max: 50, step: 5, range: [20, 40, 5] },
        high: { label: '超买线', def: 70, min: 50, max: 95, step: 5, range: [60, 80, 5] },
      },
      check: (p) => p.low < p.high || '超卖线要小于超买线',
      signal(b, s, p) {
        const r = cached(b, s, 'rsi' + p.n, () => ind.rsi(b.close[s], p.n));
        return sig(r.length, 0, (i) => (!fin(r[i]) ? 0 : r[i] < p.low ? 1 : r[i] > p.high ? -1 : 0));
      },
    },
    boll: {
      label: '布林带回归',
      desc: '收盘跌破下轨看多，突破上轨看空；均值回归思路',
      params: {
        n: { label: '周期', def: 20, min: 5, max: 120, step: 5, range: [10, 40, 10] },
        k: { label: '标准差倍数', def: 2, min: 1, max: 3, step: 0.5, range: [1.5, 2.5, 0.5] },
      },
      signal(b, s, p) {
        const c = b.close[s];
        const bb = cached(b, s, `boll${p.n},${p.k}`, () => ind.boll(c, p.n, p.k));
        return sig(c.length, p.n - 1, (i) => (!fin(bb.mid[i]) ? 0 : c[i] < bb.lower[i] ? 1 : c[i] > bb.upper[i] ? -1 : 0));
      },
    },
    donchian: {
      label: '通道突破',
      desc: '收盘突破过去 N 日最高价看多，跌破过去 M 日最低价看空（海龟法则）',
      params: {
        n: { label: '突破天数', def: 20, min: 5, max: 250, step: 5, range: [10, 60, 10] },
        m: { label: '跌破天数', def: 10, min: 3, max: 120, step: 1, range: [5, 30, 5] },
      },
      signal(b, s, p) {
        const c = b.close[s];
        const hh = cached(b, s, 'prevHigh' + p.n, () => ind.shift(ind.highest(b.high[s], p.n), 1));
        const ll = cached(b, s, 'prevLow' + p.m, () => ind.shift(ind.lowest(b.low[s], p.m), 1));
        return sig(c.length, 0, (i) => (fin(hh[i]) && c[i] > hh[i] ? 1 : fin(ll[i]) && c[i] < ll[i] ? -1 : 0));
      },
    },
    kdj: {
      label: 'KDJ',
      desc: 'K 在 D 上方看多，下方看空（参数 9,3,3）',
      params: { n: { label: 'RSV 周期', def: 9, min: 3, max: 60, step: 1, range: [5, 20, 5] } },
      signal(b, s, p) {
        const k = cached(b, s, 'kdj' + p.n, () => ind.kdj(b.high[s], b.low[s], b.close[s], p.n, 3, 3));
        return sig(k.K.length, p.n + 5, (i) => (fin(k.K[i]) ? (k.K[i] > k.D[i] + EPS ? 1 : k.K[i] < k.D[i] - EPS ? -1 : 0) : 0));
      },
    },
    roc: {
      label: '动量 ROC',
      desc: '过去 N 日涨幅超过阈值看多，跌幅超过阈值看空',
      params: {
        n: { label: '回看天数', def: 20, min: 5, max: 250, step: 5, range: [10, 120, 10] },
        th: { label: '阈值 %', def: 0, min: 0, max: 20, step: 1, range: [0, 5, 1] },
      },
      signal(b, s, p) {
        const r = cached(b, s, 'roc' + p.n, () => ind.roc(b.close[s], p.n));
        const t = p.th / 100;
        return sig(r.length, p.n, (i) => (!fin(r[i]) ? 0 : r[i] > t + EPS ? 1 : r[i] < -t - EPS ? -1 : 0));
      },
    },
  };

  // 风控参数：0 表示关闭。range 为参数优化时的默认搜索范围 [起, 止, 步长]
  const RISK_PARAMS = {
    stopLoss: { label: '止损 %', def: 0, min: 0, max: 30, step: 1, range: [0, 15, 5] },
    takeProfit: { label: '止盈 %', def: 0, min: 0, max: 100, step: 5, range: [0, 40, 10] },
    trailATR: { label: 'ATR 移动止损倍数', def: 0, min: 0, max: 6, step: 0.5, range: [0, 4, 1] },
  };

  function defaultParams(id) {
    return Object.fromEntries(Object.entries(RULES[id].params).map(([k, d]) => [k, d.def]));
  }

  class RuleStrategy {
    /* config: { rules: [{ id, params }], entry: 'all'|'any', exit: 'any'|'all',
     *           sizing: 'fixed'|'equal', stopLoss, takeProfit, trailATR } */
    constructor(config) {
      const unknown = (config.rules || []).find((r) => !RULES[r.id]);
      if (unknown) throw new Error('未知规则：' + unknown.id);
      const rules = (config.rules || []).map((r) => ({ id: r.id, params: { ...defaultParams(r.id), ...r.params } }));
      if (!rules.length) throw new Error('至少添加一条规则');
      for (const r of rules) {
        const def = RULES[r.id];
        for (const [k, spec] of Object.entries(def.params)) {
          if (!(r.params[k] >= spec.min)) throw new Error(`${def.label}的"${spec.label}"不能小于 ${spec.min}`);
        }
        const msg = def.check ? def.check(r.params) : true;
        if (msg !== true) throw new Error(`${def.label}：${msg}`);
      }
      this.name = 'rules';
      this.rules = rules;
      this.entry = config.entry === 'any' ? 'any' : 'all';
      this.exit = config.exit === 'all' ? 'all' : 'any';
      this.sizing = config.sizing === 'equal' ? 'equal' : 'fixed';
      this.stopLoss = (+config.stopLoss || 0) / 100;
      this.takeProfit = (+config.takeProfit || 0) / 100;
      this.trailATR = +config.trailATR || 0;
    }

    params() {
      const out = {};
      this.rules.forEach((r) => Object.entries(r.params).forEach(([k, v]) => (out[`${r.id}.${k}`] = v)));
      return Object.assign(out, { stopLoss: this.stopLoss * 100, takeProfit: this.takeProfit * 100, trailATR: this.trailATR });
    }

    generate(close, dates, symbols, bars) {
      const n = dates.length;
      const N = symbols.length;
      const holding = new Uint8Array(N);
      const state = symbols.map((s) => ({
        sigs: this.rules.map((r) => RULES[r.id].signal(bars, s, r.params)),
        atr: this.trailATR ? cached(bars, s, 'atr14', () => ind.atr(bars.high[s], bars.low[s], bars.close[s], 14)) : null,
        entryPx: NaN,
        peak: NaN,
      }));
      const out = new Array(n).fill(null);

      for (let i = 0; i < n; i++) {
        let changed = i === 0;
        for (let k = 0; k < N; k++) {
          const st = state[k];
          const c = close[symbols[k]][i];
          if (!fin(c)) continue;
          if (!holding[k]) {
            const enter = this.entry === 'all' ? st.sigs.every((x) => x[i] === 1) : st.sigs.some((x) => x[i] === 1);
            if (enter) {
              holding[k] = 1;
              st.entryPx = c;
              st.peak = c;
              changed = true;
            }
            continue;
          }
          st.peak = Math.max(st.peak, c);
          let exit = this.exit === 'any' ? st.sigs.some((x) => x[i] === -1) : st.sigs.every((x) => x[i] === -1);
          if (this.stopLoss && c <= st.entryPx * (1 - this.stopLoss)) exit = true;
          if (this.takeProfit && c >= st.entryPx * (1 + this.takeProfit)) exit = true;
          if (this.trailATR && fin(st.atr[i]) && c < st.peak - this.trailATR * st.atr[i]) exit = true;
          if (exit) {
            holding[k] = 0;
            changed = true;
          }
        }
        if (!changed) continue;
        const count = holding.reduce((a, b) => a + b, 0);
        const w = this.sizing === 'equal' ? (count ? 1 / count : 0) : 1 / N;
        out[i] = Array.from(holding, (h) => (h ? w : 0));
      }
      return out;
    }
  }

  const api = { RULES, RISK_PARAMS, RuleStrategy, defaultParams };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.AQ, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
