/* 板块轮动状态机 · 云端副本
 * ★ 单一真源 = _research/rotation/state.js（本文件是副本，禁止直接改）
 * 同步：node _research/rotation/sync-cloud.js
 * 忘了同步 = 云端判定/口径与本地回测结论不一致，属严重问题。
 */
/* 板块轮动状态机 · 核心（单一真源）
 * 预注册规则见 PREREG-ROTATION.md，本文件的阈值必须与之一致。
 * UMD：Node 里 require，浏览器里挂 window.ROT。
 *
 * 输入：bars = [[YYYYMMDD, o, h, l, c, vol, amt], ...] 按日期升序
 * 输出：run(bars) → [{ i, date, state, f }]，f 为特征对象
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.ROT = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  /* ============ 预注册阈值（基准档 = 1.0×） ============ */
  var CFG = {
    /* S1 加速高潮 */
    climax: { p250: 0.85, r5: 0.08, r10: 0.15, vr5: 1.50, mf5: 0.25 },
    /* S2 见顶退潮 */
    ebb: { dd60: -0.06, mf5: -0.05, p250: 0.50 },
    /* S3 下跌趋势 */
    down: { dd60: -0.12 },
    /* S4 底部衰竭 */
    exhaust: { p250: 0.25, dd60: -0.20, vr20: 0.85, r5: -0.02, mf20: -0.15 },
    /* S5 资金潜伏 */
    accumulate: { p250: 0.45, mf5: 0.15, mf20: 0.05, r10: 0.05, vr5: 0.95 },
    /* S6 启动 */
    ignition: { vr5: 1.40, mf5: 0.15, p250: 0.80 },
    /* S7 主升 */
    main: { r20: 0.05, p250: 0.55, mf20: 0.03 },
    /* 计算窗口 */
    win: { short: 5, mid: 20, long: 60, vlong: 250, slope: 5 }
  }

  var STATES = ['climax', 'ebb', 'down', 'exhaust', 'accumulate', 'ignition', 'main', 'range']

  var STATE_META = {
    climax: { cn: '加速高潮', hot: 5, color: '#b91c1c' },
    main: { cn: '主升', hot: 4, color: '#d97706' },
    ignition: { cn: '启动', hot: 3, color: '#1d5fd1' },
    accumulate: { cn: '资金潜伏', hot: 2, color: '#0f766e' },
    range: { cn: '震荡整理', hot: 1, color: '#94a3b8' },
    ebb: { cn: '见顶退潮', hot: -3, color: '#7c3aed' },
    exhaust: { cn: '底部衰竭', hot: -2, color: '#64748b' },
    down: { cn: '下跌趋势', hot: -4, color: '#475569' }
  }

  /* ============ 基础工具（一律顶层，避免块级作用域坑） ============ */
  function mean(a) { if (!a.length) return NaN; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length }
  function median(a) {
    if (!a.length) return NaN
    var b = a.slice().sort(function (x, y) { return x - y }), m = b.length >> 1
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
  }
  function stdev(a) {
    if (a.length < 2) return NaN
    var m = mean(a), s = 0
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m)
    return Math.sqrt(s / (a.length - 1))
  }
  function tstat(a) { var sd = stdev(a); return (a.length < 2 || !isFinite(sd) || sd === 0) ? NaN : mean(a) / (sd / Math.sqrt(a.length)) }
  function fin(v) { return (v === null || v === undefined || v === '' || !isFinite(v)) ? NaN : +v }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v) }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s }

  /* ============ 特征计算 ============ */
  /* 在索引 i 上计算特征；要求 i >= CFG.win.vlong */
  function features(bars, i) {
    if (i < CFG.win.vlong) return null
    var c = bars[i][4]
    var W = CFG.win

    /* 位置：p60 / p250（价格在 [最低价, 最高价] 区间的位置） */
    function posRange(n) {
      var lo = Infinity, hi = -Infinity
      for (var k = i - n + 1; k <= i; k++) {
        if (bars[k][3] < lo) lo = bars[k][3]
        if (bars[k][2] > hi) hi = bars[k][2]
      }
      return hi > lo ? (c - lo) / (hi - lo) : 0.5
    }
    var p60 = posRange(60), p250 = posRange(250)

    /* 距 60 日最高收盘的回撤（用最高价更有意义） */
    var hi60 = -Infinity
    for (var k = i - 59; k <= i; k++) if (bars[k][2] > hi60) hi60 = bars[k][2]
    var dd60 = c / hi60 - 1

    /* 均线与乖离 */
    var s20 = 0, s60 = 0
    for (var k1 = i - 19; k1 <= i; k1++) s20 += bars[k1][4]
    for (var k2 = i - 59; k2 <= i; k2++) s60 += bars[k2][4]
    var ma20 = s20 / 20, ma60 = s60 / 60
    var bias20 = c / ma20 - 1, bias60 = c / ma60 - 1

    /* MA20 斜率（对比 5 日前） */
    var s20p = 0
    for (var k3 = i - 24; k3 <= i - 5; k3++) s20p += bars[k3][4]
    var ma20p = s20p / 20
    var slope20 = ma20 / ma20p - 1

    /* 动量 */
    function ret(n) { return c / bars[i - n][4] - 1 }
    var r5 = ret(5), r10 = ret(10), r20 = ret(20)

    /* 量能 */
    function meanVol(from, len) { var t = 0; for (var k = from; k < from + len; k++) t += bars[k][5]; return t / len }
    var v5 = meanVol(i - 4, 5), v20 = meanVol(i - 19, 20), v60 = meanVol(i - 59, 60)
    var vr5 = v20 > 0 ? v5 / v20 : 1
    var vr20 = v60 > 0 ? v20 / v60 : 1

    /* 资金强度 mf(n) = (Σ流入额 − Σ流出额) / (Σ流入额 + Σ流出额)，涨日计流入、跌日计流出 */
    function mf(n) {
      var up = 0, dn = 0
      for (var k = i - n + 1; k <= i; k++) {
        if (k < 1) continue
        var chg = bars[k][4] - bars[k - 1][4]
        var amt = bars[k][6]
        if (chg > 0) up += amt
        else if (chg < 0) dn += amt
      }
      var tot = up + dn
      return tot > 0 ? (up - dn) / tot : 0
    }
    var mf5 = mf(5), mf20 = mf(20)

    return {
      p60: p60, p250: p250, dd60: dd60, bias20: bias20, bias60: bias60,
      slope20: slope20, r5: r5, r10: r10, r20: r20,
      vr5: vr5, vr20: vr20, mf5: mf5, mf20: mf20, mfTrend: mf5 - mf20,
      c: c, amt: bars[i][6]
    }
  }

  /* ============ 状态判定（按预注册顺序，命中即停） ============ */
  /* scale：阈值缩放系数，用于稳健性检验（0.8 / 1.0 / 1.2）。仅对"数值型阈值"生效。 */
  function classify(f, prevState, scale) {
    if (!f) return 'range'
    var s = scale || 1
    var C = CFG, S

    /* S1 加速高潮：p250↑ 且 暴涨 且 放量 且 资金流入 */
    S = C.climax
    if (f.p250 >= S.p250 * s &&
        (f.r5 >= S.r5 * s || f.r10 >= S.r10 * s) &&
        f.vr5 >= S.vr5 * s && f.mf5 >= S.mf5 * s) return 'climax'

    /* S2 见顶退潮：明显回撤 + 资金流出 + 曾处高位 */
    S = C.ebb
    if (f.dd60 <= S.dd60 * s && f.mf5 <= S.mf5 / s && f.p250 >= S.p250 / s) return 'ebb'

    /* S4 底部衰竭：低位 + 深跌 + 缩量 + 止跌 + 流出放缓
       ★ 修订 2026-10-07：本块**必须排在「下跌趋势」之前**。
       理由：底衰的 5 个条件里已含 dd60 ≤ −20%，是下跌趋势（dd60 ≤ −12%）的**严格子集**；
       若按原预注册顺序（down 在 exhaust 之前），down 会先命中，导致 exhaust **永不可达**
       （实测 1630 个交易日 0 次触发）。这是「判定顺序应为从特殊到一般」的实现修正，
       与阈值高低无关，且发生在查看任何收益/转移结果之前。 */
    S = C.exhaust
    if (f.p250 <= S.p250 * s && f.dd60 <= S.dd60 * s &&
        f.vr20 <= S.vr20 / s && f.r5 >= S.r5 * s && f.mf20 >= S.mf20 * s) return 'exhaust'

    /* S3 下跌趋势：双均线之下 + 均线下行 + 深度回撤 */
    S = C.down
    if (f.bias20 <= 0 && f.bias60 <= 0 && f.slope20 <= 0 && f.dd60 <= S.dd60 * s) return 'down'

    /* S5 资金潜伏：中低位 + 资金净流入 + 价格未动 + 有量 */
    S = C.accumulate
    if (f.p250 <= S.p250 / s &&
        (f.mf5 >= S.mf5 * s || f.mf20 >= S.mf20 * s) &&
        Math.abs(f.r10) <= S.r10 / s && f.vr5 >= S.vr5 / s) return 'accumulate'

    /* S6 启动：刚站上 MA20 + 放量 + 资金流入 + 不在高位 + 前一态不是趋势中继 */
    S = C.ignition
    if (f.bias20 > 0 && f.slope20 > 0 && f.vr5 >= S.vr5 * s && f.mf5 >= S.mf5 * s &&
        f.p250 <= S.p250 / s && prevState !== 'main' && prevState !== 'climax') return 'ignition'

    /* S7 主升：双均线之上 + 均线上行 + 中期涨幅 + 中高位 + 中期资金流入 */
    S = C.main
    if (f.bias20 > 0 && f.bias60 > 0 && f.slope20 > 0 &&
        f.r20 >= S.r20 * s && f.p250 >= S.p250 / s && f.mf20 >= S.mf20 * s) return 'main'

    return 'range'
  }

  /* ============ 逐日推进 ============ */
  function run(bars, opts) {
    var o = opts || {}
    var scale = o.scale || 1
    var out = []
    var prev = 'range'
    for (var i = CFG.win.vlong; i < bars.length; i++) {
      var f = features(bars, i)
      if (!f) continue
      var st = classify(f, prev, scale)
      out.push({ i: i, date: bars[i][0], state: st, f: f })
      prev = st
    }
    return out
  }

  return {
    CFG: CFG, STATES: STATES, STATE_META: STATE_META,
    features: features, classify: classify, run: run,
    mean: mean, median: median, stdev: stdev, tstat: tstat, fin: fin, sum: sum, clamp01: clamp01
  }
})
