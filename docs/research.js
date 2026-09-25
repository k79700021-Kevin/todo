/* 研究工具：参数优化（网格/随机）、滚动前推检验、通缩夏普比率、时序统计与因子 IC。 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const AQ = isNode
    ? Object.assign({ ind: require('./indicators.js') }, require('./engine.js'), require('./rules.js'))
    : root.AQ;
  const ind = AQ.ind;
  const TD = 244;
  const fin = Number.isFinite;

  // ---------- 基础统计 ----------

  function mean(a) {
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  }

  function moments(a) {
    const n = a.length;
    const m = mean(a);
    let m2 = 0, m3 = 0, m4 = 0;
    for (const v of a) {
      const d = v - m;
      m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
    }
    m2 /= n; m3 /= n; m4 /= n;
    return {
      n, mean: m,
      std: Math.sqrt((m2 * n) / (n - 1)),
      skew: m2 > 0 ? m3 / m2 ** 1.5 : NaN,
      kurt: m2 > 0 ? m4 / (m2 * m2) : NaN, // 非超额峰度，正态分布为 3
    };
  }

  function normCdf(x) {
    // Abramowitz–Stegun 7.1.26，误差 < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }

  function normInv(p) {
    // Acklam 有理逼近，相对误差 < 1.2e-9
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - lo) return -normInv(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // 秩（从 1 开始，并列取平均秩）：原生数值排序后二分查找，比按下标排序快得多
  function ranks(a) {
    const n = a.length;
    const sorted = Float64Array.from(a).sort();
    const r = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = a[i];
      let lo = 0, hi = n;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
      let up = lo, top = n;
      while (up < top) { const m = (up + top) >> 1; if (sorted[m] <= v) up = m + 1; else top = m; }
      r[i] = (lo + up + 1) / 2;
    }
    return r;
  }

  function pearson(x, y) {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }

  const spearman = (x, y) => pearson(ranks(x), ranks(y));

  function acf(r, maxLag) {
    const m = mean(r);
    let den = 0;
    for (const v of r) den += (v - m) ** 2;
    const out = [];
    for (let k = 1; k <= maxLag; k++) {
      let num = 0;
      for (let t = k; t < r.length; t++) num += (r[t] - m) * (r[t - k] - m);
      out.push(den > 0 ? num / den : NaN);
    }
    return out;
  }

  // Lo–MacKinlay 方差比（同方差假设下的 z 值）：>1 偏动量，<1 偏均值回归
  function varianceRatio(r, q) {
    const T = r.length;
    const mu = mean(r);
    let v1 = 0;
    for (const x of r) v1 += (x - mu) ** 2;
    v1 /= T - 1;
    let s = 0;
    for (let t = 0; t < q; t++) s += r[t];
    let vq = (s - q * mu) ** 2;
    for (let t = q; t < T; t++) {
      s += r[t] - r[t - q];
      vq += (s - q * mu) ** 2;
    }
    vq /= q * (T - q + 1) * (1 - q / T);
    const vr = vq / v1;
    const z = (vr - 1) / Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * T));
    return { vr, z };
  }

  function returnsOf(prices) {
    const out = [];
    for (let i = 1; i < prices.length; i++) {
      const r = prices[i] / prices[i - 1] - 1;
      if (fin(r)) out.push(r);
    }
    return out;
  }

  // ---------- 区间绩效（优化时对净值曲线切片计算，避免重复回测） ----------

  function segStats(eq, a, b, rf = 0.02) {
    const n = b - a;
    if (n < 2) return null;
    const rfd = rf / TD;
    let s = 0, s2 = 0, dn = 0, peak = eq[a], mdd = 0;
    for (let i = a + 1; i <= b; i++) {
      const r = eq[i] / eq[i - 1] - 1;
      s += r; s2 += r * r;
      const e = r - rfd;
      if (e < 0) dn += e * e;
      if (eq[i] > peak) peak = eq[i];
      const dd = eq[i] / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    const m = s / n;
    const std = Math.sqrt(Math.max((s2 - n * m * m) / (n - 1), 0));
    const total = eq[b] / eq[a] - 1;
    const cagr = total > -1 ? Math.pow(1 + total, TD / n) - 1 : -1;
    const downside = Math.sqrt(dn / n) * Math.sqrt(TD);
    return {
      total_return: total,
      cagr,
      sharpe: std > 0 ? ((m - rfd) / std) * Math.sqrt(TD) : NaN,
      sortino: downside > 0 ? ((m - rfd) * TD) / downside : NaN,
      calmar: mdd < 0 ? cagr / -mdd : NaN,
      max_drawdown: mdd,
      volatility: std * Math.sqrt(TD),
      srDaily: std > 0 ? (m - rfd) / std : NaN,
      days: n,
    };
  }

  /* 通缩夏普比率（Bailey & López de Prado, 2014）。
   * srs：所有试验的日频夏普；best：选中者的日频夏普；T：样本天数；skew/kurt：选中者日收益的偏度与（非超额）峰度。
   * 返回在"试了这么多次"的前提下，真实夏普 > 0 的概率。 */
  function deflatedSharpe(srs, best, T, skew, kurt, trials) {
    // trials：累计试验次数（含以前在同一份数据上做过的），不小于本次的试验数；方差仍按本次试验估计
    const N = Math.max(srs.length, trials || 0);
    let sr0 = 0;
    if (N >= 2 && srs.length >= 2) {
      const m = mean(srs);
      const v = srs.reduce((a, x) => a + (x - m) ** 2, 0) / (srs.length - 1);
      const g = 0.5772156649015329;
      sr0 = Math.sqrt(v) * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
    }
    const denom = Math.sqrt(Math.max(1 - skew * best + ((kurt - 1) / 4) * best * best, 1e-12));
    const z = ((best - sr0) * Math.sqrt(T - 1)) / denom;
    return { sr0, prob: normCdf(z), trials: N };
  }

  // ---------- 参数空间 ----------

  function rangeValues({ min, max, step }) {
    const out = [];
    if (!(step > 0) || !(max >= min)) return [min];
    const n = Math.floor((max - min) / step + 1e-9);
    for (let i = 0; i <= n && out.length < 1000; i++) out.push(+(min + i * step).toFixed(6));
    return out;
  }

  function gridSize(space) {
    return space.reduce((a, d) => a * d.values.length, 1);
  }

  function* gridIter(space) {
    const idx = new Array(space.length).fill(0);
    const total = gridSize(space);
    for (let c = 0; c < total; c++) {
      yield space.map((d, k) => d.values[idx[k]]);
      for (let k = space.length - 1; k >= 0; k--) {
        if (++idx[k] < space[k].values.length) break;
        idx[k] = 0;
      }
    }
  }

  function randomCombos(space, count, seed = 1) {
    let x = seed >>> 0 || 1;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const seen = new Set();
    const out = [];
    const cap = Math.min(count, gridSize(space));
    let guard = 0;
    while (out.length < cap && guard++ < cap * 50) {
      const combo = space.map((d) => d.values[Math.floor(rnd() * d.values.length)]);
      const key = combo.join(',');
      if (!seen.has(key)) { seen.add(key); out.push(combo); }
    }
    return out;
  }

  /* 参数路径：r<规则序号>.<参数名>（规则参数）、risk.<参数名>（风控与持仓）、
   * f<因子序号>.weight（因子权重）、fs.<参数名>（多因子策略的持有数量等） */
  function applyParams(config, space, combo) {
    const cfg = JSON.parse(JSON.stringify(config));
    (cfg.rules || []).forEach((r) => (r.params = r.params || {}));
    space.forEach((d, k) => {
      const [head, key] = d.path.split('.');
      if (head === 'risk') cfg[key] = combo[k];
      else if (head === 'fs') cfg.factor[key] = combo[k];
      else if (head[0] === 'f') cfg.factor.factors[+head.slice(1)][key] = combo[k];
      else cfg.rules[+head.slice(1)].params[key] = combo[k];
    });
    return cfg;
  }

  function makeBacktester(data, engine) {
    return new AQ.Backtester(data, {
      initialCash: engine.initialCash,
      fees: new AQ.FeeModel(engine.fees || {}),
      slippage: engine.slippage,
      rebalanceBand: engine.rebalanceBand,
      meta: engine.meta || null,
      delistRecovery: engine.delistRecovery || 0,
    });
  }

  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  const tradesIn = (idx, a, b) => lowerBound(idx, b + 1) - lowerBound(idx, a + 1);

  const score = (st, objective) => (st && fin(st[objective]) ? st[objective] : -Infinity);

  /* 参数优化主流程：训练 / 验证 / 测试三段。
   * 训练集给所有参数组合排序；在训练排名前 10%（至少 5 组）中挑验证集表现最好的作为"选定参数"；
   * 测试集只计算选定参数一组，供最后一次性检验。滚动前推只在训练+验证段内进行，不触碰测试集。
   * input: { data, engine, config, space: [{path, label, values}], method: 'grid'|'random', samples,
   *          objective, minTrades, valStart, testStart, rf, wf: { enabled, trainYears, testYears, anchored } } */
  function optimize(input, onProgress = () => {}) {
    const { data, engine, config, space, objective = 'sharpe', minTrades = 0, rf = 0.02 } = input;
    if (!space.length) throw new Error('至少勾选一个要优化的参数');
    const bt = makeBacktester(data, engine);
    const dates = bt.dates;
    const n = dates.length;
    const v = lowerBound(dates, input.valStart || dates[Math.floor(n * 0.6)]);
    const t = lowerBound(dates, input.testStart || dates[Math.floor(n * 0.8)]);
    if (v < 120) throw new Error('训练集至少要 120 个交易日，请把验证集起始日期往后调');
    if (t - v < 60) throw new Error('验证集至少要 60 个交易日，请调整验证集或测试集起始日期');
    if (n - t < 60) throw new Error('测试集至少要 60 个交易日，请把测试集起始日期往前调');
    const trEnd = v - 1, vaEnd = t - 1, last = n - 1;
    const dateIdx = new Map(dates.map((d, i) => [d, i]));

    const combos = input.method === 'random' ? randomCombos(space, input.samples || 200, input.seed) : [...gridIter(space)];
    const keepEquity = input.wf && input.wf.enabled;
    const bench = bt.run(new AQ.BuyAndHold());
    const entries = [];
    let invalid = 0;
    combos.forEach((combo, c) => {
      let strat;
      try {
        strat = buildStrategy(applyParams(config, space, combo));
      } catch (e) {
        invalid++;
        return;
      }
      const res = bt.run(strat);
      const eq = Float64Array.from(res.equity);
      const tIdx = Int32Array.from(res.trades.map((tr) => dateIdx.get(tr.date)));
      entries.push({
        combo,
        tr: segStats(eq, 0, trEnd, rf),
        va: segStats(eq, trEnd, vaEnd, rf),
        trTrades: tradesIn(tIdx, 0, trEnd),
        vaTrades: tradesIn(tIdx, trEnd, vaEnd),
        eq: keepEquity ? eq : null,
        tIdx: keepEquity ? tIdx : null,
      });
      if (c % 10 === 0) onProgress(c + 1, combos.length);
    });
    onProgress(combos.length, combos.length);
    if (!entries.length) throw new Error('没有合法的参数组合（检查快线/慢线等约束）');

    const eligible = entries.filter((e) => e.trTrades >= minTrades);
    const ranked = eligible.slice().sort((x, y) => score(y.tr, objective) - score(x.tr, objective));
    ranked.forEach((e, i) => (e.trainRank = i + 1));
    const topK = Math.max(5, Math.ceil(ranked.length * 0.1));
    const shortlist = ranked.slice(0, topK);
    const selected = shortlist.slice().sort((x, y) => score(y.va, objective) - score(x.va, objective) || x.trainRank - y.trainRank)[0];

    // 通缩夏普：以全部合格试验的训练集夏普为"噪声分布"，检验训练集第一名
    let dsr = null;
    const best = ranked[0];
    if (best && fin(best.tr.srDaily)) {
      const srs = eligible.map((e) => e.tr.srDaily).filter(fin);
      const bestEq = best.eq || Float64Array.from(bt.run(buildStrategy(applyParams(config, space, best.combo))).equity);
      const mom = moments(returnsOf(Array.from(bestEq.subarray(0, v))));
      const prior = Math.max(0, Math.floor(input.priorTrials || 0));
      dsr = deflatedSharpe(srs, best.tr.srDaily, trEnd, mom.skew, mom.kurt, srs.length + prior);
      dsr.thisRun = srs.length;
      dsr.prior = prior;
      dsr.probThisRun = deflatedSharpe(srs, best.tr.srDaily, trEnd, mom.skew, mom.kurt).prob;
      dsr.sr0Annual = dsr.sr0 * Math.sqrt(TD);
      dsr.bestAnnual = best.tr.srDaily * Math.sqrt(TD);
    }

    // 测试集：只对选定参数计算一次
    let test = null;
    if (selected) {
      const res = bt.run(buildStrategy(applyParams(config, space, selected.combo)));
      const eq = res.equity;
      const seg = (arr) => Array.from(arr.slice(vaEnd, n), (x) => x / arr[vaEnd]);
      test = {
        combo: selected.combo,
        stats: segStats(eq, vaEnd, last, rf),
        rel: relativeStats(eq, bench.equity, vaEnd, last, rf),
        exposure: exposure(eq, styleFactors(bt, rf), vaEnd, last, rf),
        bench: segStats(bench.equity, vaEnd, last, rf),
        trades: roundTrips(res.trades, dates, dates[t]),
        dates: dates.slice(vaEnd),
        equity: seg(eq),
        benchEquity: seg(bench.equity),
      };
    }

    const wf = keepEquity ? walkForward(entries, bt, bench.equity, dates.slice(0, t), input.wf, objective, minTrades, rf, config, space) : null;
    const slim = (e) => ({ combo: e.combo, tr: e.tr, va: e.va, trTrades: e.trTrades, vaTrades: e.vaTrades, trainRank: e.trainRank });
    return {
      dates: [dates[0], dates[last]],
      splits: { valStart: dates[v], testStart: dates[t], trainDays: v, valDays: t - v, testDays: n - t },
      space: space.map((d) => ({ path: d.path, label: d.label, values: d.values })),
      trials: entries.length,
      eligible: eligible.length,
      invalid,
      objective,
      shortlist: topK,
      top: ranked.slice(0, 50).map(slim),
      selected: selected ? slim(selected) : null,
      all: entries.map((e) => ({ combo: e.combo, tr: score(e.tr, objective), va: score(e.va, objective), ok: e.trTrades >= minTrades })),
      bench: { tr: segStats(bench.equity, 0, trEnd, rf), va: segStats(bench.equity, trEnd, vaEnd, rf) },
      dsr,
      wf,
      test,
    };
  }

  /* 相对基准的指标（区间 (a, b]）：β、年化 α（CAPM）、跟踪误差、信息比率、超额收益 */
  function relativeStats(eq, beq, a, b, rf = 0.02) {
    const rfd = rf / TD;
    const r = [], br = [];
    for (let i = a + 1; i <= b; i++) {
      r.push(eq[i] / eq[i - 1] - 1);
      br.push(beq[i] / beq[i - 1] - 1);
    }
    if (r.length < 3) return null;
    const mr = mean(r), mb = mean(br);
    let cov = 0, vb = 0;
    for (let i = 0; i < r.length; i++) { cov += (r[i] - mr) * (br[i] - mb); vb += (br[i] - mb) ** 2; }
    const beta = vb > 0 ? cov / vb : NaN;
    const diff = r.map((x, i) => x - br[i]);
    const te = moments(diff).std * Math.sqrt(TD);
    return {
      beta,
      alpha: ((mr - rfd) - beta * (mb - rfd)) * TD,
      trackingError: te,
      infoRatio: te > 0 ? (mean(diff) * TD) / te : NaN,
      excessReturn: eq[b] / eq[a] - beq[b] / beq[a],
    };
  }

  /* 按笔统计：同一标的从空仓到建仓再回到空仓算一笔，收益 = (卖出所得 - 买入花费) / 买入花费，均含费用。
   * 始终在完整成交记录上配对；给出 from/to 时只统计在该区间内平仓的交易，
   * 其中建仓早于 from 的记为"跨区间"，区间结束时仍未平仓的记为"持仓中"。 */
  function roundTrips(trades, dates, from, to) {
    const idx = new Map(dates.map((d, i) => [d, i]));
    const lo = from || '0000', hi = to || '9999';
    const open = {}, done = [];
    for (const tr of trades) {
      if (tr.date > hi) break;
      let p = open[tr.symbol];
      if (!p) p = open[tr.symbol] = { symbol: tr.symbol, start: tr.date, shares: 0, cost: 0, proceeds: 0 };
      if (tr.side === 'buy') { p.shares += tr.shares; p.cost += tr.amount + tr.fee; }
      else { p.shares -= tr.shares; p.proceeds += tr.amount - tr.fee; }
      if (p.shares <= 0) {
        if (tr.date >= lo) {
          done.push({ symbol: p.symbol, start: p.start, end: tr.date, pnl: p.proceeds - p.cost, ret: p.cost > 0 ? p.proceeds / p.cost - 1 : NaN,
            days: (idx.get(tr.date) ?? 0) - (idx.get(p.start) ?? 0), spanning: p.start < lo });
        }
        delete open[tr.symbol];
      }
    }
    const wins = done.filter((x) => x.pnl > 0), losses = done.filter((x) => x.pnl <= 0);
    const avg = (a, f) => (a.length ? a.reduce((acc, x) => acc + f(x), 0) / a.length : NaN);
    const grossWin = wins.reduce((a, x) => a + x.pnl, 0), grossLoss = -losses.reduce((a, x) => a + x.pnl, 0);
    const avgWin = avg(wins, (x) => x.ret), avgLoss = avg(losses, (x) => x.ret);
    return {
      count: done.length,
      open: Object.keys(open).length,
      spanning: done.filter((x) => x.spanning).length,
      winRate: done.length ? wins.length / done.length : NaN,
      avgWin, avgLoss,
      payoff: avgLoss < 0 ? avgWin / -avgLoss : NaN,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : NaN,
      avgDays: avg(done, (x) => x.days),
      list: done,
    };
  }

  /* 月度收益：{ years: [年份], rows: { 年份: [12 个月收益或 null], 全年收益 } } */
  function monthlyReturns(dates, eq) {
    const monthEnd = new Map();
    dates.forEach((d, i) => monthEnd.set(d.slice(0, 7), eq[i]));
    const keys = [...monthEnd.keys()];
    const rows = {};
    let prev = eq[0];
    const yearStart = {};
    keys.forEach((k) => {
      const [y, m] = k.split('-');
      if (!rows[y]) { rows[y] = { months: new Array(12).fill(null), year: NaN }; yearStart[y] = prev; }
      const v = monthEnd.get(k);
      rows[y].months[+m - 1] = v / prev - 1;
      rows[y].year = v / yearStart[y] - 1;
      prev = v;
    });
    return { years: Object.keys(rows), rows };
  }

  /* 连续账户上的多段策略：每段由当时选出的参数驱动，同一个账户跨段运行。
   * 切换时新参数接手现有持仓（按新参数的出场规则决定去留），其余通过引擎实际调仓，含费用与涨跌停限制。
   * segments: [{ from, to, strategy }]，from/to 为做决策的交易日序号（闭区间），段外空仓不交易。 */
  class SwitchingStrategy {
    constructor(segments) {
      this.name = 'walkforward';
      this.segments = segments;
    }

    params() {
      return { windows: this.segments.length };
    }

    prepare(close, dates, symbols, bars) {
      this.symbols = symbols;
      for (const seg of this.segments) {
        if (typeof seg.strategy.decide === 'function') seg.strategy.prepare(close, dates, symbols, bars);
        else seg.rows = seg.strategy.generate(close, dates, symbols, bars);
      }
    }

    decide(i, ctx) {
      const seg = this.segments.find((x) => i >= x.from && i <= x.to);
      if (!seg) return null;
      const st = seg.strategy;
      if (typeof st.decide === 'function') {
        if (i === seg.from) {
          // 接手现有持仓与尚未成交的订单（如跌停没卖出的仍视为要卖）
          this.symbols.forEach((s, k) => {
            const want = ctx.pending && ctx.pending.has(s) ? ctx.pending.get(s) > 0 : ctx.shares[s] > 0;
            st.ctx.desired[k] = want ? 1 : 0;
          });
          st.ctx.emitted = false;
        }
        return st.decide(i, ctx);
      }
      if (i === seg.from) {
        // 切换到按信号序列运行的策略：立即调整到该参数当前应持有的组合
        for (let j = i; j >= 0; j--) if (seg.rows[j]) return seg.rows[j];
        return this.symbols.map(() => 0);
      }
      return seg.rows[i];
    }
  }

  /* 滚动前推（连续账户）：每个窗口只用此前的数据（训练窗口内的净值）选参，
   * 然后由一个账户按选出的参数连续交易，窗口切换产生真实的调仓与成本。
   * dates 只含训练+验证段，不触碰测试集。 */
  function walkForward(entries, bt, benchEq, dates, opts, objective, minTrades, rf, config, space) {
    const n = dates.length;
    const train = Math.round((opts.trainYears || 3) * TD);
    const test = Math.round((opts.testYears || 1) * TD);
    if (train + 20 >= n) throw new Error('训练+验证段太短，放不下一个滚动前推的训练窗口，请缩短训练窗口年数');
    const windows = [];
    for (let t0 = train; t0 < n - 1; t0 += test) {
      const a = opts.anchored ? 0 : t0 - train;
      const b = Math.min(t0 + test, n - 1);
      let best = null, bestScore = -Infinity;
      for (const e of entries) {
        if (tradesIn(e.tIdx, a, t0) < minTrades) continue;
        const sc = score(segStats(e.eq, a, t0, rf), objective);
        if (sc > bestScore) { bestScore = sc; best = e; }
      }
      if (!best) best = entries[0];
      windows.push({ a, t0, b, combo: best.combo, trainScore: bestScore });
    }
    // 决策日 t0..b-1 属于该窗口（在 t0 收盘用 t0 及以前的数据决策，t0+1 开盘成交）
    const segments = windows.map((w, k) => ({
      from: w.t0,
      to: k < windows.length - 1 ? windows[k + 1].t0 - 1 : w.b - 1,
      strategy: buildStrategy(applyParams(config, space, w.combo)),
    }));
    const res = bt.run(new SwitchingStrategy(segments));
    const first = windows[0].t0, last = windows[windows.length - 1].b;
    const eqS = res.equity.slice(first, last + 1).map((v) => v / res.equity[first]);
    const bS = benchEq.slice(first, last + 1).map((v) => v / benchEq[first]);
    const trades = res.trades.filter((tr) => tr.date > dates[first] && tr.date <= dates[last]);
    const traded = trades.reduce((acc, tr) => acc + tr.amount, 0);
    const years = (last - first) / TD;
    const meanEq = res.equity.slice(first, last + 1).reduce((acc, v) => acc + v, 0) / (last - first + 1);
    return {
      windows: windows.map((w) => ({
        train: [dates[w.a], dates[w.t0]],
        test: [dates[w.t0], dates[w.b]],
        combo: w.combo,
        trainScore: w.trainScore,
        testReturn: res.equity[w.b] / res.equity[w.t0] - 1,
        benchReturn: benchEq[w.b] / benchEq[w.t0] - 1,
      })),
      dates: dates.slice(first, last + 1),
      equity: eqS,
      bench: bS,
      stats: segStats(eqS, 0, eqS.length - 1, rf),
      benchStats: segStats(bS, 0, bS.length - 1, rf),
      trades: roundTrips(res.trades, bt.dates, dates[first], dates[last]),
      fees: trades.reduce((acc, tr) => acc + tr.fee, 0) / res.equity[first],
      turnover: years > 0 ? traded / meanEq / years : NaN,
    };
  }

  // ---------- 暴露归因 ----------

  // 解线性方程组 A x = B 的逆矩阵（高斯-约当，k 很小）
  function invert(A) {
    const k = A.length;
    const M = A.map((row, i) => row.concat(Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c];
      for (let j = 0; j < 2 * k; j++) M[c][j] /= d;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f) for (let j = 0; j < 2 * k; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((row) => row.slice(k));
  }

  /* 最小二乘 + Newey–West HAC 标准误。X 每行不含常数项（自动加截距）。
   * lag 默认 floor(4·(T/100)^(2/9))。返回 { coef, se, t, r2, n, lag }，coef[0] 为截距。 */
  function olsHAC(y, X, lag) {
    const T = y.length;
    const Z = X.map((row) => [1].concat(row));
    const k = Z[0].length;
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xty = new Array(k).fill(0);
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < k; i++) {
        Xty[i] += Z[t][i] * y[t];
        for (let j = 0; j < k; j++) XtX[i][j] += Z[t][i] * Z[t][j];
      }
    }
    const inv = invert(XtX);
    if (!inv) return null;
    const coef = inv.map((row) => row.reduce((acc, v, j) => acc + v * Xty[j], 0));
    const u = y.map((v, t) => v - Z[t].reduce((acc, x, j) => acc + x * coef[j], 0));
    const L = lag ?? Math.floor(4 * Math.pow(T / 100, 2 / 9));
    const S = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let l = 0; l <= L; l++) {
      const w = l === 0 ? 1 : 1 - l / (L + 1);
      for (let t = l; t < T; t++) {
        const uu = u[t] * u[t - l] * w;
        for (let i = 0; i < k; i++) {
          for (let j = 0; j < k; j++) {
            S[i][j] += l === 0 ? uu * Z[t][i] * Z[t][j] : uu * (Z[t][i] * Z[t - l][j] + Z[t - l][i] * Z[t][j]);
          }
        }
      }
    }
    const V = inv.map((row) => S[0].map((_, j) => row.reduce((acc, v, m) => acc + v * S[m].reduce((a2, s2, q) => a2 + s2 * inv[q][j], 0), 0)));
    const se = V.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
    const my = mean(y);
    const sst = y.reduce((acc, v) => acc + (v - my) ** 2, 0);
    const sse = u.reduce((acc, v) => acc + v * v, 0);
    return { coef, se, t: coef.map((c, i) => (se[i] > 0 ? c / se[i] : NaN)), r2: sst > 0 ? 1 - sse / sst : NaN, n: T, lag: L };
  }

  /* 股票池内的风格因子日收益（第 i 个元素为 i-1 收盘到 i 收盘）：
   * MKT：全部标的等权收益 − 无风险利率；
   * MOM：按前一日的 60 日涨幅分三组，强势组 − 弱势组；
   * LOWVOL：按前一日的 20 日波动率分三组，低波组 − 高波组。
   * 当日有效标的不足 6 只时，MOM 与 LOWVOL 记为 NaN。 */
  function styleFactors(bt, rf = 0.02) {
    const b = bt.bars();
    const syms = bt.symbols;
    const n = bt.dates.length;
    const rfd = rf / TD;
    const ret = syms.map((s) => b.close[s].map((c, i) => (i ? c / b.close[s][i - 1] - 1 : NaN)));
    const mom = syms.map((s) => ind.roc(b.close[s], 60));
    const vol = syms.map((_, k) => ind.stdev(Float64Array.from(ret[k], (v) => (fin(v) ? v : NaN)), 20, 1));
    const MKT = new Float64Array(n).fill(NaN), MOM = new Float64Array(n).fill(NaN), LOWVOL = new Float64Array(n).fill(NaN);
    const spread = (keys, i, sign) => {
      if (keys.length < 6) return NaN;
      keys.sort((p, q) => p[1] - q[1]);
      const m = Math.floor(keys.length / 3);
      const avg = (arr) => arr.reduce((acc, [k]) => acc + ret[k][i], 0) / arr.length;
      return sign * (avg(keys.slice(-m)) - avg(keys.slice(0, m)));
    };
    for (let i = 1; i < n; i++) {
      let sum = 0, cnt = 0;
      const km = [], kv = [];
      syms.forEach((s, k) => {
        const r = ret[k][i];
        if (!fin(r) || (b.member && !b.member[s][i - 1])) return;
        sum += r; cnt++;
        if (fin(mom[k][i - 1])) km.push([k, mom[k][i - 1]]);
        if (fin(vol[k][i - 1])) kv.push([k, vol[k][i - 1]]);
      });
      if (!cnt) continue;
      MKT[i] = sum / cnt - rfd;
      MOM[i] = spread(km, i, 1);
      LOWVOL[i] = spread(kv, i, -1);
    }
    return { MKT, MOM, LOWVOL };
  }

  const STYLE_LABELS = { MKT: '市场（等权）', MOM: '动量', LOWVOL: '低波动' };

  /* 暴露回归：策略日超额收益 = α + Σ β·因子 + ε，区间 (a, b]。
   * 某个因子在区间内缺失超过一半就不纳入。α 为年化，t 值用 HAC 标准误。 */
  function exposure(eq, sf, a, b, rf = 0.02) {
    const rfd = rf / TD;
    const names = ['MKT', 'MOM', 'LOWVOL'].filter((k) => {
      let ok = 0;
      for (let i = a + 1; i <= b; i++) if (fin(sf[k][i])) ok++;
      return ok >= (b - a) / 2 && ok >= 60;
    });
    if (!names.includes('MKT')) return null;
    const y = [], X = [];
    for (let i = a + 1; i <= b; i++) {
      const r = eq[i] / eq[i - 1] - 1;
      const row = names.map((k) => sf[k][i]);
      if (!fin(r) || !row.every(fin)) continue;
      y.push(r - rfd);
      X.push(row);
    }
    if (y.length < 60) return null;
    const fit = olsHAC(y, X);
    if (!fit) return null;
    return {
      alpha: fit.coef[0] * TD,
      alphaT: fit.t[0],
      loadings: names.map((k, j) => ({ id: k, label: STYLE_LABELS[k], beta: fit.coef[j + 1], t: fit.t[j + 1] })),
      r2: fit.r2,
      n: fit.n,
      lag: fit.lag,
      missing: ['MOM', 'LOWVOL'].filter((k) => !names.includes(k)),
    };
  }

  // ---------- 因子研究 ----------

  function cachedPanel(b, s, key, fn) {
    const k = s + '|' + key;
    if (!b.cache.has(k)) b.cache.set(k, fn());
    return b.cache.get(k);
  }

  // 滚动 12 个月每股收益：年报即全年；其余 = 本期累计 + 上年年报 − 上年同期累计（只用当时已公告的数据）
  function epsTTM(r, known) {
    const md = r.report.slice(5);
    if (md === '12-31') return r.eps;
    const y = +r.report.slice(0, 4);
    const annual = known.get(`${y - 1}-12-31`), same = known.get(`${y - 1}-${md}`);
    return annual && same && fin(annual.eps) && fin(same.eps) && fin(r.eps) ? r.eps + annual.eps - same.eps : NaN;
  }

  /* 财务数据按公告日对齐：公告日之后的第一个交易日起才可用（公告可能在盘后发布）。
   * 同一时点取报告期最新的一期；更正公告按数据源的最新值计，存在轻微前视。 */
  function fundPanel(b, s) {
    return cachedPanel(b, s, 'fund', () => {
      const dates = b.dates, n = dates.length;
      const recs = (((b.meta || {}).fundamentals || {})[s] || [])
        .filter((r) => r.notice && r.report)
        .slice()
        .sort((x, y) => (x.notice < y.notice ? -1 : x.notice > y.notice ? 1 : x.report < y.report ? -1 : 1));
      const col = () => new Float32Array(n).fill(NaN); // 财务指标单精度足够，省内存
      const out = { epsTTM: col(), bps: col(), roe: col(), revYoy: col(), profitYoy: col() };
      const known = new Map();
      let latest = null, j = 0, ttm = NaN;
      for (let i = 0; i < n; i++) {
        let changed = false;
        while (j < recs.length && recs[j].notice < dates[i]) {
          const r = recs[j++];
          known.set(r.report, r);
          if (!latest || r.report >= latest.report) latest = r;
          changed = true;
        }
        if (!latest) continue;
        if (changed) ttm = epsTTM(latest, known);
        out.epsTTM[i] = ttm;
        out.bps[i] = latest.bps > 0 ? latest.bps : NaN;
        out.roe[i] = latest.bps > 0 ? ttm / latest.bps : NaN;
        out.revYoy[i] = fin(latest.revYoy) ? latest.revYoy : NaN;
        out.profitYoy[i] = fin(latest.profitYoy) ? latest.profitYoy : NaN;
      }
      return out;
    });
  }

  // 流通市值 = 不复权价 × 流通股本；流通股本 = 近 20 日成交量（手）× 100 ÷ 换手率，用 20 日合计减小换手率取整误差
  function floatCap(b, s) {
    return cachedPanel(b, s, 'floatcap', () => {
      const n = b.dates.length;
      const out = new Float64Array(n).fill(NaN);
      const px = b.raw[s], tv = b.turnover[s], vol = b.volume[s];
      if (!px || !tv) return out;
      let sv = 0, st = 0, cnt = 0;
      const q = [];
      for (let i = 0; i < n; i++) {
        const ok = fin(vol[i]) && fin(tv[i]) && tv[i] > 0;
        q.push(ok ? [vol[i], tv[i]] : null);
        if (ok) { sv += vol[i]; st += tv[i]; cnt++; }
        if (q.length > 20) { const x = q.shift(); if (x) { sv -= x[0]; st -= x[1]; cnt--; } }
        if (cnt >= 10 && st > 0) out[i] = px[i] * ((sv * 100) / (st / 100));
      }
      return out;
    });
  }

  const byPrice = (b, s, num) => {
    const px = b.raw[s];
    return px ? px.map((p, i) => (p > 0 ? num[i] / p : NaN)) : new Float64Array(b.dates.length).fill(NaN);
  };

  const FACTORS = [
    { id: 'roc1', label: '昨日涨跌', f: (b, s) => ind.roc(b.close[s], 1) },
    { id: 'roc5', label: '5 日动量', f: (b, s) => ind.roc(b.close[s], 5) },
    { id: 'roc20', label: '20 日动量', f: (b, s) => ind.roc(b.close[s], 20) },
    { id: 'roc60', label: '60 日动量', f: (b, s) => ind.roc(b.close[s], 60) },
    { id: 'ma20', label: '偏离 20 日均线', f: (b, s) => ind.sma(b.close[s], 20).map((m, i) => b.close[s][i] / m - 1) },
    { id: 'ma60', label: '偏离 60 日均线', f: (b, s) => ind.sma(b.close[s], 60).map((m, i) => b.close[s][i] / m - 1) },
    { id: 'rsi14', label: 'RSI(14)', f: (b, s) => ind.rsi(b.close[s], 14) },
    { id: 'macd', label: 'MACD 柱 / 价格', f: (b, s) => ind.macd(b.close[s]).hist.map((h, i) => h / b.close[s][i]) },
    { id: 'pctb', label: '布林 %B(20,2)', f: (b, s) => ind.boll(b.close[s], 20, 2).pctB },
    { id: 'kdjj', label: 'KDJ J 值', f: (b, s) => ind.kdj(b.high[s], b.low[s], b.close[s]).J },
    { id: 'vol20', label: '20 日波动率', f: (b, s) => ind.stdev(Float64Array.from(ind.roc(b.close[s], 1)), 20, 1) },
    { id: 'atr', label: 'ATR(14) / 价格', f: (b, s) => ind.atr(b.high[s], b.low[s], b.close[s], 14).map((a, i) => a / b.close[s][i]) },
    {
      id: 'volume', label: '量比（5日/20日）', needsVolume: true,
      f: (b, s) => {
        const v5 = ind.sma(b.volume[s], 5), v20 = ind.sma(b.volume[s], 20);
        return v5.map((v, i) => v / v20[i] - 1);
      },
    },
    {
      id: 'high250', label: '距 250 日新高',
      f: (b, s) => ind.highest(b.high[s], 250).map((h, i) => b.close[s][i] / h - 1),
    },
    {
      id: 'maxret', label: '20 日最大单日涨幅',
      f: (b, s) => ind.highest(Float64Array.from(ind.roc(b.close[s], 1)), 20),
    },
    {
      id: 'illiq', label: '非流动性（Amihud）', needsVolume: true,
      f: (b, s) => {
        const r = ind.roc(b.close[s], 1);
        const x = r.map((v, i) => Math.abs(v) / (b.close[s][i] * b.volume[s][i]) * 1e9);
        return ind.sma(Float64Array.from(x, (v) => (Number.isFinite(v) ? v : NaN)), 20);
      },
    },
    // 以下需要个股数据：财务数据（按公告日对齐）、不复权价与换手率
    { id: 'ep', label: '盈利收益率 E/P（TTM）', needsFund: true, f: (b, s) => byPrice(b, s, fundPanel(b, s).epsTTM) },
    { id: 'bp', label: '账面市值比 B/P', needsFund: true, f: (b, s) => byPrice(b, s, fundPanel(b, s).bps) },
    { id: 'roe', label: 'ROE（TTM）', needsFund: true, f: (b, s) => fundPanel(b, s).roe },
    { id: 'profit_g', label: '净利润同比增速', needsFund: true, f: (b, s) => fundPanel(b, s).profitYoy },
    { id: 'rev_g', label: '营业收入同比增速', needsFund: true, f: (b, s) => fundPanel(b, s).revYoy },
    { id: 'size', label: '流通市值（对数）', needsCap: true, f: (b, s) => floatCap(b, s).map((v) => (v > 0 ? Math.log(v) : NaN)) },
  ];
  const FACTOR_BY_ID = Object.fromEntries(FACTORS.map((f) => [f.id, f]));
  const WARM = 60;

  /* 多因子选股：每个调仓日，把各因子在标的之间转成排名分（-0.5~0.5），按权重相加得到综合分，
   * 买入综合分最高的 topN 只。权重为负表示因子值越小越好（如反转、低波动）。
   * trendN > 0 时加大盘趋势过滤：全部标的等权指数跌破其 trendN 日均线就空仓。 */
  class FactorStrategy {
    constructor({ factors = [], topN = 2, rebalance = 20, trendN = 0, sizing = 'equal' } = {}) {
      const unknown = factors.find((f) => !FACTOR_BY_ID[f.id]);
      if (unknown) throw new Error('未知因子：' + unknown.id);
      this.factors = factors.map((f) => ({ id: f.id, weight: +f.weight || 0 })).filter((f) => f.weight !== 0);
      if (!this.factors.length) throw new Error('至少选一个权重不为 0 的因子');
      if (!(topN >= 1 && rebalance >= 1 && trendN >= 0)) throw new Error('持有数量、调仓间隔至少为 1，趋势均线不能为负');
      Object.assign(this, { name: 'factor', topN: Math.floor(topN), rebalance: Math.floor(rebalance), trendN: Math.floor(trendN), sizing });
    }

    params() {
      const out = { topN: this.topN, rebalance: this.rebalance, trendN: this.trendN };
      this.factors.forEach((f) => (out['w.' + f.id] = f.weight));
      return out;
    }

    generate(close, dates, symbols, bars) {
      const n = dates.length;
      const N = symbols.length;
      const cache = (s, key, fn) => {
        const k = s + '|' + key;
        if (!bars.cache.has(k)) bars.cache.set(k, fn());
        return bars.cache.get(k);
      };
      const vals = this.factors.map((f) => symbols.map((s) => cache(s, 'fac:' + f.id, () => FACTOR_BY_ID[f.id].f(bars, s))));
      const vol = this.sizing === 'invvol' ? symbols.map((s) => cache(s, 'vol20', () => AQ.annVol(bars.close[s], 20))) : null;
      const member = bars.member;

      // 等权指数：各标的相对自身首个价格的均值
      let riskOn = () => true;
      if (this.trendN > 0) {
        const first = symbols.map((s) => close[s].find(fin));
        const idx = dates.map((_, i) => {
          let sum = 0, cnt = 0;
          symbols.forEach((s, k) => { const c = close[s][i]; if (fin(c)) { sum += c / first[k]; cnt++; } });
          return cnt ? sum / cnt : NaN;
        });
        const ma = ind.sma(idx, this.trendN);
        riskOn = (i) => !fin(ma[i]) || idx[i] > ma[i];
      }

      const out = new Array(n).fill(null);
      let wasOn = true;
      let lastRebal = -Infinity;
      for (let i = WARM; i < n; i++) {
        const on = riskOn(i);
        const due = i - lastRebal >= this.rebalance;
        if (!on) {
          if (wasOn) out[i] = new Array(N).fill(0);
          wasOn = false;
          continue;
        }
        if (!due && wasOn) continue;
        wasOn = true;
        lastRebal = i;
        const eligible = [];
        for (let k = 0; k < N; k++) {
          if (member && !member[symbols[k]][i]) continue;
          if (vals.every((v) => fin(v[k][i])) && fin(close[symbols[k]][i])) eligible.push(k);
        }
        const score = new Array(N).fill(0);
        this.factors.forEach((f, j) => {
          const r = ranks(eligible.map((k) => vals[j][k][i]));
          eligible.forEach((k, e) => (score[k] += f.weight * ((r[e] - 0.5) / eligible.length - 0.5)));
        });
        const picked = eligible.slice().sort((a, b2) => score[b2] - score[a]).slice(0, this.topN);
        const row = new Array(N).fill(0);
        if (this.sizing === 'invvol' && picked.length) {
          const inv = picked.map((k) => (vol[k][i] > 0 ? 1 / vol[k][i] : 0));
          const avg = inv.filter((v) => v > 0).reduce((a, x) => a + x, 0) / (inv.filter((v) => v > 0).length || 1) || 1;
          const raw = inv.map((v) => v || avg);
          const total = raw.reduce((a, x) => a + x, 0);
          const budget = picked.length / this.topN;
          picked.forEach((k, e) => (row[k] = (raw[e] / total) * budget));
        } else {
          picked.forEach((k) => (row[k] = 1 / this.topN));
        }
        out[i] = row;
      }
      return out;
    }
  }

  // 按配置构建策略：type 为 'factor' 时是多因子选股，否则为规则组合
  function buildStrategy(config) {
    if (config.type === 'factor') return new FactorStrategy(config.factor || {});
    return new AQ.RuleStrategy(config);
  }

  // 未来收益：t 日收盘出信号，t+1 日开盘买入，持有 h 日后开盘卖出
  function forwardReturns(open, h) {
    const out = new Float64Array(open.length).fill(NaN);
    for (let t = 0; t + 1 + h < open.length; t++) out[t] = open[t + 1 + h] / open[t + 1] - 1;
    return out;
  }

  function factorPanel(bt, h, ids) {
    const b = bt.bars();
    const factors = availableFactors(b, bt.symbols).filter((f) => !ids || ids.includes(f.id));
    const fwd = {}, vals = {};
    for (const s of bt.symbols) {
      fwd[s] = forwardReturns(b.open[s], h);
      vals[s] = {};
      for (const f of factors) vals[s][f.id] = f.f(b, s);
      // 时点股票池：不在池内的日子没有未来收益，自然不参与 IC 与分组
      if (b.member) {
        const m = b.member[s], fw = fwd[s];
        for (let t = 0; t < fw.length; t++) if (!m[t]) fw[t] = NaN;
      }
    }
    return { factors, fwd, vals };
  }

  // 当前数据支持的因子：量类需要成交量，财务类需要财务数据，市值需要不复权价与换手率
  function availableFactors(b, symbols) {
    const hasVolume = symbols.every((s) => b.volume[s].some(fin));
    const hasFund = !!(b.meta && b.meta.fundamentals) && symbols.some((s) => (b.meta.fundamentals[s] || []).length);
    const hasRaw = symbols.some((s) => b.raw[s]);
    const hasCap = symbols.some((s) => b.raw[s] && b.turnover[s]);
    return FACTORS.filter((f) => (!f.needsVolume || hasVolume) && (!f.needsFund || (hasFund && hasRaw)) && (!f.needsCap || hasCap));
  }

  function lcg(seed) {
    let x = seed >>> 0 || 1;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // 移动块自助法：随机取长度为 L 的连续块拼成长度 T 的下标序列，保留序列相关
  function blockIndices(T, L, rnd) {
    const out = new Int32Array(T);
    for (let k = 0; k < T;) {
      const s0 = Math.floor(rnd() * (T - L + 1));
      for (let j = 0; j < L && k < T; j++) out[k++] = s0 + j;
    }
    return out;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const x = p * (sorted.length - 1), i = Math.floor(x), f = x - i;
    return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  }

  // 相关系数所需的六个量的前缀和（缺失值跳过），供块自助法按块累加
  function corrPrefix(x, y) {
    const T = x.length;
    const P = new Float64Array(6 * (T + 1));
    for (let k = 0; k < T; k++) {
      const a = x[k], b = y[k], o = 6 * k;
      const ok = a === a && b === b;
      P[o + 6] = P[o] + (ok ? 1 : 0);
      P[o + 7] = P[o + 1] + (ok ? a : 0);
      P[o + 8] = P[o + 2] + (ok ? b : 0);
      P[o + 9] = P[o + 3] + (ok ? a * a : 0);
      P[o + 10] = P[o + 4] + (ok ? b * b : 0);
      P[o + 11] = P[o + 5] + (ok ? a * b : 0);
    }
    return P;
  }

  function corrBlocks(P, starts, L, T) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < starts.length; k++) {
      const len = Math.min(L, T - k * L);
      const a = 6 * starts[k], b = 6 * (starts[k] + len);
      n += P[b] - P[a]; sx += P[b + 1] - P[a + 1]; sy += P[b + 2] - P[a + 2];
      sxx += P[b + 3] - P[a + 3]; syy += P[b + 4] - P[a + 4]; sxy += P[b + 5] - P[a + 5];
    }
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    return n > 2 && vx > 1e-9 && vy > 1e-9 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : NaN;
  }

  /* stat(starts, L, T)：starts 为各块起点，第 k 块长度 min(L, T − k·L)，与 blockIndices 的取样一致。
   * 用前缀和按块累加，比逐个下标快约 L 倍。 */
  function bootCI(stat, T, B, seed) {
    if (T < 4) return [NaN, NaN];
    const rnd = lcg(seed);
    const L = Math.max(1, Math.round(Math.cbrt(T)));
    const K = Math.ceil(T / L);
    const out = [];
    const starts = new Int32Array(K);
    for (let b = 0; b < B; b++) {
      for (let k = 0; k < K; k++) starts[k] = Math.floor(rnd() * (T - L + 1));
      const v = stat(starts, L, T);
      if (fin(v)) out.push(v);
    }
    out.sort((p, q) => p - q);
    return [percentile(out, 0.025), percentile(out, 0.975)];
  }

  /* 因子 IC：每 h 天抽样一次（非重叠），置信区间用按日期的移动块自助法（B 次、固定种子）。
   * 时序 IC：每只标的"因子值 vs 未来收益"的秩相关，再在标的之间等权平均；自助法对所有标的同时重抽相同的日期块，
   *   因此高度相关或重复的标的不会虚增显著性（9 只一样的标的与 1 只结果相同）。
   * 截面 IC：每个抽样日在标的之间做秩相关（至少 3 只），对这条日度序列做块自助法。
   * 以 95% 置信区间是否跨过 0 判断显著。 */
  function factorIC(bt, h, { B = 200, seed = 7 } = {}) {
    const { factors, fwd, vals } = factorPanel(bt, h);
    const syms = bt.symbols;
    const ts = [];
    for (let t = WARM; t < bt.dates.length; t += h) ts.push(t);
    const T = ts.length;
    return factors.map((f) => {
      const per = [];
      for (const s of syms) {
        const idx = [], x = [], y = [];
        const vf = vals[s][f.id], fw = fwd[s];
        for (let k = 0; k < T; k++) {
          const t = ts[k], v = vf[t], r = fw[t];
          if (v === v && r === r && v !== Infinity && v !== -Infinity) { idx.push(k); x.push(v); y.push(r); }
        }
        if (x.length < 20) continue;
        const rx = ranks(x), ry = ranks(y);
        const ic = pearson(rx, ry);
        if (!fin(ic)) continue;
        const ax = new Float64Array(T).fill(NaN), ay = new Float64Array(T).fill(NaN);
        idx.forEach((k, j) => { ax[k] = rx[j]; ay[k] = ry[j]; });
        per.push({ P: corrPrefix(ax, ay), ic });
      }
      const tsIC = per.length ? mean(per.map((p) => p.ic)) : NaN;
      const [tsLo, tsHi] = per.length ? bootCI((starts, L, T2) => {
        let sum = 0, cnt = 0;
        for (const p of per) { const c = corrBlocks(p.P, starts, L, T2); if (fin(c)) { sum += c; cnt++; } }
        return cnt ? sum / cnt : NaN;
      }, T, B, seed) : [NaN, NaN];

      const cs = [];
      if (syms.length >= 3) {
        for (const t of ts) {
          const x = [], y = [];
          for (const s of syms) {
            const v = vals[s][f.id][t], r = fwd[s][t];
            if (fin(v) && fin(r)) { x.push(v); y.push(r); }
          }
          if (x.length >= 3) {
            const ic = spearman(x, y);
            if (fin(ic)) cs.push(ic);
          }
        }
      }
      const csm = cs.length > 2 ? moments(cs) : null;
      const csP = new Float64Array(cs.length + 1);
      cs.forEach((v, k) => (csP[k + 1] = csP[k] + v));
      const [csLo, csHi] = csm ? bootCI((starts, L, T2) => {
        let a = 0;
        for (let k = 0; k < starts.length; k++) a += csP[starts[k] + Math.min(L, T2 - k * L)] - csP[starts[k]];
        return a / T2;
      }, cs.length, B, seed) : [NaN, NaN];
      const half = cs.length >> 1;
      return {
        id: f.id,
        label: f.label,
        tsIC, tsLo, tsHi,
        tsSyms: per.length,
        tsN: T,
        csIC: csm ? csm.mean : NaN,
        csLo, csHi,
        csIR: csm && csm.std > 0 ? csm.mean / csm.std : NaN,
        csN: cs.length,
        csFirst: half > 2 ? mean(cs.slice(0, half)) : NaN,
        csSecond: half > 2 ? mean(cs.slice(half)) : NaN,
      };
    });
  }

  function periodStats(r, ppy) {
    if (r.length < 3) return null;
    const m = moments(r);
    const growth = r.reduce((acc, x) => acc * (1 + x), 1);
    const ann = (a) => (a.length ? Math.pow(Math.max(a.reduce((acc, x) => acc * (1 + x), 1), 0), ppy / a.length) - 1 : NaN);
    const half = r.length >> 1;
    return {
      annReturn: Math.pow(Math.max(growth, 0), ppy / r.length) - 1,
      annVol: m.std * Math.sqrt(ppy),
      sharpe: m.std > 0 ? (m.mean / m.std) * Math.sqrt(ppy) : NaN,
      first: ann(r.slice(0, half)),
      second: ann(r.slice(half)),
    };
  }

  /* 可交易的分组组合：每 h 天在 t 日收盘按因子值把标的从低到高分 q 组，各组等权，
   * t+1 日开盘买入、持有 h 日后开盘卖出；每次调仓按权重变化扣成本（cost 为单边费率，含佣金、印花税、滑点）。
   * 多空 = 最高组 - 最低组（A 股融券受限，仅作因子强弱的参考）。
   * 组数按标的数量：≥10 只分 5 组，6~9 只分 3 组，更少不分组。 */
  function factorPortfolios(bt, factorId, h, { q, cost = 0.0015 } = {}) {
    const syms = bt.symbols;
    const N = syms.length;
    q = q || (N >= 10 ? 5 : N >= 6 ? 3 : 0);
    if (!q) return { q: 0, error: '分组组合至少需要 6 只标的' };
    const { fwd, vals } = factorPanel(bt, h, [factorId]);
    const ppy = TD / h;
    const groups = Array.from({ length: q }, () => ({ rets: [], gross: [], turn: [], w: new Map() }));
    const dates = [], ls = [];
    for (let t = WARM; t < bt.dates.length; t += h) {
      const elig = syms.filter((s) => fin(vals[s][factorId][t]) && fin(fwd[s][t]));
      if (elig.length < q) continue;
      elig.sort((a, b) => vals[a][factorId][t] - vals[b][factorId][t]);
      const m = elig.length;
      groups.forEach((g, k) => {
        const members = elig.slice(Math.floor((k * m) / q), Math.floor(((k + 1) * m) / q));
        const w = new Map(members.map((s) => [s, 1 / members.length]));
        let dw = 0;
        for (const [s, v] of w) dw += Math.abs(v - (g.w.get(s) || 0));
        for (const [s, v] of g.w) if (!w.has(s)) dw += v;
        const gross = members.reduce((acc, s) => acc + fwd[s][t], 0) / members.length;
        g.gross.push(gross);
        g.rets.push(gross - dw * cost);
        g.turn.push(dw / 2);
        g.w = w;
      });
      ls.push(groups[q - 1].rets[groups[q - 1].rets.length - 1] - groups[0].rets[groups[0].rets.length - 1]);
      dates.push(bt.dates[t]);
    }
    const curve = (r) => { let v = 1; return [1].concat(r.map((x) => (v *= 1 + x))); };
    return {
      q, h, cost,
      periods: dates.length,
      dates,
      groups: groups.map((g, k) => ({
        group: k + 1,
        ...periodStats(g.rets, ppy),
        grossReturn: periodStats(g.gross, ppy)?.annReturn,
        turnover: g.turn.length ? mean(g.turn.slice(1)) : NaN,
        equity: curve(g.rets),
      })),
      longShort: { ...periodStats(ls, ppy), equity: curve(ls) },
    };
  }

  function seriesStats(bt, symbol) {
    const r = returnsOf(bt.bars().close[symbol].filter(fin));
    const m = moments(r);
    return {
      symbol,
      days: r.length,
      annReturn: m.mean * TD,
      annVol: m.std * Math.sqrt(TD),
      skew: m.skew,
      exKurt: m.kurt - 3,
      acf: acf(r, 20),
      absAcf: acf(r.map(Math.abs), 20),
      band: 1.96 / Math.sqrt(r.length),
      vr: [2, 5, 10, 20].map((q) => ({ q, ...varianceRatio(r, q) })),
    };
  }

  const api = {
    moments, normCdf, normInv, ranks, spearman, acf, varianceRatio, segStats, deflatedSharpe,
    rangeValues, gridSize, gridIter, randomCombos, applyParams, makeBacktester, optimize,
    relativeStats, roundTrips, monthlyReturns, SwitchingStrategy, olsHAC, styleFactors, exposure,
    FACTORS, availableFactors, fundPanel, floatCap, FactorStrategy, buildStrategy, factorIC, factorPortfolios, seriesStats, forwardReturns, blockIndices,
  };
  if (isNode) module.exports = api;
  else AQ.research = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
