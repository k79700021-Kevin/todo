const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const L = require(path.join(__dirname, '..', '..', 'docs', 'ledger.js'));

test('ledger: hash chain detects edits, deletions and conflicting imports', async () => {
  const a = await new L.Ledger({ device: 'A' }).init();
  await a.append('backtest', { dataKey: 'd1', configHash: 'c1', config: { x: 1 } });
  await a.append('backtest', { dataKey: 'd1', configHash: 'c1', config: { x: 1 } });
  await a.append('optimize', { dataKey: 'd1', trials: 40 });
  await a.append('reveal_test', { dataKey: 'd1' });
  assert.deepEqual((await a.verify()).ok, true);
  const st = a.stats('d1');
  assert.equal(st.trials, 41, '重复的回测配置只算一次，加上 40 组优化');
  assert.equal(st.testReveals, 1);

  // 篡改一条内容
  const edited = JSON.parse(a.exportJSON());
  edited.entries[2].trials = 1;
  await assert.rejects(new L.Ledger({ device: 'B' }).init().then((b) => b.importJSON(JSON.stringify(edited))), /内容被改动/);
  // 删除一条
  const deleted = JSON.parse(a.exportJSON());
  deleted.entries.splice(1, 1);
  await assert.rejects(new L.Ledger({ device: 'B' }).init().then((b) => b.importJSON(JSON.stringify(deleted))), /序号不连续|链接断开/);

  // 另一台设备合并：试验次数合计
  const b = await new L.Ledger({ device: 'B' }).init();
  await b.append('optimize', { dataKey: 'd1', trials: 10 });
  const r = await b.importJSON(a.exportJSON());
  assert.equal(r.added, 4);
  assert.ok(r.ok && r.chains === 2);
  assert.equal(b.stats('d1').trials, 51);
  // 重复导入不重复计数；同序号不同内容视为冲突
  assert.equal((await b.importJSON(a.exportJSON())).added, 0);
  const forked = await new L.Ledger({ device: 'A' }).init();
  await forked.append('backtest', { dataKey: 'd1', configHash: 'zzz' });
  await assert.rejects(b.importJSON(forked.exportJSON()), /冲突/);
});

test('ledger: canonical serialization and data fingerprints are stable', async () => {
  assert.equal(L.canon({ b: 1, a: [2, { d: 3, c: 4 }] }), L.canon({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const data = { x: { dates: ['2020-01-01', '2020-01-02'], close: [1, 2] } };
  assert.equal(await L.fingerprint(data), await L.fingerprint(JSON.parse(JSON.stringify(data))));
  assert.notEqual(await L.fingerprint(data), await L.fingerprint({ x: { dates: ['2020-01-01', '2020-01-02'], close: [1, 2.5] } }));
});
