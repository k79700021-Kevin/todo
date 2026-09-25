const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require(path.join(__dirname, '..', '..', 'docs', 'portfolio.js'));

function returns(T, N, seed, corr = 0.3) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  return Array.from({ length: T }, () => { const m = g(); return Array.from({ length: N }, (_, i) => 0.01 * (1 + i / N) * (Math.sqrt(corr) * m + Math.sqrt(1 - corr) * g())); });
}

// 两个板块：板块内相关 0.7，板块间约 0（常相关目标不是真实结构，数据多时应少收缩）
function sectors(T, N, seed) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  return Array.from({ length: T }, () => { const a = g(), b = g(); return Array.from({ length: N }, (_, i) => 0.01 * (Math.sqrt(0.7) * (i < N / 2 ? a : b) + Math.sqrt(0.3) * g())); });
}

test('Ledoit–Wolf: symmetric, positive diagonal, shrinks more with fewer observations', () => {
  const few = P.ledoitWolf(sectors(40, 30, 3)), many = P.ledoitWolf(sectors(2000, 30, 3));
  assert.ok(P.ledoitWolf(returns(2000, 30, 3)).shrink > 0.8, '真实结构就是常相关时应大幅收缩');
  const N = 30;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) assert.ok(Math.abs(few.cov[i * N + j] - few.cov[j * N + i]) < 1e-15);
  assert.ok(few.shrink > many.shrink, `${few.shrink} vs ${many.shrink}`);
  assert.ok(few.shrink > 0 && few.shrink <= 1);
  assert.ok(many.shrink < 0.2, `数据充足时收缩 ${many.shrink}`);
});

test('capped-simplex prox satisfies budget and bounds', () => {
  const w = P.proxCappedSimplex(Float64Array.from([0.9, 0.5, -0.2, 0.1]), new Float64Array(4), 0, 0.4, 1);
  assert.ok(Math.abs(w.reduce((a, x) => a + x, 0) - 1) < 1e-9);
  assert.ok(w.every((x) => x >= -1e-12 && x <= 0.4 + 1e-12));
});

test('optimizer: tilts to alpha, respects caps, turnover penalty keeps old weights, industry penalty neutralizes', () => {
  const lw = P.ledoitWolf(returns(500, 6, 9, 0.2));
  const alpha = Float64Array.from([0.01, 0.008, 0, 0, -0.005, 0]);
  const w = P.optimize({ alpha, cov: lw.cov, lambda: 5, cap: 0.4 });
  assert.ok(Math.abs(w.reduce((a, x) => a + x, 0) - 1) < 1e-6);
  assert.ok(w.every((x) => x <= 0.4 + 1e-9 && x >= -1e-12));
  assert.ok(w[0] > w[4] && w[1] > w[4], JSON.stringify(Array.from(w)));
  // 很高的换手惩罚：几乎不动
  const w0 = Float64Array.from([0, 0, 0.5, 0.5, 0, 0]);
  const stay = P.optimize({ alpha, cov: lw.cov, lambda: 5, cap: 1, w0, kappa: 1 });
  assert.ok(Math.abs(stay[2] - 0.5) < 1e-3 && Math.abs(stay[3] - 0.5) < 1e-3, JSON.stringify(Array.from(stay)));
  // 行业惩罚：两个行业各 50%
  const groups = ['a', 'a', 'b', 'b', 'b', 'b'];
  const neu = P.optimize({ alpha, cov: lw.cov, lambda: 5, cap: 1, groups, bench: { a: 0.5, b: 0.5 }, rho: 1e4 });
  assert.ok(Math.abs(neu[0] + neu[1] - 0.5) < 0.01, JSON.stringify(Array.from(neu)));
});

test('risk decomposition: contributions sum to one and portfolio equal to benchmark has zero tracking error', () => {
  const lw = P.ledoitWolf(returns(300, 5, 4));
  const w = Float64Array.from([0.4, 0.3, 0.3, 0, 0]), wb = Float64Array.from([0.2, 0.2, 0.2, 0.2, 0.2]);
  const r = P.riskDecomposition(lw.cov, w, wb, ['x', 'x', 'y', 'y', 'z']);
  assert.ok(Math.abs(r.contrib.reduce((a, x) => a + x, 0) - 1) < 1e-9);
  assert.ok(Math.abs(Object.values(r.byGroup).reduce((a, x) => a + x, 0) - 1) < 1e-9);
  assert.ok(r.te > 0 && r.vol > 0);
  assert.ok(P.riskDecomposition(lw.cov, wb, wb).te < 1e-12);
});

test('Ledoit–Wolf stays finite when a column has zero variance', () => {
  const X = returns(200, 5, 8).map((r) => [...r, 0]);
  const lw = P.ledoitWolf(X);
  assert.ok(Number.isFinite(lw.shrink) && Array.from(lw.cov).every(Number.isFinite));
});
