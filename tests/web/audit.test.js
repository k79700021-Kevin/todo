/* 审计回归测试：把外部审计发现的问题写成对抗性用例，修复前应当失败、修复后必须通过。
 * 编号对应审计清单。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const AQ = require(path.join(docs, 'engine.js'));
const RULES = require(path.join(docs, 'rules.js'));
const R = require(path.join(docs, 'research.js'));
const PF = require(path.join(docs, 'portfolio.js'));
const L = require(path.join(docs, 'ledger.js'));
const POOL = require(path.join(docs, 'stockpool.js'));

const dayList = (n, start = Date.UTC(2020, 0, 1)) => Array.from({ length: n }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
function walk(n, seed, drift = 0) {
  let x = seed, p = 10;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, () => (p = Math.max(1, p * (1 + drift + (rnd() - 0.5) * 0.04))));
}
const bars = (dates, px, extra = {}) => ({ dates, open: px.slice(), close: px.slice(), high: px.map((p) => p * 1.01), low: px.map((p) => p * 0.99), volume: px.map(() => 1e5), ...extra });

// ---------- 1. 趋势过滤不能用"未来才纳入"的股票 ----------
test('1: decisions before a stock joins the universe do not depend on that stock', () => {
  const n = 500, E = 300;
  const dates = dayList(n);
  const mk = (bump) => {
    const data = {}, universe = {};
    for (let k = 0; k < 6; k++) {
      const s = '6000' + String(k).padStart(2, '0');
      let px = walk(n, 11 + k, 0.0003);
      // 最后一只（未来成分）纳入前的价格被篡改
      if (k === 5 && bump) px = px.map((p, i) => (i < E ? p * (i % 2 ? 3 : 0.3) : p));
      data[s] = bars(dates, px);
      universe[s] = k === 5 ? [[dates[E], null]] : [[dates[0], null]];
    }
    return new AQ.Backtester(data, { meta: { universe }, rebalanceBand: 0 });
  };
  const A = mk(false), B = mk(true);
  const strategies = [
    () => new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 2, rebalance: 5, trendN: 20 }),
    () => new R.FactorStrategy({ factors: [{ id: 'vol20', weight: -1 }], topN: 2, rebalance: 5, trendN: 60, sizing: 'invvol' }),
    () => new AQ.MomentumRotation({ lookback: 20, topN: 2, rebalance: 5 }),
    () => new AQ.BuyAndHold(),
    () => new RULES.RuleStrategy({ rules: [{ id: 'price_ma', params: { n: 10 } }], maxPositions: 2 }),
  ];
  for (const mk2 of strategies) {
    const ra = A.run(mk2()), rb = B.run(mk2());
    assert.deepEqual(ra.equity.slice(0, E), rb.equity.slice(0, E), ra.strategy);
  }
  const sa = R.styleFactors(A), sb = R.styleFactors(B);
  for (const k of ['MKT', ...sa.order]) assert.deepEqual(Array.from(sa[k].slice(0, E)), Array.from(sb[k].slice(0, E)), k);
});

// ---------- 2. 非时点行业分类不得进入历史信号 ----------
test('2: current (non point-in-time) industry labels cannot drive historical signals', () => {
  const dates = dayList(300);
  const data = {}, industry = {};
  for (let k = 0; k < 6; k++) { const s = '6000' + k; data[s] = bars(dates, walk(300, k + 3)); industry[s] = k % 2 ? 'A' : 'B'; }
  const bt = new AQ.Backtester(data, { meta: { industry } });
  const b = bt.bars();
  const strat = (cfg) => () => new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 2, ...cfg }).generate(b.close, bt.dates, bt.symbols, b);
  assert.throws(strat({ neutral: 'industry' }), /时点/);
  assert.throws(strat({ neutral: 'industry_size' }), /时点/);
  assert.throws(strat({ sizing: 'optimize', industryPenalty: 50 }), /时点/);
  assert.throws(() => R.factorIC(bt, 5, { neutral: 'industry', B: 10 }), /时点/);
  // 只按市值中性化是时点的，允许
  assert.doesNotThrow(strat({ neutral: 'size' }));
  // 显式标注为时点分类后允许
  const bt2 = new AQ.Backtester(data, { meta: { industry, industryPIT: true } });
  const b2 = bt2.bars();
  assert.doesNotThrow(() => new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 2, neutral: 'industry' }).generate(b2.close, bt2.dates, bt2.symbols, b2));
  // 事后归因仍可使用当前分类
  assert.ok(R.styleFactors(bt).industries);
});

// ---------- 3. 研究层不能在停牌日"成交" ----------
test('3: forward returns never enter or exit on a suspended day', () => {
  const dates = dayList(4);
  const data = { X: { dates, open: [10, 10, 10.5, 10.5], close: [10, 10, 10.5, 10.5], volume: [1, 0, 1, 1] } };
  const bt = new AQ.Backtester(data, {});
  const f = R.forwardReturnsOf(bt, 'X', 1);
  assert.ok(Number.isNaN(f[0]), `1 月 2 日停牌，不能以 10 元买入：${f[0]}`);
  assert.equal(f[1], 0); // 1 月 3 日开盘 10.5 买、1 月 4 日开盘 10.5 卖
  // 开盘涨停买不进
  const up = { X: { dates, open: [10, 10, 11, 11], close: [10, 10, 11, 11], volume: [1, 1, 1, 1] } };
  assert.ok(Number.isNaN(R.forwardReturnsOf(new AQ.Backtester(up, {}), 'X', 1)[1]));
});

test('3b: tradable quantile portfolios run through the execution engine', () => {
  const n = 400;
  const dates = dayList(n);
  const data = {};
  for (let k = 0; k < 10; k++) data['6000' + String(k).padStart(2, '0')] = bars(dates, walk(n, 50 + k, 0.0002 * (k - 5)));
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const p = R.factorPortfolios(bt, 'roc20', 20);
  assert.equal(p.q, 5);
  assert.ok(p.engine, '由回测引擎成交');
  for (const g of p.groups) {
    assert.ok(g.fees > 0, '含真实交易费用');
    assert.equal(g.equity.length, p.dates.length);
  }
});

// ---------- 4. 信号用复权价，成交用真实价格；送股、分红调整持仓 ----------
test('4: execution uses raw prices with corporate actions; equity follows the adjusted series', () => {
  const dates = dayList(6);
  // 第 3 天 10 送 10：真实价格从 20 跌到 10.2；复权价连续
  const rawC = [20, 20, 20, 10.2, 10.4, 10.6];
  const adjC = [10, 10, 10, 10.2, 10.4, 10.6];
  const data = { '600000': { dates, open: adjC.slice(), close: adjC.slice(), high: adjC.slice(), low: adjC.slice(), volume: dates.map(() => 1e6), raw: rawC.slice() } };
  const fees = new AQ.FeeModel({ commissionRate: 0, minCommission: 0, transferRate: 0, stampDutyRate: 0 });
  // 送转需要明细数据（仅凭复权因子无法区分派现与送转，见 audit2 的 1a/1b）
  const corporateActions = { '600000': [{ date: dates[3], bonus: 1 }] };
  const bt = new AQ.Backtester(data, { initialCash: 100000, fees, slippage: 0, rebalanceBand: 0, meta: { corporateActions } });
  const res = bt.run(new AQ.BuyAndHold());
  const buy = res.trades[0];
  assert.equal(buy.price, 20, '按真实开盘价成交');
  assert.equal(buy.shares, 5000, '真实股数');
  assert.equal(res.finalShares['600000'], 10000, '送股后股数翻倍');
  assert.ok(Math.abs(res.equity[5] - 5000 * 20 * (10.6 / 10)) < 1e-6, `净值随复权价变化：${res.equity[5]}`);
  // 送转不是成交：不计入成交笔数与换手
  assert.equal(AQ.summarize(res).trades, 1);
  assert.equal(res.trades.filter((t) => t.side === 'corporate').length, 1);
  // 现金分红：真实价格除息 0.5 元
  const raw2 = [20, 20, 20, 19.5, 19.5, 19.5];
  const adj2 = raw2.map((r, i) => (i < 3 ? r * (19.5 / 20) : r));
  const d2 = { '600000': { dates, open: adj2.slice(), close: adj2.slice(), volume: dates.map(() => 1e6), raw: raw2.slice() } };
  const r2 = new AQ.Backtester(d2, { initialCash: 100000, fees, slippage: 0, rebalanceBand: 0 }).run(new AQ.BuyAndHold());
  assert.equal(r2.finalShares['600000'], 5000, '分红不改变股数');
  assert.ok(Math.abs(r2.equity[5] - (5000 * 19.5 + 5000 * 0.5)) < 1e-6, `分红进现金：${r2.equity[5]}`);
  // 买入 → 分红 → 送转后全部卖出：往返收益包含分红，送转后的股数正确结清
  const d3 = { '600000': { dates, open: adjC.slice(), close: adjC.slice(), volume: dates.map(() => 1e6), raw: rawC.slice() } };
  const rows = [[1], null, null, null, [0], null];
  const r3 = new AQ.Backtester(d3, { initialCash: 100000, fees, slippage: 0, rebalanceBand: 0, meta: { corporateActions } }).run({ name: 'x', params: () => ({}), generate: () => rows });
  const rt = R.roundTrips(r3.trades, r3.dates);
  assert.equal(rt.count, 1);
  assert.equal(rt.open, 0);
  assert.ok(Math.abs(rt.list[0].ret - (10.6 / 10 - 1)) < 1e-9, JSON.stringify(rt.list[0]));
});

test('4c: cent rounding of adjusted and raw prices is not mistaken for dividends', () => {
  // 后复权 = 不复权 × 1.5，两者各自四舍五入到分：复权因子每天有舍入噪声，但没有任何公司行为
  const n = 300;
  const dates = dayList(n);
  const raw = walk(n, 5).map((p) => +(p * 0.4).toFixed(2));
  const hfq = raw.map((p) => +(p * 1.5).toFixed(2));
  const f = raw[n - 1] / hfq[n - 1];
  const adj = hfq.map((p) => p * f);
  const data = { '600000': { dates, open: adj.slice(), close: adj.slice(), volume: dates.map(() => 1e6), raw } };
  const res = new AQ.Backtester(data, { initialCash: 1e6, slippage: 0, rebalanceBand: 0 }).run(new AQ.BuyAndHold());
  assert.equal(res.trades.filter((t) => !AQ.isFill(t)).length, 0, '没有公司行为');
  const buy = res.trades[0];
  const cash = 1e6 - buy.amount - buy.fee;
  assert.ok(Math.abs(res.equity[n - 1] - (cash + buy.shares * raw[n - 1])) < 1e-6, '净值 = 现金 + 股数 × 真实收盘价');
});

test('4b: participation cap and fees use the same (raw) money unit', () => {
  const n = 40;
  const dates = dayList(n);
  const adj = dates.map(() => 5), raw = dates.map(() => 50); // 复权价只有真实价的 1/10
  const data = { '600000': { dates, open: adj.slice(), close: adj.slice(), volume: dates.map(() => 1000), raw } };
  const bt = new AQ.Backtester(data, { initialCash: 1e6, rebalanceBand: 0, slippage: 0, participation: 0.1 });
  const buys = bt.run(new AQ.BuyAndHold()).trades.filter((t) => t.side === 'buy');
  // 20 日均成交额 = 1000 手 × 100 × 50 = 500 万；10% = 50 万
  assert.ok(buys.every((t) => t.amount <= 5e5 + 1e-6 && t.price === 50), JSON.stringify(buys.slice(0, 2)));
});

// ---------- 5. 缺行情的历史成分不能被静默删除 ----------
test('5: strict mode refuses an incomplete point-in-time universe', () => {
  const members = { members: { '600001': [['2015-01-01', null]], '600002': [['2015-01-01', null]] } };
  const dates = dayList(400, Date.UTC(2015, 0, 1));
  const rec = { code: '600001', v: POOL.VERSION, bars: bars(dates, walk(400, 1)), fin: [] };
  assert.throws(() => POOL.assemble(members, { '600001': rec }, '2015-06-01', '2016-01-01', { strict: true }), /覆盖率/);
  const loose = POOL.assemble(members, { '600001': rec }, '2015-06-01', '2016-01-01');
  assert.ok(loose.coverage.minDaily < 0.6, `逐日覆盖率 ${loose.coverage.minDaily}`);
  assert.deepEqual(loose.coverage.missing, ['600002']);
});

// ---------- 6. 引擎层强制时点股票池 ----------
test('6: the engine refuses buys outside the point-in-time universe, whatever the strategy asks', () => {
  const dates = dayList(10);
  const px = dates.map(() => 10);
  const data = { '600001': bars(dates, px), '600002': bars(dates, px) };
  const universe = { '600001': [[dates[0], null]], '600002': [[dates[5], null]] };
  const bt = new AQ.Backtester(data, { meta: { universe }, rebalanceBand: 0 });
  const rogue = { name: 'rogue', params: () => ({}), generate: (c, d) => d.map((_, i) => (i === 0 ? [0, 1] : null)) };
  const trades = bt.run(rogue).trades;
  const first = trades.find((t) => t.symbol === '600002');
  assert.ok(!first || first.date > dates[5], `纳入前被买入：${first && first.date}`);
});

// ---------- 7. 单票上限不得被静默放宽 ----------
test('7: maxWeight is a hard constraint; an infeasible budget leaves cash', () => {
  const N = 5;
  const cov = new Float64Array(N * N);
  for (let i = 0; i < N; i++) cov[i * N + i] = 1e-4;
  const w = PF.optimize({ alpha: Float64Array.from([1, 2, 3, 4, 5].map((x) => x * 1e-3)), cov, cap: 0.1, budget: 1 });
  assert.ok(Array.from(w).every((x) => x <= 0.1 + 1e-9), JSON.stringify(Array.from(w)));
  assert.ok(Math.abs(w.reduce((a, x) => a + x, 0) - 0.5) < 1e-6, '剩余 50% 为现金');
});

// ---------- 8. 数据指纹覆盖全部数据与元数据；实验清单覆盖全部执行假设 ----------
test('8: fingerprints cover every field and the manifest covers execution assumptions', async () => {
  const A = { X: { dates: ['2020-01-01', '2020-01-02'], open: [1, 2], close: [1, 2] } };
  const B = { X: { dates: ['2020-01-01', '2020-01-02'], open: [9, 9], close: [2, 1] } };
  assert.notEqual(await L.fingerprint(A), await L.fingerprint(B));
  const C = { X: { ...A.X, open: [1, 2.0000001] } };
  assert.notEqual(await L.fingerprint(A), await L.fingerprint(C), '只改开盘价也要能区分');
  assert.notEqual(await L.fingerprint(A, { universe: { X: [['2020-01-01', null]] } }), await L.fingerprint(A, { universe: { X: [['2020-01-02', null]] } }), '元数据变化');
  const base = { data: 'h', strategy: { type: 'rules' }, engine: { slippage: 0.0005, fees: { commissionRate: 0.00025 } }, range: ['', ''] };
  const other = { ...base, engine: { ...base.engine, slippage: 0.001 } };
  assert.notEqual(await L.manifestHash(base), await L.manifestHash(other), '滑点不同是不同的实验');
});

// ---------- 9. 组合优化以实际持仓为起点 ----------
test('9: the optimizer starts from actual holdings, not the previous target', () => {
  const n = 320;
  const dates = dayList(n);
  const data = {};
  for (let k = 0; k < 8; k++) data['6000' + String(k).padStart(2, '0')] = bars(dates, walk(n, 70 + k, 0.0003 * (k - 3)));
  // 第一次决策（第 60 天）之后成交量全为 0 → 永远无法成交，实际持仓一直为空，而上一次的目标不为空
  for (const s of Object.keys(data)) data[s].volume = data[s].volume.map((v, i) => (i > 60 ? 0 : v));
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const st = new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 3, rebalance: 10, sizing: 'optimize', maxWeight: 40 });
  bt.run(st);
  assert.ok(st.lastW0, '记录了优化起点');
  assert.ok([...st.lastW0.values()].every((v) => v === 0), '无法成交时实际持仓为 0');
  // 对照：理想化预览（假设全部成交）的起点是上一次目标，不为 0
  const pv = new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 3, rebalance: 10, sizing: 'optimize', maxWeight: 40 });
  const b = bt.bars();
  pv.generate(b.close, bt.dates, bt.symbols, b);
  assert.ok([...pv.lastW0.values()].some((v) => v > 0));
});

// ---------- 10. 影子组合走真实的成交引擎 ----------
test('10: paper account replays frozen targets through the execution engine', () => {
  const dates = dayList(8);
  const px = [10, 10, 10, 11, 11, 11, 11, 11]; // 第 3 天开盘涨停（+10%）
  const data = { '600001': { dates, open: px.slice(), close: px.slice(), volume: dates.map(() => 1e6) }, '600002': bars(dates, dates.map(() => 20)) };
  const entries = [{ date: dates[2], targets: { '600001': 0.5, '600002': 0.5 }, engine: { initialCash: 1e5, fees: {}, slippage: 0.0005, rebalanceBand: 0 } }];
  const acct = R.paperReplay(data, entries, {});
  const t1 = acct.trades.filter((t) => t.symbol === '600001');
  assert.ok(!t1.length || t1[0].date > dates[3], '涨停当天买不进');
  assert.ok(acct.trades.every((t) => t.fee > 0 && t.shares % 100 === 0), '含费用与整手');
  assert.equal(acct.dates[0], dates[2]);
  assert.ok(acct.pending !== undefined && acct.cash > 0);
});

// ---------- 11. 交易规则：科创板申报数量、创业板 / 科创板 ETF 涨跌幅、新股前 5 日 ----------
test('11: STAR lot rules, 20% limits for ChiNext/STAR ETFs, IPO days without limits', () => {
  assert.equal(AQ.priceLimit('159915', '2021-01-04'), 0.2);
  assert.equal(AQ.priceLimit('159915', '2019-01-04'), 0.1);
  assert.equal(AQ.priceLimit('588000', '2021-01-04'), 0.2);
  assert.equal(AQ.priceLimit('510300', '2021-01-04'), 0.1);
  assert.equal(AQ.lotRound('688981', 350), 350, '科创板 200 股起、1 股递增');
  assert.equal(AQ.lotRound('688981', 150), 0);
  assert.equal(AQ.lotRound('600000', 350), 300);
  // 新股上市前 5 个交易日（注册制板块）不设涨跌幅
  const dates = dayList(8);
  const px = [10, 20, 30, 30, 30, 30, 30, 30];
  const data = { '688001': { dates, open: px.slice(), close: px.slice(), volume: dates.map(() => 1e6) } };
  const bt = new AQ.Backtester(data, { meta: { listDate: { '688001': dates[0] } }, rebalanceBand: 0 });
  const buy = bt.run(new AQ.BuyAndHold()).trades[0];
  assert.equal(buy.date, dates[1], '上市第 2 天开盘涨 100% 也能成交');
  // 数据从上市之后才开始时，不能把数据的前几天当成上市初期
  const late = new AQ.Backtester(data, { meta: { listDate: { '688001': '2019-07-22' } }, rebalanceBand: 0 });
  assert.equal(late.limitOf('688001', 1), 0.2);
});

// ---------- 部分成交：现金不足时的补单 ----------
test('partial fills caused by pending sells are retried the next day', () => {
  const dates = dayList(6);
  const a = [10, 10, 9, 9, 9, 9]; // 第 3 天跌停，卖不出
  const data = { '600001': { dates, open: a.slice(), close: a.slice(), volume: dates.map(() => 1e6) }, '600002': bars(dates, dates.map(() => 10)) };
  const rows = [[1, 0], [0, 1], null, null, null, null];
  const strat = { name: 'switch', params: () => ({}), generate: () => rows };
  const res = new AQ.Backtester(data, { rebalanceBand: 0, slippage: 0 }).run(strat);
  const buysB = res.trades.filter((t) => t.symbol === '600002' && t.side === 'buy');
  assert.ok(buysB.length >= 1 && buysB[buysB.length - 1].date > dates[2], '卖出成交后继续买入：' + JSON.stringify(res.trades.map((t) => [t.date, t.symbol, t.side, t.shares])));
  assert.ok(res.finalShares['600002'] >= 9000, `最终持仓 ${res.finalShares['600002']}`);
});

// ---------- 12. 统计的蒙特卡洛精度 ----------
test('12: SPA reports Monte Carlo error and uses enough draws; PBO warns on short blocks', () => {
  let x = 3;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const d = Array.from({ length: 5 }, () => Float32Array.from({ length: 300 }, () => (rnd() - 0.5) * 0.02));
  const s = R.spa(d);
  assert.ok(s.bootstrap >= 1000 && Number.isFinite(s.se), JSON.stringify(s));
  const blocks = d.map((r) => { const b = { sum: new Float64Array(12), sq: new Float64Array(12), n: new Float64Array(12) }; r.forEach((v, t) => { const j = Math.floor((t * 12) / r.length); b.sum[j] += v; b.sq[j] += v * v; b.n[j]++; }); return b; });
  assert.match(R.pbo(blocks).warning || '', /短/);
});
