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

  function ranks(a) {
    const idx = a.map((v, i) => i).sort((i, j) => a[i] - a[j]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
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
  function deflatedSharpe(srs, best, T, skew, kurt) {
    const N = srs.length;
    let sr0 = 0;
    if (N >= 2) {
      const m = mean(srs);
      const v = srs.reduce((a, x) => a + (x - m) ** 2, 0) / (N - 1);
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

  // 参数路径：r<规则序号>.<参数名> 或 risk.<参数名>
  function applyParams(config, space, combo) {
    const cfg = { ...config, rules: config.rules.map((r) => ({ id: r.id, params: { ...r.params } })) };
    space.forEach((d, k) => {
      const [head, key] = d.path.split('.');
      if (head === 'risk') cfg[key] = combo[k];
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

  /* 参数优化主流程。
   * input: { data, engine, config, space: [{path, label, values}], method: 'grid'|'random', samples,
   *          objective, minTrades, splitDate, rf, wf: { enabled, trainYears, testYears, anchored } } */
  function optimize(input, onProgress = () => {}) {
    const { data, engine, config, space, objective = 'sharpe', minTrades = 0, rf = 0.02 } = input;
    if (!space.length) throw new Error('至少勾选一个要优化的参数');
    const bt = makeBacktester(data, engine);
    const dates = bt.dates;
    const n = dates.length;
    const split = lowerBound(dates, input.splitDate || dates[Math.floor(n * 0.7)]);
    if (split < 120 || split > n - 60) throw new Error('样本外起始日期要让样本内至少 120 天、样本外至少 60 天');
    const isEnd = split - 1;
    const dateIdx = new Map(dates.map((d, i) => [d, i]));

    const combos = input.method === 'random' ? randomCombos(space, input.samples || 200, input.seed) : [...gridIter(space)];
    const keepEquity = input.wf && input.wf.enabled;
    const bench = bt.run(new AQ.BuyAndHold());
    const entries = [];
    let invalid = 0;
    combos.forEach((combo, c) => {
      let strat;
      try {
        strat = new AQ.RuleStrategy(applyParams(config, space, combo));
      } catch (e) {
        invalid++;
        return;
      }
      const res = bt.run(strat);
      const eq = Float64Array.from(res.equity);
      const tIdx = Int32Array.from(res.trades.map((t) => dateIdx.get(t.date)));
      entries.push({
        combo,
        is: segStats(eq, 0, isEnd, rf),
        oos: segStats(eq, isEnd, n - 1, rf),
        isTrades: tradesIn(tIdx, 0, isEnd),
        oosTrades: tradesIn(tIdx, isEnd, n - 1),
        eq: keepEquity ? eq : null,
        tIdx: keepEquity ? tIdx : null,
      });
      if (c % 10 === 0) onProgress(c + 1, combos.length);
    });
    onProgress(combos.length, combos.length);
    if (!entries.length) throw new Error('没有合法的参数组合（检查快线/慢线等约束）');

    const eligible = entries.filter((e) => e.isTrades >= minTrades);
    const ranked = eligible.slice().sort((x, y) => score(y.is, objective) - score(x.is, objective));

    // 通缩夏普：以全部合格试验的样本内夏普为"噪声分布"
    let dsr = null;
    const best = ranked[0];
    if (best && fin(best.is.srDaily)) {
      const srs = eligible.map((e) => e.is.srDaily).filter(fin);
      const bestEq = best.eq || Float64Array.from(bt.run(new AQ.RuleStrategy(applyParams(config, space, best.combo))).equity);
      const mom = moments(returnsOf(Array.from(bestEq.subarray(0, split))));
      dsr = deflatedSharpe(srs, best.is.srDaily, isEnd, mom.skew, mom.kurt);
      dsr.sr0Annual = dsr.sr0 * Math.sqrt(TD);
      dsr.bestAnnual = best.is.srDaily * Math.sqrt(TD);
    }

    const wf = keepEquity ? walkForward(entries, bench.equity, dates, input.wf, objective, minTrades, rf) : null;
    const slim = (e) => ({ combo: e.combo, is: e.is, oos: e.oos, isTrades: e.isTrades, oosTrades: e.oosTrades });
    return {
      dates: [dates[0], dates[n - 1]],
      split: dates[split],
      space: space.map((d) => ({ path: d.path, label: d.label, values: d.values })),
      trials: entries.length,
      eligible: eligible.length,
      invalid,
      objective,
      top: ranked.slice(0, 50).map(slim),
      all: entries.map((e) => ({ combo: e.combo, is: score(e.is, objective), oos: score(e.oos, objective), ok: e.isTrades >= minTrades })),
      bench: { is: segStats(bench.equity, 0, isEnd, rf), oos: segStats(bench.equity, isEnd, n - 1, rf) },
      dsr,
      wf,
    };
  }

  function walkForward(entries, benchEq, dates, opts, objective, minTrades, rf) {
    const n = dates.length;
    const train = Math.round((opts.trainYears || 3) * TD);
    const test = Math.round((opts.testYears || 1) * TD);
    if (train + 20 >= n) throw new Error('数据太短，放不下一个训练窗口');
    const windows = [];
    const eqS = [1], bS = [1], dS = [dates[train]];
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
      for (let j = t0 + 1; j <= b; j++) {
        eqS.push(eqS[eqS.length - 1] * (best.eq[j] / best.eq[j - 1]));
        bS.push(bS[bS.length - 1] * (benchEq[j] / benchEq[j - 1]));
        dS.push(dates[j]);
      }
      const ts = segStats(best.eq, t0, b, rf);
      windows.push({
        train: [dates[a], dates[t0]],
        test: [dates[t0], dates[b]],
        combo: best.combo,
        trainScore: bestScore,
        testReturn: ts ? ts.total_return : NaN,
        testSharpe: ts ? ts.sharpe : NaN,
        benchReturn: benchEq[b] / benchEq[t0] - 1,
      });
    }
    return {
      windows,
      dates: dS,
      equity: eqS,
      bench: bS,
      stats: segStats(eqS, 0, eqS.length - 1, rf),
      benchStats: segStats(bS, 0, bS.length - 1, rf),
    };
  }

  // ---------- 因子研究 ----------

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
  ];
  const WARM = 60;

  // 未来收益：t 日收盘出信号，t+1 日开盘买入，持有 h 日后开盘卖出
  function forwardReturns(open, h) {
    const out = new Float64Array(open.length).fill(NaN);
    for (let t = 0; t + 1 + h < open.length; t++) out[t] = open[t + 1 + h] / open[t + 1] - 1;
    return out;
  }

  function factorPanel(bt, h) {
    const b = bt.bars();
    const hasVolume = bt.symbols.every((s) => b.volume[s].some(fin));
    const factors = FACTORS.filter((f) => !f.needsVolume || hasVolume);
    const fwd = {}, vals = {};
    for (const s of bt.symbols) {
      fwd[s] = forwardReturns(b.open[s], h);
      vals[s] = {};
      for (const f of factors) vals[s][f.id] = f.f(b, s);
    }
    return { factors, fwd, vals };
  }

  /* 因子 IC：非重叠抽样（每 h 天取一次），避免重叠收益虚增显著性。
   * 时序 IC：每只标的上"因子值 vs 未来收益"的秩相关，按样本数加权合并，z = Σ n·IC / √Σn。
   * 截面 IC：每个抽样日在标的之间做秩相关（至少 3 只），t = 均值 / 标准差 × √期数。 */
  function factorIC(bt, h) {
    const { factors, fwd, vals } = factorPanel(bt, h);
    const syms = bt.symbols;
    const n = bt.dates.length;
    return factors.map((f) => {
      let wsum = 0, nsum = 0;
      for (const s of syms) {
        const x = [], y = [];
        for (let t = WARM; t < n; t += h) {
          const v = vals[s][f.id][t], r = fwd[s][t];
          if (fin(v) && fin(r)) { x.push(v); y.push(r); }
        }
        if (x.length < 20) continue;
        const ic = spearman(x, y);
        if (!fin(ic)) continue;
        wsum += ic * x.length;
        nsum += x.length;
      }
      const cs = [];
      if (syms.length >= 3) {
        for (let t = WARM; t < n; t += h) {
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
      return {
        id: f.id,
        label: f.label,
        tsIC: nsum ? wsum / nsum : NaN,
        tsT: nsum ? wsum / Math.sqrt(nsum) : NaN,
        tsN: nsum,
        csIC: csm ? csm.mean : NaN,
        csIR: csm && csm.std > 0 ? csm.mean / csm.std : NaN,
        csT: csm && csm.std > 0 ? (csm.mean / csm.std) * Math.sqrt(cs.length) : NaN,
        csN: cs.length,
      };
    });
  }

  // 分组收益：每只标的按自身历史分位数分 q 组，汇总各组的平均未来收益
  function factorQuantiles(bt, factorId, h, q = 5) {
    const { fwd, vals } = factorPanel(bt, h);
    const sums = new Array(q).fill(0), counts = new Array(q).fill(0);
    for (const s of bt.symbols) {
      const pairs = [];
      for (let t = WARM; t < bt.dates.length; t += h) {
        const v = vals[s][factorId][t], r = fwd[s][t];
        if (fin(v) && fin(r)) pairs.push([v, r]);
      }
      if (pairs.length < q * 4) continue;
      pairs.sort((a, b) => a[0] - b[0]);
      pairs.forEach(([, r], i) => {
        const g = Math.min(q - 1, Math.floor((i * q) / pairs.length));
        sums[g] += r;
        counts[g]++;
      });
    }
    return sums.map((s, g) => ({ group: g + 1, mean: counts[g] ? s / counts[g] : NaN, count: counts[g] }));
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
    FACTORS, factorIC, factorQuantiles, seriesStats, forwardReturns,
  };
  if (isNode) module.exports = api;
  else AQ.research = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
