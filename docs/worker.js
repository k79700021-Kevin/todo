/* 后台线程：运行参数优化与因子 IC，不阻塞页面。 */
/* global importScripts */
importScripts('indicators.js', 'engine.js', 'rules.js', 'research.js');

self.onmessage = (e) => {
  const { type, payload } = e.data;
  const R = self.AQ.research;
  if (type === 'ic') {
    try {
      self.postMessage({ type: 'result', result: R.factorIC(R.makeBacktester(payload.data, payload.engine), payload.h) });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }
  if (type !== 'optimize') return;
  try {
    let last = 0;
    const result = self.AQ.research.optimize(payload, (done, total) => {
      const now = Date.now();
      if (now - last > 150 || done === total) {
        last = now;
        self.postMessage({ type: 'progress', done, total });
      }
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
