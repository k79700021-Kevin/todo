/* 第二轮审计回归测试：外部审计用"极端但合法"的金融数据构造的探针，修复前失败、修复后必须通过。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const AQ = require(path.join(docs, 'engine.js'));
const R = require(path.join(docs, 'research.js'));
const L = require(path.join(docs, 'ledger.js'));

const dayList = (n, start = Date.UTC(2020, 0, 1)) => Array.from({ length: n }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
const free = () => new AQ.FeeModel({ commissionRate: 0, minCommission: 0, transferRate: 0, stampDutyRate: 0 });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
// 等比前复权：复权价 = 真实价 × 当日复权因子 / 最新复权因子
const adjusted = (raw, g) => raw.map((p, i) => (p * g[i]) / g[g.length - 1]);

// ---------- 1. 公司行为：派现不能被当成送股 ----------
test('1a: a 10% cash dividend is cash, with or without detail data (109000, not 109999)', () => {
  const dates = dayList(5);
  const raw = [100, 100, 90, 99, 99];
  const g = [1, 1, 100 / 90, 100 / 90, 100 / 90]; // 除息日复权因子跳 1.111…，与 10 送 1 完全相同
  const adj = adjusted(raw, g);
  const mk = () => ({ '600000': { dates, open: adj.slice(), close: adj.slice(), volume: dates.map(() => 1e6), raw: raw.slice() } });
  const opts = { initialCash: 100000, fees: free(), slippage: 0, rebalanceBand: 0 };
  // 有明细：每股派 10 元
  const r1 = new AQ.Backtester(mk(), { ...opts, meta: { corporateActions: { '600000': [{ date: dates[2], cash: 10 }] } } }).run(new AQ.BuyAndHold());
  assert.equal(r1.finalShares['600000'], 1000);
  close(r1.equity[4], 109000, 1e-6, '有明细');
  assert.equal(r1.inferredActions, 0);
  // 没有明细：不能猜成送股，按价值不变折成现金
  const r2 = new AQ.Backtester(mk(), opts).run(new AQ.BuyAndHold());
  assert.equal(r2.finalShares['600000'], 1000, '没有明细时不凭空增加股数');
  close(r2.equity[4], 109000, 1e-6, '没有明细');
  assert.equal(r2.inferredActions, 1, '推断次数要报告');
  // 明细与复权因子对不上（例如明细写成每股派 20 元）时要报告
  const bad = new AQ.Backtester(mk(), { ...opts, meta: { corporateActions: { '600000': [{ date: dates[2], cash: 20 }] } } });
  assert.equal(bad.caMismatch.length, 1);
  assert.equal(new AQ.Backtester(mk(), { ...opts, meta: { corporateActions: { '600000': [{ date: dates[2], cash: 10 }] } } }).caMismatch.length, 0);
});

test('1b: explicit bonus shares and combined bonus + cash keep value on the ex-date', () => {
  const dates = dayList(5);
  // 10 送 6 派 1.7（平安银行 2013）：除权参考价 = (16 − 0.17) / 1.6
  const exRef = (16 - 0.17) / 1.6;
  const raw = [16, 16, exRef, exRef * 1.1, exRef * 1.1];
  const g = [1, 1, 16 / exRef, 16 / exRef, 16 / exRef];
  const adj = adjusted(raw, g);
  const data = { '600000': { dates, open: adj.slice(), close: adj.slice(), volume: dates.map(() => 1e6), raw: raw.slice() } };
  const res = new AQ.Backtester(data, { initialCash: 16000, fees: free(), slippage: 0, rebalanceBand: 0, meta: { corporateActions: { '600000': [{ date: dates[2], cash: 0.17, bonus: 0.6 }] } } }).run(new AQ.BuyAndHold());
  assert.equal(res.finalShares['600000'], 1600);
  close(res.equity[2], 16000, 1e-6, '除权日价值不变');
  close(res.equity[4], 1600 * exRef * 1.1 + 170, 1e-6, '之后按新股数计');
});

test('1c: an event on a suspended ex-date is applied when the price resumes (no valuation spike)', () => {
  const dates = dayList(6);
  const raw = [20, 20, NaN, 10, 10, 10]; // 除权日停牌
  const g = [1, 1, 1, 2, 2, 2];
  const adj = raw.map((p, i) => (Number.isFinite(p) ? (p * g[i]) / 2 : NaN));
  const data = { '600000': { dates, open: adj.slice(), close: adj.slice(), volume: [1e6, 1e6, 0, 1e6, 1e6, 1e6], raw: raw.slice() } };
  const res = new AQ.Backtester(data, { initialCash: 100000, fees: free(), slippage: 0, rebalanceBand: 0, meta: { corporateActions: { '600000': [{ date: dates[2], bonus: 1 }] } } }).run(new AQ.BuyAndHold());
  assert.ok(res.equity.every((v) => Math.abs(v - 100000) < 1e-6), JSON.stringify(res.equity));
  assert.equal(res.finalShares['600000'], 10000);
});

// ---------- 2. Amihud 非流动性必须用真实成交额 ----------
test('2: Amihud illiquidity does not depend on the adjustment scale', () => {
  const n = 60;
  const dates = dayList(n);
  let x = 5;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const raw = [];
  let p = 10;
  for (let i = 0; i < n; i++) raw.push((p *= 1 + (rnd() - 0.5) * 0.04));
  const vol = dates.map(() => 1e5);
  // A、B 真实价格、成交量、收益完全相同，只是 B 的复权价被历史公司行为整体缩小到 1/10
  const data = {
    A: { dates, open: raw.slice(), close: raw.slice(), volume: vol.slice(), raw: raw.slice() },
    B: { dates, open: raw.map((v) => v / 10), close: raw.map((v) => v / 10), volume: vol.slice(), raw: raw.slice() },
  };
  const b = new AQ.Backtester(data, {}).bars();
  const f = R.FACTORS.find((q) => q.id === 'illiq').f;
  const a = f(b, 'A'), c = f(b, 'B');
  for (let i = 25; i < n; i++) close(a[i], c[i], 1e-9 * Math.abs(a[i]), `第 ${i} 天`);
});

// ---------- 3. 股本的生效日与获知日分开（双时态） ----------
test('3a: report-period equity uses shares effective at the report date, once they are known', () => {
  const dates = dayList(120, Date.UTC(2021, 0, 4));
  const px = dates.map(() => 10);
  const data = { X: { dates, open: px.slice(), close: px.slice(), volume: dates.map(() => 1e5), raw: px.slice() } };
  // 2020-12-31 总股本已是 200，但要到 2021-03-10 年报公告才知道
  const shares = { X: [{ date: '2020-06-30', known: '2020-07-01', total: 100, float: 100 }, { date: '2020-12-31', known: '2021-03-10', total: 200, float: 200 }] };
  const fundamentals = { X: [{ report: '2020-12-31', notice: '2021-03-10', update: '2021-03-10', profit: 100, eps: 0.5, bps: 5 }] };
  const b = new AQ.Backtester(data, { meta: { shares, fundamentals } }).bars();
  const F = R.fundPanel(b, 'X');
  const i = dates.findIndex((d) => d > '2021-03-10');
  close(F.equity[i], 1000, 1e-9, '报告期净资产 = 5 × 200');
  // 公告前市值按已知的 100 股；公告后按 200 股
  const cap = R.marketCap(b, 'X');
  assert.equal(cap[dates.indexOf('2021-03-10')], 1000);
  assert.equal(cap[i], 2000);
});

test('3b: B/P does not jump when bonus shares list after the report date', () => {
  const dates = dayList(200, Date.UTC(2013, 3, 1));
  const ex = '2013-06-20';
  const raw = dates.map((d) => (d < ex ? 16 : 10));
  const data = { X: { dates, open: raw.slice(), close: raw.slice(), volume: dates.map(() => 1e5), raw: raw.slice() } };
  const shares = { X: [{ date: '2012-12-31', known: '2013-03-08', total: 5e9, float: 5e9 }, { date: ex, known: '2013-06-14', total: 8e9, float: 8e9 }] };
  const fundamentals = { X: [{ report: '2012-12-31', notice: '2013-03-08', update: '2013-03-08', profit: 1e10, eps: 2, bps: 16 }] };
  const b = new AQ.Backtester(data, { meta: { shares, fundamentals } }).bars();
  const bp = R.FACTORS.find((q) => q.id === 'bp').f(b, 'X');
  const before = bp[dates.indexOf('2013-06-19')], after = bp[dates.indexOf(ex)];
  close(before, 1, 1e-9, '除权前 B/P');
  close(after, 1, 1e-9, '除权后 B/P 不应放大 1.6 倍');
});

test('data: dividend details and bitemporal share records are parsed', () => {
  const em = require(path.join(docs, 'eastmoney.js'));
  const bonus = em.parseBonus({ result: { data: [
    { EX_DIVIDEND_DATE: '2013-06-20 00:00:00', PRETAX_BONUS_RMB: 1.7, BONUS_IT_RATIO: 6, ASSIGN_PROGRESS: '实施分配' },
    { EX_DIVIDEND_DATE: '2012-10-19 00:00:00', PRETAX_BONUS_RMB: 1, BONUS_IT_RATIO: null, ASSIGN_PROGRESS: '实施分配' },
    { EX_DIVIDEND_DATE: null, PRETAX_BONUS_RMB: 2, BONUS_IT_RATIO: null, ASSIGN_PROGRESS: '董事会预案' },
  ] } });
  assert.deepEqual(bonus, [{ date: '2012-10-19', cash: 0.1, bonus: 0 }, { date: '2013-06-20', cash: 0.17, bonus: 0.6 }]);
  const sh = em.parseShares({ result: { data: [{ END_DATE: '2012-12-31 00:00:00', NOTICE_DATE: '2013-03-08 00:00:00', TOTAL_SHARES: 5123350416, LISTED_A_SHARES: 5e9 }] } });
  assert.equal(sh[0].date, '2012-12-31');
  assert.equal(sh[0].known, '2013-03-08');
});

// ---------- 4. "持有几只"在组合优化模式下也是持仓上限 ----------
test('4: topN caps the number of holdings in optimize mode (40 stocks, topN = 2)', () => {
  const n = 400;
  const dates = dayList(n);
  const data = {};
  for (let k = 0; k < 40; k++) {
    let x = 90 + k, p = 10;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const px = dates.map(() => (p = Math.max(1, p * (1 + 0.0002 * (k - 20) + (rnd() - 0.5) * 0.04))));
    data['6000' + String(k).padStart(2, '0')] = { dates, open: px.slice(), close: px.slice(), volume: dates.map(() => 1e6) };
  }
  const bt = new AQ.Backtester(data, { rebalanceBand: 0 });
  const mk = () => new R.FactorStrategy({ factors: [{ id: 'roc20', weight: 1 }], topN: 2, rebalance: 10, sizing: 'optimize', maxWeight: 10 });
  const b = bt.bars();
  const rows = mk().generate(b.close, bt.dates, bt.symbols, b).filter(Boolean);
  assert.ok(rows.length > 10);
  for (const r of rows) {
    assert.ok(r.filter((w) => w > 0).length <= 2, `目标持仓 ${r.filter((w) => w > 0).length} 只`);
    assert.ok(r.every((w) => w <= 0.1 + 1e-9));
  }
  // 引擎实际持仓也不超过 2 只
  const res = bt.run(mk());
  const held = new Map();
  let maxHeld = 0;
  for (const t of res.trades) {
    held.set(t.symbol, (held.get(t.symbol) || 0) + (t.side === 'buy' ? t.shares : -t.shares));
    maxHeld = Math.max(maxHeld, [...held.values()].filter((v) => v > 0).length);
  }
  assert.ok(maxHeld <= 3, `实际同时持有 ${maxHeld} 只`); // 同一天先买后卖的时间差最多多 1 只
});

// ---------- 6. 影子账户：按冻结分段、从冻结的结算状态接着算 ----------
function paperData(n) {
  const dates = dayList(n);
  const mk = (seed) => { let x = seed, p = 20; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); return dates.map(() => +(p *= 1 + (rnd() - 0.5) * 0.03).toFixed(2)); };
  const data = {};
  for (const [s, seed] of [['600001', 3], ['600002', 4], ['600003', 5]]) { const px = mk(seed); data[s] = { dates, open: px.slice(), close: px.slice(), volume: dates.map(() => 1e6) }; }
  return { dates, data };
}

test('6a: settling in pieces from a frozen state equals one continuous settlement', () => {
  const { dates, data } = paperData(60);
  const eng = { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0 };
  const entries = [
    { date: dates[5], targets: { '600001': 0.5, '600002': 0.5 }, engine: eng },
    { date: dates[30], targets: { '600002': 0.3, '600003': 0.6 }, engine: eng },
  ];
  const full = R.paperReplay(data, entries, {});
  // 截至第 20 天结算并冻结，之后从冻结状态接着算
  const cut = Object.fromEntries(Object.entries(data).map(([s, d]) => [s, { dates: d.dates.slice(0, 21), open: d.open.slice(0, 21), close: d.close.slice(0, 21), volume: d.volume.slice(0, 21) }]));
  const part1 = R.paperReplay(cut, entries, {});
  assert.equal(part1.state.date, dates[20]);
  const part2 = R.paperReplay(data, entries, { snapshot: part1.state });
  assert.equal(part2.dates[0], dates[21]);
  const joined = part1.equity.concat(part2.equity);
  assert.equal(joined.length, full.equity.length);
  joined.forEach((v, i) => close(v, full.equity[i], 1e-6, `第 ${i} 天`));
  assert.equal(part1.trades.length + part2.trades.length, full.trades.length);
});

test('6b: each freeze settles under the execution assumptions saved with it', () => {
  const { dates, data } = paperData(40);
  const cheap = { initialCash: 1e6, fees: {}, slippage: 0, rebalanceBand: 0 };
  const dear = { ...cheap, slippage: 0.01 };
  const entries = [
    { date: dates[3], targets: { '600001': 0.9 }, engine: cheap },
    { date: dates[20], targets: { '600002': 0.9 }, engine: dear },
  ];
  const acct = R.paperReplay(data, entries, {});
  const b1 = acct.trades.find((t) => t.symbol === '600001' && t.side === 'buy');
  const b2 = acct.trades.find((t) => t.symbol === '600002' && t.side === 'buy');
  close(b1.price, data['600001'].open[dates.indexOf(b1.date)], 1e-9, '第一次冻结：无滑点');
  close(b2.price, data['600002'].open[dates.indexOf(b2.date)] * 1.01, 1e-9, '第二次冻结：1% 滑点');
  assert.equal(acct.segments, 2);
});

// ---------- 7. 过拟合检验的对象与优化目标一致 ----------
test('7: PBO picks the in-sample winner by the chosen objective; DSR tests the selected parameters', () => {
  const { data } = paperData(700);
  const input = {
    data, engine: { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0 },
    config: { type: 'rules', rules: [{ id: 'price_ma', params: { n: 20 } }] },
    space: [{ path: 'r0.n', label: 'n', values: [5, 10, 20, 40, 60] }], rf: 0.02,
  };
  for (const objective of ['sharpe', 'cagr', 'sortino']) {
    const r = R.optimize({ ...input, objective });
    assert.equal(r.overfit.pbo.criterion, objective);
    assert.equal(r.overfit.pbo.approx, false);
    assert.equal(r.dsr.target, 'selected');
    close(r.dsr.bestAnnual, r.selected.tr.sharpe, 1e-9, 'DSR 检验的是选定参数的训练集夏普');
  }
  const c = R.optimize({ ...input, objective: 'calmar' });
  assert.equal(c.overfit.pbo.approx, true, '卡玛无法按时间块拼合，必须标明近似');
});

// ---------- 8. 账本：末尾删除要靠链外锚点发现；因子研究计入试验次数 ----------
test('8a: deleting the tail of the ledger is caught against an external anchor', async () => {
  const lg = new L.Ledger({ device: 'dev-a' });
  for (let k = 0; k < 4; k++) await lg.append('backtest', { dataKey: 'k', configHash: 'c' + k });
  const anchor = lg.anchor();
  const cut = lg.entries.slice(0, 3);
  assert.equal((await L.Ledger.verifyEntries(cut)).ok, true, '没有锚点时，删掉末尾的链仍然自洽（这是哈希链本身的局限）');
  const v = await L.Ledger.verifyEntries(cut, { anchors: anchor });
  assert.equal(v.ok, false);
  assert.match(v.broken[0].reason, /末尾/);
  assert.equal((await L.Ledger.verifyEntries(lg.entries, { anchors: anchor })).ok, true);
});

test('8b: factor-research views count as trials on that data', async () => {
  const lg = new L.Ledger({ device: 'dev-b' });
  await lg.append('backtest', { dataKey: 'k', configHash: 'c1' });
  await lg.append('research', { dataKey: 'k', views: ['ic|roc20|h5|none', 'ic|roc60|h5|none'] });
  await lg.append('research', { dataKey: 'k', views: ['ic|roc20|h5|none', 'quantile|roc20|h5|none'] });
  const st = lg.stats('k');
  assert.equal(st.researchViews, 3, '同一视图不重复计');
  assert.equal(st.trials, 1 + 3);
});

test('6c: resuming after the source revised the last settled close is reported', () => {
  const { dates, data } = paperData(40);
  const eng = { initialCash: 1e6, fees: {}, slippage: 0, rebalanceBand: 0 };
  const entries = [{ date: dates[5], targets: { '600001': 0.9 }, engine: eng }];
  const cut = { '600001': Object.fromEntries(Object.entries(data['600001']).map(([k, v]) => [k, v.slice(0, 21)])) };
  const part1 = R.paperReplay(cut, entries, {});
  assert.ok(part1.state.marks['600001'] > 0, '期末估值价格一并冻结');
  assert.equal(R.paperReplay(data, entries, { snapshot: part1.state }).revisions.length, 0);
  const revised = { '600001': { ...data['600001'], close: data['600001'].close.map((v, i) => (i === 20 ? v * 1.2 : v)) } };
  const r = R.paperReplay(revised, entries, { snapshot: part1.state });
  assert.equal(r.revisions.length, 1);
  close(r.revisions[0].now / r.revisions[0].frozen, 1.2, 1e-9);
});
