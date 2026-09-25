/* 系统级"无未来函数"检验：把某一天之后的所有数据（行情、财务、股本、成分）随机篡改，
 * 该天及以前的因子值、规则信号、风格因子、策略净值与成交必须完全不变。
 * 遍历注册表里的全部因子、规则与策略，新增的因子或规则自动纳入检验。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const AQ = require(path.join(docs, 'engine.js'));
const RULES = require(path.join(docs, 'rules.js'));
const R = require(path.join(docs, 'research.js'));

const N = 700, CUT = 450;
const dates = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2015, 0, 5) + i * 86400000).toISOString().slice(0, 10));
const SYMS = Array.from({ length: 10 }, (_, k) => '6000' + String(k).padStart(2, '0'));
const INDUSTRY = Object.fromEntries(SYMS.map((s, k) => [s, ['银行', '白酒', '电力'][k % 3]]));

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function build(mutate) {
  const data = {}, fundamentals = {}, shares = {}, universe = {};
  SYMS.forEach((s, k) => {
    const r = rng(k + 1), m = rng(1000 + k);
    let p = 10 + k;
    const o = [], c = [], h = [], l = [], v = [], raw = [], tv = [];
    for (let i = 0; i < N; i++) {
      const open = p * (1 + (r() - 0.5) * 0.01);
      p = Math.max(1, p * (1 + (r() - 0.5) * 0.05));
      let row = [open, p, Math.max(open, p) * 1.01, Math.min(open, p) * 0.99, 1e5 + r() * 1e5, p * 0.8, 0.5 + r()];
      if (mutate && i > CUT) row = row.map((x, j) => (j === 4 || j === 6 ? x * (0.1 + 5 * m()) : x * (0.5 + m())));
      [o, c, h, l, v, raw, tv].forEach((arr, j) => arr.push(row[j]));
    }
    // 某只股票在截断日后停牌一段
    if (k === 3) for (let i = CUT + 5; i < CUT + 25; i++) v[i] = 0;
    data[s] = { dates, open: o, close: c, high: h, low: l, volume: v, raw, turnover: tv };
    const recs = [];
    for (let q = 0; q < 12; q++) {
      const notice = dates[Math.min(N - 1, 40 + q * 55)];
      const rec = { report: `${2014 + Math.floor(q / 4)}-${['03-31', '06-30', '09-30', '12-31'][q % 4]}`, notice, update: notice,
        profit: 1e8 * (k + 1) * (q % 4 + 1), eps: 0.1 * (q % 4 + 1), bps: 3 + k + q * 0.1, revYoy: 5 + k, profitYoy: 3 + q };
      if (mutate && notice > dates[CUT]) Object.assign(rec, { profit: rec.profit * -7, bps: 99, revYoy: -80, profitYoy: 500 });
      recs.push(rec);
    }
    // 截断日后才公告的一条"修订"：只能影响之后
    if (mutate) recs.push({ report: '2014-12-31', notice: dates[CUT + 3], update: dates[CUT + 3], profit: 1, eps: 1, bps: 1, revYoy: 1, profitYoy: 1 });
    fundamentals[s] = recs;
    shares[s] = [{ date: dates[0], total: 1e9 * (k + 1), float: 6e8 * (k + 1) }, { date: dates[300], total: 1.5e9 * (k + 1), float: 9e8 * (k + 1) }];
    if (mutate) shares[s].push({ date: dates[CUT + 10], total: 1, float: 1 });
    universe[s] = k === 9 ? [[dates[100], mutate ? dates[CUT + 20] : null]] : [[dates[0], null]];
  });
  const meta = { universe, fundamentals, shares, industry: INDUSTRY, industryPIT: true, delisted: mutate ? { '600008': dates[CUT + 30] } : {} };
  return { data, meta };
}

const same = (a, b, what) => {
  for (let i = 0; i <= CUT; i++) {
    const x = a[i], y = b[i];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    assert.ok(x === y || Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x)), `${what}：第 ${i} 天 ${x} ≠ ${y}`);
  }
};

const A = build(false), B = build(true);
const opts = (x) => ({ meta: x.meta, participation: 0.1, impact: 0.5, delistRecovery: 0, rebalanceBand: 0 });
const btA = new AQ.Backtester(A.data, opts(A)), btB = new AQ.Backtester(B.data, opts(B));
const bA = btA.bars(), bB = btB.bars();

test('every registered factor ignores data after the cut-off', () => {
  const fs = R.availableFactors(bA, SYMS);
  assert.equal(fs.length, R.FACTORS.length, '合成数据支持全部因子');
  for (const f of fs) for (const s of SYMS) same(f.f(bA, s), f.f(bB, s), `因子 ${f.id} ${s}`);
});

test('every registered rule signal ignores data after the cut-off', () => {
  for (const [id, def] of Object.entries(RULES.RULES)) {
    const p = RULES.defaultParams(id);
    for (const s of SYMS) same(def.signal(bA, s, p), def.signal(bB, s, p), `规则 ${id} ${s}`);
  }
});

test('style factors ignore data after the cut-off', () => {
  const sa = R.styleFactors(btA), sb = R.styleFactors(btB);
  for (const k of ['MKT', ...sa.order]) same(sa[k], sb[k], `风格因子 ${k}`);
  for (const g of Object.keys(sa.industries)) same(sa.industries[g], sb.industries[g], `行业因子 ${g}`);
});

test('every strategy: equity and fills up to the cut-off are unchanged', () => {
  const strategies = [
    () => new AQ.BuyAndHold(),
    () => new AQ.DualMA({ fast: 5, slow: 20 }),
    () => new AQ.MomentumRotation({ lookback: 20, topN: 3, rebalance: 5 }),
    ...Object.keys(RULES.RULES).map((id) => () => new RULES.RuleStrategy({ rules: [{ id }], stopLoss: 8, trailATR: 2, maxPositions: 4, minHold: 2, maxHold: 30, cooldown: 3, sizing: 'invvol' })),
    ...R.FACTORS.map((f) => () => new R.FactorStrategy({ factors: [{ id: f.id, weight: 1 }], topN: 3, rebalance: 7, trendN: 20, neutral: 'industry_size', sizing: 'invvol' })),
    () => new R.FactorStrategy({ factors: [{ id: 'ep', weight: 1 }, { id: 'roc20', weight: 1 }], topN: 3, rebalance: 10, sizing: 'optimize', maxWeight: 30, industryPenalty: 20 }),
    () => new R.FactorStrategy({ factors: [{ id: 'bp', weight: 1 }, { id: 'roc60', weight: 1 }], topN: 4, rebalance: 5, trendN: 60, neutral: 'size', sizing: 'optimize', maxWeight: 20 }),
  ];
  for (const mk of strategies) {
    const ra = btA.run(mk()), rb = btB.run(mk());
    const name = `${ra.strategy} ${JSON.stringify(ra.params).slice(0, 60)}`;
    same(ra.equity, rb.equity, `净值 ${name}`);
    const upTo = (tr) => tr.filter((t) => t.date <= dates[CUT]);
    assert.deepEqual(upTo(ra.trades), upTo(rb.trades), `成交 ${name}`);
  }
});
