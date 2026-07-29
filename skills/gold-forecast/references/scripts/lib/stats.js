'use strict';

// Acklam 逆正态近似,绝对误差 < 1.15e-9,足够定区间与算 p 值。
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
           1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
           6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
           -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

function normInv(p) {
  if (p <= 0 || p >= 1) throw new Error('normInv 参数须在 (0,1)');
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
         / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
       / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

// 标准正态 CDF,用 erf 的 Abramowitz-Stegun 近似
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

function solve(M, v) {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    [a[i], a[piv]] = [a[piv], a[i]];
    if (Math.abs(a[i][i]) < 1e-12) throw new Error('矩阵奇异,无法求解');
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c <= n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

// IRLS。ridge 项防止线性可分时系数发散。
function fitLogistic(X, y, { iters = 50, ridge = 1e-6 } = {}) {
  const n = X.length, k = X[0].length + 1;
  const Z = X.map((row) => [1, ...row]);
  let beta = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    const g = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const eta = Z[i].reduce((s, z, j) => s + z * beta[j], 0);
      const p = 1 / (1 + Math.exp(-eta));
      const w = Math.max(p * (1 - p), 1e-8);
      for (let a2 = 0; a2 < k; a2++) {
        g[a2] += Z[i][a2] * (y[i] - p);
        for (let b2 = 0; b2 < k; b2++) H[a2][b2] += Z[i][a2] * Z[i][b2] * w;
      }
    }
    for (let j = 0; j < k; j++) { H[j][j] += ridge; g[j] -= ridge * beta[j]; }
    const step = solve(H, g);
    beta = beta.map((b, j) => b + step[j]);
    if (step.every((s) => Math.abs(s) < 1e-10)) break;
  }
  return beta;
}

function predictLogistic(beta, x) {
  const eta = [1, ...x].reduce((s, z, j) => s + z * beta[j], 0);
  return 1 / (1 + Math.exp(-eta));
}

// Newey-West:重叠窗口使损失差高度自相关,忽略它会低估方差、把噪声判成显著。
function neweyWestVar(d, lag) {
  const n = d.length;
  const m = d.reduce((a, b) => a + b, 0) / n;
  const gamma = (h) => {
    let s = 0;
    for (let t = h; t < n; t++) s += (d[t] - m) * (d[t - h] - m);
    return s / n;
  };
  let v = gamma(0);
  for (let h = 1; h <= lag; h++) v += 2 * (1 - h / (lag + 1)) * gamma(h);
  return v / n;
}

function dieboldMariano(lossA, lossB, { lag = 0 } = {}) {
  const d = lossA.map((a, i) => a - lossB[i]);
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const v = neweyWestVar(d, lag);
  const stat = v > 0 ? m / Math.sqrt(v) : 0;
  return { stat, p: 2 * (1 - normCdf(Math.abs(stat))) };
}

module.exports = { normInv, normCdf, solve, fitLogistic, predictLogistic, neweyWestVar, dieboldMariano };
