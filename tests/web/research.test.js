// 网页版策略、优化与统计函数的单元测试：node --test tests/web
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const AQ = require(path.join(docs, 'engine.js'));
const AQ_RULES = require(path.join(docs, 'rules.js'));
const { RuleStrategy } = AQ_RULES;
const R = require(path.join(docs, 'research.js'));
const em = require(path.join(docs, 'eastmoney.js'));

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// 确定性伪随机行情
function series(n, seed, drift = 0.0003, vol = 0.015) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dates = [], open = [], close = [], high = [], low = [], volume = [];
  let p = 10;
  const d0 = Date.UTC(2015, 0, 5);
  for (let i = 0, k = 0; i < n; k++) {
    const day = new Date(d0 + k * 86400000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const z = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const o = p * (1 + (rnd() - 0.5) * 0.004);
    p = Math.max(0.5, p * (1 + drift + vol * z));
    dates.push(day.toISOString().slice(0, 10));
    open.push(+o.toFixed(2)); close.push(+p.toFixed(2));
    high.push(+(Math.max(o, p) * 1.005).toFixed(2)); low.push(+(Math.min(o, p) * 0.995).toFixed(2));
    volume.push(1e6 + Math.floor(rnd() * 1e6));
    i++;
  }
  return { dates, open, close, high, low, volume };
}

function bars(data) {
  return new AQ.Backtester(data, { rebalanceBand: 0 }).bars();
}

test('normal distribution helpers', () => {
  close(R.normInv(0.975), 1.959963985, 1e-6);
  close(R.normInv(0.5), 0, 1e-9);
  close(R.normCdf(1.959963985), 0.975, 1e-6);
  close(R.normCdf(-1), 0.158655254, 1e-6);
});

