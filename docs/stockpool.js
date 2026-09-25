/* 个股股票池（时点）：按沪深300 历史成分获取行情与财务数据，存入浏览器 IndexedDB，并组装成回测数据与元数据。
 * 成分数据 data/hs300_members.json 由 tools/build_hs300.py 从中证指数公司历次调整公告重建。 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const em = isNode ? require('./eastmoney.js') : root.AQ.em;
  const DB_NAME = 'aq-stockpool';
  const STORE = 'stocks';
  const WARMUP_DAYS = 420; // 纳入前预留约 280 个交易日，供 250 日指标预热
  const VERSION = 2;       // 本地记录格式：2 = 含股本变动历史、原始净利润与更新日
  const INDEX_KEY = 'IDX000300';

  const addDays = (d, n) => {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };

  /* 每只股票需要的行情区间：与 [start, end] 有交集的成分区间，向前留预热期，剔除后多留几天以便卖出。
   * 返回 { code: { from, to, intervals } }，intervals 已裁到 [start, end]。 */
  function plan(members, start, end) {
    const out = {};
    for (const [code, ivs] of Object.entries(members.members)) {
      const hit = ivs.filter(([f, t]) => f <= end && (!t || t > start));
      if (!hit.length) continue;
      const first = hit[0][0] > start ? hit[0][0] : start;
      const lastTo = hit[hit.length - 1][1];
      out[code] = {
        from: addDays(first, -WARMUP_DAYS),
        to: lastTo && lastTo < end ? addDays(lastTo, 20) : end,
        intervals: hit,
      };
    }
    return out;
  }

  // 只保留 [from, to] 内的行情
  function trim(d, from, to) {
    const idx = [];
    d.dates.forEach((x, i) => { if (x >= from && x <= to) idx.push(i); });
    const pick = (a) => (a ? idx.map((i) => a[i]) : undefined);
    const out = { dates: pick(d.dates) };
    for (const k of ['open', 'high', 'low', 'close', 'volume', 'raw', 'turnover']) if (d[k]) out[k] = pick(d[k]);
    return out;
  }

  /* 组装：records 为 IndexedDB 中的 { code, bars, fin }。返回 { data, meta, coverage }。
   * meta.universe 只含有行情的股票；coverage 统计成分股里有多少取到了行情。 */
  function assemble(members, records, start, end, { industry = null, fundAvail = 'notice' } = {}) {
    const want = plan(members, start, end);
    const data = {}, universe = {}, fundamentals = {}, delisted = {}, shares = {}, ind = {};
    let got = 0;
    const missing = [];
    for (const code of Object.keys(want)) {
      const r = records[code];
      if (!r || !r.bars || !r.bars.dates.length) { missing.push(code); continue; }
      const bars = trim(r.bars, want[code].from, want[code].to);
      if (!bars.dates.length) { missing.push(code); continue; }
      data[code] = bars;
      universe[code] = want[code].intervals;
      if (r.fin && r.fin.length) fundamentals[code] = r.fin;
      if (r.shares && r.shares.length) shares[code] = r.shares;
      if (industry && industry[code]) ind[code] = industry[code];
      if (members.delisted && members.delisted[code]) delisted[code] = members.delisted[code];
      got++;
    }
    const idx = records[INDEX_KEY];
    return {
      data,
      meta: {
        universe, fundamentals, delisted, shares, fundAvail,
        industry: Object.keys(ind).length ? ind : null,
        index: idx && idx.bars ? { code: '000300', name: '沪深300（价格指数）', dates: idx.bars.dates, close: idx.bars.close } : null,
      },
      coverage: { wanted: Object.keys(want).length, got, missing, stale: Object.values(records).filter((r) => r.code !== INDEX_KEY && r.v !== VERSION).length },
    };
  }

  // ---------- 浏览器：IndexedDB 与 JSONP 获取 ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'code' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
    });
  }

  async function dbAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = {};
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out[c.key] = c.value; c.continue(); } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(rec) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入本地数据库失败（空间不足？）'));
    });
  }

  async function dbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  let seq = 0;
  function jsonp(makeUrl, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const cb = 'aqp_' + Date.now().toString(36) + '_' + (seq++);
      const tag = document.createElement('script');
      const timer = setTimeout(() => done(new Error('请求超时')), timeout);
      function done(err, val) {
        clearTimeout(timer);
        window[cb] = () => {}; // 迟到的回调不报错
        setTimeout(() => { delete window[cb]; }, 60000);
        tag.remove();
        if (err) reject(err); else resolve(val);
      }
      window[cb] = (json) => done(null, json);
      tag.onerror = () => done(new Error('连不上东方财富'));
      tag.src = makeUrl(cb);
      document.head.appendChild(tag);
    });
  }

  async function withRetry(fn, tries = 3) {
    for (let a = 1; ; a++) {
      try { return await fn(); } catch (e) {
        if (a >= tries) throw e;
        await new Promise((r) => setTimeout(r, 1500 * a));
      }
    }
  }

  // 一只股票：后复权 + 不复权（含换手率）→ 等比前复权；财务主要指标；股本变动历史
  async function fetchStock(code, from, to) {
    const k = (adj) => withRetry(async () => em.parseKlines(await jsonp((cb) => em.klineUrl(code, from, to, adj, cb)), code));
    const hfq = await k('hfq');
    const raw = await k('none');
    const bars = em.proportional(hfq, raw, code);
    let fin = [];
    try { fin = em.parseFinance(await withRetry(() => jsonp((cb) => em.financeUrl(code, cb)))); } catch (e) { /* 财务数据缺失不影响行情 */ }
    let shares = [];
    try { shares = em.parseShares(await withRetry(() => jsonp((cb) => em.sharesUrl(code, cb)))); } catch (e) { /* 缺股本时估值退回每股口径 */ }
    return { code, v: VERSION, name: raw.name || hfq.name || '', bars, fin, shares, from, to, fetched: new Date().toISOString().slice(0, 10) };
  }

  /* 构建股票池：已存且覆盖所需区间的股票跳过（可中断后继续）。onProgress(done, total, code, failed) */
  async function build(members, start, end, { concurrency = 4, onProgress = () => {}, shouldStop = () => false } = {}) {
    const want = plan(members, start, end);
    const have = await dbAll();
    const todo = Object.entries(want).filter(([code, w]) => {
      const r = have[code];
      return !(r && r.v === VERSION && r.from <= w.from && r.to >= w.to);
    });
    // 官方指数（第二基准）：取全历史（成分股行情含预热期，早于起始年份），每次都更新
    try {
      const bars = em.parseKlines(await withRetry(() => jsonp((cb) => em.indexKlineUrl('000300', '2005-01-01', end, cb))), '000300');
      await dbPut({ code: INDEX_KEY, bars, fetched: new Date().toISOString().slice(0, 10) });
    } catch (e) { /* 取不到指数时只用成分等权基准 */ }
    const failed = [];
    let done = Object.keys(want).length - todo.length;
    const total = Object.keys(want).length;
    onProgress(done, total, '', failed);
    let next = 0;
    async function worker() {
      while (next < todo.length && !shouldStop()) {
        const [code, w] = todo[next++];
        try {
          const rec = await fetchStock(code, w.from, w.to);
          await dbPut(rec);
        } catch (e) {
          failed.push(`${code}（${String(e.message || e).slice(0, 30)}）`);
        }
        done++;
        onProgress(done, total, code, failed);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { total, failed, stopped: shouldStop() };
  }

  async function load(members, start, end, opts) {
    return assemble(members, await dbAll(), start, end, opts);
  }

  const api = { plan, trim, assemble, build, load, dbAll, dbClear, WARMUP_DAYS, VERSION, INDEX_KEY };
  if (isNode) module.exports = api;
  else root.AQ.pool = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
