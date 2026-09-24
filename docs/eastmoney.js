/* 东方财富日线接口：拼接请求地址、解析返回的 K 线、等比前复权。网页和 tools/data_smoke.js 共用这一份代码。 */
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

  /* 等比前复权：后复权价（按比例调整，恒为正）整体乘以"最新不复权价 / 最新后复权价"，
   * 使最新价格等于真实股价。东方财富自带的前复权是减法调整，分红多的股票早年价格会变成 0 或负数。 */
  function proportional(hfq, raw, sym) {
    const rawClose = new Map(raw.dates.map((d, i) => [d, raw.close[i]]));
    let k = hfq.dates.length - 1;
    while (k >= 0 && !(rawClose.get(hfq.dates[k]) > 0)) k--;
    if (k < 0 || !(hfq.close[k] > 0)) throw new Error(`${sym}：无法对齐不复权与后复权数据`);
    const f = rawClose.get(hfq.dates[k]) / hfq.close[k];
    const scale = (a) => a.map((v) => v * f);
    return {
      dates: hfq.dates.slice(), open: scale(hfq.open), high: scale(hfq.high), low: scale(hfq.low),
      close: scale(hfq.close), volume: hfq.volume.slice(),
    };
  }

  // 回测要求开盘、收盘价为正；否则价格为 0 时会买入无穷多股，算出的收益毫无意义
  function checkPositive(d, sym) {
    for (let i = 0; i < d.dates.length; i++) {
      if (!(d.open[i] > 0 && d.close[i] > 0)) {
        throw new Error(`${sym} 在 ${d.dates[i]} 的价格为 ${d.close[i]}，不能用于回测。` +
          '这通常是减法前复权造成的（分红多的股票早年价格会被减成负数），请用"等比前复权"或"后复权"重新获取。');
      }
    }
    return d;
  }

  const api = { market, klineUrl, parseKlines, proportional, checkPositive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).em = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