test('spearman handles ties with average ranks', () => {
  assert.deepEqual(R.ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  close(R.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(R.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});

test('variance ratio is near 1 for iid returns and above 1 for trending ones', () => {
  const d = series(3000, 7, 0, 0.01);
  const r = d.close.slice(1).map((c, i) => c / d.close[i] - 1);
  const vr = R.varianceRatio(r, 5);
  assert.ok(Math.abs(vr.vr - 1) < 0.15, `iid VR=${vr.vr}`);
  const ar = [0];
  for (let i = 1; i < 3000; i++) ar.push(0.5 * ar[i - 1] + (r[i] || 0));
  assert.ok(R.varianceRatio(ar, 5).vr > 1.5);
});

test('deflated sharpe drops as the number of trials grows', () => {
  const one = R.deflatedSharpe([0.05], 0.05, 1000, 0, 3);
  const noise = Array.from({ length: 200 }, (_, i) => 0.05 * Math.sin(i * 1.7));
  const many = R.deflatedSharpe(noise, 0.05, 1000, 0, 3);
  assert.ok(one.prob > 0.9, `single trial prob=${one.prob}`);
  assert.ok(many.prob < one.prob);
  assert.ok(many.sr0 > 0);
});

test('rule strategy validates parameters', () => {
  assert.throws(() => new RuleStrategy({ rules: [] }), /至少添加一条规则/);
  assert.throws(() => new RuleStrategy({ rules: [{ id: 'ma_cross', params: { fast: 30, slow: 10 } }] }), /快线要小于慢线/);
  assert.throws(() => new RuleStrategy({ rules: [{ id: 'nope' }] }), /未知规则/);
});

test('rule strategy: entries, exits and stop loss', () => {
  // 先涨 40 天，再每天跌 1.5%
  const n = 70;
  const px = Array.from({ length: n }, (_, i) => (i < 40 ? 10 + i * 0.1 : 13.9 * Math.pow(0.985, i - 39)));
  const dates = px.map((_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const data = { '510300': { dates, open: px, close: px, high: px, low: px, volume: px.map(() => 1) } };
  const b = bars(data);
  const run = (cfg) => new RuleStrategy(cfg).generate(b.close, dates, ['510300'], b);
  const firstExit = (rows) => rows.findIndex((r, i) => r && r[0] === 0 && i > 10);

  // 唐奇安：突破 5 日高点入场；跌破 120 日低点才出场（本段数据内不会触发）
  const base = { rules: [{ id: 'donchian', params: { n: 5, m: 120 } }] };
  const plain = run(base);
  const entry = plain.findIndex((r) => r && r[0] === 1);
  assert.equal(entry, 5, '突破前 5 日高点时入场');
  assert.equal(firstExit(plain), -1, '无风控时一直持有');
  assert.equal(plain.filter(Boolean).length, 2, '只在状态改变时发出信号');
  const stop = firstExit(run({ ...base, stopLoss: 10 }));
  assert.ok(stop > 40, `止损在下跌段触发：${stop}`);
  assert.ok(px[stop] <= px[entry] * 0.9 && px[stop - 1] > px[entry] * 0.9);
  const take = firstExit(run({ ...base, takeProfit: 20 }));
  assert.ok(take > entry && take < 40, `止盈在上涨段触发：${take}`);
  assert.ok(px[take] >= px[entry] * 1.2 && px[take - 1] < px[entry] * 1.2);
});

test('equal sizing splits capital among held symbols', () => {
  const a = series(400, 1, 0.002), c = series(400, 2, -0.002);
  const data = { '510300': a, '510500': c };
  const b = bars(data);
  const syms = ['510300', '510500'];
  const cfg = { rules: [{ id: 'price_ma', params: { n: 20 } }] };
  const fixed = new RuleStrategy(cfg).generate(b.close, a.dates, syms, b).filter(Boolean);
  const equal = new RuleStrategy({ ...cfg, sizing: 'equal' }).generate(b.close, a.dates, syms, b).filter(Boolean);
  for (const row of fixed) row.forEach((w) => assert.ok(w === 0 || w === 0.5));
  for (const row of equal) {
    const held = row.filter((w) => w > 0);
    held.forEach((w) => close(w, 1 / held.length));
  }
});

test('optimize: train ranks, validation selects, test is computed only for the selection', () => {
  const data = { '510300': series(1500, 3), '510500': series(1500, 4), '159915': series(1500, 5) };
  const dates = new AQ.Backtester(data, {}).dates;
  const space = [
    { path: 'r0.fast', label: '快线', values: [5, 10, 20] },
    { path: 'r0.slow', label: '慢线', values: [10, 30, 60] },
  ];
  const res = R.optimize({
    data,
    engine: { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0.01 },
    config: { rules: [{ id: 'ma_cross', params: { fast: 10, slow: 30 } }] },
    space,
    method: 'grid',
    objective: 'sharpe',
    minTrades: 0,
    valStart: dates[900],
    testStart: dates[1200],
    wf: { enabled: true, trainYears: 2, testYears: 1, anchored: false },
  });
  assert.equal(res.trials + res.invalid, 9);
  assert.equal(res.invalid, 2); // fast >= slow
  assert.equal(res.splits.valStart, dates[900]);
  assert.equal(res.splits.testStart, dates[1200]);
  const trainScores = res.top.map((t) => t.tr.sharpe);
  for (let i = 1; i < trainScores.length; i++) assert.ok(trainScores[i - 1] >= trainScores[i]);
  // 选定参数来自训练排名前列里验证集最好的一组
  const shortlist = res.top.slice(0, res.shortlist);
  const bestVal = Math.max(...shortlist.map((t) => t.va.sharpe));
  assert.equal(res.selected.va.sharpe, bestVal);
  // 测试集只有选定参数一组，且与选定参数一致；训练/验证表中不含测试集数据
  assert.deepEqual(res.test.combo, res.selected.combo);
  assert.ok(res.top.every((t) => !('te' in t) && !('test' in t)));
  assert.equal(res.test.dates[0], dates[1199]);
  close(res.test.equity[0], 1);
  // 滚动前推只用到测试集之前的数据
  const lastWf = res.wf.dates[res.wf.dates.length - 1];
  assert.ok(lastWf < dates[1200], `前推结束于 ${lastWf}`);
  assert.ok(res.dsr && res.dsr.prob >= 0 && res.dsr.prob <= 1);
});

test('optimize rejects splits that leave a segment too short', () => {
  const data = { '510300': series(600, 3) };
  const dates = new AQ.Backtester(data, {}).dates;
  const base = { data, engine: { fees: {} }, config: { rules: [{ id: 'price_ma' }] }, space: [{ path: 'r0.n', values: [10, 20] }] };
  assert.throws(() => R.optimize({ ...base, valStart: dates[50], testStart: dates[400] }), /训练集/);
  assert.throws(() => R.optimize({ ...base, valStart: dates[300], testStart: dates[330] }), /验证集/);
  assert.throws(() => R.optimize({ ...base, valStart: dates[300], testStart: dates[580] }), /测试集/);
});

test('relative stats: benchmark against itself has beta 1 and zero alpha', () => {
  const eq = series(500, 8).close;
  const rel = R.relativeStats(eq, eq, 0, eq.length - 1, 0.02);
  close(rel.beta, 1, 1e-9);
  close(rel.alpha, 0, 1e-9);
  close(rel.trackingError, 0, 1e-12);
  const lev = eq.map((v, i) => (i ? null : v));
  for (let i = 1; i < eq.length; i++) lev[i] = lev[i - 1] * (1 + 2 * (eq[i] / eq[i - 1] - 1));
  close(R.relativeStats(lev, eq, 0, eq.length - 1, 0).beta, 2, 1e-9);
});

test('round trips pair entries and exits per symbol', () => {
  const dates = dayList(10);
  const trades = [
    { date: dates[1], symbol: 'A', side: 'buy', shares: 100, amount: 1000, fee: 5 },
    { date: dates[4], symbol: 'A', side: 'sell', shares: 100, amount: 1200, fee: 5 },
    { date: dates[2], symbol: 'B', side: 'buy', shares: 100, amount: 1000, fee: 5 },
    { date: dates[3], symbol: 'B', side: 'buy', shares: 100, amount: 1000, fee: 5 },
    { date: dates[6], symbol: 'B', side: 'sell', shares: 200, amount: 1800, fee: 5 },
    { date: dates[7], symbol: 'A', side: 'buy', shares: 100, amount: 1000, fee: 5 },
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  const rt = R.roundTrips(trades, dates);
  assert.equal(rt.count, 2);
  assert.equal(rt.open, 1);
  close(rt.winRate, 0.5);
  close(rt.list.find((x) => x.symbol === 'A').pnl, 190);
  close(rt.list.find((x) => x.symbol === 'B').pnl, 1795 - 2010);
  close(rt.profitFactor, 190 / 215);
  close(rt.avgDays, (3 + 4) / 2);
});

test('monthly returns chain to the total return', () => {
  const d = series(400, 12);
  const m = R.monthlyReturns(d.dates, d.close);
  let total = 1;
  for (const y of m.years) m.rows[y].months.forEach((r) => { if (r !== null) total *= 1 + r; });
  close(total, d.close[d.close.length - 1] / d.close[0], 1e-9);
});

test('optimize: random search samples unique combinations', () => {
  const combos = R.randomCombos([{ values: [1, 2, 3, 4] }, { values: [1, 2, 3, 4, 5] }], 12, 9);
  assert.equal(combos.length, 12);
  assert.equal(new Set(combos.map((c) => c.join())).size, 12);
  assert.equal(R.randomCombos([{ values: [1, 2] }], 50).length, 2);
});

test('factor IC detects a planted predictive signal', () => {
  // 构造：次日开盘到之后的收益与"昨日涨跌"同号（强动量），IC 应显著为正
  const n = 1500;
  const base = series(n, 11, 0, 0.01);
  const open = [base.close[0]], cl = [base.close[0]];
  for (let i = 1; i < n; i++) {
    const r = base.close[i] / base.close[i - 1] - 1;
    const prevR = i > 1 ? cl[i - 1] / cl[i - 2] - 1 : 0;
    open.push(cl[i - 1]);
    cl.push(cl[i - 1] * (1 + r + 0.8 * prevR));
  }
  const data = { '510300': { ...base, open, close: cl, high: cl.map((c, i) => Math.max(c, open[i])), low: cl.map((c, i) => Math.min(c, open[i])) } };
  const bt = new AQ.Backtester(data, {});
  const ic = R.factorIC(bt, 1);
  const roc1 = ic.find((f) => f.id === 'roc1');
  assert.ok(roc1.tsIC > 0.2 && roc1.tsLo > 0.1 && roc1.tsHi > roc1.tsIC, JSON.stringify(roc1));
});

test('factor IC: duplicated symbols do not inflate the confidence interval', () => {
  const one = series(1200, 41, 0, 0.012);
  const single = R.factorIC(new AQ.Backtester({ '510300': one }, {}), 5);
  const copies = {};
  for (let k = 0; k < 9; k++) copies['51030' + k] = one;
  const dup = R.factorIC(new AQ.Backtester(copies, {}), 5);
  // 纯随机游走：绝大多数因子的 95% 置信区间应包含 0
  const cover = single.filter((f) => f.tsLo <= 0 && f.tsHi >= 0).length;
  assert.ok(cover >= single.length - 3, `${cover}/${single.length}`);
  single.forEach((f, j) => {
    close(dup[j].tsIC, f.tsIC, 1e-12);
    close(dup[j].tsLo, f.tsLo, 1e-12);
    close(dup[j].tsHi, f.tsHi, 1e-12);
  });
});

test('block bootstrap indices stay in range and keep blocks contiguous', () => {
  let x = 3;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const d = R.blockIndices(100, 5, rnd);
  assert.equal(d.length, 100);
  assert.ok(d.every((k) => k >= 0 && k < 100));
  for (let k = 0; k < 100; k += 5) for (let j = 1; j < 5; j++) assert.equal(d[k + j], d[k] + j);
});

test('factor portfolios: tradable quintiles with turnover and cost', () => {
  // 10 只标的，漂移与编号成正比；60 日动量越高的组收益越高
  const data = {};
  for (let k = 0; k < 10; k++) data['6000' + String(k).padStart(2, '0')] = series(1000, 50 + k, 0.0002 * (k - 4.5), 0.01);
  const bt = new AQ.Backtester(data, {});
  const p = R.factorPortfolios(bt, 'roc60', 20);
  assert.equal(p.q, 5);
  assert.equal(p.groups.length, 5);
  assert.ok(p.groups[4].annReturn > p.groups[0].annReturn, JSON.stringify(p.groups.map((g) => g.annReturn)));
  assert.ok(p.longShort.annReturn > 0);
  p.groups.forEach((g) => {
    assert.ok(g.turnover >= 0 && g.turnover <= 1);
    assert.ok(g.grossReturn >= g.annReturn, '扣成本后不高于毛收益');
    assert.equal(g.equity.length, p.periods + 1);
  });
  const free = R.factorPortfolios(bt, 'roc60', 20, { cost: 0 });
  close(free.groups[2].annReturn, free.groups[2].grossReturn, 1e-12);
  assert.equal(R.factorPortfolios(new AQ.Backtester({ a: series(300, 1), b: series(300, 2) }, {}), 'roc20', 5).q, 0);
});

test('eastmoney: proportional forward adjustment stays positive and matches hfq returns', () => {
  const dates = ['2014-01-02', '2014-01-03', '2014-01-06'];
  const hfq = { dates, open: [100, 98, 98], high: [101, 99, 100], low: [99, 97, 97], close: [100, 97.5, 99], volume: [1, 1, 1] };
  const raw = { dates, open: [40, 34, 34.2], high: [41, 35, 35], low: [39, 33, 34], close: [40, 34, 34.5], volume: [1, 1, 1] };
  const q = em.proportional(hfq, raw, '000333');
  close(q.close[2], 34.5, 1e-12);
  close(q.close[1] / q.close[0], 97.5 / 100, 1e-12);
  assert.ok(q.open.concat(q.close, q.high, q.low).every((v) => v > 0));
  // 减法前复权产生的负价格必须被拒绝
  assert.throws(() => em.checkPositive({ dates, open: [-10.3, 1, 1], close: [-0.29, 1, 1] }, '000333'), /价格为 -0.29/);
  assert.equal(em.checkPositive(q, 'x'), q);
});

test('engine never trades at a non-positive price', () => {
  const dates = ['2014-01-02', '2014-01-03', '2014-01-06', '2014-01-07'];
  const px = [0, 0, 5, 5];
  const bt = new AQ.Backtester({ '000333': { dates, open: px, close: px, volume: [1, 1, 1, 1] } }, { rebalanceBand: 0 });
  const res = bt.run(new AQ.BuyAndHold());
  assert.ok(res.trades.every((t) => t.price > 0 && Number.isFinite(t.shares)));
  assert.ok(res.equity.every(Number.isFinite));
});

// ---------- 规则策略：用途、持仓上限、持有期、冷却、波动率加权 ----------

function frame(pxBySym, dates) {
  const data = {};
  for (const [s, px] of Object.entries(pxBySym)) {
    data[s] = { dates, open: px, close: px, high: px.map((p) => p * 1.01), low: px.map((p) => p * 0.99), volume: px.map(() => 1e6) };
  }
  return new AQ.Backtester(data, { rebalanceBand: 0 }).bars();
}
const dayList = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const ramp = (n, start, step) => Array.from({ length: n }, (_, i) => start + i * step);

test('rule roles: exit-only rules never trigger entries', () => {
  const dates = dayList(60);
  const b = frame({ '510300': ramp(60, 10, 0.1) }, dates);
  // price_ma 看多但只用于出场、没有入场规则 → 构造时报错
  assert.throws(() => new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 10 }, role: 'exit' }] }), /入场/);
  // 入场用均线；出场只看"放量"（永远不会给出 -1）→ 一直持有
  const rows = new RuleStrategy({
    rules: [{ id: 'price_ma', params: { n: 10 }, role: 'entry' }, { id: 'vol_surge', role: 'exit' }],
  }).generate(b.close, dates, ['510300'], b);
  const emitted = rows.filter(Boolean);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1][0], 1);
});

