/* 研究工具：参数优化（网格/随机）、滚动前推检验、通缩夏普比率、时序统计与因子 IC。 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const AQ = isNode
    ? Object.assign({ ind: require('./indicators.js') }, require('./engine.js'), require('./rules.js'))
    : root.AQ;
  const ind = AQ.ind;
  const PF = isNode ? require('./portfolio.js') : root.AQ.portfolio;
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

  /* 回测过拟合概率（Bailey, Borwein, López de Prado & Zhu 的 CSCV）。
   * blocks[k] = { sum: Float64Array(S), sq: Float64Array(S), n: Float64Array(S) }：第 k 组参数在 S 个时间块上的日收益和、平方和、天数。
   * 枚举所有"一半块做样本内、另一半做样本外"的组合：样本内夏普最高的参数，在样本外的相对排名 ω；
   * PBO = P(ω ≤ 1/2)，即样本内冠军在样本外落到后一半的概率。另给出样本外亏损概率与样本内外夏普的回归斜率。 */
  /* criterion 与优化目标一致：'sharpe'、'sortino'、'cagr'（按日均对数收益排名，与年化几何收益同序）可由分块统计精确合成；
   * 'calmar' 依赖整条路径的最大回撤，无法由分块合成，按 'cagr' 近似（返回 approx = true）。
   * 分块统计：sum / sq / n 为日收益的和、平方和、天数；lsum 为 ln(1+r) 之和；dsq 为超额收益负部的平方和。rfd 为日无风险利率。 */
  function pbo(blocks, { criterion = 'sharpe', rfd = 0 } = {}) {
    const N = blocks.length;
    if (N < 2) return null;
    const S = blocks[0].sum.length;
    const half = S / 2;
    const hasLog = blocks.every((b) => b.lsum), hasDown = blocks.every((b) => b.dsq);
    const crit = criterion === 'calmar' ? 'cagr' : criterion;
    const use = (crit === 'cagr' && !hasLog) || (crit === 'sortino' && !hasDown) || !['sharpe', 'sortino', 'cagr'].includes(crit) ? 'sharpe' : crit;
    const sharpe = (e, mask, want) => {
      let s1 = 0, s2 = 0, n = 0, l = 0, d = 0;
      for (let j = 0; j < S; j++) {
        if (((mask >> j) & 1) !== want) continue;
        s1 += e.sum[j]; s2 += e.sq[j]; n += e.n[j];
        if (hasLog) l += e.lsum[j];
        if (hasDown) d += e.dsq[j];
      }
      if (n < 2) return NaN;
      const m = s1 / n;
      if (use === 'cagr') return l / n;
      if (use === 'sortino') return d > 0 ? (m - rfd) / Math.sqrt(d / n) : NaN;
      const v = (s2 - n * m * m) / (n - 1);
      return v > 0 ? (m - rfd) / Math.sqrt(v) : NaN;
    };
    let below = 0, loss = 0, total = 0;
    const logits = [], pairs = [];
    for (let mask = 0; mask < 1 << S; mask++) {
      let bits = 0;
      for (let j = 0; j < S; j++) bits += (mask >> j) & 1;
      if (bits !== half) continue;
      let best = -1, bestIs = -Infinity;
      const oos = new Float64Array(N);
      for (let k = 0; k < N; k++) {
        const is = sharpe(blocks[k], mask, 1);
        oos[k] = sharpe(blocks[k], mask, 0);
        if (is > bestIs) { bestIs = is; best = k; }
      }
      if (best < 0 || !fin(oos[best])) continue;
      let rank = 1;
      for (let k = 0; k < N; k++) if (fin(oos[k]) && oos[k] < oos[best]) rank++;
      const w = rank / (N + 1);
      const lam = Math.log(w / (1 - w));
      logits.push(lam);
      pairs.push([bestIs, oos[best]]);
      if (lam <= 0) below++;
      if (oos[best] < 0) loss++;
      total++;
    }
    if (!total) return null;
    const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
    let sxy = 0, sxx = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    // 每块天数太少时，块内夏普噪声很大，PBO 本身也不稳定
    const days = blocks[0].n.reduce((a, x) => a + x, 0) / S;
    return {
      criterion: use, requested: criterion, approx: use !== criterion,
      pbo: below / total, probLoss: loss / total, splits: total, blocks: S, blockDays: days,
      warning: days < 60 ? `每块平均只有 ${Math.round(days)} 个交易日（< 60），样本太短，PBO 估计不稳定，仅作参考` : '',
      slope: sxx > 0 ? sxy / sxx : NaN,
      oosSharpe: my * Math.sqrt(TD), isSharpe: mx * Math.sqrt(TD),
      logits: logits.sort((a, b) => a - b),
    };
  }

  /* Hansen (2005) 高级预测能力检验（SPA）：H0 为"所有候选都不比基准好"。
   * d[k] 为第 k 组参数相对基准的日超额收益（Float32Array，长度 T）。用平稳自助法（平均块长 L）重抽样，
   * 并按 Hansen 的一致性修正只保留"不太差"的候选参与零分布。返回 p 值（越小越说明最优者确实优于基准）。 */
  function spa(d, { B = 1000, L = 10, seed = 11 } = {}) {
    const K = d.length;
    if (!K) return null;
    const T = d[0].length;
    const rnd = lcg(seed);
    const P = d.map((x) => { const p = new Float64Array(T + 1); for (let t = 0; t < T; t++) p[t + 1] = p[t] + x[t]; return p; });
    const mu = d.map((x) => { let s = 0; for (let t = 0; t < T; t++) s += x[t]; return s / T; });
    // 长期方差（Newey–West，带宽 L）
    const omega = d.map((x, k) => {
      let v = 0;
      for (let l = 0; l <= L; l++) {
        let c = 0;
        for (let t = l; t < T; t++) c += (x[t] - mu[k]) * (x[t - l] - mu[k]);
        c /= T;
        v += l === 0 ? c : 2 * (1 - l / (L + 1)) * c;
      }
      return Math.sqrt(Math.max(v, 1e-18));
    });
    const stat = Math.max(0, ...mu.map((m, k) => (Math.sqrt(T) * m) / omega[k]));
    const thr = (k) => -omega[k] * Math.sqrt((2 * Math.log(Math.log(T))) / T);
    const g = mu.map((m, k) => (m >= thr(k) ? m : 0)); // μ̂ᶜ：明显差于基准的候选中心取 0，其余取样本均值
    let exceed = 0;
    const p = 1 / L;
    for (let b = 0; b < B; b++) {
      // 平稳自助法：块起点均匀、块长几何分布；块用前缀和累加
      const segs = [];
      for (let t = 0; t < T;) {
        const start = Math.floor(rnd() * T);
        let len = 1;
        while (rnd() > p && len < T) len++;
        len = Math.min(len, T - t);
        segs.push([start, len]);
        t += len;
      }
      let mx = 0;
      for (let k = 0; k < K; k++) {
        let s = 0;
        for (const [st, len] of segs) {
          const end = st + len;
          s += end <= T ? P[k][end] - P[k][st] : P[k][T] - P[k][st] + P[k][end - T];
        }
        const z = (Math.sqrt(T) * (s / T - g[k])) / omega[k]; // Hansen 的一致性中心化：减去 μ̂ᶜ
        if (z > mx) mx = z;
      }
      if (mx >= stat) exceed++;
    }
    const pv = exceed / B;
    // 蒙特卡洛标准误：p 值本身来自 B 次重抽样，有抽样误差
    return { p: pv, se: Math.sqrt(Math.max(pv * (1 - pv), 1 / B) / B), stat, models: K, days: T, bootstrap: B };
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
      participation: engine.participation || 0,
      impact: engine.impact || 0,
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
    // 过拟合检验只用训练 + 验证段（第 1 ~ t−1 天的日收益）：CSCV 按 12 个时间块汇总；SPA 需要逐日超额收益，内存允许时保留
    const S = 12, T = t - 1;
    const blockOf = (i) => Math.min(S - 1, Math.floor(((i - 1) * S) / T));
    const keepDaily = combos.length * T <= 1.2e7;
    const benchRet = Float64Array.from({ length: T }, (_, j) => bench.equity[j + 1] / bench.equity[j] - 1);
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
      const tIdx = Int32Array.from(res.trades.filter(AQ.isFill).map((tr) => dateIdx.get(tr.date)));
      const blocks = { sum: new Float64Array(S), sq: new Float64Array(S), n: new Float64Array(S), lsum: new Float64Array(S), dsq: new Float64Array(S) };
      const excess = keepDaily ? new Float32Array(T) : null;
      for (let i = 1; i < t; i++) {
        const r = eq[i] / eq[i - 1] - 1;
        const j = blockOf(i);
        blocks.sum[j] += r; blocks.sq[j] += r * r; blocks.n[j]++;
        blocks.lsum[j] += Math.log(Math.max(1 + r, 1e-12));
        const e = r - rf / TD;
        if (e < 0) blocks.dsq[j] += e * e;
        if (excess) excess[i - 1] = r - benchRet[i - 1];
      }
      entries.push({
        combo,
        tr: segStats(eq, 0, trEnd, rf),
        va: segStats(eq, trEnd, vaEnd, rf),
        trTrades: tradesIn(tIdx, 0, trEnd),
        vaTrades: tradesIn(tIdx, trEnd, vaEnd),
        eq: keepEquity ? eq : null,
        tIdx: keepEquity ? tIdx : null,
        blocks,
        excess,
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

    /* 通缩夏普：以全部合格试验的训练集夏普为"噪声分布"，检验最终选定的参数（训练集夏普 vs N 次试验的期望最大值）。
     * 选定参数是训练前列里验证集最好的，其训练集夏普不高于第一名，因此这个检验比检验第一名更保守。
     * 优化目标不是夏普时，这是以夏普为尺度的辅助诊断。 */
    let dsr = null;
    const best = selected;
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
      dsr.target = 'selected';
      dsr.objective = objective;
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

    // 回测过拟合概率（CSCV）与 Hansen SPA：候选为全部合格的参数组合
    const overfit = {
      pbo: eligible.length >= 2 ? pbo(eligible.map((e) => e.blocks), { criterion: objective, rfd: rf / TD }) : null,
      spa: keepDaily && eligible.length ? spa(eligible.map((e) => e.excess)) : null,
      spaSkipped: !keepDaily,
    };
    if (overfit.pbo) delete overfit.pbo.logits;
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
      overfit,
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
      else if (tr.side === 'corporate') { p.shares = tr.shares; p.proceeds += tr.cash || 0; continue; } // 送转：股数变为新的总数
      else if (tr.side === 'dividend') { p.proceeds += tr.amount; continue; }
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
        if (i === seg.from && typeof st.adopt === 'function') st.adopt(ctx);
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
    const trades = res.trades.filter((tr) => AQ.isFill(tr) && tr.date > dates[first] && tr.date <= dates[last]);
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

  /* 风格因子：按前一日收盘时的因子值把当期成分分三组，高组 − 低组（sign 为 −1 时反过来），等权。
   * 只有当前数据支持的才计算（价值、质量需要财务数据，规模需要不复权价与股本或换手率）。 */
  const STYLE_DEFS = [
    { id: 'SIZE', label: '规模（小 − 大）', factor: 'size', sign: -1 },
    { id: 'VALUE', label: '价值（高 E/P − 低）', factor: 'ep', sign: 1 },
    { id: 'MOM', label: '动量（60 日）', factor: 'roc60', sign: 1 },
    { id: 'LOWVOL', label: '低波动', factor: 'vol20', sign: -1 },
    { id: 'QUALITY', label: '质量（高 ROE − 低）', factor: 'roe', sign: 1 },
    { id: 'LIQ', label: '非流动性（Amihud 高 − 低）', factor: 'illiq', sign: 1 },
  ];

  const facValues = (b, s, id) => cachedPanel(b, s, 'fac:' + id, () => FACTOR_BY_ID[id].f(b, s));
  const industryOf = (b, s) => (((b.meta || {}).industry || {})[s]) || null;

  /* 股票池内的风格因子日收益（第 i 个元素为 i−1 收盘到 i 收盘）：MKT 为成分等权收益 − 无风险利率；
   * 其余见 STYLE_DEFS，当日有效标的不足 6 只时记为 NaN。
   * 有行业分类时另给出各行业等权收益 − 全体等权收益（industries），用于加入行业的归因模型；平均不足 3 只的行业不单列，
   * 成分最多的行业作为基准不单列（避免与市场因子共线）。 */
  function styleFactors(bt, rf = 0.02) {
    const b = bt.bars();
    const syms = bt.symbols;
    const n = bt.dates.length;
    const rfd = rf / TD;
    const ret = syms.map((s) => b.close[s].map((c, i) => (i ? c / b.close[s][i - 1] - 1 : NaN)));
    const avail = new Set(availableFactors(b, syms).map((f) => f.id));
    const defs = STYLE_DEFS.filter((d) => avail.has(d.factor));
    const vals = defs.map((d) => syms.map((s) => facValues(b, s, d.factor)));
    const out = { MKT: new Float64Array(n).fill(NaN), order: defs.map((d) => d.id), labels: { MKT: '市场（等权）' } };
    defs.forEach((d) => { out[d.id] = new Float64Array(n).fill(NaN); out.labels[d.id] = d.label; });
    const groups = syms.map((s) => industryOf(b, s));
    const hasInd = groups.some(Boolean);
    const indSum = new Map(), indCnt = new Map(), indDays = new Map();
    const indRet = hasInd ? new Map() : null;
    const spread = (keys, i, sign) => {
      if (keys.length < 6) return NaN;
      keys.sort((p, q) => p[1] - q[1]);
      const m = Math.floor(keys.length / 3);
      const avg = (arr) => arr.reduce((acc, [k]) => acc + ret[k][i], 0) / arr.length;
      return sign * (avg(keys.slice(-m)) - avg(keys.slice(0, m)));
    };
    for (let i = 1; i < n; i++) {
      let sum = 0, cnt = 0;
      const keys = defs.map(() => []);
      indSum.clear(); indCnt.clear();
      syms.forEach((s, k) => {
        const r = ret[k][i];
        if (!fin(r) || (b.member && !b.member[s][i - 1])) return;
        sum += r; cnt++;
        defs.forEach((d, j) => { const v = vals[j][k][i - 1]; if (fin(v)) keys[j].push([k, v]); });
        if (hasInd && groups[k]) {
          indSum.set(groups[k], (indSum.get(groups[k]) || 0) + r);
          indCnt.set(groups[k], (indCnt.get(groups[k]) || 0) + 1);
        }
      });
      if (!cnt) continue;
      const mkt = sum / cnt;
      out.MKT[i] = mkt - rfd;
      defs.forEach((d, j) => (out[d.id][i] = spread(keys[j], i, d.sign)));
      if (hasInd) {
        for (const [g, c] of indCnt) {
          if (!indRet.has(g)) indRet.set(g, new Float64Array(n).fill(NaN));
          indRet.get(g)[i] = indSum.get(g) / c - mkt;
          indDays.set(g, (indDays.get(g) || 0) + c);
        }
      }
    }
    if (hasInd) {
      const days = n - 1;
      const keep = [...indDays].filter(([, c]) => c / days >= 3).sort((p, q) => q[1] - p[1]);
      out.industries = Object.fromEntries(keep.slice(1).map(([g]) => [g, indRet.get(g)]));
      out.baseIndustry = keep.length ? keep[0][0] : null;
    }
    return out;
  }

  /* 暴露回归：策略日超额收益 = α + Σ β·因子 + ε，区间 (a, b]。
   * industry 为真时再加入行业因子（行业等权 − 全体等权）。区间内缺失超过一半的因子不纳入。α 为年化，t 值用 HAC 标准误。 */
  function exposure(eq, sf, a, b, rf = 0.02, { industry = false } = {}) {
    const rfd = rf / TD;
    const okCol = (arr) => {
      let ok = 0;
      for (let i = a + 1; i <= b; i++) if (fin(arr[i])) ok++;
      return ok >= (b - a) / 2 && ok >= 60;
    };
    if (!okCol(sf.MKT)) return null;
    const cols = [{ id: 'MKT', label: sf.labels.MKT, arr: sf.MKT, kind: 'style' }];
    const order = sf.order || ['MOM', 'LOWVOL'];
    for (const id of order) if (sf[id] && okCol(sf[id])) cols.push({ id, label: sf.labels ? sf.labels[id] : id, arr: sf[id], kind: 'style' });
    if (industry && sf.industries) {
      for (const [g, arr] of Object.entries(sf.industries)) if (okCol(arr)) cols.push({ id: 'IND:' + g, label: g, arr, kind: 'industry' });
    }
    const y = [], X = [];
    for (let i = a + 1; i <= b; i++) {
      const r = eq[i] / eq[i - 1] - 1;
      const row = cols.map((c) => c.arr[i]);
      if (!fin(r) || !row.every(fin)) continue;
      y.push(r - rfd);
      X.push(row);
    }
    if (y.length < Math.max(60, 4 * cols.length)) return null;
    const fit = olsHAC(y, X);
    if (!fit) return null;
    return {
      alpha: fit.coef[0] * TD,
      alphaT: fit.t[0],
      loadings: cols.map((c, j) => ({ id: c.id, label: c.label, kind: c.kind, beta: fit.coef[j + 1], t: fit.t[j + 1] })),
      r2: fit.r2,
      n: fit.n,
      lag: fit.lag,
      missing: STYLE_DEFS.map((d) => d.id).filter((id) => !cols.some((c) => c.id === id)),
      baseIndustry: industry ? sf.baseIndustry : null,
    };
  }

  /* 截面中性化：先把因子值转成截面秩分（−0.5 ~ 0.5），'industry' 再减去所在行业均值（行业内只有 1 只时为 0），
   * 'industry_size' 再对行业内去均值后的对数流通市值回归取残差（Frisch–Waugh），缺市值的保留行业中性化结果。
   * xs 与 syms 一一对应（已剔除缺失值），t 为日期序号。 */
  /* 行业分类必须是时点数据才能进入历史信号。data/hs300_industry.json 是今天的分类（公司会改行业、分类标准会修订），
   * 用它在历史上做中性化或行业约束会引入前视偏差，所以只允许用于事后归因；meta.industryPIT === true 时才放行。 */
  const NEUTRAL_MODES = ['none', 'size', 'industry', 'industry_size'];
  const INDUSTRY_MODES = ['industry', 'industry_size'];
  function assertIndustryPIT(b, what) {
    if (!(b && b.meta && b.meta.industryPIT === true)) {
      throw new Error(`${what}需要时点（point-in-time）行业分类；当前行业标签是今天的分类，用于历史信号会引入前视偏差，只能用于事后归因`);
    }
  }

  function neutralize(xs, syms, mode, b, t) {
    if (INDUSTRY_MODES.includes(mode)) assertIndustryPIT(b, '行业中性化');
    const n = xs.length;
    const r = ranks(xs).map((v) => (v - 0.5) / n - 0.5);
    if (!mode || mode === 'none' || n < 3) return r;
    // 'size'：只对对数流通市值回归取残差（市值是时点数据）
    const g = mode === 'size' ? syms.map(() => '—') : syms.map((s) => industryOf(b, s) || '—');
    const demean = (v, use) => {
      const sum = new Map(), cnt = new Map();
      v.forEach((x, k) => { if (use[k]) { sum.set(g[k], (sum.get(g[k]) || 0) + x); cnt.set(g[k], (cnt.get(g[k]) || 0) + 1); } });
      return v.map((x, k) => (use[k] ? x - sum.get(g[k]) / cnt.get(g[k]) : 0));
    };
    const all = r.map(() => true);
    const xd = demean(r, all);
    if (mode === 'industry') return xd;
    const z = syms.map((s) => { const c = floatCap(b, s)[t]; return c > 0 ? Math.log(c) : NaN; });
    const use = z.map(fin);
    const zd = demean(z.map((v) => (fin(v) ? v : 0)), use);
    let sxz = 0, szz = 0;
    for (let k = 0; k < n; k++) if (use[k]) { sxz += xd[k] * zd[k]; szz += zd[k] * zd[k]; }
    const beta = szz > 0 ? sxz / szz : 0;
    return xd.map((x, k) => (use[k] ? x - beta * zd[k] : x));
  }

  // ---------- 因子研究 ----------

  function cachedPanel(b, s, key, fn) {
    const k = s + '|' + key;
    if (!b.cache.has(k)) b.cache.set(k, fn());
    return b.cache.get(k);
  }

  /* 滚动 12 个月值（年初至今累计口径）：年报即全年；其余 = 本期累计 + 上年年报 − 上年同期累计，只用当时已公告的报告。 */
  function ttm(r, known, key) {
    const md = r.report.slice(5);
    if (md === '12-31') return fin(r[key]) ? r[key] : NaN;
    const y = +r.report.slice(0, 4);
    const annual = known.get(`${y - 1}-12-31`), same = known.get(`${y - 1}-${md}`);
    return annual && same && fin(annual[key]) && fin(same[key]) && fin(r[key]) ? r[key] + annual[key] - same[key] : NaN;
  }

  /* 股本记录是双时态的：date = 生效日，known = 公告日（缺省同生效日）。
   * sharesAt(list, date, key, asOf)：站在 asOf 这一天（只用公告日早于 asOf 的记录），还原 date 当天（含）生效的股本。 */
  const knownOf = (x) => x.known || x.date;
  function sharesAt(list, date, key, asOf) {
    let v = NaN, best = '';
    for (const x of list) {
      if (x.date > date || !(knownOf(x) < asOf)) continue;
      if (x.date >= best) { best = x.date; v = x[key]; }
    }
    return v;
  }

  /* 股本（总股本、流通 A 股）的逐日序列：第 i 天用"公告日早于当天、且已生效"的最新一条（按生效日）。 */
  function sharesPanel(b, s) {
    return cachedPanel(b, s, 'shares', () => {
      const n = b.dates.length;
      const total = new Float64Array(n).fill(NaN), float = new Float64Array(n).fill(NaN);
      const list = (((b.meta || {}).shares || {})[s]) || [];
      // 可用时刻：生效日与"公告日之后"两者中较晚的那个（'!' 排在同一天之后，表示公告日的下一个交易日起）
      const act = list.map((x) => ({ x, at: knownOf(x) >= x.date ? knownOf(x) + '!' : x.date })).sort((p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : 0));
      let j = 0, cur = null;
      for (let i = 0; i < n; i++) {
        while (j < act.length && act[j].at <= b.dates[i]) {
          const x = act[j++].x;
          if (!cur || x.date >= cur.date) cur = x;
        }
        if (cur) { total[i] = cur.total; float[i] = cur.float; }
      }
      return { total, float, has: list.length > 0 };
    });
  }

  /* 财务数据按公告日对齐：公告日之后的第一个交易日起才可用（公告可能在盘后发布）。
   * meta.fundAvail === 'update' 时改用最后更新日（保守口径：数据源会在次年用追溯调整后的数值覆盖，更新日之前看不到这个数）。
   * 估值用归母净利润总额与总股本计算：数据源的每股收益会按之后的送转追溯调整，直接用会低估当时的 E/P。 */
  function fundPanel(b, s) {
    return cachedPanel(b, s, 'fund', () => {
      const dates = b.dates, n = dates.length;
      const meta = b.meta || {};
      const useUpdate = meta.fundAvail === 'update';
      const avail = (r) => (useUpdate && r.update > r.notice ? r.update : r.notice);
      const recs = ((meta.fundamentals || {})[s] || [])
        .filter((r) => r.notice && r.report)
        .map((r) => ({ ...r, avail: avail(r) }))
        .sort((x, y) => (x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : x.report < y.report ? -1 : 1));
      const shares = (meta.shares || {})[s] || [];
      const col = () => new Float32Array(n).fill(NaN); // 财务指标单精度足够，省内存
      const out = { profitTTM: col(), epsTTM: col(), bps: col(), equity: col(), revYoy: col(), profitYoy: col() };
      const known = new Map();
      let latest = null, j = 0, cur = null, eqShares = NaN;
      for (let i = 0; i < n; i++) {
        let changed = false;
        while (j < recs.length && recs[j].avail < dates[i]) {
          const r = recs[j++];
          known.set(r.report, r);
          if (!latest || r.report >= latest.report) latest = r;
          changed = true;
        }
        if (!latest) continue;
        // 报告期末的总股本：站在今天（只用已公告的股本记录）还原报告期末的状态；股本公告可能晚于财报，所以每天都要看
        const sh = sharesAt(shares, latest.report, 'total', dates[i]);
        if (changed || !Object.is(sh, eqShares)) {
          eqShares = sh;
          const bps = latest.bps > 0 ? latest.bps : NaN;
          cur = {
            profitTTM: ttm(latest, known, 'profit'),
            epsTTM: ttm(latest, known, 'eps'),
            bps,
            equity: bps * sh, // 报告期末归母净资产（数据源的每股净资产是报告期口径，未被之后的送转追溯调整）
            revYoy: fin(latest.revYoy) ? latest.revYoy : NaN,
            profitYoy: fin(latest.profitYoy) ? latest.profitYoy : NaN,
          };
        }
        for (const k in cur) out[k][i] = cur[k];
      }
      return out;
    });
  }

  // 总市值 = 不复权价 × 当时总股本
  function marketCap(b, s) {
    return cachedPanel(b, s, 'mktcap', () => {
      const px = b.raw[s], sh = sharesPanel(b, s).total;
      return Float64Array.from(b.dates, (_, i) => (px && px[i] > 0 && sh[i] > 0 ? px[i] * sh[i] : NaN));
    });
  }

  // 流通市值 = 不复权价 × 流通股本；流通股本 = 近 20 日成交量（手）× 100 ÷ 换手率，用 20 日合计减小换手率取整误差
  function floatCap(b, s) {
    return cachedPanel(b, s, 'floatcap', () => {
      const n = b.dates.length;
      const out = new Float64Array(n).fill(NaN);
      // 有股本变动历史时直接用流通 A 股 × 不复权价（时点数据）；否则用换手率反推
      const sp = sharesPanel(b, s);
      if (sp.has && b.raw[s]) {
        for (let i = 0; i < n; i++) out[i] = b.raw[s][i] > 0 && sp.float[i] > 0 ? b.raw[s][i] * sp.float[i] : NaN;
        return out;
      }
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
        // 成交额必须用真实价格：成交量（手）× 100 × 不复权价；复权价的尺度随历史公司行为而变，会把因子放大缩小
        const r = ind.roc(b.close[s], 1);
        const px = b.raw[s] || b.close[s];
        const x = r.map((v, i) => Math.abs(v) / (px[i] * b.volume[s][i] * 100) * 1e11);
        return ind.sma(Float64Array.from(x, (v) => (Number.isFinite(v) ? v : NaN)), 20);
      },
    },
    // 以下需要个股数据：财务数据（按公告日对齐）、不复权价与换手率
    {
      id: 'ep', label: '盈利收益率 E/P（TTM）', needsFund: true,
      f: (b, s) => {
        const F = fundPanel(b, s), cap = marketCap(b, s);
        // 优先：滚动归母净利润 / 总市值；缺股本数据时退回每股收益 / 股价（每股收益可能被追溯调整）
        return Float64Array.from(b.dates, (_, i) => (cap[i] > 0 ? F.profitTTM[i] / cap[i] : b.raw[s] && b.raw[s][i] > 0 ? F.epsTTM[i] / b.raw[s][i] : NaN));
      },
    },
    {
      // 报告期末归母净资产 / 当前总市值；每股净资产 / 当前股价在报告期后送转时会被放大（股价除权、每股净资产还是旧口径）
      id: 'bp', label: '账面市值比 B/P', needsFund: true,
      f: (b, s) => {
        const F = fundPanel(b, s), cap = marketCap(b, s);
        return Float64Array.from(b.dates, (_, i) => (cap[i] > 0 && F.equity[i] > 0 ? F.equity[i] / cap[i] : b.raw[s] && b.raw[s][i] > 0 ? F.bps[i] / b.raw[s][i] : NaN));
      },
    },
    {
      id: 'roe', label: 'ROE（TTM）', needsFund: true,
      f: (b, s) => {
        const F = fundPanel(b, s);
        return Float64Array.from(b.dates, (_, i) => (F.equity[i] > 0 ? F.profitTTM[i] / F.equity[i] : F.bps[i] > 0 ? F.epsTTM[i] / F.bps[i] : NaN));
      },
    },
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
    constructor({ factors = [], topN = 2, rebalance = 20, trendN = 0, sizing = 'equal', neutral = 'none',
      ic = 0.05, riskAversion = 10, maxWeight = 10, turnoverCost = 0.15, industryPenalty = 0 } = {}) {
      const unknown = factors.find((f) => !FACTOR_BY_ID[f.id]);
      if (unknown) throw new Error('未知因子：' + unknown.id);
      this.factors = factors.map((f) => ({ id: f.id, weight: +f.weight || 0 })).filter((f) => f.weight !== 0);
      if (!this.factors.length) throw new Error('至少选一个权重不为 0 的因子');
      if (!(topN >= 1 && rebalance >= 1 && trendN >= 0)) throw new Error('持有数量、调仓间隔至少为 1，趋势均线不能为负');
      Object.assign(this, { name: 'factor', topN: Math.floor(topN), rebalance: Math.floor(rebalance), trendN: Math.floor(trendN), sizing,
        neutral: NEUTRAL_MODES.includes(neutral) ? neutral : 'none' });
      // 组合优化（sizing = 'optimize'）：Grinold 预期收益 α = IC × σ × z；单票上限与单边成本以百分比给出
      if (sizing === 'optimize') {
        if (!(ic > 0 && riskAversion >= 0 && maxWeight > 0 && turnoverCost >= 0 && industryPenalty >= 0)) throw new Error('组合优化参数需为正（IC、单票上限）或非负');
        Object.assign(this, { ic: +ic, riskAversion: +riskAversion, maxWeight: +maxWeight / 100, turnoverCost: +turnoverCost / 100, industryPenalty: +industryPenalty });
      }
    }

    params() {
      const out = { topN: this.topN, rebalance: this.rebalance, trendN: this.trendN, neutral: this.neutral };
      if (this.sizing === 'optimize') Object.assign(out, { ic: this.ic, riskAversion: this.riskAversion, maxWeight: this.maxWeight, turnoverCost: this.turnoverCost, industryPenalty: this.industryPenalty });
      this.factors.forEach((f) => (out['w.' + f.id] = f.weight));
      return out;
    }

    /* 回测引擎调用：预先计算因子值与趋势过滤用的指数。
     * 趋势指数只用决策当时可知的信息：有官方指数（meta.index）时用它；否则为"前一交易日在股票池内的标的"日收益等权的链式指数，
     * 未来才纳入的股票在纳入前不影响任何决策。 */
    prepare(close, dates, symbols, bars) {
      if (INDUSTRY_MODES.includes(this.neutral)) assertIndustryPIT(bars, '行业中性化');
      if (this.sizing === 'optimize' && this.industryPenalty > 0) assertIndustryPIT(bars, '组合优化的行业偏离惩罚');
      const cache = (s, key, fn) => {
        const k = s + '|' + key;
        if (!bars.cache.has(k)) bars.cache.set(k, fn());
        return bars.cache.get(k);
      };
      const vals = this.factors.map((f) => symbols.map((s) => cache(s, 'fac:' + f.id, () => FACTOR_BY_ID[f.id].f(bars, s))));
      const vol = this.sizing === 'invvol' ? symbols.map((s) => cache(s, 'vol20', () => AQ.annVol(bars.close[s], 20))) : null;
      let riskOn = () => true;
      if (this.trendN > 0) {
        const idx = trendIndex(close, dates, symbols, bars);
        const ma = ind.sma(idx, this.trendN);
        riskOn = (i) => !fin(ma[i]) || idx[i] > ma[i];
      }
      this.lastW0 = null;
      this.st = { close, dates, symbols, bars, vals, vol, riskOn, member: bars.member, N: symbols.length,
        prevRow: new Array(symbols.length).fill(0), wasOn: true, lastRebal: -Infinity };
    }

    // 连续账户切换参数时：下一个决策日立即按新参数调仓
    adopt() {
      this.st.lastRebal = -Infinity;
      this.st.wasOn = true;
    }

    /* 每个交易日收盘后决策。ctx 为引擎给出的实际账户状态（持股、总资产）；组合优化的换手惩罚以实际持仓权重为起点，
     * 而不是上一次的目标（目标可能因涨跌停、停牌、容量没有成交）。ctx 为空时（预览）退回上一次的目标。 */
    decide(i, ctx) {
      const st = this.st;
      const { close, symbols, bars, vals, vol, member, N } = st;
      if (i < WARM) return null;
      const on = st.riskOn(i);
      const due = i - st.lastRebal >= this.rebalance;
      if (!on) {
        const out = st.wasOn ? new Array(N).fill(0) : null;
        st.wasOn = false;
        return out;
      }
      if (!due && st.wasOn) return null;
      st.wasOn = true;
      st.lastRebal = i;
      const eligible = [];
      for (let k = 0; k < N; k++) {
        if (member && !member[symbols[k]][i]) continue;
        if (vals.every((v) => fin(v[k][i])) && fin(close[symbols[k]][i])) eligible.push(k);
      }
      const score = new Array(N).fill(0);
      this.factors.forEach((f, j) => {
        // 截面秩分（−0.5 ~ 0.5），可选市值 / 行业 / 行业 + 市值中性化
        const z = neutralize(eligible.map((k) => vals[j][k][i]), eligible.map((k) => symbols[k]), this.neutral, bars, i);
        eligible.forEach((k, e) => (score[k] += f.weight * z[e]));
      });
      const picked = eligible.slice().sort((a, b2) => score[b2] - score[a]).slice(0, this.topN);
      const row = new Array(N).fill(0);
      if (this.sizing === 'optimize' && eligible.length >= 2) {
        const w0 = ctx && ctx.equity > 0 ? symbols.map((s) => Math.max(ctx.value(s), 0) / ctx.equity) : st.prevRow;
        this.lastW0 = new Map(symbols.map((s, k) => [s, w0[k]]));
        const w = this.optimizeRow(i, eligible, score, w0, symbols, close, bars);
        w.forEach((v, k) => (row[k] = v));
        st.prevRow = row;
        return row;
      }
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
      st.prevRow = row;
      return row;
    }

    /* 理想化预览：假设每个目标都按时全部成交（组合优化以上一次目标为起点）。回测一律走引擎的 decide 路径。 */
    generate(close, dates, symbols, bars) {
      this.prepare(close, dates, symbols, bars);
      return dates.map((_, i) => this.decide(i, null));
    }
  }

  // 趋势过滤用的指数（见 FactorStrategy.prepare）
  function trendIndex(close, dates, symbols, bars) {
    const n = dates.length;
    const off = bars.meta && bars.meta.index;
    if (off && off.dates && off.dates.length) {
      // 官方指数按日期对齐，缺失日沿用前值
      const out = new Float64Array(n).fill(NaN);
      let j = 0, last = NaN;
      for (let i = 0; i < n; i++) {
        while (j < off.dates.length && off.dates[j] <= dates[i]) { if (off.close[j] > 0) last = off.close[j]; j++; }
        out[i] = last;
      }
      if (out.some(fin)) return out;
    }
    const member = bars.member;
    const out = new Float64Array(n).fill(NaN);
    let level = 1, started = false;
    for (let i = 1; i < n; i++) {
      let sum = 0, cnt = 0;
      for (const s of symbols) {
        if (member && !member[s][i - 1]) continue;
        const a = close[s][i - 1], c = close[s][i];
        if (a > 0 && c > 0) { sum += c / a - 1; cnt++; }
      }
      if (cnt) { level *= 1 + sum / cnt; started = true; }
      if (started) out[i] = level;
    }
    return out;
  }

  /* 组合优化的一次调仓。"持有几只"（topN）是持仓数量上限：
   *   候选 = 综合分最高的 topN 只 + 仍排在前 2×topN 的现有持仓（减少来回换手）；
   *   优化后非零权重多于 topN 只时，保留权重最大的 topN 只再优化一次。
   * 协方差用候选过去 250 个交易日的日收益做 Ledoit–Wolf 收缩；α、Σ 都换算到调仓周期。
   * w0 为起点权重（实际持仓）；单票上限是硬约束，放不满时剩余为现金。返回每只标的的权重（Map: k → w）。 */
  FactorStrategy.prototype.optimizeRow = function (i, eligible, score, w0All, symbols, close, bars) {
    const ranked = eligible.slice().sort((a, b) => score[b] - score[a]);
    const buffer = new Set(ranked.slice(0, 2 * this.topN));
    const cand = [...new Set([...ranked.slice(0, this.topN), ...ranked.filter((k) => w0All[k] > 0 && buffer.has(k))])];
    let out = this.solveRow(i, cand, eligible, score, w0All, symbols, close, bars);
    if (out.size > this.topN) {
      const keep = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.topN).map(([k]) => k);
      out = this.solveRow(i, keep, eligible, score, w0All, symbols, close, bars);
    }
    return out;
  };

  FactorStrategy.prototype.solveRow = function (i, cand, eligible, score, w0All, symbols, close, bars) {
    const W = 250;
    const ranked = cand.slice().sort((a, b) => score[b] - score[a]);
    // 历史不足的剔除
    const X = [], use = [];
    for (const k of cand) {
      const c = close[symbols[k]];
      let ok = 0, moved = 0;
      for (let t = Math.max(1, i - W + 1); t <= i; t++) if (c[t] > 0 && c[t - 1] > 0) { ok++; if (c[t] !== c[t - 1]) moved++; }
      if (ok >= W * 0.8 && moved >= 20) use.push(k); // 整段停牌（方差为 0）的不参与优化
    }
    const out = new Map();
    if (use.length < 2) {
      // 历史不足以估计协方差：等权持有候选里综合分最高的（不超过 topN 只），每只不超过单票上限，其余为现金
      const m = Math.min(ranked.length, this.topN);
      const w = m ? Math.min(1 / m, this.maxWeight) : 0;
      ranked.slice(0, m).forEach((k) => out.set(k, w));
      return out;
    }
    for (let t = Math.max(1, i - W + 1); t <= i; t++) {
      X.push(use.map((k) => { const c = close[symbols[k]]; const r = c[t] / c[t - 1] - 1; return fin(r) ? r : 0; }));
    }
    const lw = PF.ledoitWolf(X);
    const n = use.length, R = this.rebalance;
    const sc = eligible.map((k) => score[k]);
    const mu = mean(sc), sd = Math.sqrt(sc.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(sc.length - 1, 1)) || 1;
    const alpha = Float64Array.from(use, (k, j) => this.ic * Math.sqrt(lw.cov[j * n + j] * R) * ((score[k] - mu) / sd));
    const cov = Float64Array.from(lw.cov, (v) => v * R);
    const w0 = Float64Array.from(use, (k) => w0All[k] || 0);
    let groups = null, bench = null;
    const industry = bars.meta && bars.meta.industry;
    if (this.industryPenalty > 0 && industry) {
      groups = use.map((k) => industry[symbols[k]] || '—');
      bench = {};
      for (const k of eligible) { const g = industry[symbols[k]] || '—'; bench[g] = (bench[g] || 0) + 1 / eligible.length; }
    }
    const w = PF.optimize({ alpha, cov, w0, lambda: this.riskAversion, kappa: this.turnoverCost, cap: this.maxWeight, groups, bench, rho: this.industryPenalty });
    // 不再归一化：归一化会把权重放大到超过单票上限
    use.forEach((k, j) => { if (w[j] > 1e-4) out.set(k, Math.min(w[j], this.maxWeight)); });
    return out;
  };

  // 按配置构建策略：type 为 'factor' 时是多因子选股，否则为规则组合
  function buildStrategy(config) {
    if (config.type === 'factor') return new FactorStrategy(config.factor || {});
    return new AQ.RuleStrategy(config);
  }

  // 全部策略类型（含动量轮动、买入持有），供后台线程使用
  function buildAnyStrategy(config) {
    if (config.type === 'momentum') return new AQ.MomentumRotation(config.momentum);
    if (config.type === 'buy_hold') return new AQ.BuyAndHold();
    return buildStrategy(config);
  }

  /* 容量曲线与成本压力：同一策略在不同资金规模、不同成本倍数下重跑。
   * 成本倍数同时放大佣金率、最低佣金、滑点与冲击系数（印花税、过户费是法定的，不放大）。 */
  function stressTest({ data, engine, config, rf = 0.02, capitals = [1e6, 5e6, 2e7, 1e8, 5e8, 1e9], multipliers = [1, 1.5, 2, 3] }, onProgress = () => {}) {
    const run = (cash, m) => {
      const fees = engine.fees || {};
      const e = { ...engine, initialCash: cash, slippage: (engine.slippage || 0) * m, impact: (engine.impact || 0) * m,
        fees: { ...fees, commissionRate: (fees.commissionRate ?? 0.00025) * m, minCommission: (fees.minCommission ?? 5) * m } };
      const res = makeBacktester(data, e).run(buildAnyStrategy(config));
      const sm = AQ.summarize(res, rf);
      return { cash, mult: m, cagr: sm.cagr, sharpe: sm.sharpe, maxDD: sm.max_drawdown, turnover: sm.annual_turnover,
        costShare: (sm.total_fees + sm.total_impact) / cash, impactShare: sm.total_impact / cash };
    };
    const total = capitals.length + multipliers.length - 1;
    let done = 0;
    const tick = () => onProgress(++done, total);
    const capacity = capitals.map((c) => { const r = run(c, 1); tick(); return r; });
    const base = capitals.includes(engine.initialCash) ? engine.initialCash : capitals[0];
    const cost = multipliers.map((m) => { if (m === 1) return capacity[capitals.indexOf(base)] || run(base, 1); const r = run(base, m); tick(); return r; });
    return { capacity, cost, base };
  }

  /* 信号衰减：截面 IC 随预测周期的变化（各周期非重叠抽样）、按年份的截面 IC、因子自身的秩自相关（越低换手越高）。 */
  function factorDecay(bt, factorId, { horizons = [1, 5, 10, 20, 60], yearH = 5, neutral = 'none' } = {}) {
    const b = bt.bars();
    if (INDUSTRY_MODES.includes(neutral)) assertIndustryPIT(b, '行业中性化');
    const syms = bt.symbols;
    const f = FACTOR_BY_ID[factorId];
    const vals = Object.fromEntries(syms.map((s) => [s, f.f(b, s)]));
    const member = (s, t) => !b.member || b.member[s][t];
    const csIC = (t, fwd) => {
      const x = [], y = [], ss = [];
      for (const s of syms) {
        const v = vals[s][t], r = fwd[s][t];
        if (fin(v) && fin(r) && member(s, t)) { x.push(v); y.push(r); ss.push(s); }
      }
      if (x.length < 5) return NaN;
      return spearman(neutral === 'none' ? x : neutralize(x, ss, neutral, b, t), y);
    };
    const byH = horizons.map((h) => {
      const fwd = Object.fromEntries(syms.map((s) => [s, forwardReturnsOf(bt, s, h)]));
      const ics = [];
      for (let t = WARM; t < bt.dates.length; t += h) { const c = csIC(t, fwd); if (fin(c)) ics.push(c); }
      const m = ics.length > 2 ? moments(ics) : null;
      return { h, ic: m ? m.mean : NaN, icir: m && m.std > 0 ? m.mean / m.std : NaN, n: ics.length };
    });
    const fwdY = Object.fromEntries(syms.map((s) => [s, forwardReturnsOf(bt, s, yearH)]));
    const years = {};
    for (let t = WARM; t < bt.dates.length; t += yearH) {
      const c = csIC(t, fwdY);
      if (!fin(c)) continue;
      const y = bt.dates[t].slice(0, 4);
      (years[y] = years[y] || []).push(c);
    }
    const autocorr = horizons.map((h) => {
      const cs = [];
      for (let t = WARM + h; t < bt.dates.length; t += Math.max(h, 5)) {
        const x = [], y = [];
        for (const s of syms) { const a = vals[s][t - h], c = vals[s][t]; if (fin(a) && fin(c) && member(s, t)) { x.push(a); y.push(c); } }
        if (x.length >= 5) { const r = spearman(x, y); if (fin(r)) cs.push(r); }
      }
      return { h, rho: cs.length ? mean(cs) : NaN };
    });
    return {
      id: factorId, label: f.label, byH,
      years: Object.entries(years).map(([y, a]) => ({ year: y, ic: mean(a), n: a.length })),
      autocorr,
    };
  }

  // 未来收益（理想化，不检查能否成交）：t 日收盘出信号，t+1 日开盘买入，持有 h 日后开盘卖出
  function forwardReturns(open, h) {
    const out = new Float64Array(open.length).fill(NaN);
    for (let t = 0; t + 1 + h < open.length; t++) out[t] = open[t + 1 + h] / open[t + 1] - 1;
    return out;
  }

  /* 可成交的未来收益：t+1 日开盘买入、t+1+h 日开盘卖出，用未填充的复权开盘价；
   * 买入日停牌或开盘涨停、卖出日停牌或开盘跌停时为 NaN（该样本不参与 IC 与衰减统计，不用前值"成交"）。 */
  function forwardReturnsOf(bt, s, h) {
    const n = bt.dates.length, o = bt.open[s], tr = bt.tradable[s], px = bt.xopen[s], pc = bt.prevClose[s];
    const out = new Float64Array(n).fill(NaN);
    for (let t = 0; t + 1 + h < n; t++) {
      const a = t + 1, e = t + 1 + h;
      if (!tr[a] || !tr[e]) continue;
      if (AQ.isLimitUp(s, bt.dates[a], px[a], pc[a], bt.limitOf(s, a))) continue;
      if (AQ.isLimitDown(s, bt.dates[e], px[e], pc[e], bt.limitOf(s, e))) continue;
      out[t] = o[e] / o[a] - 1;
    }
    return out;
  }

  function factorPanel(bt, h, ids) {
    const b = bt.bars();
    const factors = availableFactors(b, bt.symbols).filter((f) => !ids || ids.includes(f.id));
    const fwd = {}, vals = {};
    for (const s of bt.symbols) {
      fwd[s] = forwardReturnsOf(bt, s, h);
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
    const shares = (b.meta && b.meta.shares) || {};
    const hasCap = symbols.some((s) => b.raw[s] && (b.turnover[s] || (shares[s] && shares[s].length)));
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
  function factorIC(bt, h, { B = 200, seed = 7, neutral = 'none' } = {}) {
    const b = bt.bars();
    if (INDUSTRY_MODES.includes(neutral)) assertIndustryPIT(b, '行业中性化');
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
          const x = [], y = [], ss = [];
          for (const s of syms) {
            const v = vals[s][f.id][t], r = fwd[s][t];
            if (fin(v) && fin(r)) { x.push(v); y.push(r); ss.push(s); }
          }
          if (x.length >= 3) {
            const ic = spearman(neutral === 'none' ? x : neutralize(x, ss, neutral, b, t), y);
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

  /* 可交易的分组组合：每 h 天在 t 日收盘按因子值（可选中性化）把当期股票池从低到高分 q 组，各组等权；
   * 每组都用同一个回测引擎实际成交：t+1 日开盘、真实价格、整手、涨跌停与停牌不能成交、费用与滑点（及启用时的容量、冲击）与回测一致。
   * 资金规模默认 1 亿（避免高价股因整手买不起）。多空 = 最高组日收益 − 最低组日收益（A 股融券受限，仅作因子强弱的参考）。
   * 组数按标的数量：≥10 只分 5 组，6~9 只分 3 组，更少不分组。 */
  function factorPortfolios(bt, factorId, h, { q, neutral = 'none', capital = 1e8 } = {}) {
    const b = bt.bars();
    if (INDUSTRY_MODES.includes(neutral)) assertIndustryPIT(b, '行业中性化');
    const syms = bt.symbols;
    const N = syms.length;
    q = q || (N >= 10 ? 5 : N >= 6 ? 3 : 0);
    if (!q) return { q: 0, error: '分组组合至少需要 6 只标的' };
    const f = FACTOR_BY_ID[factorId];
    const vals = syms.map((s) => cachedPanel(b, s, 'fac:' + factorId, () => f.f(b, s)));
    const n = bt.dates.length;
    const rows = Array.from({ length: q }, () => new Array(n).fill(null));
    let t0 = -1, periods = 0;
    for (let t = WARM; t < n; t += h) {
      const elig = [];
      syms.forEach((s, k) => { if ((!b.member || b.member[s][t]) && fin(vals[k][t]) && fin(b.close[s][t])) elig.push(k); });
      if (elig.length < q) continue;
      const z = neutralize(elig.map((k) => vals[k][t]), elig.map((k) => syms[k]), neutral, b, t);
      const order = elig.map((k, e) => [k, z[e]]).sort((p, p2) => p[1] - p2[1]).map((p) => p[0]);
      const m = order.length;
      for (let g = 0; g < q; g++) {
        const members = order.slice(Math.floor((g * m) / q), Math.floor(((g + 1) * m) / q));
        const row = new Array(N).fill(0);
        members.forEach((k) => (row[k] = 1 / members.length));
        rows[g][t] = row;
      }
      if (t0 < 0) t0 = t;
      periods++;
    }
    if (t0 < 0) return { q: 0, error: '有效样本不足，无法分组' };
    const saved = bt.initialCash;
    const runs = [];
    try {
      bt.initialCash = capital;
      for (let g = 0; g < q; g++) runs.push(bt.run({ name: 'quantile', params: () => ({ factor: factorId, h, q, group: g + 1 }), generate: () => rows[g] }));
    } finally {
      bt.initialCash = saved;
    }
    const dates = bt.dates.slice(t0);
    const daily = (eq) => { const r = []; for (let i = t0 + 1; i < n; i++) r.push(eq[i] / eq[i - 1] - 1); return r; };
    const curve = (r) => { let v = 1; return [1].concat(r.map((x) => (v *= 1 + x))); };
    const years = Math.max(n - 1 - t0, 1) / TD;
    const groups = runs.map((res, g) => {
      const eq = res.equity.slice(t0);
      const meanEq = eq.reduce((a, v) => a + v, 0) / eq.length;
      const tr = res.trades.filter(AQ.isFill);
      const fees = tr.reduce((a, x) => a + x.fee, 0), impact = tr.reduce((a, x) => a + (x.impact || 0), 0);
      return {
        group: g + 1,
        ...periodStats(daily(res.equity), TD),
        fees, impact,
        costDrag: (fees + impact) / meanEq / years,
        turnover: tr.reduce((a, x) => a + x.amount, 0) / meanEq / years,
        equity: eq.map((v) => v / eq[0]),
      };
    });
    const top = daily(runs[q - 1].equity), bot = daily(runs[0].equity);
    const ls = top.map((x, k) => x - bot[k]);
    return {
      q, h, engine: true, capital, periods, dates, groups,
      longShort: { ...periodStats(ls, TD), equity: curve(ls) },
    };
  }

  /* 影子账户（纸面交易）：把冻结的目标权重按时间顺序交给回测引擎执行——次日开盘、真实价格、整手、
   * 涨跌停与停牌不能成交（次日继续）、费用、滑点、容量与冲击都与回测一致，而不是"权重 × 收益"。
   * entries: [{ date, targets: { 代码: 权重 }, engine }]。按冻结分段：每次冻结之后到下一次冻结为止，用这次冻结时保存的执行假设
   *   （opts.engine 可整体覆盖）；新的冻结在当天收盘后替换尚未成交的旧目标。
   * opts.snapshot = { date, cash, shares, pending }：从已冻结的结算状态接着算（之前的日子不再重放，数据修订也不会改变它们）。
   * 行情用全部数据（成交额均值、前收需要更早的数据）。返回新结算的日期、净值、成交与期末状态。 */
  function paperReplay(data, entries, opts = {}) {
    const list = entries.filter((e) => e && e.date && e.targets).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!list.length) return null;
    const snap = opts.snapshot || null;
    const syms = [...new Set([...list.flatMap((e) => Object.keys(e.targets)), ...Object.keys((snap && snap.shares) || {})])].filter((s) => data[s]);
    if (!syms.length) return null;
    const sub = Object.fromEntries(syms.map((s) => [s, data[s]]));
    const engineOf = (e) => {
      const eng = { ...((e && e.engine) || {}), ...(opts.engine || {}) };
      if (opts.meta) eng.meta = opts.meta;
      return eng;
    };
    const cache = new Map();
    const btFor = (eng) => {
      const { meta, ...rest } = eng;
      const k = JSON.stringify(rest);
      if (!cache.has(k)) cache.set(k, makeBacktester(sub, eng));
      return cache.get(k);
    };
    const first = btFor(engineOf(list[0]));
    const dates = first.dates, n = dates.length;
    const idxOf = (d) => dates.findIndex((x) => x >= d);
    let state, a, inForce;
    if (snap) {
      a = dates.findIndex((x) => x > snap.date);
      state = { cash: snap.cash, shares: { ...snap.shares }, pending: snap.pending || null };
      inForce = list.filter((e) => e.date <= snap.date).pop() || list[0];
    } else {
      a = idxOf(list[0].date);
      state = { cash: engineOf(list[0]).initialCash || 1e6, shares: {}, pending: null };
      inForce = list[0];
    }
    const empty = { start: list[0].date, dates: [], equity: [], nav: [], trades: [], actions: [], state: snap || null, segments: 0 };
    if (a < 0) return empty;
    // 需要在区间 [a, n) 内生效的冻结：落在 a 之前的已经体现在 snapshot（或是第一次冻结本身）
    const due = list.map((e) => ({ e, i: idxOf(e.date) })).filter((x) => x.i >= a);
    const outDates = [], outEq = [], trades = [], actions = [];
    let segments = 0, cur = a;
    while (cur < n) {
      const nextK = due.findIndex((x) => x.i >= cur && x.e !== inForce);
      const stop = nextK >= 0 ? due[nextK].i : n - 1;
      const bt = btFor(engineOf(inForce));
      const rows = dates.map(() => null);
      // 本段起点就是冻结日（第一次冻结）：当天收盘后下达目标
      for (const x of due) if (x.i === cur && x.e === inForce) rows[cur] = bt.symbols.map((s) => +x.e.targets[s] || 0);
      if (nextK >= 0) rows[stop] = bt.symbols.map((s) => +due[nextK].e.targets[s] || 0);
      const res = bt.run({ name: 'paper', params: () => ({}), generate: () => rows }, { start: cur, end: stop, state });
      for (let i = cur; i <= stop; i++) { outDates.push(dates[i]); outEq.push(res.equity[i]); }
      for (const t of res.trades) (AQ.isFill(t) ? trades : actions).push(t);
      state = { cash: res.finalCash, shares: Object.fromEntries(Object.entries(res.finalShares).filter(([, v]) => v > 0)), pending: res.nextTargets };
      segments++;
      if (nextK < 0) break;
      inForce = due[nextK].e;
      cur = stop + 1;
    }
    const last = outDates.length - 1;
    const eq0 = outEq[0];
    // 期末持仓的真实收盘价（估值依据）一并冻结：下次接着结算时，若这一天的行情已被数据源修订，差额会体现在下一天，需要提示
    const lastIdx = dates.indexOf(outDates[last]);
    const markAt = (s, i) => { const c = first.xclose[s]; for (let t = i; t >= 0; t--) if (c[t] > 0) return c[t]; return NaN; };
    const marks = Object.fromEntries(Object.keys(state.shares).map((s) => [s, markAt(s, lastIdx)]));
    let revisions = [];
    if (snap && snap.marks) {
      const k = dates.findIndex((x) => x >= snap.date);
      if (k >= 0 && dates[k] === snap.date) {
        revisions = Object.entries(snap.marks).map(([s, v]) => ({ symbol: s, frozen: v, now: markAt(s, k) }))
          .filter((x) => fin(x.now) && fin(x.frozen) && Math.abs(x.now / x.frozen - 1) > 1e-9);
      }
    }
    return {
      revisions,
      start: list[0].date,
      dates: outDates,
      equity: outEq,
      nav: outEq.map((v) => v / eq0),
      trades,
      actions,
      positions: state.shares,
      cash: state.cash,
      pending: state.pending,
      state: { date: outDates[last], cash: state.cash, shares: state.shares, pending: state.pending, equity: outEq[last], marks },
      engine: engineOf(inForce),
      segments,
    };
  }

  /* 因子相关性：每个抽样日在标的之间计算两两秩相关，再对日期取平均（至少 10 只标的的日子才计入）。 */
  function factorCorrelation(bt, h, ids) {
    const b = bt.bars();
    const syms = bt.symbols;
    const factors = availableFactors(b, syms).filter((f) => !ids || ids.includes(f.id));
    const ts = [];
    for (let t = WARM; t < bt.dates.length; t += h) ts.push(t);
    const T = ts.length, N = syms.length, F = factors.length;
    // 只保留抽样日的值（F × T × N 单精度），不同时持有各因子的完整逐日序列
    const V = factors.map((f) => {
      const m = new Float32Array(T * N).fill(NaN);
      syms.forEach((s, k) => {
        const v = f.f(b, s);
        const mem = b.member ? b.member[s] : null;
        ts.forEach((t, j) => { if (!mem || mem[t]) m[j * N + k] = v[t]; });
      });
      return m;
    });
    const sum = Array.from({ length: F }, () => new Float64Array(F)), cnt = Array.from({ length: F }, () => new Float64Array(F));
    for (let j = 0; j < T; j++) {
      const rk = V.map((m) => {
        const idx = [], x = [];
        for (let k = 0; k < N; k++) { const v = m[j * N + k]; if (fin(v)) { idx.push(k); x.push(v); } }
        if (x.length < 10) return null;
        const r = new Float64Array(N).fill(NaN);
        ranks(x).forEach((v, i) => (r[idx[i]] = v));
        return r;
      });
      for (let p = 0; p < F; p++) {
        if (!rk[p]) continue;
        for (let q = p + 1; q < F; q++) {
          if (!rk[q]) continue;
          const xs = [], ys = [];
          for (let k = 0; k < N; k++) if (rk[p][k] === rk[p][k] && rk[q][k] === rk[q][k]) { xs.push(rk[p][k]); ys.push(rk[q][k]); }
          if (xs.length < 10) continue;
          const c = pearson(xs, ys);
          if (fin(c)) { sum[p][q] += c; cnt[p][q]++; }
        }
      }
    }
    const m = factors.map((_, p) => factors.map((__, q) => {
      if (p === q) return 1;
      const [a2, b2] = p < q ? [p, q] : [q, p];
      return cnt[a2][b2] ? sum[a2][b2] / cnt[a2][b2] : NaN;
    }));
    return { ids: factors.map((f) => f.id), labels: factors.map((f) => f.label), matrix: m };
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
    rangeValues, gridSize, gridIter, randomCombos, applyParams, makeBacktester, optimize, pbo, spa,
    relativeStats, roundTrips, monthlyReturns, SwitchingStrategy, olsHAC, styleFactors, exposure, neutralize, STYLE_DEFS,
    FACTORS, availableFactors, factorCorrelation, buildAnyStrategy, stressTest, factorDecay, fundPanel, floatCap, sharesPanel, marketCap, FactorStrategy, buildStrategy, factorIC, factorPortfolios, seriesStats, paperReplay, forwardReturns, forwardReturnsOf, blockIndices, trendIndex, assertIndustryPIT, NEUTRAL_MODES,
  };
  if (isNode) module.exports = api;
  else AQ.research = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
