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
  // N 日收益率标准差（年化）
  function annVol(close, n) {
    return ind.stdev(Float64Array.from(ind.roc(close, 1)), n, 1).map((v) => v * Math.sqrt(244));
  }
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
    dmi: {
      label: 'DMI 趋势强度',
      desc: 'ADX 高于阈值（有趋势）时，+DI 在上看多、-DI 在上看空；ADX 低于阈值视为无趋势',
      params: {
        n: { label: '周期', def: 14, min: 5, max: 60, step: 1, range: [10, 30, 5] },
        th: { label: 'ADX 阈值', def: 20, min: 5, max: 60, step: 5, range: [15, 35, 5] },
      },
      signal(b, s, p) {
        const d = cached(b, s, 'dmi' + p.n, () => ind.dmi(b.high[s], b.low[s], b.close[s], p.n, 6));
        return sig(d.adx.length, p.n + 6, (i) => (!(d.adx[i] > p.th) ? 0 : d.pdi[i] > d.mdi[i] ? 1 : d.pdi[i] < d.mdi[i] ? -1 : 0));
      },
    },
    cci: {
      label: 'CCI 突破',
      desc: 'CCI 上穿 +阈值看多（强势突破），跌破 -阈值看空',
      params: {
        n: { label: '周期', def: 14, min: 5, max: 60, step: 1, range: [10, 40, 10] },
        th: { label: '阈值', def: 100, min: 20, max: 300, step: 10, range: [50, 200, 50] },
      },
      signal(b, s, p) {
        const c = cached(b, s, 'cci' + p.n, () => ind.cci(b.high[s], b.low[s], b.close[s], p.n));
        return sig(c.length, p.n - 1, (i) => (!fin(c[i]) ? 0 : c[i] > p.th ? 1 : c[i] < -p.th ? -1 : 0));
      },
    },
    willr: {
      label: '威廉 %R',
      desc: '%R 高于超卖线看多，低于超买线看空（0 最强、100 最弱）；均值回归思路',
      params: {
        n: { label: '周期', def: 14, min: 3, max: 60, step: 1, range: [7, 28, 7] },
        low: { label: '超买线', def: 20, min: 5, max: 50, step: 5, range: [10, 30, 10] },
        high: { label: '超卖线', def: 80, min: 50, max: 95, step: 5, range: [70, 90, 10] },
      },
      check: (p) => p.low < p.high || '超买线要小于超卖线',
      signal(b, s, p) {
        const w = cached(b, s, 'wr' + p.n, () => ind.willr(b.high[s], b.low[s], b.close[s], p.n));
        return sig(w.length, p.n - 1, (i) => (!fin(w[i]) ? 0 : w[i] > p.high ? 1 : w[i] < p.low ? -1 : 0));
      },
    },
    vol_surge: {
      label: '放量上涨',
      desc: '成交量超过 N 日均量的 k 倍且收阳时看多；只产生看多信号，适合作为入场确认',
      params: {
        n: { label: '均量天数', def: 20, min: 5, max: 120, step: 5, range: [10, 60, 10] },
        k: { label: '放量倍数', def: 2, min: 1, max: 5, step: 0.5, range: [1.5, 3, 0.5] },
      },
      signal(b, s, p) {
        const v = b.volume[s];
        const mv = cached(b, s, 'vma' + p.n, () => ind.sma(v, p.n));
        const c = b.close[s], o = b.open[s];
        return sig(c.length, p.n, (i) => (fin(mv[i - 1]) && v[i] > p.k * mv[i - 1] && c[i] > o[i] ? 1 : 0));
      },
    },
    vol_filter: {
      label: '波动率过滤',
      desc: 'N 日年化波动率低于阈值看多（市场平稳），高于阈值看空；常用于在剧烈波动时离场',
      params: {
        n: { label: '周期', def: 20, min: 5, max: 120, step: 5, range: [10, 60, 10] },
        th: { label: '年化波动阈值 %', def: 30, min: 5, max: 100, step: 5, range: [15, 45, 5] },
      },
      signal(b, s, p) {
        const v = cached(b, s, 'vol' + p.n, () => annVol(b.close[s], p.n));
        return sig(v.length, p.n, (i) => (!fin(v[i]) ? 0 : v[i] * 100 < p.th ? 1 : -1));
      },
    },
    ma_slope: {
      label: '均线斜率',
      desc: 'N 日均线比 k 天前高看多、低看空；比价格与均线更平滑',
      params: {
        n: { label: '均线天数', def: 20, min: 5, max: 250, step: 5, range: [10, 60, 10] },
        k: { label: '比较天数', def: 5, min: 1, max: 60, step: 1, range: [3, 10, 1] },
      },
      signal(b, s, p) {
        const m = cached(b, s, 'sma' + p.n, () => ind.sma(b.close[s], p.n));
        return sig(m.length, p.n - 1 + p.k, (i) => (fin(m[i]) && fin(m[i - p.k]) ? cmp(m[i], m[i - p.k]) : 0));
      },
    },
    obv_trend: {
      label: 'OBV 能量潮',
      desc: 'OBV 在其 N 日均线上方看多（资金流入），下方看空',
      params: { n: { label: '均线天数', def: 20, min: 5, max: 120, step: 5, range: [10, 60, 10] } },
      signal(b, s, p) {
        const o = cached(b, s, 'obv', () => ind.obv(b.close[s], b.volume[s]));
        const m = cached(b, s, 'obvma' + p.n, () => ind.sma(o, p.n));
        return sig(o.length, p.n, (i) => (!fin(m[i]) ? 0 : o[i] > m[i] ? 1 : o[i] < m[i] ? -1 : 0));
      },
    },
  };

  // 风控与持仓参数：0 表示关闭/不限。range 为参数优化时的默认搜索范围 [起, 止, 步长]
  const RISK_PARAMS = {
    stopLoss: { label: '止损 %', def: 0, min: 0, max: 30, step: 1, range: [0, 15, 5] },
    takeProfit: { label: '止盈 %', def: 0, min: 0, max: 100, step: 5, range: [0, 40, 10] },
    trailATR: { label: 'ATR 移动止损倍数', def: 0, min: 0, max: 6, step: 0.5, range: [0, 4, 1] },
    maxPositions: { label: '最多持有几只', def: 0, min: 0, max: 50, step: 1, range: [1, 5, 1] },
    minHold: { label: '最短持有天数', def: 0, min: 0, max: 120, step: 1, range: [0, 10, 5] },
    maxHold: { label: '最长持有天数', def: 0, min: 0, max: 500, step: 5, range: [0, 60, 20] },
    cooldown: { label: '平仓后冷却天数', def: 0, min: 0, max: 60, step: 1, range: [0, 10, 5] },
  };

  function defaultParams(id) {
    return Object.fromEntries(Object.entries(RULES[id].params).map(([k, d]) => [k, d.def]));
  }

  const ROLES = { both: '入场和出场', entry: '只用于入场', exit: '只用于出场' };

  class RuleStrategy {
    /* config: {
     *   rules: [{ id, params, role: 'both'|'entry'|'exit' }],
     *   entry: 'all'|'any'（入场规则全部/任一看多）, exit: 'any'|'all'（出场规则任一/全部看空）,
     *   sizing: 'fixed'（每只 1/槽位数）|'equal'（持仓等分）|'invvol'（按 20 日波动率倒数加权）,
     *   stopLoss, takeProfit（%）, trailATR（倍数）, maxPositions, minHold, maxHold, cooldown（交易日）
     * } */
    constructor(config) {
      const unknown = (config.rules || []).find((r) => !RULES[r.id]);
      if (unknown) throw new Error('未知规则：' + unknown.id);
      const rules = (config.rules || []).map((r) => ({
        id: r.id,
        role: ROLES[r.role] ? r.role : 'both',
        params: { ...defaultParams(r.id), ...r.params },
      }));
      if (!rules.length) throw new Error('至少添加一条规则');
      if (!rules.some((r) => r.role !== 'exit')) throw new Error('至少要有一条规则用于入场');
      for (const r of rules) {
        const def = RULES[r.id];
        for (const [k, spec] of Object.entries(def.params)) {
          if (!(r.params[k] >= spec.min)) throw new Error(`${def.label}的"${spec.label}"不能小于 ${spec.min}`);
        }
        const msg = def.check ? def.check(r.params) : true;
        if (msg !== true) throw new Error(`${def.label}：${msg}`);
      }
      for (const [k, spec] of Object.entries(RISK_PARAMS)) {
        const v = +config[k] || 0;
        if (v < 0) throw new Error(`"${spec.label}"不能为负`);
      }
      this.name = 'rules';
      this.rules = rules;
      this.entry = config.entry === 'any' ? 'any' : 'all';
      this.exit = config.exit === 'all' ? 'all' : 'any';
      this.sizing = ['equal', 'invvol'].includes(config.sizing) ? config.sizing : 'fixed';
      this.stopLoss = (+config.stopLoss || 0) / 100;
      this.takeProfit = (+config.takeProfit || 0) / 100;
      this.trailATR = +config.trailATR || 0;
      this.maxPositions = Math.floor(+config.maxPositions || 0);
      this.minHold = Math.floor(+config.minHold || 0);
      this.maxHold = Math.floor(+config.maxHold || 0);
      this.cooldown = Math.floor(+config.cooldown || 0);
    }

    params() {
      const out = {};
      this.rules.forEach((r) => Object.entries(r.params).forEach(([k, v]) => (out[`${r.id}.${k}`] = v)));
      return Object.assign(out, {
        stopLoss: this.stopLoss * 100, takeProfit: this.takeProfit * 100, trailATR: this.trailATR,
        maxPositions: this.maxPositions, minHold: this.minHold, maxHold: this.maxHold, cooldown: this.cooldown,
      });
    }

    // 回测引擎调用：预先计算各规则的信号序列
    prepare(close, dates, symbols, bars) {
      const N = symbols.length;
      this.ctx = {
        close, symbols, N,
        slots: this.maxPositions > 0 ? Math.min(this.maxPositions, N) : N,
        entryIdx: this.rules.map((r, j) => (r.role !== 'exit' ? j : -1)).filter((j) => j >= 0),
        exitIdx: this.rules.map((r, j) => (r.role !== 'entry' ? j : -1)).filter((j) => j >= 0),
        state: symbols.map((s) => ({
          sigs: this.rules.map((r) => RULES[r.id].signal(bars, s, r.params)),
          atr: this.trailATR ? cached(bars, s, 'atr14', () => ind.atr(bars.high[s], bars.low[s], bars.close[s], 14)) : null,
          vol: this.sizing === 'invvol' ? cached(bars, s, 'vol20', () => annVol(bars.close[s], 20)) : null,
          // 入选排序（信号多于空余仓位时）用近 20 日涨幅（不足 20 日时用已有天数）
          first: close[s].findIndex(fin),
          peakEntry: -1, peak: NaN,
        })),
        desired: new Uint8Array(N),
        emitted: false,
        // 时点股票池：不在池内不能新买入，持仓被剔出股票池后卖出
        member: bars && bars.member ? symbols.map((s) => bars.member[s]) : null,
      };
    }

    /* 每天收盘后调用。ctx.shares 为实际持股，ctx.book[s] 为实际成交状态：
     * cost 含费用的平均成本价、entry 建仓成交日、exit 最近清仓成交日。
     * 止损、止盈、移动止损、最短/最长持有、冷却期全部以实际成交为准。 */
    decide(i, { shares, book }) {
      const c0 = this.ctx;
      const { close, symbols, N, slots, entryIdx, exitIdx, state, desired, member } = c0;
      const allOf = (st, idx, v) => idx.length > 0 && idx.every((j) => st.sigs[j][i] === v);
      const anyOf = (st, idx, v) => idx.some((j) => st.sigs[j][i] === v);
      const entrySignal = (st) => (this.entry === 'all' ? allOf(st, entryIdx, 1) : anyOf(st, entryIdx, 1));
      let changed = !c0.emitted;

      // 1) 已持有的：按实际成本价与成交日判断出场；未成交的买入意图：信号消失就撤销
      for (let k = 0; k < N; k++) {
        if (!desired[k]) continue;
        const s = symbols[k];
        const st = state[k];
        const c = close[s][i];
        if (!fin(c)) continue;
        const bk = book[s];
        if (!(shares[s] > 0)) {
          if (!entrySignal(st) || (member && !member[k][i])) { desired[k] = 0; changed = true; }
          continue;
        }
        if (st.peakEntry !== bk.entry) {
          // 新仓位（或切换参数后接手的仓位）：峰值从建仓成交日算起
          st.peakEntry = bk.entry;
          st.peak = bk.cost;
          for (let j = Math.max(bk.entry, 0); j < i; j++) if (close[s][j] > st.peak) st.peak = close[s][j];
        }
        st.peak = Math.max(st.peak, c);
        const held = i - bk.entry;
        let exit = false;
        if (held >= this.minHold) {
          exit = this.exit === 'any' ? anyOf(st, exitIdx, -1) : allOf(st, exitIdx, -1);
          if (this.takeProfit && c >= bk.cost * (1 + this.takeProfit)) exit = true;
        }
        // 止损类不受最短持有期限制
        if (this.stopLoss && c <= bk.cost * (1 - this.stopLoss)) exit = true;
        if (this.trailATR && fin(st.atr[i]) && c < st.peak - this.trailATR * st.atr[i]) exit = true;
        if (this.maxHold && held >= this.maxHold) exit = true;
        if (member && !member[k][i]) exit = true;
        if (exit) { desired[k] = 0; changed = true; }
      }

      // 2) 入场：候选多于空余仓位时按近 20 日涨幅择优；冷却期按实际清仓成交日计算
      const free = slots - desired.reduce((a, b) => a + b, 0);
      if (free > 0) {
        const cands = [];
        for (let k = 0; k < N; k++) {
          if (desired[k]) continue;
          const s = symbols[k];
          if (!fin(close[s][i]) || shares[s] > 0 || i - book[s].exit <= this.cooldown) continue;
          if (member && !member[k][i]) continue;
          if (entrySignal(state[k])) cands.push(k);
        }
        if (cands.length > free && this.maxPositions > 0) {
          const score = (k) => {
            const c = close[symbols[k]];
            const r = c[i] / c[Math.max(state[k].first, i - 20)] - 1;
            return fin(r) ? r : -Infinity;
          };
          cands.sort((a, b) => score(b) - score(a));
        }
        for (const k of cands.slice(0, free)) { desired[k] = 1; changed = true; }
      }

      if (!changed) return null;
      c0.emitted = true;
      return this.weights(desired, state, i, slots);
    }

    /* 理想化预览：假设信号当天按收盘价全部成交，用于检查信号逻辑本身。
     * 回测一律走引擎的 decide 路径，以实际成交为准。 */
    generate(close, dates, symbols, bars) {
      this.prepare(close, dates, symbols, bars);
      const shares = Object.fromEntries(symbols.map((s) => [s, 0]));
      const book = Object.fromEntries(symbols.map((s) => [s, { cost: NaN, entry: -1, exit: -Infinity }]));
      return dates.map((_, i) => {
        const row = this.decide(i, { shares, book });
        if (row) {
          symbols.forEach((s, k) => {
            if (row[k] > 0 && !shares[s]) { shares[s] = 1; book[s] = { cost: close[s][i], entry: i, exit: book[s].exit }; }
            else if (!(row[k] > 0) && shares[s]) { shares[s] = 0; book[s] = { cost: NaN, entry: -1, exit: i }; }
          });
        }
        return row;
      });
    }

    weights(holding, state, i, slots) {
      const count = holding.reduce((a, b) => a + b, 0);
      if (this.sizing === 'invvol' && count) {
        // 波动率倒数加权；缺波动率数据的按持仓均值处理
        const inv = Array.from(holding, (h, k) => (h && state[k].vol[i] > 0 ? 1 / state[k].vol[i] : 0));
        const known = inv.filter((v) => v > 0);
        const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
        const raw = Array.from(holding, (h, k) => (h ? inv[k] || fill : 0));
        const total = raw.reduce((a, b) => a + b, 0);
        const budget = Math.min(1, count / slots) || 0;
        return raw.map((v) => (v / total) * budget);
      }
      const w = this.sizing === 'equal' ? (count ? 1 / count : 0) : 1 / slots;
      return Array.from(holding, (h) => (h ? w : 0));
    }
  }

  const api = { RULES, RISK_PARAMS, ROLES, RuleStrategy, defaultParams, annVol };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.AQ, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
