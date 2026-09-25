/* 风险模型与组合优化：Ledoit–Wolf 收缩协方差、带约束的均值-方差优化、风险贡献分解。
 * 全部为纯函数，浏览器与 Node 共用。 */
(function (root) {
  'use strict';

  const fin = Number.isFinite;

  /* Ledoit & Wolf (2004) "Honey, I Shrunk the Sample Covariance Matrix"：向常相关矩阵收缩。
   * X：T 行 × N 列的日收益（已去掉缺失行或以 0 填补；调用方应先剔除方差为 0 的列，如整段停牌）。返回 { cov: N×N（行主序 Float64Array）, shrink, avgCorr }。 */
  function ledoitWolf(X) {
    const T = X.length, N = X[0].length;
    const mean = new Float64Array(N);
    for (const row of X) for (let i = 0; i < N; i++) mean[i] += row[i] / T;
    const Y = X.map((row) => Float64Array.from(row, (v, i) => v - mean[i]));
    const S = new Float64Array(N * N);
    for (const y of Y) for (let i = 0; i < N; i++) { const yi = y[i]; for (let j = i; j < N; j++) S[i * N + j] += (yi * y[j]) / T; }
    for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) S[i * N + j] = S[j * N + i];
    const sd = Float64Array.from({ length: N }, (_, i) => Math.sqrt(Math.max(S[i * N + i], 1e-18)));
    let rbar = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) rbar += S[i * N + j] / (sd[i] * sd[j]);
    rbar = N > 1 ? (2 * rbar) / (N * (N - 1)) : 0;
    const F = new Float64Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) F[i * N + j] = i === j ? S[i * N + i] : rbar * sd[i] * sd[j];
    // π：样本协方差估计误差的渐近方差之和；ρ：与目标的协方差项；γ：目标与样本的距离
    let pi = 0, rho = 0, gamma = 0;
    const thetaII = new Float64Array(N * N), thetaJJ = new Float64Array(N * N);
    for (const y of Y) {
      for (let i = 0; i < N; i++) {
        const yi = y[i], sii = S[i * N + i], di = yi * yi - sii;
        for (let j = 0; j < N; j++) {
          const e = yi * y[j] - S[i * N + j];
          pi += (e * e) / T;
          thetaII[i * N + j] += (di * e) / T;
          const djj = y[j] * y[j] - S[j * N + j];
          thetaJJ[i * N + j] += (djj * e) / T;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      let piii = 0;
      for (const y of Y) { const e = y[i] * y[i] - S[i * N + i]; piii += (e * e) / T; }
      rho += piii;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const sii = Math.max(S[i * N + i], 1e-18), sjj = Math.max(S[j * N + j], 1e-18);
        rho += (rbar / 2) * (Math.sqrt(sjj / sii) * thetaII[i * N + j] + Math.sqrt(sii / sjj) * thetaJJ[i * N + j]);
      }
    }
    for (let k = 0; k < N * N; k++) gamma += (F[k] - S[k]) ** 2;
    const kappa = gamma > 0 ? (pi - rho) / gamma : 0;
    const shrink = Math.max(0, Math.min(1, kappa / T));
    const cov = new Float64Array(N * N);
    for (let k = 0; k < N * N; k++) cov[k] = shrink * F[k] + (1 - shrink) * S[k];
    return { cov, shrink, avgCorr: rbar, n: N };
  }

  function matVec(A, x, N) {
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += A[i * N + j] * x[j]; out[i] = s; }
    return out;
  }

  function spectralNorm(A, N) {
    let v = new Float64Array(N).fill(1 / Math.sqrt(N)), lam = 0;
    for (let it = 0; it < 50; it++) {
      const w = matVec(A, v, N);
      const nrm = Math.sqrt(w.reduce((a, x) => a + x * x, 0)) || 1;
      lam = nrm;
      v = w.map((x) => x / nrm);
    }
    return lam;
  }

  /* 近端算子：min ½‖w − v‖² + t·κ‖w − w0‖₁，s.t. 0 ≤ w ≤ cap，Σw = budget。
   * 对预算约束的乘子 τ，每个分量的解是"向 w0 软阈值后截断到 [0, cap]"，Σw(τ) 随 τ 单调递减，二分求解。 */
  function proxCappedSimplex(v, w0, tk, cap, budget) {
    const N = v.length;
    const at = (tau) => {
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const u = v[i] - tau, d = u - w0[i];
        let x = Math.abs(d) <= tk ? w0[i] : d > 0 ? u - tk : u + tk;
        out[i] = Math.min(cap, Math.max(0, x));
      }
      return out;
    };
    const sum = (w) => w.reduce((a, x) => a + x, 0);
    let lo = Math.min(...v) - cap - tk - 1, hi = Math.max(...v) + tk + 1;
    for (let it = 0; it < 80; it++) {
      const mid = (lo + hi) / 2;
      if (sum(at(mid)) > budget) lo = mid; else hi = mid;
    }
    return at((lo + hi) / 2);
  }

  /* 均值-方差优化（FISTA 近端梯度）：
   *   max  αᵀw − λ·wᵀΣw − κ·‖w − w0‖₁ − ρ·Σ_g (Σ_{i∈g} w_i − b_g)²
   *   s.t. 0 ≤ w_i ≤ cap，Σ w_i = budget
   * alpha、Σ 需为同一持有期的量。groups[i] 为行业（可选），bench[g] 为基准行业权重。 */
  function optimize({ alpha, cov, w0, lambda = 10, kappa = 0, cap = 1, budget = 1, groups = null, bench = null, rho = 0, iters = 400 }) {
    const N = alpha.length;
    if (!N) return new Float64Array(0);
    const capEff = Math.max(cap, budget / N + 1e-12);
    w0 = w0 || new Float64Array(N);
    const gIdx = groups ? [...new Set(groups)] : [];
    const gOf = groups ? groups.map((g) => gIdx.indexOf(g)) : null;
    const b = gIdx.map((g) => (bench && bench[g]) || 0);
    let maxGroup = 0;
    if (groups) for (let g = 0; g < gIdx.length; g++) maxGroup = Math.max(maxGroup, groups.filter((x) => x === gIdx[g]).length);
    const L = 2 * lambda * spectralNorm(cov, N) + 2 * rho * maxGroup + 1e-12;
    const step = 1 / L;
    const grad = (w) => {
      const Sw = matVec(cov, w, N);
      const g = Float64Array.from(alpha, (a, i) => -a + 2 * lambda * Sw[i]);
      if (rho > 0 && groups) {
        const dev = new Float64Array(gIdx.length);
        for (let i = 0; i < N; i++) dev[gOf[i]] += w[i];
        for (let k = 0; k < dev.length; k++) dev[k] -= b[k];
        for (let i = 0; i < N; i++) g[i] += 2 * rho * dev[gOf[i]];
      }
      return g;
    };
    let w = proxCappedSimplex(Float64Array.from(w0), w0, 0, capEff, budget);
    let z = w, tk = 1;
    for (let it = 0; it < iters; it++) {
      const g = grad(z);
      const v = Float64Array.from(z, (x, i) => x - step * g[i]);
      const wn = proxCappedSimplex(v, w0, step * kappa, capEff, budget);
      const tn = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
      z = Float64Array.from(wn, (x, i) => x + ((tk - 1) / tn) * (x - w[i]));
      let diff = 0;
      for (let i = 0; i < N; i++) diff = Math.max(diff, Math.abs(wn[i] - w[i]));
      w = wn; tk = tn;
      if (diff < 1e-9) break;
    }
    return w;
  }

  /* 风险分解：组合 w 与基准 wb（同一标的顺序）在协方差 Σ 下的波动、跟踪误差，
   * 以及每只标的对跟踪误差方差的贡献（合计 = 1），可按 groups 汇总。 */
  function riskDecomposition(cov, w, wb, groups) {
    const N = w.length;
    const act = Float64Array.from(w, (x, i) => x - (wb ? wb[i] : 0));
    const quad = (x) => { const y = matVec(cov, x, N); return { v: x.reduce((a, xi, i) => a + xi * y[i], 0), y }; };
    const p = quad(w), a = quad(act);
    const bvar = wb ? quad(Float64Array.from(wb)).v : NaN;
    const contrib = Float64Array.from(act, (x, i) => (a.v > 0 ? (x * a.y[i]) / a.v : 0));
    const byGroup = {};
    if (groups) contrib.forEach((c, i) => { byGroup[groups[i]] = (byGroup[groups[i]] || 0) + c; });
    return { vol: Math.sqrt(Math.max(p.v, 0)), benchVol: Math.sqrt(Math.max(bvar, 0)), te: Math.sqrt(Math.max(a.v, 0)), contrib, byGroup };
  }

  const api = { ledoitWolf, optimize, proxCappedSimplex, riskDecomposition, matVec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).portfolio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
