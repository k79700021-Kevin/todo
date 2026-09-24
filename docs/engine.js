/* A 股日线回测引擎（浏览器版）。逻辑与 Python 包 ashare_quant 一一对应，
 * 由 tests/test_web_parity.py 在同一份数据上比对两边的净值与成交。 */
(function (root) {
  'use strict';

  const LOT_SIZE = 100;
  const CHINEXT_REFORM = '2020-08-24';
  const STAMP_DUTY_CUT = '2023-08-28';
  const LIMIT_REL_TOL = 0.001;
  const TRADING_DAYS = 244;

  // ---------- 交易规则 ----------

  const isEtf = (s) => /^(51|15|56|58)/.test(s);

  function priceLimit(symbol, date) {
    if (isEtf(symbol)) return 0.10;
    if (/^(688|689)/.test(symbol)) return 0.20;
    if (/^(300|301)/.test(symbol)) return date >= CHINEXT_REFORM ? 0.20 : 0.10;
    if (/^(4|8|92)/.test(symbol)) return 0.30;
    return 0.10;
  }

  // 与 Python Decimal(str(x)).quantize(0.01, ROUND_HALF_UP) 一致（x > 0）
  function roundCentHalfUp(x) {
    const s = String(x);
    if (s.includes('e')) return Math.round(x * 100) / 100;
    const [ip, fp = ''] = s.split('.');
    if (fp.length <= 2) return x;
    let cents = BigInt(ip + fp.slice(0, 2));
    if (fp.charCodeAt(2) >= 53) cents += 1n;
    return Number(cents) / 100;
  }

  function isLimitUp(symbol, date, price, prevClose) {
    if (!(prevClose > 0)) return false;
    const raw = prevClose * (1 + priceLimit(symbol, date));
    const threshold = Math.min(roundCentHalfUp(raw), raw * (1 - LIMIT_REL_TOL));
    return price >= threshold - 1e-9;
  }

  function isLimitDown(symbol, date, price, prevClose) {
    if (!(prevClose > 0)) return false;
    const raw = prevClose * (1 - priceLimit(symbol, date));
    const threshold = Math.max(roundCentHalfUp(raw), raw * (1 + LIMIT_REL_TOL));
    return price <= threshold + 1e-9;
  }

  class FeeModel {
    constructor({ commissionRate = 0.00025, minCommission = 5.0, transferRate = 0.00001, stampDutyRate = null } = {}) {
      Object.assign(this, { commissionRate, minCommission, transferRate, stampDutyRate });
    }
    stampDuty(date) {
      if (this.stampDutyRate !== null) return this.stampDutyRate;
      return date >= STAMP_DUTY_CUT ? 0.0005 : 0.001;
    }
    cost(symbol, date, side, amount) {
      if (amount <= 0) return 0;
      let fee = Math.max(amount * this.commissionRate, this.minCommission);
      if (!isEtf(symbol)) {
        fee += amount * this.transferRate;
        if (side === 'sell') fee += amount * this.stampDuty(date);
      }
      return Number(fee.toFixed(2));
    }
  }

  // ---------- 引擎 ----------

  /* data: { symbol: { dates: ['YYYY-MM-DD'], open: [], close: [], volume?: [] } } */
  class Backtester {
    constructor(data, { initialCash = 1e6, fees = new FeeModel(), slippage = 0.0005, rebalanceBand = 0.01 } = {}) {
      const symbols = Object.keys(data).sort();
      if (!symbols.length) throw new Error('没有行情数据');
      const dateSet = new Set();
      symbols.forEach((s) => data[s].dates.forEach((d) => dateSet.add(d)));
      const dates = [...dateSet].sort();
      const pos = new Map(dates.map((d, i) => [d, i]));
      const n = dates.length;
      const open = {}, close = {}, high = {}, low = {}, volume = {}, tradable = {}, prevClose = {};
      for (const s of symbols) {
        const src = data[s];
        const o = new Array(n).fill(NaN), c = new Array(n).fill(NaN), t = new Array(n).fill(false);
        const h = new Array(n).fill(NaN), l = new Array(n).fill(NaN), v = new Array(n).fill(NaN);
        src.dates.forEach((d, j) => {
          const i = pos.get(d);
          o[i] = src.open[j];
          c[i] = src.close[j];
          // 缺少最高/最低价时用开盘、收盘近似
          h[i] = src.high ? src.high[j] : Math.max(o[i], c[i]);
          l[i] = src.low ? src.low[j] : Math.min(o[i], c[i]);
          v[i] = src.volume ? src.volume[j] : NaN;
          const vol = src.volume ? src.volume[j] : 1;
          t[i] = Number.isFinite(o[i]) && Number.isFinite(c[i]) && vol > 0;
        });
        high[s] = h; low[s] = l; volume[s] = v;
        const p = new Array(n).fill(NaN);
        let last = NaN;
        for (let i = 0; i < n; i++) {
          p[i] = last;
          if (Number.isFinite(c[i])) last = c[i];
        }
        open[s] = o; close[s] = c; tradable[s] = t; prevClose[s] = p;
      }
      Object.assign(this, { symbols, dates, open, close, high, low, volume, tradable, prevClose, initialCash, fees, slippage, rebalanceBand });
    }

    closeFfill() {
      return this.ffill(this.close);
    }

    ffill(panel) {
      const out = {};
      for (const s of this.symbols) {
        let last = NaN;
        out[s] = panel[s].map((v) => (Number.isFinite(v) ? (last = v) : last));
      }
      return out;
    }

    // 停牌日前向填充后的完整行情，按需构建并缓存，供需要高低价、成交量的策略使用
    bars() {
      if (!this._bars) {
        this._bars = {
          open: this.ffill(this.open), high: this.ffill(this.high), low: this.ffill(this.low),
          close: this.closeFfill(), volume: this.volume, cache: new Map(),
        };
      }
      return this._bars;
    }

    run(strategy) {
      const { symbols, dates } = this;
      const bars = this.bars();
      const signals = strategy.generate(bars.close, dates, symbols, bars);
      validateSignals(signals);

      let cash = this.initialCash;
      const shares = Object.fromEntries(symbols.map((s) => [s, 0]));
      const lastClose = Object.fromEntries(symbols.map((s) => [s, NaN]));
      let pending = null;
      const equity = [], trades = [];

      dates.forEach((d, i) => {
        if (pending) [cash, pending] = this.rebalance(i, pending, cash, shares, lastClose, trades);
        let value = 0;
        for (const s of symbols) {
          const c = this.close[s][i];
          if (Number.isFinite(c)) lastClose[s] = c;
          if (shares[s]) value += shares[s] * lastClose[s];
        }
        equity.push(cash + value);
        const row = signals[i];
        if (row) pending = new Map(symbols.map((s, k) => [s, Number.isFinite(row[k]) ? row[k] : 0]));
      });

      return {
        strategy: strategy.name,
        params: strategy.params(),
        dates,
        equity,
        trades,
        finalShares: { ...shares },
        // 最后一个交易日收盘后尚未执行的目标仓位（即下一交易日开盘要做的调整）
        nextTargets: pending ? Object.fromEntries(pending) : null,
        initialCash: this.initialCash,
      };
    }

    rebalance(i, targets, cash, shares, lastClose, trades) {
      const d = this.dates[i];
      const mark = (s) => (this.tradable[s][i] ? this.open[s][i] : lastClose[s]);
      let held = 0;
      for (const s of this.symbols) if (shares[s]) held += shares[s] * mark(s);
      const equity = cash + held;
      // targets 为 Map：键用纯数字代码，普通对象会被按数值重排，Map 保持插入顺序
      const unfilled = new Map();
      const sells = [], buys = [];
      for (const [s, w] of targets) {
        if (!this.tradable[s][i]) {
          if (w > 0 || shares[s] > 0) unfilled.set(s, w);
          continue;
        }
        const price = this.open[s][i];
        const target = w > 0 ? Math.floor((w * equity) / price / LOT_SIZE) * LOT_SIZE : 0;
        const delta = target - shares[s];
        if (target && shares[s] && Math.abs(delta) * price < this.rebalanceBand * equity) continue;
        if (delta < 0) sells.push([s, -delta, price, w]);
        else if (delta > 0) buys.push([s, delta, price, w]);
      }

      for (const [s, qty, price, w] of sells) {
        if (isLimitDown(s, d, price, this.prevClose[s][i])) { unfilled.set(s, w); continue; }
        const fill = price * (1 - this.slippage);
        const amount = qty * fill;
        const fee = this.fees.cost(s, d, 'sell', amount);
        cash += amount - fee;
        shares[s] -= qty;
        trades.push({ date: d, symbol: s, side: 'sell', shares: qty, price: fill, amount, fee });
      }

      buys.sort((a, b) => b[1] * b[2] - a[1] * a[2]);
      for (const [s, want, price, w] of buys) {
        if (isLimitUp(s, d, price, this.prevClose[s][i])) { unfilled.set(s, w); continue; }
        const fill = price * (1 + this.slippage);
        const qty = this.affordable(s, d, want, fill, cash);
        if (qty <= 0) continue;
        const amount = qty * fill;
        const fee = this.fees.cost(s, d, 'buy', amount);
        cash -= amount + fee;
        shares[s] += qty;
        trades.push({ date: d, symbol: s, side: 'buy', shares: qty, price: fill, amount, fee });
      }
      return [cash, unfilled.size ? unfilled : null];
    }

    affordable(s, d, qty, price, cash) {
      qty = Math.min(qty, Math.floor(cash / price / LOT_SIZE) * LOT_SIZE);
      while (qty > 0 && qty * price + this.fees.cost(s, d, 'buy', qty * price) > cash + 1e-9) qty -= LOT_SIZE;
      return Math.max(qty, 0);
    }
  }

  function validateSignals(signals) {
    for (const row of signals) {
      if (!row) continue;
      let sum = 0;
      for (const w of row) {
        if (w < 0) throw new Error('仅支持做多，目标权重不能为负');
        if (Number.isFinite(w)) sum += w;
      }
      if (sum > 1 + 1e-9) throw new Error('目标权重之和不能超过 1（不支持杠杆）');
    }
  }

  // ---------- 策略：generate(close, dates, symbols) -> 每日一行目标权重或 null ----------

  function rollingMean(arr, w) {
    const out = new Array(arr.length).fill(NaN);
    for (let i = w - 1; i < arr.length; i++) {
      let sum = 0, ok = true;
      for (let j = i - w + 1; j <= i; j++) {
        if (!Number.isFinite(arr[j])) { ok = false; break; }
        sum += arr[j];
      }
      if (ok) out[i] = sum / w;
    }
    return out;
  }

  class BuyAndHold {
    constructor() { this.name = 'buy_hold'; }
    params() { return {}; }
    generate(close, dates, symbols) {
      const out = dates.map(() => null);
      const i = dates.findIndex((_, k) => symbols.every((s) => Number.isFinite(close[s][k])));
      if (i >= 0) out[i] = symbols.map(() => 1 / symbols.length);
      return out;
    }
  }

  class DualMA {
    constructor({ fast = 20, slow = 60 } = {}) {
      if (!(fast > 0 && fast < slow)) throw new Error('需要 0 < 快线 < 慢线');
      Object.assign(this, { name: 'dual_ma', fast, slow });
    }
    params() { return { fast: this.fast, slow: this.slow }; }
    generate(close, dates, symbols) {
      const n = symbols.length;
      const on = symbols.map((s) => {
        const f = rollingMean(close[s], this.fast), sl = rollingMean(close[s], this.slow);
        return f.map((v, i) => v > sl[i] * (1 + 1e-9)); // 相对容差，与 Python 版一致
      });
      return dates.map((_, i) => {
        const changed = i === 0 || on.some((col) => col[i] !== col[i - 1]);
        return changed ? on.map((col) => (col[i] ? 1 : 0) / n) : null;
      });
    }
  }

  class MomentumRotation {
    constructor({ lookback = 60, topN = 2, rebalance = 20, absFilter = true } = {}) {
      if (!(lookback > 0 && topN > 0 && rebalance > 0)) throw new Error('回看天数、持有数量、调仓间隔都必须为正');
      Object.assign(this, { name: 'momentum', lookback, topN, rebalance, absFilter });
    }
    params() {
      return { lookback: this.lookback, top_n: this.topN, rebalance: this.rebalance, abs_filter: this.absFilter };
    }
    generate(close, dates, symbols) {
      const out = dates.map(() => null);
      const top = Math.min(this.topN, symbols.length);
      for (let i = this.lookback; i < dates.length; i += this.rebalance) {
        let scores = symbols
          .map((s, k) => [k, close[s][i] / close[s][i - this.lookback] - 1])
          .filter(([, v]) => Number.isFinite(v));
        if (this.absFilter) scores = scores.filter(([, v]) => v > 0);
        scores.sort((a, b) => b[1] - a[1]);
        const row = symbols.map(() => 0);
        scores.slice(0, top).forEach(([k]) => (row[k] = 1 / top));
        out[i] = row;
      }
      return out;
    }
  }

  // ---------- 绩效 ----------

  function equityMetrics(equity, rf = 0.02) {
    const ret = [];
    for (let i = 1; i < equity.length; i++) ret.push(equity[i] / equity[i - 1] - 1);
    if (ret.length < 2) return {};
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const total = equity[equity.length - 1] / equity[0] - 1;
    const years = ret.length / TRADING_DAYS;
    const cagr = total > -1 ? Math.pow(1 + total, 1 / years) - 1 : -1;
    const excess = ret.map((r) => r - rf / TRADING_DAYS);
    const mr = mean(ret);
    const std = Math.sqrt(ret.reduce((a, r) => a + (r - mr) ** 2, 0) / (ret.length - 1));
    const sharpe = std > 0 ? (mean(excess) / std) * Math.sqrt(TRADING_DAYS) : NaN;
    const downside = Math.sqrt(mean(excess.map((e) => Math.min(e, 0) ** 2))) * Math.sqrt(TRADING_DAYS);
    const sortino = downside > 0 ? (mean(excess) * TRADING_DAYS) / downside : NaN;
    let peak = -Infinity, mdd = 0, run = 0, longest = 0;
    const drawdown = equity.map((v) => {
      peak = Math.max(peak, v);
      const dd = v / peak - 1;
      mdd = Math.min(mdd, dd);
      run = dd < 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
      return dd;
    });
    return {
      total_return: total,
      cagr,
      volatility: std * Math.sqrt(TRADING_DAYS),
      sharpe,
      sortino,
      max_drawdown: mdd,
      calmar: mdd < 0 ? cagr / Math.abs(mdd) : NaN,
      max_dd_days: longest,
      daily_win_rate: ret.filter((r) => r > 0).length / ret.length,
      _drawdown: drawdown,
    };
  }

  function summarize(result, rf = 0.02) {
    const m = equityMetrics(result.equity, rf);
    const years = Math.max(result.equity.length - 1, 1) / TRADING_DAYS;
    const meanEquity = result.equity.reduce((a, b) => a + b, 0) / result.equity.length;
    const traded = result.trades.reduce((a, t) => a + t.amount, 0);
    return Object.assign(m, {
      final_equity: result.equity[result.equity.length - 1],
      trades: result.trades.length,
      total_fees: result.trades.reduce((a, t) => a + t.fee, 0),
      annual_turnover: result.trades.length ? traded / meanEquity / years : 0,
    });
  }

  const api = {
    LOT_SIZE, TRADING_DAYS, isEtf, priceLimit, isLimitUp, isLimitDown, FeeModel,
    Backtester, BuyAndHold, DualMA, MomentumRotation, equityMetrics, summarize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AQ = Object.assign(root.AQ || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
