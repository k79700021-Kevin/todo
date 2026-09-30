// 行情镜像构建：由 .github/workflows/market-data.yml 每个交易日收盘后运行，结果推送到 market-data 分支（见 docs/mirror.js）。
// 用法：node tools/build_market_data.js --out <目录> [--codes 000333,510300] [--full] [--refresh-fundamentals] [--limit N]
// 增量：已有记录只取最近几周的日线合并；财务、股本、分红送配每 7 天刷新一次（--refresh-fundamentals 强制刷新）。
// 取数失败的标的保留原记录不动，失败清单写进 manifest.json。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const em = require(path.join(ROOT, 'docs', 'eastmoney.js'));
const M = require(path.join(ROOT, 'docs', 'mirror.js'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes(k);
const OUT = arg('--out', path.join(ROOT, 'market-data'));
const FULL = flag('--full');
const REFRESH = flag('--refresh-fundamentals');
const LIMIT = +arg('--limit', 0);
const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京时间
const HISTORY_FROM = '2004-01-01';
// 网页预设里的 ETF（大类资产、行业）与指数
const ETFS = ['510300', '510500', '159915', '518880', '511260', '512880', '512800', '512010', '512690', '515030', '512480', '512660', '159928', '512400', '515790', '512170', '515880'];
const INDEXES = ['000300'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// url 可以是函数 (第几次尝试) => 地址，用来在重试时轮换域名
async function get(url, { referer, json = true } = {}) {
  let last;
  for (let a = 1; a <= 6; a++) {
    try {
      const r = await fetch(typeof url === 'function' ? url(a - 1) : url, { headers: { ...HEADERS, ...(referer ? { Referer: referer } : {}) } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = json ? await r.json() : await r.text();
      await sleep(250);
      return body;
    } catch (e) {
      last = e;
      await sleep(1500 * a);
    }
  }
  throw last;
}

const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// 按区间分段取完整日线（每段约 7 年，腾讯每次最多 2000 行）
async function fetchBars(symbol, from, to) {
  let bars = null, name;
  const events = [];
  for (let a = from; a <= to; a = addDays(a, 2555)) {
    const b = addDays(a, 2554) < to ? addDays(a, 2554) : to;
    const part = M.parseTencent(await get((k) => M.tencentKlineUrl(symbol, a, b, 2000, k), { referer: 'https://gu.qq.com/' }), symbol);
    if (part.name) name = part.name;
    events.push(...part.events);
    bars = M.mergeBars(bars, part);
  }
  return { bars, name, events };
}

// 收盘前运行时丢掉当天尚未走完的日线（北京时间 16:00 前）；在与旧记录合并之后做，旧记录里残留的当天日线也一并去掉
function dropIntraday(bars, today = TODAY, hourCST = new Date(Date.now() + 8 * 3600e3).getUTCHours()) {
  while (bars.dates.length && bars.dates[bars.dates.length - 1] >= today && hourCST < 16) {
    for (const k of ['dates', 'open', 'high', 'low', 'close', 'volume']) bars[k].pop();
  }
  return bars;
}

// 合并两组分红送转事件（按日期去重，后者优先）
function mergeEvents(a, b) {
  const m = new Map();
  for (const e of [...(a || []), ...(b || [])]) m.set(e.date, e);
  return [...m.values()].sort((x, y) => (x.date < y.date ? -1 : 1));
}

async function fundamentals(code, kind) {
  if (kind === 'etf') return { ca: M.parseFundEvents(await get(M.fundDividendUrl(code), { referer: 'https://fund.eastmoney.com/', json: false })) };
  const fin = em.parseFinance(await get(em.financeUrl(code), { referer: 'https://data.eastmoney.com/' }));
  const shares = em.parseShares(await get(em.sharesUrl(code), { referer: 'https://data.eastmoney.com/' }));
  const ca = em.parseBonus(await get(em.bonusUrl(code), { referer: 'https://data.eastmoney.com/' }));
  return { fin, shares, ca };
}

function readRec(code) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'stocks', code + '.json'), 'utf8')); } catch (e) { return null; }
}

