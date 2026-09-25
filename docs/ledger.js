/* 研究账本：只追加、带哈希链的实验记录。
 * 每条记录包含上一条的哈希，改动或删除任何一条都会在校验时暴露；每台设备一条链，可导出 / 导入合并。
 * 试验次数（通缩夏普的 N）、测试集查看次数、最终留出期解锁次数都从账本统计。
 * 局限：数据存在本机浏览器，清空浏览器数据会丢失整条链（导出的备份可以恢复并校验）。 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const FORMAT = 'aq-ledger-v1';

  // 稳定序列化：键按字母序，保证同一对象的哈希一致
  function canon(x) {
    if (x === null || typeof x !== 'object') return JSON.stringify(x === undefined ? null : x);
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    return '{' + Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  }

  async function sha256(str) {
    const c = root.crypto || (isNode ? require('crypto').webcrypto : null);
    if (c && c.subtle) {
      const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // 非安全上下文（如本地文件打开）没有 WebCrypto：退回 FNV-1a（只防误改，不防有意伪造）
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return 'fnv' + (h >>> 0).toString(16);
  }

  // 数据指纹：标的、长度、首末日期、收盘价之和
  function fingerprint(data) {
    const parts = Object.keys(data || {}).sort().map((s) => {
      const d = data[s];
      let sum = 0;
      for (const v of d.close) if (Number.isFinite(v)) sum += v;
      return [s, d.dates.length, d.dates[0], d.dates[d.dates.length - 1], +sum.toFixed(4)];
    });
    return sha256(canon(parts));
  }

  // 存储：浏览器用 IndexedDB，测试用内存
  function memoryStore() {
    const rows = [];
    return { all: async () => rows.slice(), put: async (r) => { rows.push(r); } };
  }

  function idbStore(name = 'aq-ledger') {
    const open = () => new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('entries', { keyPath: 'hash' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开账本数据库'));
    });
    return {
      async all() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const req = db.transaction('entries').objectStore('entries').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      },
      async put(r) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('entries', 'readwrite');
          tx.objectStore('entries').put(r);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('写入账本失败'));
        });
      },
    };
  }

  class Ledger {
    constructor({ store, device } = {}) {
      this.store = store || memoryStore();
      this.device = device || 'dev-' + Math.random().toString(36).slice(2, 10);
      this.entries = [];
      this.queue = Promise.resolve();
    }

    async init() {
      this.entries = await this.store.all();
      this.sort();
      return this;
    }

    sort() {
      this.entries.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : a.seq - b.seq));
    }

    chain(device = this.device) {
      return this.entries.filter((e) => e.device === device);
    }

    // 追加一条记录（串行执行，保证序号与哈希链连续）
    append(kind, fields = {}) {
      this.queue = this.queue.then(async () => {
        const chain = this.chain();
        const prev = chain.length ? chain[chain.length - 1].hash : 'genesis';
        const e = { format: FORMAT, device: this.device, seq: chain.length, time: new Date().toISOString(), kind, ...fields, prev };
        e.hash = await sha256(canon(e));
        await this.store.put(e);
        this.entries.push(e);
        this.sort();
        return e;
      });
      return this.queue;
    }

    // 校验：每条的哈希与内容一致、prev 指向上一条、序号连续
    static async verifyEntries(entries) {
      const byDevice = new Map();
      for (const e of entries) {
        if (!byDevice.has(e.device)) byDevice.set(e.device, []);
        byDevice.get(e.device).push(e);
      }
      const broken = [];
      for (const [device, list] of byDevice) {
        list.sort((a, b) => a.seq - b.seq);
        let prev = 'genesis';
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          const { hash, ...body } = e;
          const ok = e.seq === i && e.prev === prev && (await sha256(canon(body))) === hash;
          if (!ok) { broken.push({ device, seq: i, reason: e.seq !== i ? '序号不连续（有记录被删除）' : e.prev !== prev ? '链接断开' : '内容被改动' }); break; }
          prev = hash;
        }
      }
      return { ok: broken.length === 0, chains: byDevice.size, entries: entries.length, broken };
    }

    verify() {
      return Ledger.verifyEntries(this.entries);
    }

    exportJSON() {
      return JSON.stringify({ format: FORMAT, exported: new Date().toISOString(), device: this.device, entries: this.entries });
    }

    /* 导入另一台设备（或备份）的账本：先校验，再合并。
     * 同一设备同一序号但哈希不同 → 视为冲突，拒绝导入。 */
    async importJSON(text) {
      const obj = JSON.parse(text);
      if (!obj || obj.format !== FORMAT || !Array.isArray(obj.entries)) throw new Error('不是有效的研究账本文件');
      const v = await Ledger.verifyEntries(obj.entries);
      if (!v.ok) throw new Error(`导入的账本校验不通过：${v.broken.map((b) => `${b.device} 第 ${b.seq} 条${b.reason}`).join('；')}`);
      const have = new Map(this.entries.map((e) => [e.device + '#' + e.seq, e.hash]));
      let added = 0;
      for (const e of obj.entries) {
        const k = e.device + '#' + e.seq;
        if (have.has(k)) {
          if (have.get(k) !== e.hash) throw new Error(`冲突：设备 ${e.device} 第 ${e.seq} 条与本机记录不同`);
          continue;
        }
        await this.store.put(e);
        this.entries.push(e);
        added++;
      }
      this.sort();
      const merged = await this.verify();
      return { added, ...merged };
    }

    /* 统计：某份数据（dataKey；不传则全部）上的试验次数 = 不同回测配置数 + 优化的参数组合数（全部设备合计） */
    stats(dataKey) {
      const es = this.entries.filter((e) => !dataKey || e.dataKey === dataKey);
      const configs = new Set(es.filter((e) => e.kind === 'backtest').map((e) => e.configHash));
      const optTrials = es.filter((e) => e.kind === 'optimize').reduce((a, e) => a + (e.trials || 0), 0);
      // 旧版（账本之前）本机累计的计数，迁移时作为一条 legacy 记录保存
      let legacyTrials = 0, legacyUnlocks = 0;
      for (const e of this.entries) {
        if (e.kind !== 'legacy' || !e.perKey) continue;
        for (const [k, v] of Object.entries(e.perKey)) {
          if (dataKey && k !== dataKey) continue;
          legacyTrials += v.trials || 0;
          legacyUnlocks += v.unlocks || 0;
        }
      }
      return {
        legacyTrials,
        entries: es.length,
        backtests: es.filter((e) => e.kind === 'backtest').length,
        uniqueConfigs: configs.size,
        optimizations: es.filter((e) => e.kind === 'optimize').length,
        optTrials,
        trials: configs.size + optTrials + legacyTrials,
        testReveals: es.filter((e) => e.kind === 'reveal_test').length,
        holdoutUnlocks: es.filter((e) => e.kind === 'unlock_holdout').length + legacyUnlocks,
        devices: new Set(es.map((e) => e.device)).size,
      };
    }
  }

  const api = { Ledger, canon, sha256, fingerprint, memoryStore, idbStore, FORMAT };
  if (isNode) module.exports = api;
  else (root.AQ = root.AQ || {}).ledger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
