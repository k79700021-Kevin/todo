/* 东方财富接口：日线（含换手率）、财务主要指标；解析、等比前复权。网页和 tools/data_smoke.js 共用这一份代码。 */
(function (root) {
  'use strict';

  // 沪市：6 开头股票、5 开头基金、9 开头 B 股；其余（深市、北交所）为 0
  const market = (sym) => (/^[569]/.test(sym) ? 1 : 0);

  function klineUrl(sym, start, end, adjust, cb) {
    const fqt = { qfq: 1, hfq: 2, none: 0 }[adjust] ?? 1;
    return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market(sym)}.${sym}` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f61&klt=101&fqt=${fqt}` +
      `&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}` + (cb ? `&cb=${cb}` : '');
  }

  // 每行格式：日期,开盘,收盘,最高,最低,成交量(手)[,换手率%]
  function parseKlines(json, sym) {
    const k = json && json.data && json.data.klines;
    if (!k || !k.length) throw new Error(`${sym}：没有数据，检查代码是否正确`);
    const out = { dates: [], open: [], close: [], high: [], low: [], volume: [] };
    const hasTurnover = k[0].split(',').length > 6;
    if (hasTurnover) out.turnover = [];
    for (const line of k) {
      const p = line.split(',');
      out.dates.push(p[0]); out.open.push(+p[1]); out.close.push(+p[2]);
      out.high.push(+p[3]); out.low.push(+p[4]); out.volume.push(+p[5]);
      if (hasTurnover) out.turnover.push(+p[6]);
    }
    if (json.data.name) out.name = json.data.name;
    return out;
  }

  const secucode = (sym) => `${sym}.${market(sym) === 1 ? 'SH' : /^(4|8|92)/.test(sym) ? 'BJ' : 'SZ'}`;
  const DC = 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=';

  /* 财务主要指标（含已退市公司）：报告期、首次公告日、最后更新日、归母净利润（年初至今，原始披露值）、
   * 每股净资产、营收与归母净利润同比。注意：数据源中的每股收益会按之后的送转追溯调整，所以估值用净利润总额计算。 */
  function financeUrl(sym, cb) {
    return DC + 'RPT_F10_FINANCE_MAINFINADATA' +
      '&columns=REPORT_DATE,NOTICE_DATE,UPDATE_DATE,PARENTNETPROFIT,EPSJB,BPS,TOTALOPERATEREVETZ,PARENTNETPROFITTZ' +
      `&filter=(SECUCODE%3D%22${secucode(sym)}%22)&pageSize=300&sortColumns=REPORT_DATE&sortTypes=1` + (cb ? `&callback=${cb}` : '');
  }

  // 股本变动历史：变动日（除权日/上市日）、总股本、流通 A 股
  function sharesUrl(sym, cb) {
    return DC + 'RPT_F10_EH_EQUITY&columns=END_DATE,NOTICE_DATE,TOTAL_SHARES,LISTED_A_SHARES' +
      `&filter=(SECUCODE%3D%22${secucode(sym)}%22)&pageSize=500&sortColumns=END_DATE&sortTypes=1` + (cb ? `&callback=${cb}` : '');
  }

  // 分红送配明细：除权除息日、每 10 股派现（税前）、每 10 股送转
  function bonusUrl(sym, cb) {
    return DC + 'RPT_SHAREBONUS_DET&columns=EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,ASSIGN_PROGRESS,NOTICE_DATE' +
      `&filter=(SECUCODE%3D%22${secucode(sym)}%22)&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=1` + (cb ? `&callback=${cb}` : '');
  }

  const per10 = (v) => Math.round(((+v || 0) / 10) * 1e8) / 1e8; // 每 10 股 → 每股，去掉浮点尾差
  // 只取已实施的方案；返回 [{ date: 除权除息日, cash: 每股派现（税前）, bonus: 每股送转 }]
  function parseBonus(json) {
    const rows = (json && json.result && json.result.data) || [];
    return rows
      .filter((r) => r.EX_DIVIDEND_DATE && r.ASSIGN_PROGRESS === '实施分配')
      .map((r) => ({ date: r.EX_DIVIDEND_DATE.slice(0, 10), cash: per10(r.PRETAX_BONUS_RMB), bonus: per10(r.BONUS_IT_RATIO) }))
      .filter((r) => r.cash > 0 || r.bonus > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  function parseShares(json) {
    const rows = (json && json.result && json.result.data) || [];
    return rows
      .filter((r) => r.END_DATE && r.TOTAL_SHARES > 0)
      .map((r) => {
        const end = r.END_DATE.slice(0, 10), notice = (r.NOTICE_DATE || r.END_DATE).slice(0, 10);
        /* 双时态：date = 股本生效日（变动日 / 报告期末），known = 公告日（此后才可知）。
         * 例如年报披露的期末股本：公告前不可用，公告后用于还原报告期末的状态（报告期净资产 = 每股净资产 × 当期股本）。 */
        return { date: end, known: notice, total: +r.TOTAL_SHARES, float: +r.LISTED_A_SHARES || NaN };
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // 指数日线（沪深300 为 1.000300，价格指数，不含分红）
  function indexKlineUrl(code, start, end, cb) {
    return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${/^(000|880)/.test(code) ? 1 : 0}.${code}` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0` +
      `&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}` + (cb ? `&cb=${cb}` : '');
  }

  function parseFinance(json) {
    const rows = (json && json.result && json.result.data) || [];
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : +v);
    return rows
      .filter((r) => r.REPORT_DATE && r.NOTICE_DATE)
      .map((r) => ({
        report: r.REPORT_DATE.slice(0, 10), notice: r.NOTICE_DATE.slice(0, 10),
        update: (r.UPDATE_DATE || r.NOTICE_DATE).slice(0, 10),
        profit: num(r.PARENTNETPROFIT), eps: num(r.EPSJB), bps: num(r.BPS),
        revYoy: num(r.TOTALOPERATEREVETZ), profitYoy: num(r.PARENTNETPROFITTZ),
      }));
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
    const out = {
      dates: hfq.dates.slice(), open: scale(hfq.open), high: scale(hfq.high), low: scale(hfq.low),
      close: scale(hfq.close), volume: hfq.volume.slice(),
    };
    // 个股研究用：对齐后的不复权收盘价与换手率（市值、估值因子需要）
    if (raw.turnover) {
      const rawTv = new Map(raw.dates.map((d, i) => [d, raw.turnover[i]]));
      out.raw = hfq.dates.map((d) => rawClose.get(d) ?? NaN);
      out.turnover = hfq.dates.map((d) => rawTv.get(d) ?? NaN);
    }
    return out;
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

  const api = { market, klineUrl, parseKlines, proportional, checkPositive, financeUrl, parseFinance, sharesUrl, parseShares, bonusUrl, parseBonus, indexKlineUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.AQ = root.AQ || {}).em = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