async function buildOne(code, kind) {
  const old = FULL ? null : readRec(code);
  const symbol = kind === 'index' ? M.tencentIndexSymbol(code) : M.tencentSymbol(code);
  const lastDate = old && old.bars && old.bars.dates.length ? old.bars.dates[old.bars.dates.length - 1] : null;
  const from = lastDate ? addDays(lastDate, -30) : HISTORY_FROM;
  const got = await fetchBars(symbol, from, TODAY);
  const bars = dropIntraday(M.mergeBars(old && old.bars, got.bars));
  if (!bars.dates.length) throw new Error('没有日线');
  if (old && bars.dates.length < old.bars.dates.length) throw new Error('新数据比原记录短，放弃覆盖');
  const rec = {
    v: M.FORMAT, code, kind, name: got.name || (old && old.name) || '', updated: TODAY,
    source: { bars: 'tencent', fundamentals: kind === 'etf' ? 'eastmoney-fund-f10' : kind === 'index' ? null : 'eastmoney-datacenter' },
    bars, ca: (old && old.ca) || [], fin: (old && old.fin) || [], shares: (old && old.shares) || [], fundUpdated: old && old.fundUpdated,
    // 腾讯日线里附带的分红送转（数据中心没有记录时的备用来源，例如已退市公司）
    txEvents: mergeEvents(old && old.txEvents, got.events),
  };
  const stale = !rec.fundUpdated || addDays(rec.fundUpdated, 7) <= TODAY;
  if (kind !== 'index' && (REFRESH || FULL || stale)) {
    const f = await fundamentals(code, kind);
    Object.assign(rec, f, { fundUpdated: TODAY });
  }
  if (kind === 'stock' && !rec.ca.length && rec.txEvents.length) { rec.ca = rec.txEvents; rec.source.events = 'tencent'; }
  fs.writeFileSync(path.join(OUT, 'stocks', code + '.json'), JSON.stringify(rec));
  return rec;
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'stocks'), { recursive: true });
  const members = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'hs300_members.json'), 'utf8'));
  let list = [...Object.keys(members.members).map((c) => [c, 'stock']), ...ETFS.map((c) => [c, 'etf']), ...INDEXES.map((c) => [c, 'index'])];
  const only = arg('--codes', '');
  if (only) { const set = new Set(only.split(',')); list = list.filter(([c]) => set.has(c)).concat([...set].filter((c) => !list.some(([x]) => x === c)).map((c) => [c, /^(5|15|16)/.test(c) ? 'etf' : 'stock'])); }
  if (LIMIT) list = list.slice(0, LIMIT);
  let manifestOld = {};
  try { manifestOld = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')); } catch (e) { /* 首次构建 */ }
  const codes = { ...(manifestOld.codes || {}) };
  const failed = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < list.length) {
      const [code, kind] = list[next++];
      try {
        const rec = await buildOne(code, kind);
        const d = rec.bars.dates;
        codes[code] = { kind, name: rec.name, from: d[0], to: d[d.length - 1], rows: d.length, events: rec.ca.length, fundUpdated: rec.fundUpdated || null };
      } catch (e) {
        failed.push({ code, error: String(e.message || e).slice(0, 120) });
      }
      if (++done % 50 === 0) console.log(`${done}/${list.length}，${Math.round((Date.now() - t0) / 1000)} 秒，失败 ${failed.length}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const lastDate = Object.values(codes).reduce((m, c) => (c.to > m ? c.to : m), '');
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    v: M.FORMAT, updated: new Date().toISOString(), lastDate, count: Object.keys(codes).length,
    sources: { bars: '腾讯日线（不复权）', stocks: '东方财富数据中心：分红送配、财务主要指标、股本变动', etf: '东方财富基金 F10：分红与份额拆分' },
    failed, codes,
  }, null, 0));
  console.log(`完成：${list.length} 只，失败 ${failed.length}，数据截至 ${lastDate}，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  if (failed.length) console.log('失败：', failed.slice(0, 20).map((f) => `${f.code}(${f.error})`).join('；'));
  // 失败太多（接口变了或被封）时让工作流失败，不推送残缺的数据
  if (failed.length > Math.max(20, list.length * 0.1)) process.exit(1);
}

if (require.main === module) main();
module.exports = { dropIntraday, mergeEvents };
