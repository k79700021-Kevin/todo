// 真实行情冒烟测试：用网页同一份代码请求东方财富，校验数据，并在真实数据上跑一遍回测、优化与因子分析。
// 用法：node tools/data_smoke.js [输出 JSON 路径]；由 .github/workflows/data-smoke.yml 在 GitHub Actions 上运行。
'use strict';
const fs = require('fs');
const path = require('path');
const docs = path.join(__dirname, '..', 'docs');
const em = require(path.join(docs, 'eastmoney.js'));
const AQ = require(path.join(docs, 'engine.js'));
const { RuleStrategy } = require(path.join(docs, 'rules.js'));
const R = require(path.join(docs, 'research.js'));

// 覆盖沪市 ETF、深市 ETF、沪市主板、创业板、科创板
const SYMBOLS = ['510300', '510500', '159915', '600519', '300750', '688981'];
const START = '2016-01-01';
const END = new Date().toISOString().slice(0, 10);
const BASE = process.env.EM_BASE; // 测试时可指向本地假服务

async function fetchOne(sym) {
  const cb = 'cb_' + sym;
  let url = em.klineUrl(sym, START, END, 'qfq', cb);
  if (BASE) url = url.replace('https://push2his.eastmoney.com', BASE);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
      const text = await res.text();
      const m = text.match(new RegExp(`^\\s*${cb}\\(([\\s\\S]*)\\);?\\s*$`));
      if (!m) throw new Error(`返回不是预期的 JSONP：${text.slice(0, 120)}`);
      return em.parseKlines(JSON.parse(m[1]), sym);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function check(sym, d) {
  const n = d.dates.length;
  if (n < 250) throw new Error(`${sym}：只有 ${n} 天数据`);
  for (let i = 0; i < n; i++) {
    if (i && d.dates[i] <= d.dates[i - 1]) throw new Error(`${sym}：日期未严格递增 @${d.dates[i]}`);
    const o = d.open[i], c = d.close[i], h = d.high[i], l = d.low[i];
    if (![o, c, h, l, d.volume[i]].every(Number.isFinite)) throw new Error(`${sym}：非数值 @${d.dates[i]}`);
    if (h + 1e-6 < Math.max(o, c) || l - 1e-6 > Math.min(o, c)) throw new Error(`${sym}：高低价不包含开收盘 @${d.dates[i]}`);
  }
  return `${sym}: ${n} 天，${d.dates[0]} ~ ${d.dates[n - 1]}，最新收盘 ${d.close[n - 1]}`;
}

(async () => {
  const lines = ['## 真实行情冒烟测试', ''];
  const data = {};
  for (const s of SYMBOLS) {
    data[s] = await fetchOne(s);
    lines.push('- ' + check(s, data[s]));
  }

  const bt = new AQ.Backtester(data, {});
  const cfg = { rules: [{ id: 'macd' }, { id: 'price_ma', params: { n: 60 } }], stopLoss: 10 };
  const m = AQ.summarize(bt.run(new RuleStrategy(cfg)));
  const b = AQ.summarize(bt.run(new AQ.BuyAndHold()));
  const pct = (v) => (v * 100).toFixed(2) + '%';
  lines.push('', `**回测** MACD + 60 日均线 + 10% 止损：年化 ${pct(m.cagr)}，夏普 ${m.sharpe.toFixed(2)}，最大回撤 ${pct(m.max_drawdown)}，${m.trades} 笔；基准年化 ${pct(b.cagr)}`);

  const opt = R.optimize({
    data, engine: { initialCash: 1e6, fees: {}, slippage: 0.0005, rebalanceBand: 0.01 }, config: cfg,
    space: [{ path: 'r1.n', label: '均线天数', values: [20, 60, 120] }, { path: 'r0.fast', label: '快线', values: [8, 12] }],
    method: 'grid', objective: 'sharpe', minTrades: 5,
    wf: { enabled: true, trainYears: 3, testYears: 1 },
  });
  lines.push(`**优化** ${opt.trials} 组，样本内最优夏普 ${opt.top[0].is.sharpe.toFixed(2)}，样本外 ${opt.top[0].oos.sharpe.toFixed(2)}，` +
    `真实夏普>0 概率 ${pct(opt.dsr.prob)}；滚动前推 ${opt.wf.windows.length} 个窗口，样本外年化 ${pct(opt.wf.stats.cagr)}`);

  const ic = R.factorIC(bt, 5);
  lines.push('', '**因子 IC（未来 5 日）**', '', '| 因子 | 时序 IC | t | 截面 IC | t |', '|---|---|---|---|---|');
  for (const f of ic) lines.push(`| ${f.label} | ${f.tsIC.toFixed(3)} | ${f.tsT.toFixed(2)} | ${f.csIC.toFixed(3)} | ${f.csT.toFixed(2)} |`);

  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(data));
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