test('maxPositions keeps the strongest momentum candidates', () => {
  const n = 80;
  const dates = dayList(n);
  const px = { A: ramp(n, 10, 0.05), B: ramp(n, 10, 0.2), C: ramp(n, 10, 0.1) };
  const b = frame(px, dates);
  const rows = new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 10 } }], maxPositions: 1 })
    .generate(b.close, dates, ['A', 'B', 'C'], b);
  const first = rows.find((r) => r && r.some((w) => w > 0));
  assert.deepEqual(first, [0, 1, 0], '只买 20 日动量最强的 B');
});

test('minHold defers signal exits but not stop losses; maxHold forces exits; cooldown blocks re-entry', () => {
  const n = 60;
  const dates = dayList(n);
  // 上涨 25 天后横盘在均线下方 3 天再继续上涨
  const px = ramp(n, 10, 0.1).map((p, i) => (i >= 25 && i < 28 ? 11.5 : p));
  const b = frame({ X: px }, dates);
  const run = (extra) => new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 5 } }], ...extra }).generate(b.close, dates, ['X'], b);
  const exitDay = (rows) => rows.findIndex((r, i) => r && r[0] === 0 && i > 5);
  const entryDays = (rows) => rows.map((r, i) => (r && r[0] > 0 ? i : -1)).filter((i) => i >= 0);
  assert.equal(exitDay(run({})), 25);
  assert.ok(exitDay(run({ minHold: 30 })) === -1 || exitDay(run({ minHold: 30 })) > 25, '最短持有期内不因信号离场');
  assert.equal(exitDay(run({ maxHold: 10 })), entryDays(run({}))[0] + 10, '持有满 10 天强制离场');
  const plainReentry = entryDays(run({}))[1];
  const coolReentry = entryDays(run({ cooldown: 10 }))[1];
  assert.ok(coolReentry >= 25 + 11 && coolReentry > plainReentry, `冷却期内不再入场：${plainReentry} → ${coolReentry}`);
});

