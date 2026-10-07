/* 板块轮动汇总口径 · 云端副本
 * ★ 单一真源 = _research/rotation/report.js（本文件是副本，禁止直接改）
 * 同步：node _research/rotation/sync-cloud.js
 * 忘了同步 = 云端判定/口径与本地回测结论不一致，属严重问题。
 */
/* 板块轮动 · 汇总口径（单一真源）
 * 输入：rows = 每个板块一行
 *   { code, name, kind:'hy'|'hy2'|'gn', state, days, date, chg5, chg20, mf5, mf20, amt, vr5, p250, dd60 }
 * 输出：rotation.json 的对象（前端「板块轮动」页直读）
 *
 * ★ 口径硬约定（2026-10-07 实测确认，务必保持；前端有对应口径守卫断言）：
 *   1) 90 个一级行业板块成交额合计 ≈ 1.45 万亿，与 A 股全市场日成交额同量级
 *      → 行业板块互斥、可加总，市场级指标只用一级行业。
 *   2) 概念板块（885xxx/886xxx）成分股高度重叠 ⇒ 净额不可跨板块比较、更不可加总。
 *   3) mf5 = (上涨日成交额 − 下跌日成交额) / (上涨日成交额 + 下跌日成交额)。
 *      它把**全部**成交额计入买卖压力，量级远大于东财「主力净流入占比」（后者仅算大单/超大单），
 *      单边下行市里整行业合计会到 ±万亿级 —— **不可解读为「资金净流出金额」**。
 *      故：跨板块排序与展示一律用 mf5（比例），**绝不展示净额绝对值**。
 *   4) 「注意力集中度」= 前 10 大成交额行业 ÷ 全部一级行业成交额（成交额可加总，直接反映关注度分布）。
 *
 * UMD：Node 里 require；浏览器里挂 window.ROTREPORT。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.ROTREPORT = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  /* 排除清单：指数/交易机制/风格标签类板块 —— 它们不是「行业或题材」，
   * 混进来会把「融资融券」「ST板块」这种非主题板块排到轮动榜上（预注册 PREREG-ROTATION.md §1.2） */
  var EXCLUDE = {
    885338: 1, 885520: 1, 885694: 1, 885699: 1, 885587: 1, 885598: 1, 885742: 1, 885739: 1,
    885905: 1, 885907: 1, 886045: 1, 886072: 1, 886075: 1, 886082: 1, 886096: 1, 886102: 1
  }

  var STATE_ORDER = ['climax', 'main', 'ignition', 'accumulate', 'exhaust', 'ebb', 'down', 'range']

  function kindOf(code) {
    var p = String(code).slice(0, 3)
    if (p === '881') return 'hy'
    if (p === '884') return 'hy2'
    if (p === '885' || p === '886') return 'gn'
    return 'other'
  }

  function median(a) {
    if (!a.length) return NaN
    var b = a.slice().sort(function (x, y) { return x - y }), m = b.length >> 1
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
  }

  /* rows 已按板块算好 → rotation.json */
  function build(rows) {
    var keep = rows.filter(function (r) { return r && r.state && r.date })
    if (!keep.length) throw new Error('无可用板块行')
    /* 数据日 = 最新日期；日期不一致的板块（停牌/新板块）剔除，避免"僵尸板块"混进当日榜单 */
    var dataDate = ''
    for (var i = 0; i < keep.length; i++) if (keep[i].date > dataDate) dataDate = keep[i].date
    var synced = keep.filter(function (r) { return r.date === dataDate })
    var dropped = keep.length - synced.length

    var counts = {}, hyCounts = {}
    STATE_ORDER.forEach(function (s) { counts[s] = 0; hyCounts[s] = 0 })
    synced.forEach(function (r) { if (counts[r.state] !== undefined) counts[r.state]++ })

    var hy = synced.filter(function (r) { return r.kind === 'hy' })
    hy.forEach(function (r) { if (hyCounts[r.state] !== undefined) hyCounts[r.state]++ })
    var hyUp = hy.filter(function (r) { return r.mf5 > 0 }).length
    var hyAmtTot = hy.reduce(function (a, b) { return a + b.amt }, 0)
    var hyTop10Amt = hy.slice().sort(function (a, b) { return b.amt - a.amt })
      .slice(0, 10).reduce(function (a, b) { return a + b.amt }, 0)

    /* 排序：资金强度降序。★ 必须带 chg5 次序（mf5 在「连涨/连跌 5 天」时会饱和到 ±100%，
     * 全是并列值 → 并列时按 5 日涨跌幅分高下，榜单才有信息量；降序保证 slice(-10).reverse()
     * 拿到的是「跌得最深」那一批，而不是目录顺序） */
    var byMf = synced.slice().sort(function (a, b) { return (b.mf5 - a.mf5) || (b.chg5 - a.chg5) })

    return {
      v: 1,
      src: 'ths',
      date: dataDate,
      generated: new Date().toISOString(),
      dropped: dropped,
      market: {
        count: synced.length,
        counts: counts,
        industry: {
          count: hy.length,
          up: hyUp,
          down: hy.length - hyUp,
          mf5Med: hy.length ? +median(hy.map(function (r) { return r.mf5 })).toFixed(1) : 0,
          amt: Math.round(hyAmtTot),
          counts: hyCounts
        },
        focusTop10: hyAmtTot > 0 ? +(hyTop10Amt / hyAmtTot).toFixed(4) : 0
      },
      boards: byMf
    }
  }

  return {
    EXCLUDE: EXCLUDE, STATE_ORDER: STATE_ORDER,
    kindOf: kindOf, median: median, build: build
  }
})
