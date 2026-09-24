/* 东方财富日线接口：拼接请求地址、解析返回的 K 线。网页和 tools/data_smoke.js 共用这一份代码。 */
(function (root) {
  'use strict';

  // 沪市：6 开头股票、5 开头基金、9 开头 B 股；其余（深市、北交所）为 0
  const market = (sym) => (/^[569]/.test(sym) ? 1 : 0);

  function klineUrl(sym, start, end, adjust, cb) {
    const fqt = { qfq: 1, hfq: 2, none: 0 }[adjust] ?? 1;
    return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market(sym)}.${sym}` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=${fqt}` +
      `&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}` + (cb ? `&cb=${cb}` : '');
  }

  // 每行格式：日期,开盘,收盘,最高,最低,成交量
  function parseKlines(json, sym) {
    const k = json && json.data && json.data.klines;
    if (!k || !k.length) throw new Error(`${sym}：没有数据，检查代码是否正确`);
    const out = { dates: [], open: [], close: [], high: [], low: [], volume: [] };
    for (const line of k) {
      const p = line.split(',');
      out.dates.push(p[0]); out.open.push(+p[1]); out.close.push(+p[2]);
      out.high.push(+p[3]); out.low.push(+p[4]); out.volume.push(+p[5]);
    }
    return out;
  }

  const api = { market, klineUrl, parseKlines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).em = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
