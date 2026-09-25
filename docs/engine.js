/* A 股日线回测引擎（浏览器版）。逻辑与 Python 包 ashare_quant 一一对应，
 * 由 tests/test_web_parity.py 在同一份数据上比对两边的净值与成交。 */
(function (root) {
  'use strict';

  const LOT_SIZE = 100;
  const CHINEXT_REFORM = '2020-08-24';
  const LIMIT_REL_TOL = 0.001;
  const TRADING_DAYS = 244;

  // ---------- 交易规则 ----------

  const isEtf = (s) => /^(51|15|56|58)/.test(s);

  // 历史规则表（规则本身也是时点数据），与 Python 版 rules.py 一致
  // 印花税：[生效日, 税率, 是否买卖双向]
  const STAMP_DUTY_HISTORY = [
    ['1900-01-01', 0.002, true], ['2005-01-24', 0.001, true], ['2007-05-30', 0.003, true],
    ['2008-04-24', 0.001, true], ['2008-09-19', 0.001, false], ['2023-08-28', 0.0005, false],
  ];
  // 过户费：2015-08-01 前仅沪市股票按股数（每股 0.001 元、最低 1 元），之后沪深统一按成交额
  const TRANSFER_PER_SHARE_UNTIL = '2015-08-01';
  const TRANSFER_HISTORY = [['2015-08-01', 0.00002], ['2022-04-29', 0.00001]];
  function regime(table, date) {
    let out = null;
    for (const row of table) if (row[0] <= date) out = row;
    return out;
  }

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
    constructor({ commissionRate = 0.00025, minCommission = 5.0, transferRate = null, stampDutyRate = null } = {}) {
      Object.assign(this, { commissionRate, minCommission, transferRate, stampDutyRate });
    }
    stampDuty(date, side = 'sell') {
      if (this.stampDutyRate !== null && this.stampDutyRate !== undefined) return side === 'sell' ? this.stampDutyRate : 0;
      const [, rate, both] = regime(STAMP_DUTY_HISTORY, date);
      return side === 'sell' || both ? rate : 0;
    }
    transfer(symbol, date, amount, shares) {
      if (this.transferRate !== null && this.transferRate !== undefined) return amount * this.transferRate;
      if (date < TRANSFER_PER_SHARE_UNTIL) return /^[69]/.test(symbol) ? Math.max((shares || 0) * 0.001, 1) : 0;
      return amount * regime(TRANSFER_HISTORY, date)[1];
    }
    cost(symbol, date, side, amount, shares) {
      if (amount <= 0) return 0;
      let fee = Math.max(amount * this.commissionRate, this.minCommission);
      if (!isEtf(symbol)) {
        fee += this.transfer(symbol, date, amount, shares);
        fee += amount * this.stampDuty(date, side);
      }
      return Number(fee.toFixed(2));
    }
  }

  // ---------- 引擎 ----------

  /* data: { symbol: { dates: ['YYYY-MM-DD'], open: [], close: [], high?, low?, volume?, raw?: 不复权收盘, turnover?: 换手率% } }
   * meta（可选，个股研究用）：
   *   universe: { symbol: [[纳入日, 剔除日或 null], ...] }：时点股票池，纳入日当天起算、剔除日当天起不再是成分；
   *     给出后，不在池内的标的不能新买入，基准为当期成分等权
   *   delisted: { symbol: 退市日 }：此后仍持有的股份按最后价格 × delistRecovery 注销
   *   fundamentals: { symbol: [{ report, notice, eps, bps, revYoy, profitYoy }] }：财务数据，公告日之后才可用 */
  class Backtester {
    constructor(data, { initialCash = 1e6, fees = new FeeModel(), slippage = 0.0005, rebalanceBand = 0.01, meta = null, delistRecovery = 0, participation = 0, impact = 0 } = {}) {
      const symbols = Object.keys(data).sort();
      if (!symbols.length) throw new Error('没有行情数据');
      const dateSet = new Set();
      symbols.forEach((s) => data[s].dates.forEach((d) => dateSet.add(d)));
      const dates = [...dateSet].sort();
      const pos = new Map(dates.map((d, i) => [d, i]));
      const n = dates.length;
      const open = {}, close = {}, high = {}, low = {}, volume = {}, tradable = {}, prevClose = {}, raw = {}, turnover = {};
      for (const s of symbols) {
        const src = data[s];
        // 开盘、收盘（涨跌停判断用）保持双精度；其余用单精度省内存（个股池有几百只标的）
        const o = new Float64Array(n).fill(NaN), c = new Float64Array(n).fill(NaN), t = new Uint8Array(n);
        const h = new Float32Array(n).fill(NaN), l = new Float32Array(n).fill(NaN), v = new Float32Array(n).fill(NaN);
        const rw = src.raw ? new Float64Array(n).fill(NaN) : null, tv = src.turnover ? new Float32Array(n).fill(NaN) : null;
        src.dates.forEach((d, j) => {
          const i = pos.get(d);
          if (rw) rw[i] = src.raw[j];
          if (tv) tv[i] = src.turnover[j];
          o[i] = src.open[j];
          c[i] = src.close[j];
          // 缺少最高/最低价时用开盘、收盘近似
          h[i] = src.high ? src.high[j] : Math.max(o[i], c[i]);
          l[i] = src.low ? src.low[j] : Math.min(o[i], c[i]);
          v[i] = src.volume ? src.volume[j] : NaN;
          const vol = src.volume ? src.volume[j] : 1;
          t[i] = o[i] > 0 && c[i] > 0 && vol > 0 ? 1 : 0; // 价格非正（坏数据）也视为不可交易
        });
        high[s] = h; low[s] = l; volume[s] = v;
        if (rw) raw[s] = rw;
        if (tv) turnover[s] = tv;
        const p = new Float64Array(n).fill(NaN);
        let last = NaN;
        for (let i = 0; i < n; i++) {
          p[i] = last;
          if (Number.isFinite(c[i])) last = c[i];
        }
        open[s] = o; close[s] = c; tradable[s] = t; prevClose[s] = p;
      }
      Object.assign(this, { symbols, dates, open, close, high, low, volume, tradable, prevClose, raw, turnover, initialCash, fees, slippage, rebalanceBand });
      this.meta = meta || {};
      this.delistRecovery = delistRecovery;
      /* 成交容量与冲击成本（0 = 不启用）：
       *   participation：单只标的单日成交额不超过前 20 日平均成交额的这个比例，超出部分次日继续；
       *   impact：平方根冲击系数，额外滑点 = impact × 前 20 日日波动率 × √(成交额 / 前 20 日平均成交额)。
       * 成交额 = 成交量（手）× 100 × 不复权收盘价（没有不复权价时用收盘价），只用前一日及以前的数据。 */
      this.participation = participation;
      this.impact = impact;
      if (participation > 0 || impact > 0) this.liquidity(data);
      // 时点股票池：member[s][i] = 1 表示第 i 天收盘时是成分股
      this.member = null;
      if (this.meta.universe) {
        this.member = {};
        for (const s of symbols) {
          const m = new Uint8Array(n);
          for (const [from, to] of this.meta.universe[s] || []) {
            for (let i = 0; i < n; i++) if (dates[i] >= from && (!to || dates[i] < to)) m[i] = 1;
          }
          this.member[s] = m;
        }
      }
      // 退市：第一个晚于退市日的交易日序号
      this.delistAt = {};
      for (const [s, d] of Object.entries(this.meta.delisted || {})) {
        if (!symbols.includes(s)) continue;
        const i = dates.findIndex((x) => x > d);
        if (i >= 0) this.delistAt[s] = i;
      }
    }

    liquidity(data) {
      const n = this.dates.length;
      this.adv = {};
      this.sigma = {};
      this.hasVolume = {};
      for (const s of this.symbols) {
        const v = this.volume[s], c = this.close[s], px = this.raw[s] || c;
        const adv = new Float64Array(n).fill(NaN), sig = new Float64Array(n).fill(NaN);
        const amt = [], ret = [];
        let prev = NaN;
        for (let i = 0; i < n; i++) {
          // 先用前 20 日的数据给出第 i 天的值，再把第 i 天加入窗口
          const a = amt.filter(Number.isFinite);
          if (a.length >= 10) adv[i] = a.reduce((x, y) => x + y, 0) / a.length;
          const r = ret.filter(Number.isFinite);
          if (r.length >= 10) {
            const m = r.reduce((x, y) => x + y, 0) / r.length;
            sig[i] = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1));
          }
          amt.push(v[i] > 0 && px[i] > 0 ? v[i] * 100 * px[i] : NaN);
          ret.push(c[i] > 0 && prev > 0 ? c[i] / prev - 1 : NaN);
          if (c[i] > 0) prev = c[i];
          if (amt.length > 20) amt.shift();
          if (ret.length > 20) ret.shift();
        }
        this.adv[s] = adv;
        this.hasVolume[s] = v.some((x) => x > 0);
        this.sigma[s] = sig;
      }
    }

    // 按容量限制截断的股数与冲击滑点
    capacity(s, i, qty, price) {
      const adv = this.adv ? this.adv[s][i] : NaN;
      if (!(adv > 0)) {
        // 有成交量数据但历史不足 10 天（刚开始或刚上市）：设了参与率上限时先不成交，等积累历史；完全没有成交量数据的不限制
        if (this.participation > 0 && this.hasVolume[s]) return { qty: 0, slip: this.slippage, capped: true };
        return { qty, slip: this.slippage, capped: false };
      }
      let q = qty, capped = false;
      if (this.participation > 0) {
        const max = Math.floor((this.participation * adv) / price / LOT_SIZE) * LOT_SIZE;
        if (q > max) { q = max; capped = true; }
      }
      const sig = this.sigma[s][i];
      const extra = this.impact > 0 && sig > 0 ? this.impact * sig * Math.sqrt((q * price) / adv) : 0;
      return { qty: q, slip: this.slippage + extra, capped };
    }

    closeFfill() {
      return this.ffill(this.close);
    }

    ffill(panel) {
      const out = {};
      for (const s of this.symbols) {
        if (!panel[s]) continue;
        let last = NaN;
        out[s] = Array.from(panel[s], (v) => (Number.isFinite(v) ? (last = v) : last));
      }
      return out;
    }

    // 停牌日前向填充后的完整行情，各项在第一次用到时才构建并缓存（个股池省内存）
    bars() {
      if (!this._bars) {
        const self = this;
        const lazy = {};
        const b = { volume: this.volume, turnover: this.turnover, member: this.member, meta: this.meta, dates: this.dates, cache: new Map() };
        for (const k of ['open', 'high', 'low', 'close', 'raw']) {
          Object.defineProperty(b, k, {
            enumerable: true,
            get() { return lazy[k] || (lazy[k] = self.ffill(self[k])); },
          });
        }
        this._bars = b;
      }
      return this._bars;
    }

    /* 两种策略接口：
     * - generate(close, dates, symbols, bars)：一次性给出整段目标权重（不依赖实际成交的策略，如轮动、多因子）
     * - prepare(...) + decide(i, ctx)：每天收盘后根据"实际成交状态"决定目标权重（止损、持有期等依赖成本价和成交日的策略）
     *   ctx.shares 为实际持股，ctx.pending 为尚未成交、次日继续执行的目标（Map 或 null），ctx.book[s] = { cost: 含费用的平均成本价, entry: 建仓成交日序号, exit: 最近清仓成交日序号 } */
    run(strategy) {
      const { symbols, dates } = this;
      const bars = this.bars();
      const live = typeof strategy.decide === 'function';
      let signals = null;
      if (live) strategy.prepare(bars.close, dates, symbols, bars);
      else {
        signals = strategy.generate(bars.close, dates, symbols, bars);
        validateSignals(signals);
      }

      let cash = this.initialCash;
      const shares = Object.fromEntries(symbols.map((s) => [s, 0]));
      const book = Object.fromEntries(symbols.map((s) => [s, { cost: NaN, entry: -1, exit: -Infinity }]));
      const lastClose = Object.fromEntries(symbols.map((s) => [s, NaN]));
      let pending = null;
      const equity = [], trades = [];
      const ctx = { shares, book };

      dates.forEach((d, i) => {
        // 退市：仍持有的股份按最后价格 × 回收比例注销，记为一笔卖出
        for (const s in this.delistAt) {
          if (i < this.delistAt[s]) continue;
          if (pending) pending.delete(s);
          if (!shares[s]) continue;
          const price = lastClose[s] * this.delistRecovery;
          const amount = shares[s] * price;
          cash += amount;
          trades.push({ date: d, symbol: s, side: 'sell', shares: shares[s], price, amount, fee: 0, delisted: true });
          shares[s] = 0;
          book[s] = { cost: NaN, entry: -1, exit: i };
        }
        if (pending && !pending.size) pending = null;
        if (pending) [cash, pending] = this.rebalance(i, pending, cash, shares, lastClose, trades, book);
        let value = 0;
        for (const s of symbols) {
          const c = this.close[s][i];
          if (Number.isFinite(c)) lastClose[s] = c;
          if (shares[s]) value += shares[s] * lastClose[s];
        }
        equity.push(cash + value);
        ctx.pending = pending;
        const row = live ? strategy.decide(i, ctx) : signals[i];
        if (row) {
          if (live) validateSignals([row]);
          pending = new Map(symbols.map((s, k) => [s, Number.isFinite(row[k]) ? row[k] : 0]));
        }
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

    rebalance(i, targets, cash, shares, lastClose, trades, book) {
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

      for (const [s, want, price, w] of sells) {
        if (isLimitDown(s, d, price, this.prevClose[s][i])) { unfilled.set(s, w); continue; }
        const cap = this.capacity(s, i, want, price);
        if (cap.capped) unfilled.set(s, w);
        const qty = cap.qty;
        if (qty <= 0) continue;
        const fill = price * (1 - cap.slip);
        const amount = qty * fill;
        const fee = this.fees.cost(s, d, 'sell', amount, qty);
        cash += amount - fee;
        shares[s] -= qty;
        trades.push({ date: d, symbol: s, side: 'sell', shares: qty, price: fill, amount, fee, impact: qty * price * (cap.slip - this.slippage) });
        if (book && shares[s] === 0) book[s] = { cost: NaN, entry: -1, exit: i };
      }

      buys.sort((a, b) => b[1] * b[2] - a[1] * a[2]);
      for (const [s, want0, price, w] of buys) {
        if (isLimitUp(s, d, price, this.prevClose[s][i])) { unfilled.set(s, w); continue; }
        const cap = this.capacity(s, i, want0, price);
        if (cap.capped) unfilled.set(s, w);
        const fill = price * (1 + cap.slip);
        const qty = this.affordable(s, d, cap.qty, fill, cash);
        if (qty <= 0) continue;
        const amount = qty * fill;
        const fee = this.fees.cost(s, d, 'buy', amount, qty);
        cash -= amount + fee;
        if (book) {
          const bk = book[s];
          // 成本价含费用；从空仓买入时记录建仓成交日
          bk.cost = shares[s] > 0 ? (bk.cost * shares[s] + amount + fee) / (shares[s] + qty) : (amount + fee) / qty;
          if (shares[s] === 0) bk.entry = i;
        }
        shares[s] += qty;
        trades.push({ date: d, symbol: s, side: 'buy', shares: qty, price: fill, amount, fee, impact: qty * price * (cap.slip - this.slippage) });
      }
      return [cash, unfilled.size ? unfilled : null];
    }

    affordable(s, d, qty, price, cash) {
      qty = Math.min(qty, Math.floor(cash / price / LOT_SIZE) * LOT_SIZE);
      while (qty > 0 && qty * price + this.fees.cost(s, d, 'buy', qty * price, qty) > cash + 1e-9) qty -= LOT_SIZE;
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
    generate(close, dates, symbols, bars) {
      const out = dates.map(() => null);
      const member = bars && bars.member;
      if (member) {
        // 时点股票池：持有当期全部成分股等权，成分变化时调仓
        let prev = '';
        dates.forEach((_, i) => {
          const on = symbols.map((s) => member[s][i] === 1 && Number.isFinite(close[s][i]));
          const key = on.map(Number).join('');
          const count = on.filter(Boolean).length;
          if (key !== prev && count) out[i] = on.map((x) => (x ? 1 / count : 0));
          prev = key;
        });
        return out;
      }
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
    generate(close, dates, symbols, bars) {
      const out = dates.map(() => null);
      const top = Math.min(this.topN, symbols.length);
      const member = bars && bars.member;
      for (let i = this.lookback; i < dates.length; i += this.rebalance) {
        let scores = symbols
          .map((s, k) => [k, member && !member[s][i] ? NaN : close[s][i] / close[s][i - this.lookback] - 1])
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
      total_impact: result.trades.reduce((a, t) => a + (t.impact || 0), 0),
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
