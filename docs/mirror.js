/* 行情镜像：东方财富的日线接口（push2his）拒绝境外机房（GitHub、各家 AI 的云端浏览器）访问，
 * 所以由 GitHub Actions 每个交易日收盘后从境外也能访问的数据源抓取，存为静态 JSON 放在本仓库的 market-data 分支，
 * 网页、云端浏览器、Python 都从 raw.githubusercontent.com 读取（允许跨域）。
 *   日线：腾讯（不复权，与东方财富逐日核对一致：开高低收到分、成交量到手）
 *   分红送配、财务主要指标、股本变动：东方财富数据中心（境外可访问）
 *   ETF 分红与份额拆分：东方财富基金 F10 页面
 * 本文件浏览器与 Node 共用：数据源的地址与解析（构建脚本用）、镜像记录的读取（网页用）。 */
(function (root) {
  'use strict';

  const MIRROR_BASE = 'https://raw.githubusercontent.com/k79700021-Kevin/todo/market-data/';
  const FORMAT = 1;

  // 腾讯的市场前缀：沪市（6、9 开头股票，5 开头基金）、北交所（4、8、92 开头）、其余深市
  function tencentSymbol(code) {
    if (/^(4|8|92)/.test(code)) return 'bj' + code;
    return (/^[569]/.test(code) ? 'sh' : 'sz') + code;
  }
  // 指数用 sh000300 这类写法（000 开头是沪市指数，399 开头是深市指数）
  const tencentIndexSymbol = (code) => (/^399/.test(code) ? 'sz' : 'sh') + code;

  // 不复权日线；每次最多返回区间内最近的 2000 行，长历史要按区间分段取。
  // 两个域名是同一接口，某个域名间歇性返回反爬挑战页（HTTP 501）时换另一个重试
  const TENCENT_HOSTS = ['https://web.ifzq.gtimg.cn', 'https://ifzq.gtimg.cn'];
  function tencentKlineUrl(symbol, from, to, count = 2000, host = 0) {
    return `${TENCENT_HOSTS[host % TENCENT_HOSTS.length]}/appstock/app/fqkline/get?param=${symbol},day,${from},${to},${count},`;
  }

  // 行格式：[日期, 开, 收, 高, 低, 成交量（手）, 除权除息信息（可选）]
  function parseTencent(json, symbol) {
    const d = json && json.data && json.data[symbol];
    const rows = (d && (d.day || d.qfqday)) || [];
    const out = { dates: [], open: [], high: [], low: [], close: [], volume: [], events: [] };
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const o = +r[1], c = +r[2], h = +r[3], l = +r[4], v = +r[5];
      if (!(o > 0 && c > 0)) continue;
      out.dates.push(r[0]); out.open.push(o); out.close.push(c); out.high.push(h); out.low.push(l); out.volume.push(v);
      // 除权除息日的行带有分红送转说明，如"10送6派1.7元"
      const info = r[6];
      if (info && typeof info === 'object' && info.FHcontent) {
        const e = parseDividendText(info.FHcontent);
        if (e) out.events.push({ date: info.cqr || r[0], ...e });
      }
    }
    const qt = d && d.qt && d.qt[symbol];
    if (Array.isArray(qt) && qt[1]) out.name = qt[1];
    return out;
  }

  // "10送6转2派1.7元" → { cash: 0.17, bonus: 0.8 }（每股）；解析不出或全为 0 时返回 null
  function parseDividendText(t) {
    const m = String(t).match(/^\s*10\s*(.*)$/);
    if (!m) return null;
    const num = (re) => { const x = m[1].match(re); return x ? +x[1] : 0; };
    const cash = num(/派\s*([\d.]+)/), song = num(/送\s*([\d.]+)/), zhuan = num(/转(?:增)?\s*([\d.]+)/);
    if (!(cash > 0 || song > 0 || zhuan > 0)) return null;
    const r8 = (x) => Math.round(x * 1e8) / 1e8;
    return { cash: r8(cash / 10), bonus: r8((song + zhuan) / 10) };
  }

  // 合并两段日线（后者覆盖前者的重叠日期），按日期升序
  function mergeBars(a, b) {
    const m = new Map();
    for (const x of [a, b]) {
      if (!x || !x.dates) continue;
      x.dates.forEach((d, i) => m.set(d, [x.open[i], x.high[i], x.low[i], x.close[i], x.volume[i]]));
    }
    const dates = [...m.keys()].sort();
    const out = { dates, open: [], high: [], low: [], close: [], volume: [] };
    for (const d of dates) { const v = m.get(d); out.open.push(v[0]); out.high.push(v[1]); out.low.push(v[2]); out.close.push(v[3]); out.volume.push(v[4]); }
    return out;
  }

  const fundDividendUrl = (code) => `https://fundf10.eastmoney.com/fhsp_${code}.html`;

  /* ETF 分红与份额拆分（基金 F10 页面）：
   *   分红表：年份 | 权益登记日 | 除息日 | 每10份派现金X元 | 发放日 → { date: 除息日, cash: X/10 }
   *   拆分表：年份 | 拆分折算日 | 份额分拆/份额折算 | 1:r → { date: 拆分折算日的次日, bonus: r − 1 }（r < 1 为合并）
   *     折算日收盘后才变更份额，价格从下一个交易日起按新份额计（510500 于 2022-08-26 折算，08-29 价格跳变），
   *     所以事件日记为次日，由使用方落到其后第一个交易日 */
  function parseFundEvents(html) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const out = [];
    for (const m of text.matchAll(/(\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2}) 每10份派现金([\d.]+)元/g)) {
      out.push({ date: m[2], cash: Math.round((+m[3] / 10) * 1e8) / 1e8, bonus: 0 });
    }
    for (const m of text.matchAll(/(\d{4}-\d{2}-\d{2}) 份额(?:分拆|折算|拆分|合并) 1:([\d.]+)/g)) {
      const r = +m[2];
      const next = new Date(m[1] + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      if (r > 0 && r !== 1) out.push({ date: next.toISOString().slice(0, 10), cash: 0, bonus: Math.round((r - 1) * 1e8) / 1e8 });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /* 从镜像读取一只标的：{ code, name, kind, updated, bars（不复权）, ca, fin, shares }。
   * fetchImpl 默认用全局 fetch；base 可指向本地目录的 HTTP 服务（测试用）。 */
  async function load(code, { base = MIRROR_BASE, fetchImpl = (...a) => root.fetch(...a) } = {}) {
    const r = await fetchImpl(`${base}stocks/${code}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${code}：镜像里没有（HTTP ${r.status}）`);
    const rec = await r.json();
    if (!rec || rec.v !== FORMAT || !rec.bars || !rec.bars.dates || !rec.bars.dates.length) throw new Error(`${code}：镜像记录格式不对`);
    return rec;
  }

  async function manifest({ base = MIRROR_BASE, fetchImpl = (...a) => root.fetch(...a) } = {}) {
    const r = await fetchImpl(`${base}manifest.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`镜像清单读取失败（HTTP ${r.status}）`);
    return r.json();
  }

  /* 镜像记录 → 回测用日线（与 eastmoney.parseKlines 同形，外加 raw = 不复权收盘）：
   *   qfq：不复权价 + 分红送转明细自建等比前复权；hfq：同一序列按首日真实价缩放（等比后复权）；none：不复权。指数不做调整。 */
  function toBars(rec, adjust = 'qfq') {
    const em = typeof module !== 'undefined' && module.exports ? require('./eastmoney.js') : root.AQ.em;
    const b = rec.bars;
    if (adjust === 'none' || rec.kind === 'index') {
      return { dates: b.dates.slice(), open: b.open.slice(), high: b.high.slice(), low: b.low.slice(), close: b.close.slice(), volume: b.volume.slice(), raw: b.close.slice(), name: rec.name };
    }
    const q = em.adjustFromEvents(b, rec.ca || [], rec.code);
    q.name = rec.name;
    if (adjust !== 'hfq') return q;
    const k = b.close[0] / q.close[0];
    for (const f of ['open', 'high', 'low', 'close']) q[f] = q[f].map((v) => v * k);
    return q;
  }

  const api = { MIRROR_BASE, FORMAT, parseDividendText, tencentSymbol, tencentIndexSymbol, tencentKlineUrl, parseTencent, mergeBars, fundDividendUrl, parseFundEvents, load, manifest, toBars };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).mirror = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