test('inverse-volatility sizing gives the calmer asset more weight', () => {
  const n = 80;
  const dates = dayList(n);
  const calm = ramp(n, 10, 0.05);
  const wild = ramp(n, 10, 0.05).map((p, i) => p * (1 + (i % 2 ? 0.03 : -0.03)));
  const b = frame({ calm, wild }, dates);
  const rows = new RuleStrategy({ rules: [{ id: 'ma_slope', params: { n: 25, k: 2 } }], sizing: 'invvol' })
    .generate(b.close, dates, ['calm', 'wild'], b);
  const both = rows.filter((r) => r && r[0] > 0 && r[1] > 0).pop();
  assert.ok(both && both[0] > both[1], JSON.stringify(both));
  close(both[0] + both[1], 1, 1e-9);
});

test('new indicator rules produce signals within range', () => {
  const d = series(600, 21);
  const data = { '600000': d };
  const b = new AQ.Backtester(data, {}).bars();
  for (const id of ['dmi', 'cci', 'willr', 'vol_surge', 'vol_filter', 'ma_slope', 'obv_trend']) {
    // 测试数据的成交量波动小，放量倍数取 1
    const p = { ...AQ_RULES.defaultParams(id), ...(id === 'vol_surge' ? { k: 1 } : {}) };
    const sig = AQ_RULES.RULES[id].signal(b, '600000', p);
    const vals = new Set(sig);
    assert.ok([...vals].every((v) => v === -1 || v === 0 || v === 1), id);
    assert.ok(vals.has(1), `${id} 至少出现一次看多`);
  }
});

// ---------- 多因子选股 ----------

test('factor strategy buys the top-ranked names and respects weight sign', () => {
  const n = 150;
  const dates = dayList(n);
  const px = { A: ramp(n, 10, 0.02), B: ramp(n, 10, 0.08), C: ramp(n, 10, 0.05), D: ramp(n, 10, 0.01) };
  const b = frame(px, dates);
  const syms = ['A', 'B', 'C', 'D'];
  const pick = (cfg) => new R.FactorStrategy(cfg).generate(b.close, dates, syms, b).find(Boolean);
  // 动量越大越好 → 买 B、C
  assert.deepEqual(pick({ factors: [{ id: 'roc20', weight: 1 }], topN: 2, rebalance: 20 }), [0, 0.5, 0.5, 0]);
  // 权重为负 → 买动量最弱的 D、A
  assert.deepEqual(pick({ factors: [{ id: 'roc20', weight: -1 }], topN: 2, rebalance: 20 }), [0.5, 0, 0, 0.5]);
  assert.throws(() => new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 0 }] }), /权重不为 0/);
});

test('factor strategy trend filter moves to cash in a falling market', () => {
  const n = 150;
  const dates = dayList(n);
  const down = (start) => Array.from({ length: n }, (_, i) => start * Math.pow(0.995, i));
  const b = frame({ A: down(10), B: down(20), C: down(15) }, dates);
  const rows = new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 1, rebalance: 5, trendN: 20 })
    .generate(b.close, dates, ['A', 'B', 'C'], b).filter(Boolean);
  assert.ok(rows.length >= 1 && rows.every((r) => r.every((w) => w === 0)), '一路下跌时始终空仓');
});

test('applyParams keeps rule roles and handles factor weights', () => {
  const cfg = { rules: [{ id: 'price_ma', role: 'exit', params: { n: 20 } }, { id: 'macd', role: 'entry', params: {} }],
    type: 'rules', factor: { factors: [{ id: 'roc20', weight: 1 }], topN: 2 } };
  const out = R.applyParams(cfg, [{ path: 'r0.n' }, { path: 'f0.weight' }, { path: 'fs.topN' }, { path: 'risk.maxPositions' }], [60, -1, 3, 2]);
  assert.equal(out.rules[0].role, 'exit');
  assert.equal(out.rules[0].params.n, 60);
  assert.equal(out.factor.factors[0].weight, -1);
  assert.equal(out.factor.topN, 3);
  assert.equal(out.maxPositions, 2);
  assert.equal(cfg.rules[0].params.n, 20, '不修改原配置');
  // 规则未写 params 时也能套用参数
  assert.equal(R.applyParams({ rules: [{ id: 'macd' }] }, [{ path: 'r0.fast' }], [8]).rules[0].params.fast, 8);
});

// ---------- 风控与实际成交闭环 ----------

function bookData(open, close, sym = '600000') {
  const dates = dayList(close.length);
  return { [sym]: { dates, open, close, high: close.map((c, i) => Math.max(c, open[i])), low: close.map((c, i) => Math.min(c, open[i])), volume: close.map(() => 1e6) } };
}

test('stop loss is measured from the actual fill price, not the signal price', () => {
  // 第 4 天收盘 10 元出现入场信号；第 5 天开盘 10.8 元成交，收盘 10.2 元（按成交价已亏 5.56%）
  const px = [9.6, 9.7, 9.8, 9.9, 10.0, 10.2, 10.2, 10.3, 10.4, 10.5];
  const open = [9.6, 9.7, 9.8, 9.9, 10.0, 10.8, 10.2, 10.2, 10.3, 10.4];
  const data = bookData(open, px);
  const cfg = { rules: [{ id: 'price_ma', params: { n: 5 } }], stopLoss: 5 };
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const res = bt.run(new RuleStrategy(cfg));
  const buy = res.trades.find((t) => t.side === 'buy');
  const sell = res.trades.find((t) => t.side === 'sell');
  assert.equal(buy.date, bt.dates[5]);
  close(buy.price, 10.8 * 1.0005, 1e-9);
  assert.ok(sell, '按实际成本价计算已触发 5% 止损');
  assert.equal(sell.date, bt.dates[6], '第 5 天收盘触发，第 6 天开盘卖出');
  // 对照：理想化预览按信号价 10 元计算，不会止损
  const b = bt.bars();
  const preview = new RuleStrategy(cfg).generate(b.close, bt.dates, ['600000'], b);
  assert.ok(!preview.slice(5).some((r) => r && r[0] === 0), '信号价口径下看不到这次止损');
});

test('a buy blocked at limit-up is not treated as a position', () => {
  // 第 4 天信号；第 5 天开盘一字涨停买不进；第 6 天可以买入
  const px = [9.6, 9.7, 9.8, 9.9, 10.0, 11.0, 11.1, 11.2, 11.3, 11.4];
  const open = [9.6, 9.7, 9.8, 9.9, 10.0, 11.0, 11.05, 11.15, 11.25, 11.35];
  const data = bookData(open, px);
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const res = bt.run(new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 5 } }], maxHold: 2 }));
  const buys = res.trades.filter((t) => t.side === 'buy');
  const sells = res.trades.filter((t) => t.side === 'sell');
  assert.equal(buys[0].date, bt.dates[6], '涨停当天没成交，次日才买入');
  // 最长持有 2 天从实际成交日（第 6 天）算起：第 8 天收盘触发，第 9 天开盘卖出
  assert.equal(sells[0].date, bt.dates[9]);
});

