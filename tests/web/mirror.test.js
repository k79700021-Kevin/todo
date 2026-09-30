/* 行情镜像：数据源解析（腾讯日线、基金 F10 分红拆分）、构建脚本的合并规则、网页读镜像的路径。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const docs = path.join(__dirname, '..', '..', 'docs');
const M = require(path.join(docs, 'mirror.js'));
const em = require(path.join(docs, 'eastmoney.js'));
const pool = require(path.join(docs, 'stockpool.js'));
const B = require(path.join(__dirname, '..', '..', 'tools', 'build_market_data.js'));

test('tencent symbols and url', () => {
  assert.equal(M.tencentSymbol('600000'), 'sh600000');
  assert.equal(M.tencentSymbol('510300'), 'sh510300');
  assert.equal(M.tencentSymbol('000333'), 'sz000333');
  assert.equal(M.tencentSymbol('159915'), 'sz159915');
  assert.equal(M.tencentSymbol('830799'), 'bj830799');
  assert.equal(M.tencentIndexSymbol('000300'), 'sh000300');
  assert.equal(M.tencentIndexSymbol('399006'), 'sz399006');
  assert.match(M.tencentKlineUrl('sz000333', '2020-01-01', '2020-12-31'), /^https:\/\/web\.ifzq\.gtimg\.cn\/.*param=sz000333,day,2020-01-01,2020-12-31,2000,$/);
  assert.match(M.tencentKlineUrl('sz000333', 'a', 'b', 2000, 1), /^https:\/\/ifzq\.gtimg\.cn\//);
});

test('parseTencent: bars, name, ex-date events', () => {
  const json = { code: 0, data: { sz000333: {
    day: [
      ['2014-04-29', '60.00', '61.00', '62.00', '59.00', '1000.000'],
      ['2014-04-30', '37.00', '37.50', '38.00', '36.50', '2000.000', { nd: '2013', fh_sh: '10', djr: '2014-04-29', cqr: '2014-04-30', FHcontent: '10派20元转15股' }],
      ['2014-05-02', '0', '0', '0', '0', '0'],
    ],
    qt: { sz000333: ['51', '美的集团', '000333'] },
  } } };
  const p = M.parseTencent(json, 'sz000333');
  assert.deepEqual(p.dates, ['2014-04-29', '2014-04-30']);
  assert.deepEqual(p.close, [61, 37.5]);
  assert.deepEqual(p.high, [62, 38]);
  assert.deepEqual(p.volume, [1000, 2000]);
  assert.equal(p.name, '美的集团');
  assert.deepEqual(p.events, [{ date: '2014-04-30', cash: 2, bonus: 1.5 }]);
  assert.deepEqual(M.parseTencent({ data: {} }, 'sz000333').dates, []);
});

test('parseDividendText', () => {
  assert.deepEqual(M.parseDividendText('10派17.0089元'), { cash: 1.70089, bonus: 0 });
  assert.deepEqual(M.parseDividendText('10送6转2派1.7元'), { cash: 0.17, bonus: 0.8 });
  assert.deepEqual(M.parseDividendText('10转增3股'), { cash: 0, bonus: 0.3 });
  assert.deepEqual(M.parseDividendText('10送5转5'), { cash: 0, bonus: 1 });
  assert.equal(M.parseDividendText('现金分红'), null);
});

test('parseFundEvents: dividends on ex-date, splits effective the next day', () => {
  const html = `<table><tr><td>2024年</td><td>2024-05-16</td><td>2024-05-17</td><td>每10份派现金0.8700元</td><td>2024-05-23</td></tr></table>
    <table><tr><td>2022年</td><td>2022-08-26</td><td>份额分拆</td><td>1:1.1454</td></tr>
    <tr><td>2015年</td><td>2015-04-14</td><td>份额折算</td><td>1:0.2803</td></tr></table>`;
  assert.deepEqual(M.parseFundEvents(html), [
    { date: '2015-04-15', cash: 0, bonus: -0.7197 },
    { date: '2022-08-27', cash: 0, bonus: 0.1454 },
    { date: '2024-05-17', cash: 0.087, bonus: 0 },
  ]);
});

test('a share split lands on the first trading day after the conversion date', () => {
  // 周五折算 1:2，周一价格减半：复权后没有跳变
  const raw = { dates: ['2022-08-25', '2022-08-26', '2022-08-29'], open: [10, 10, 5], high: [10, 10, 5], low: [10, 10, 5], close: [10, 10, 5], volume: [1, 1, 1] };
  const ev = M.parseFundEvents('<td>2022-08-26</td><td>份额分拆</td><td>1:2</td>');
  const a = em.adjustFromEvents(raw, ev, '510500');
  assert.deepEqual(a.close, [5, 5, 5]);
  assert.deepEqual(a.raw, [10, 10, 5]);
});

test('mergeBars / mergeEvents / dropIntraday', () => {
  const a = { dates: ['2024-01-02', '2024-01-03'], open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [10, 20] };
  const b = { dates: ['2024-01-03', '2024-01-04'], open: [3, 4], high: [3, 4], low: [3, 4], close: [3, 4], volume: [30, 40] };
  const m = M.mergeBars(a, b);
  assert.deepEqual(m.dates, ['2024-01-02', '2024-01-03', '2024-01-04']);
  assert.deepEqual(m.close, [1, 3, 4]);
  assert.deepEqual(M.mergeBars(null, a).close, [1, 2]);
  assert.deepEqual(B.mergeEvents([{ date: '2020-01-01', cash: 1 }], [{ date: '2019-01-01', cash: 2 }, { date: '2020-01-01', cash: 3 }]),
    [{ date: '2019-01-01', cash: 2 }, { date: '2020-01-01', cash: 3 }]);
  // 收盘前：当天的日线（包括旧记录里残留的）去掉；收盘后保留
  assert.deepEqual(B.dropIntraday(M.mergeBars(null, m), '2024-01-04', 10).dates, ['2024-01-02', '2024-01-03']);
  assert.deepEqual(B.dropIntraday(M.mergeBars(null, m), '2024-01-04', 17).dates, m.dates);
});

test('toBars: qfq / hfq / none / index', () => {
  const rec = { v: 1, code: '600000', kind: 'stock', name: 'x', ca: [{ date: '2024-01-03', cash: 1, bonus: 0 }],
    bars: { dates: ['2024-01-02', '2024-01-03'], open: [10, 9], high: [10, 9], low: [10, 9], close: [10, 9], volume: [1, 1] } };
  const q = M.toBars(rec, 'qfq');
  assert.deepEqual(q.close, [9, 9]);
  assert.deepEqual(q.raw, [10, 9]);
  assert.deepEqual(M.toBars(rec, 'hfq').close, [10, 10]);
  assert.deepEqual(M.toBars(rec, 'none').close, [10, 9]);
  assert.deepEqual(M.toBars({ ...rec, kind: 'index' }, 'qfq').close, [10, 9]);
});

test('stock pool reads the mirror first and trims to the requested window', async () => {
  const rec = { v: 1, code: '600000', kind: 'stock', name: '浦发银行', ca: [{ date: '2024-01-03', cash: 1, bonus: 0 }], fin: [{ a: 1 }], shares: [{ b: 2 }],
    bars: { dates: ['2023-12-29', '2024-01-02', '2024-01-03'], open: [11, 10, 9], high: [11, 10, 9], low: [11, 10, 9], close: [11, 10, 9], volume: [1, 1, 1] } };
  const seen = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => rec }; };
  try {
    const r = await pool.fetchStock('600000', '2024-01-01', '2024-01-31');
    assert.equal(seen[0], M.MIRROR_BASE + 'stocks/600000.json');
    assert.equal(r.source, 'mirror');
    assert.equal(r.v, pool.VERSION);
    assert.equal(r.bars.adj, 'events');
    assert.deepEqual(r.bars.dates, ['2024-01-02', '2024-01-03']);
    assert.deepEqual(r.bars.close, [9, 9]);
    assert.deepEqual(r.bars.raw, [10, 9]);
    assert.deepEqual([r.fin, r.shares, r.ca, r.name, r.mirrorDate], [rec.fin, rec.shares, rec.ca, '浦发银行', '2024-01-03']);
    const a = pool.assemble({ members: { '600000': [['2023-01-01', null]] } }, { '600000': r }, '2024-01-01', '2024-01-31');
    assert.equal(a.coverage.mirror, 1);
    assert.equal(a.coverage.mirrorDate, '2024-01-03');
    // 格式不对的记录不能用
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...rec, v: 99 }) });
    await assert.rejects(M.load('600000'), /格式不对/);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(M.load('600000'), /镜像里没有/);
  } finally {
    globalThis.fetch = old;
  }
});
