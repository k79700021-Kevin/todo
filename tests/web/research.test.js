// 网页版策略、优化与统计函数的单元测试：node --test tests/web
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const AQ = require(path.join(docs, 'engine.js'));
const { RuleStrategy } = require(path.join(docs, 'rules.js'));
const R = require(path.join(docs, 'research.js'));

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

test('optimize: grid enumerates every combination and ranks by in-sample objective', () => {
  const data = { '510300': series(1500, 3), '510500': series(1500, 4), '159915': series(1500, 5) };
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
    wf: { enabled: true, trainYears: 2, testYears: 1, anchored: false },
  });
  // fast >= slow 的组合（10/10、20/10）无效
  assert.equal(res.trials + res.invalid, 9);
  assert.equal(res.invalid, 2);
  const scores = res.top.map((t) => t.is.sharpe);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
  assert.ok(res.dsr && res.dsr.prob >= 0 && res.dsr.prob <= 1);

  // 滚动前推：测试窗口首尾相接，拼接净值与日期等长
  const w = res.wf.windows;
  assert.ok(w.length >= 3);
  for (let i = 1; i < w.length; i++) assert.equal(w[i].test[0], w[i - 1].test[1]);
  assert.equal(res.wf.equity.length, res.wf.dates.length);
  assert.equal(res.wf.dates[res.wf.dates.length - 1], res.dates[1]);
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
  assert.ok(roc1.tsIC > 0.2 && roc1.tsT > 5, JSON.stringify(roc1));
  const q = R.factorQuantiles(bt, 'roc1', 1, 5);
  assert.equal(q.length, 5);
  assert.ok(q[4].mean > q[0].mean);
});