test('cooldown starts from the actual exit fill', () => {
  const n = 40;
  const px = ramp(n, 10, 0.1).map((p, i) => (i >= 12 && i < 14 ? 10.5 : p));
  const data = bookData(px.slice(), px);
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const trades = bt.run(new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 5 } }], cooldown: 5 })).trades;
  const firstSell = trades.find((t) => t.side === 'sell');
  const reBuy = trades.filter((t) => t.side === 'buy')[1];
  const idx = (d) => bt.dates.indexOf(d);
  assert.ok(reBuy && idx(reBuy.date) - idx(firstSell.date) > 5, `清仓 ${firstSell.date} 后 ${reBuy && reBuy.date} 才再买入`);
});

// ---------- 连续账户滚动前推 ----------

test('switching to identical parameters mid-run leaves the account unchanged', () => {
  const data = { '510300': series(800, 31), '510500': series(800, 32), '159915': series(800, 33) };
  const bt = new AQ.Backtester(data, { rebalanceBand: 1 });
  const cfg = { rules: [{ id: 'price_ma', params: { n: 20 } }], stopLoss: 8, trailATR: 3, maxPositions: 2 };
  const whole = bt.run(new RuleStrategy(cfg));
  const cuts = [0, 250, 400, 555, 799];
  const segs = cuts.slice(0, -1).map((a, k) => ({ from: a, to: cuts[k + 1] - (k < cuts.length - 2 ? 1 : 0), strategy: new RuleStrategy(cfg) }));
  const pieced = bt.run(new R.SwitchingStrategy(segs));
  assert.ok(whole.trades.length > 10);
  assert.deepEqual(pieced.trades, whole.trades);
  assert.deepEqual(pieced.equity, whole.equity);
});

test('walk-forward runs one continuous account and never looks past the test start', () => {
  const mk = () => ({ '510300': series(1500, 3), '510500': series(1500, 4), '159915': series(1500, 5) });
  const data = mk();
  const dates = new AQ.Backtester(data, {}).dates;
  const input = (d) => ({
    data: d,
    engine: { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0.01 },
    config: { rules: [{ id: 'ma_cross', params: { fast: 10, slow: 30 } }] },
    space: [{ path: 'r0.fast', values: [5, 10, 20] }, { path: 'r0.slow', values: [30, 60] }],
    method: 'grid', objective: 'sharpe', minTrades: 0,
    valStart: dates[900], testStart: dates[1200],
    wf: { enabled: true, trainYears: 1.5, testYears: 0.5, anchored: false },
  });
  const wf = R.optimize(input(data)).wf;
  assert.ok(wf.windows.length >= 3);
  // 各窗口收益连乘 = 连续账户的总收益（同一个账户，不是拼接）
  const chained = wf.windows.reduce((acc, w) => acc * (1 + w.testReturn), 1);
  close(chained, wf.equity[wf.equity.length - 1], 1e-9);
  assert.ok(wf.fees > 0 && wf.turnover > 0);
  assert.ok(wf.trades.count > 0);
  // 篡改测试集的行情，前推结果不变
  const d2 = mk();
  for (const s of Object.keys(d2)) for (let i = 1200; i < 1500; i++) d2[s].close[i] *= 1.5, d2[s].open[i] *= 1.5, d2[s].high[i] *= 1.5, d2[s].low[i] *= 1.5;
  const wf2 = R.optimize(input(d2)).wf;
  assert.deepEqual(wf2.equity, wf.equity);
  assert.deepEqual(wf2.windows, wf.windows);
});

// ---------- 暴露归因 ----------

test('OLS with HAC recovers planted loadings and alpha', () => {
  let x = 5;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  const X = [], y = [];
  for (let t = 0; t < 3000; t++) {
    const f = [rnd() * 0.02, rnd() * 0.01];
    X.push(f);
    y.push(0.001 + 0.8 * f[0] - 0.5 * f[1] + rnd() * 0.002);
  }
  const fit = R.olsHAC(y, X);
  close(fit.coef[0], 0.001, 1e-4);
  close(fit.coef[1], 0.8, 0.02);
  close(fit.coef[2], -0.5, 0.03);
  assert.ok(fit.t[0] > 10 && fit.r2 > 0.9);
});

test('exposure: the equal-weight market itself has beta 1 and no alpha', () => {
  const data = {};
  for (let k = 0; k < 8; k++) data['6000' + k] = series(600, 60 + k, 0.0003 * (k - 3), 0.012);
  const bt = new AQ.Backtester(data, {});
  const sf = R.styleFactors(bt, 0.02);
  const eq = [1];
  for (let i = 1; i < bt.dates.length; i++) eq.push(eq[i - 1] * (1 + (Number.isFinite(sf.MKT[i]) ? sf.MKT[i] + 0.02 / 244 : 0)));
  const ex = R.exposure(eq, sf, 0, bt.dates.length - 1, 0.02);
  const mkt = ex.loadings.find((l) => l.id === 'MKT');
  close(mkt.beta, 1, 1e-9);
  close(ex.alpha, 0, 1e-9);
  assert.deepEqual(ex.loadings.map((l) => l.id), ['MKT', 'MOM', 'LOWVOL', 'LIQ'], '没有财务与股本数据时不含规模、价值、质量');
  assert.deepEqual(ex.missing, ['SIZE', 'VALUE', 'QUALITY']);
  // 标的不足 6 只时只做市场因子
  const few = new AQ.Backtester({ a: series(600, 1), b: series(600, 2), c: series(600, 3) }, {});
  const ex2 = R.exposure(few.bars().close.a, R.styleFactors(few), 0, 599);
  assert.deepEqual(ex2.loadings.map((l) => l.id), ['MKT']);
});

test('deflated sharpe counts prior trials', () => {
  const noise = Array.from({ length: 50 }, (_, i) => 0.05 * Math.sin(i * 1.7));
  const now = R.deflatedSharpe(noise, 0.08, 1000, 0, 3);
  const withPrior = R.deflatedSharpe(noise, 0.08, 1000, 0, 3, 500);
  assert.equal(withPrior.trials, 500);
  assert.ok(withPrior.prob < now.prob && withPrior.sr0 > now.sr0);
});

// ---------- 个股：时点股票池、退市、财务数据 ----------

test('point-in-time universe: no buys outside the pool, exits on removal, PIT benchmark', () => {
  const n = 60;
  const dates = dayList(n);
  const up = ramp(n, 10, 0.1);
  const data = {};
  for (const s of ['600000', '600001', '600002']) data[s] = { dates, open: up, close: up, high: up, low: up, volume: up.map(() => 1e6) };
  const universe = { '600000': [[dates[0], null]], '600001': [[dates[0], dates[30]]], '600002': [[dates[40], null]] };
  const bt = new AQ.Backtester(data, { rebalanceBand: 0, meta: { universe } });
  const res = bt.run(new RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 5 } }] }));
  const idx = (d) => dates.indexOf(d);
  const by = (s, side) => res.trades.filter((t) => t.symbol === s && t.side === side).map((t) => idx(t.date));
  assert.ok(by('600002', 'buy').every((i) => i > 40), '纳入前不买：' + by('600002', 'buy'));
  assert.ok(by('600002', 'buy').length > 0);
  assert.deepEqual(by('600001', 'sell'), [31], '剔除当日收盘决定卖出，次日开盘成交');
  // 基准：当期成分等权，成分变化时调仓
  const bench = bt.run(new AQ.BuyAndHold());
  const days = [...new Set(bench.trades.map((t) => idx(t.date)))];
  assert.deepEqual(days, [1, 31, 41]);
});

test('delisted positions are written off at the recovery ratio', () => {
  const dates = dayList(30);
  const px = ramp(30, 10, 0);
  const data = {
    '600000': { dates: dates.slice(0, 20), open: px.slice(0, 20), close: px.slice(0, 20), volume: px.slice(0, 20) },
    '600001': { dates, open: px, close: px, volume: px },
  };
  const run = (rec) => new AQ.Backtester(data, { rebalanceBand: 0, fees: new AQ.FeeModel({ minCommission: 0, commissionRate: 0, transferRate: 0, stampDutyRate: 0 }), slippage: 0, meta: { delisted: { '600000': dates[19] } }, delistRecovery: rec })
    .run(new AQ.BuyAndHold());
  const full = run(1), zero = run(0), half = run(0.5);
  const w = full.trades.find((t) => t.delisted);
  assert.equal(w.date, dates[20]);
  close(full.equity[29], 1e6, 1);
  close(zero.equity[29], 5e5, 1);
  close(half.equity[29], 7.5e5, 1);
});

test('fundamentals become visible only after the notice date; TTM EPS uses announced reports', () => {
  const dates = ['2021-04-28', '2021-04-29', '2021-04-30', '2021-08-30', '2021-08-31'];
  const px = [20, 20, 20, 20, 20];
  const fundamentals = { '600000': [
    { report: '2020-06-30', notice: '2020-08-20', eps: 0.4, bps: 5 },
    { report: '2020-12-31', notice: '2021-03-30', eps: 1.0, bps: 5.5, profitYoy: 10 },
    { report: '2021-06-30', notice: '2021-08-30', eps: 0.6, bps: 6, profitYoy: 30 },
  ] };
  const bt = new AQ.Backtester({ '600000': { dates, open: px, close: px, raw: px, volume: [1, 1, 1, 1, 1] } }, { meta: { fundamentals } });
  const F = R.fundPanel(bt.bars(), '600000');
  close(F.epsTTM[3], 1.0, 1e-6); // 财务指标以单精度存储 // 8-30 当天公告，当天还不可用
  close(F.epsTTM[4], 0.6 + 1.0 - 0.4, 1e-6); // 财务指标以单精度存储
  close(F.bps[4], 6, 1e-6); // 财务指标以单精度存储
  close(F.profitYoy[3], 10, 1e-6); // 财务指标以单精度存储
  const ep = R.FACTORS.find((f) => f.id === 'ep').f(bt.bars(), '600000');
  close(ep[4], 1.2 / 20, 1e-6); // 财务指标以单精度存储
  // 未来才公告的数据不影响之前的值
  const later = JSON.parse(JSON.stringify(fundamentals));
  later['600000'][2].eps = 99;
  const bt2 = new AQ.Backtester({ '600000': { dates, open: px, close: px, raw: px, volume: [1, 1, 1, 1, 1] } }, { meta: { fundamentals: later } });
  const F2 = R.fundPanel(bt2.bars(), '600000');
  assert.deepEqual(Array.from(F2.epsTTM.slice(0, 4)), Array.from(F.epsTTM.slice(0, 4)));
  assert.ok(R.availableFactors(bt.bars(), ['600000']).some((f) => f.id === 'ep'));
  assert.ok(!R.availableFactors(new AQ.Backtester({ '600000': series(100, 1) }, {}).bars(), ['600000']).some((f) => f.id === 'ep'));
});

test('float market cap from turnover', () => {
  const n = 40;
  const dates = dayList(n);
  const px = ramp(n, 10, 0);
  // 流通股本 1 亿股：成交 50 万手 = 5000 万股，换手率 50%
  const bt = new AQ.Backtester({ '600000': { dates, open: px, close: px, raw: px, volume: px.map(() => 5e5), turnover: px.map(() => 50) } }, {});
  const cap = R.floatCap(bt.bars(), '600000');
  close(cap[30], 10 * 1e8, 1);
  assert.ok(!Number.isFinite(cap[5]));
});

test('factor panel ignores days outside the universe', () => {
  const data = {};
  for (let k = 0; k < 4; k++) data['60000' + k] = series(400, 70 + k);
  const dates = new AQ.Backtester(data, {}).dates;
  const universe = { '600000': [[dates[0], null]], '600001': [[dates[0], null]], '600002': [[dates[0], null]], '600003': [[dates[200], null]] };
  const bt = new AQ.Backtester(data, { meta: { universe } });
  const ic = R.factorIC(bt, 5, { B: 20 });
  const bt3 = new AQ.Backtester({ '600000': data['600000'], '600001': data['600001'], '600002': data['600002'] }, {});
  // 前 200 天第 4 只不在池内：截面 IC 的前段与只有 3 只时相同 → 整体不同但有效期数相同
  assert.equal(ic[0].csN, R.factorIC(bt3, 5, { B: 20 })[0].csN);
});

// ---------- 股票池组装 ----------

test('stock pool: plan windows, trim with warmup, assemble meta and coverage', () => {
  const pool = require(path.join(docs, 'stockpool.js'));
  const members = {
    members: {
      '600001': [['2005-07-01', '2009-12-29']],
      '600002': [['2012-01-01', '2014-01-01'], ['2016-01-01', null]],
      '600003': [['2011-06-01', null]],
    },
    delisted: { '600001': '2009-12-29' },
  };
  const p = pool.plan(members, '2012-01-01', '2020-12-31');
  assert.deepEqual(Object.keys(p).sort(), ['600002', '600003'], '区间外的股票不需要');
  assert.equal(p['600002'].to, '2020-12-31');
  assert.ok(p['600002'].from < '2011-01-01', '纳入前预留预热期');
  assert.ok(p['600003'].from < '2011-01-01', '区间开始前已是成分：从区间开始往前预热');
  const dates = dayList(4000);
  const mk = () => ({ dates, open: dates.map(() => 10), close: dates.map(() => 10), volume: dates.map(() => 1) });
  const out = pool.assemble(members, { '600002': { code: '600002', bars: mk(), fin: [{ report: '2012-12-31', notice: '2013-03-01', eps: 1 }] } }, '2012-01-01', '2020-12-31');
  assert.deepEqual(out.coverage, { wanted: 2, got: 1, missing: ['600003'], stale: 1 }, '没有版本号的旧记录计为待更新');
  const d = out.data['600002'];
  assert.ok(d.dates[0] >= p['600002'].from && d.dates[d.dates.length - 1] <= '2020-12-31');
  assert.deepEqual(out.meta.universe['600002'], members.members['600002']);
  assert.equal(out.meta.fundamentals['600002'].length, 1);
  // 组装出的数据可以直接回测
  const bt = new AQ.Backtester(out.data, { meta: out.meta });
  assert.ok(bt.member['600002'].some((x) => x === 1));
});

test('eastmoney: klines with turnover and finance rows parse', () => {
  const k = em.parseKlines({ data: { name: '测试', klines: ['2024-01-02,10,10.5,10.8,9.9,1000,1.25'] } }, '600000');
  assert.deepEqual(k.turnover, [1.25]);
  assert.equal(k.name, '测试');
  const f = em.parseFinance({ result: { data: [{ REPORT_DATE: '2023-12-31 00:00:00', NOTICE_DATE: '2024-03-30 00:00:00', EPSJB: 1.2, BPS: 8, TOTALOPERATEREVETZ: 5, PARENTNETPROFITTZ: null }] } });
  assert.deepEqual(f[0].report, '2023-12-31');
  assert.ok(Number.isNaN(f[0].profitYoy));
  assert.ok(em.financeUrl('000001').includes('000001.SZ') && em.financeUrl('600519').includes('600519.SH'));
  // 等比前复权时带上不复权价与换手率
  const hfq = { dates: ['a', 'b'], open: [2, 4], high: [2, 4], low: [2, 4], close: [2, 4], volume: [1, 1] };
  const raw = { dates: ['a', 'b'], open: [1, 1], high: [1, 1], low: [1, 1], close: [1, 1], volume: [1, 1], turnover: [0.5, 0.6] };
  const q = em.proportional(hfq, raw, 'x');
  assert.deepEqual(q.raw, [1, 1]);
  assert.deepEqual(q.turnover, [0.5, 0.6]);
});

test('neutralize: industry demeaning removes industry effects; size regression removes size', () => {
  const syms = ['a', 'b', 'c', 'd', 'e', 'f'];
  const b = { meta: { industry: { a: '银行', b: '银行', c: '银行', d: '白酒', e: '白酒', f: '白酒' } }, cache: new Map(), dates: ['x'], raw: {}, turnover: {}, volume: {} };
  // 因子值完全由行业决定：中性化后全为 0
  const x = [1, 1, 1, 5, 5, 5];
  assert.ok(R.neutralize(x, syms, 'industry', b, 0).every((v) => Math.abs(v) < 1e-12));
  // 行业内的排序得以保留
  const y = [1, 2, 3, 10, 11, 12];
  const n1 = R.neutralize(y, syms, 'industry', b, 0);
  close(n1[0], n1[3], 1e-12);
  assert.ok(n1[2] > n1[0]);
  const raw = R.neutralize(y, syms, 'none', b, 0);
  assert.ok(raw[3] > raw[2], '不中性化时白酒整体排在前面');
});

test('exposure with industry factors and new style factors on a stock-like pool', () => {
  const n = 700;
  const dates = dayList(n);
  const data = {}, industry = {}, shares = {}, fundamentals = {};
  for (let k = 0; k < 12; k++) {
    const sym = '6000' + String(k).padStart(2, '0');
    const d = series(n, 90 + k, 0.0002 * ((k % 4) - 1.5), 0.012);
    data[sym] = { ...d, dates, raw: d.close.slice() };
    industry[sym] = ['银行', '白酒', '电力'][k % 3];
    shares[sym] = [{ date: dates[0], total: 1e9 * (1 + k), float: 5e8 * (1 + k) }];
    fundamentals[sym] = [{ report: '2019-12-31', notice: dates[5], update: dates[5], profit: 1e8 * (k + 1), bps: 3 + k, eps: 0.1 }];
  }
  const bt = new AQ.Backtester(data, { meta: { industry, shares, fundamentals } });
  const sf = R.styleFactors(bt);
  assert.deepEqual(sf.order, ['SIZE', 'VALUE', 'MOM', 'LOWVOL', 'QUALITY', 'LIQ']);
  assert.ok(sf.industries && Object.keys(sf.industries).length === 2, '三个行业去掉基准行业后剩两个');
  const eq = bt.run(new AQ.BuyAndHold()).equity;
  const ex = R.exposure(eq, sf, 0, n - 1, 0.02, { industry: true });
  assert.ok(ex.loadings.some((l) => l.kind === 'industry'));
  assert.ok(ex.baseIndustry);
  // E/P 用净利润 / 总市值，不受每股收益追溯调整影响
  const ep = R.FACTORS.find((f) => f.id === 'ep').f(bt.bars(), '600003');
  close(ep[n - 1], (1e8 * 4) / (data['600003'].close[n - 1] * 4e9), 1e-9);
});

// ---------- 成交容量与冲击成本 ----------

test('participation cap splits a large order across days using only past volume', () => {
  const n = 60;
  const dates = dayList(n);
  const px = dates.map(() => 10);
  // 每天成交 1000 手 = 100 万元；参与率 10% → 每天最多买 10 万元
  const mk = (vol) => ({ '600000': { dates, open: px, close: px, high: px, low: px, volume: vol } });
  const vol = dates.map(() => 1000);
  const opts = { initialCash: 1e6, rebalanceBand: 0, slippage: 0, participation: 0.1 };
  const bt = new AQ.Backtester(mk(vol), opts);
  const res = bt.run(new AQ.BuyAndHold());
  const buys = res.trades.filter((t) => t.side === 'buy');
  assert.ok(buys.length >= 9, `分 ${buys.length} 天买入`);
  assert.ok(buys.every((t) => t.amount <= 1e5 + 1e-6));
  assert.ok(res.dates.indexOf(buys[0].date) >= 10, '成交量历史不足 10 天时先不买')
  // 篡改当天及以后的成交量不影响当天的成交上限
  const vol2 = vol.slice();
  const day = res.dates.indexOf(buys[3].date);
  for (let i = day; i < n; i++) vol2[i] = 1e9;
  const res2 = new AQ.Backtester(mk(vol2), opts).run(new AQ.BuyAndHold());
  assert.equal(res2.trades.filter((t) => t.side === 'buy')[3].amount, buys[3].amount);
});

test('square-root impact raises cost with order size', () => {
  const d = series(300, 77, 0, 0.02);
  d.volume = d.volume.map(() => 200); // 每天约 2000 万股·元级别的成交额
  // 第二只从第 30 天才有行情：等权买入发生在有了 20 日历史之后
  const late = { dates: d.dates.slice(30), open: d.open.slice(30), close: d.close.slice(30), volume: d.volume.slice(30) };
  const data = { '600000': d, '600001': late };
  const run = (cash) => new AQ.Backtester(data, { initialCash: cash, rebalanceBand: 0, slippage: 0, impact: 1 }).run(new AQ.BuyAndHold()).trades.find((t) => t.symbol === '600000');
  const small = run(1e5), big = run(1e7);
  assert.ok(small.impact > 0 && big.impact > 0);
  assert.ok(big.impact / big.amount > small.impact / small.amount * 5, `${small.impact / small.amount} vs ${big.impact / big.amount}`);
});

test('makeBacktester forwards capacity, impact, delisting and meta settings', () => {
  const bt = R.makeBacktester({ '600000': series(100, 1) }, { fees: {}, participation: 0.1, impact: 0.5, delistRecovery: 0.3, meta: { industry: { '600000': '银行' } } });
  assert.equal(bt.participation, 0.1);
  assert.equal(bt.impact, 0.5);
  assert.equal(bt.delistRecovery, 0.3);
  assert.equal(bt.meta.industry['600000'], '银行');
  assert.ok(bt.adv && bt.sigma, '启用容量或冲击时预先计算成交额与波动率');
});

// ---------- 过拟合检验：PBO（CSCV）与 SPA ----------

function noiseReturns(K, T, seed, edge = []) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: K }, (_, k) => Float32Array.from({ length: T }, () => {
    const z = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    return 0.01 * z + (edge[k] || 0);
  }));
}
function toBlocks(r, S = 12) {
  const T = r.length, b = { sum: new Float64Array(S), sq: new Float64Array(S), n: new Float64Array(S) };
  for (let t = 0; t < T; t++) { const j = Math.min(S - 1, Math.floor((t * S) / T)); b.sum[j] += r[t]; b.sq[j] += r[t] * r[t]; b.n[j]++; }
  return b;
}

test('PBO is high for pure noise and near zero with a persistent edge', () => {
  const noise = noiseReturns(40, 1200, 5);
  const p1 = R.pbo(noise.map((r) => toBlocks(r)));
  assert.equal(p1.splits, 924);
  // 纯噪声：全样本均值固定，样本内冠军在样本外往往落到中位数以下，PBO 通常 ≥ 0.5
  assert.ok(p1.pbo >= 0.4, `噪声 PBO = ${p1.pbo}`);
  const edged = noiseReturns(40, 1200, 5, { 7: 0.002 });
  const p2 = R.pbo(edged.map((r) => toBlocks(r)));
  assert.ok(p2.pbo < 0.05, `有真实优势时 PBO = ${p2.pbo}`);
});

test('SPA does not reject for noise and rejects when one candidate truly beats the benchmark', () => {
  // 零假设成立时 p 值应近似均匀：20 组纯噪声里 p < 0.05 的比例不应明显超过 5%
  const ps = Array.from({ length: 20 }, (_, i) => R.spa(noiseReturns(30, 1000, 7 * i + 8), { B: 150 }).p);
  const rej = ps.filter((p) => p < 0.05).length / ps.length;
  assert.ok(rej <= 0.2, `噪声下的拒绝比例 ${rej}：${ps.map((p) => p.toFixed(2)).join(' ')}`);
  const edged = noiseReturns(30, 1000, 9, { 3: 0.0015 });
  const b = R.spa(edged, { B: 200 });
  assert.ok(b.p < 0.05, `真实优势 SPA p = ${b.p}`);
});

test('factor strategy with portfolio optimization: weights obey cap and budget', () => {
  const data = {};
  for (let k = 0; k < 8; k++) data['6000' + k] = series(600, 200 + k, 0.0003 * (k - 3), 0.015);
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const b = bt.bars();
  const rows = new R.FactorStrategy({ factors: [{ id: 'roc60', weight: 1 }], topN: 2, rebalance: 20, sizing: 'optimize', maxWeight: 35 })
    .generate(b.close, bt.dates, bt.symbols, b).filter(Boolean);
  assert.ok(rows.length > 5);
  for (const r of rows) {
    const sum = r.reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `权重和 ${sum}`);
    assert.ok(r.every((x) => x >= 0 && x <= 0.35 + 1e-6), JSON.stringify(r));
  }
  assert.throws(() => new R.FactorStrategy({ factors: [{ id: 'roc60', weight: 1 }], sizing: 'optimize', ic: 0 }), /组合优化/);
});

test('stress test: higher capital and higher costs never help', () => {
  const data = { '600000': series(700, 301), '600001': series(700, 302), '600002': series(700, 303) };
  const out = R.stressTest({
    data, engine: { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0.01, participation: 0.1, impact: 0.5 },
    config: { type: 'rules', rules: [{ id: 'price_ma', params: { n: 20 } }] }, capitals: [1e6, 1e8], multipliers: [1, 3],
  });
  assert.equal(out.capacity.length, 2);
  assert.ok(out.capacity[1].impactShare > out.capacity[0].impactShare, '资金越大冲击成本占比越高');
  assert.ok(out.cost[1].cagr < out.cost[0].cagr, '成本放大后收益下降');
});

test('factor decay reports IC by horizon, by year and factor autocorrelation', () => {
  const data = {};
  for (let k = 0; k < 8; k++) data['6000' + k] = series(800, 400 + k);
  const bt = new AQ.Backtester(data, {});
  const d = R.factorDecay(bt, 'roc20', { horizons: [1, 5, 20] });
  assert.deepEqual(d.byH.map((x) => x.h), [1, 5, 20]);
  assert.ok(d.years.length >= 2);
  // 20 日动量：相隔 1 天的秩自相关远高于相隔 20 天
  assert.ok(d.autocorr[0].rho > d.autocorr[2].rho && d.autocorr[0].rho > 0.8, JSON.stringify(d.autocorr));
});
