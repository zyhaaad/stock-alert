/* ============================================================
 *  A股持仓 · 趋势阶段引擎 + 信号有效性统计  stage-core.js
 * ============================================================
 *  单一真源说明：
 *    「趋势阶段判定」的算法核心（STAGE_META / 特征 / raw 阈值 / 历史回溯统计）
 *    全部在本文件；console.html 经 inject-core.js 注入后使用，控制台侧只保留
 *    stageStable（localStorage 防抖状态）与 stageOf（组装展示）两个薄封装。
 *    —— 阈值只在这里一份，实时判定与历史统计不会漂移。
 *
 *  判定口径（2026-09-22 定版；2026-09-25 迁移进 core；2026-09-26 增补「高位回落剔除」）：
 *    破位分：跌破 MA60 / 距 60 日高点回撤 ≥15% / 20 日跌幅 ≥10%（各 1 分）
 *    过热分：20 日涨幅 ≥20% / 距 60 日低点涨幅 ≥30% / 换手 >3%（各 1 分）
 *    ddHi ≤ -8% 且破位项 ≥2 → 破位分 ≥2 ? 转势下跌 : 健康回调
 *    ★ 高位回落剔除（2026-09-26）：break 分支内若确认日 ret20 ≥15% 或 MA60 上方 ≥20%，
 *      直接判转势下跌（不给健康回调）。依据：300 只池（2024-01~2026-09）确认日画像，
 *      高位回落型深套>10% 概率 39.4% vs 普通回调 7.6%（5.2 倍）；
 *      2021-2023 全新样本独立确认（40.6%/9.2% 与 33.3%/4.5%，方向一致）。
 *      机制：暴涨后 MA60 失真，破位分确认天然滞后，高位回落即崩塌前段。
 *    upLo ≥ +15% 且过热项 ≥2 → 过热分满需 ? 见顶风险 : 差 1 项 ? 过热警戒 : 上涨中继
 *    其余 → trend（趋势运行中）
 *    ⚠️ 换手率取不到时过热分按可用项降级（2 项中 2 项也算见顶），与实时判定一致。
 *
 *  有效性统计口径（★ 2026-09-25 用户要求，每日收盘后自动重算记录）：
 *    信号「首次出现」= 稳定阶段切换进该状态的确认日（连续 STAGE_CONFIRM 天防抖）；
 *    「终止切换」= 稳定阶段切走到其它状态的当日；期间一律用收盘价。
 *      转势下跌：确认日收盘 → 终止切换日收盘 的累计涨跌幅、下跌概率
 *      健康回调：期间继续回调概率 / 平均回调幅度（最深收盘回撤）/ 终止时转入
 *                转势下跌的概率 / 期间收盘收复信号日收盘的概率
 *      过热警戒 / 见顶风险：确认日 → 终止切换日 的平均涨跌幅（附上涨占比）
 *    ⚠️ 历史换手率按 成交量(手)×10000/流通股本 近似（与东财 f168 同定义），
 *       无股本时 turn=NaN 走降级口径；历史末端尚未终止的阶段段不计入（终点未知）。
 * ============================================================ */
/* ⚠️ 前导分号防御：本文件会被注入进 console.html 主脚本，若前一语句无分号结尾
 *   （如 var STAGE_CONFIRM = 2），ASI 会把它与本 IIFE 拼成 2(function...)() → 运行时炸。
 *   2026-09-25 线上事故根因，勿删分号。 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StageCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- K 线取值（兼容 normBars 对象与腾讯原始数组） ---------------- */
  function closeAt(bars, i) {
    var r = bars[i]; if (r == null) return NaN;
    if (typeof r === 'object' && !Array.isArray(r)) return Number(r.c != null ? r.c : r[2]);
    if (Array.isArray(r)) return Number(r[2]);
    return NaN;
  }
  function highAt(bars, i) {
    var r = bars[i]; if (r == null) return NaN;
    return Number((typeof r === 'object' && !Array.isArray(r)) ? r.h : r[3]);
  }
  function lowAt(bars, i) {
    var r = bars[i]; if (r == null) return NaN;
    return Number((typeof r === 'object' && !Array.isArray(r)) ? r.l : r[4]);
  }
  function volAt(bars, i) {
    var r = bars[i]; if (r == null) return NaN;
    return Number((typeof r === 'object' && !Array.isArray(r)) ? r.v : r[5]);
  }
  function dateAt(bars, i) {
    var r = bars[i]; if (r == null) return '';
    return String((typeof r === 'object' && !Array.isArray(r)) ? r.d : r[0]).slice(0, 10);
  }

  /* ---------------- 阶段元数据 ---------------- */
  var STAGE_META = {
    'up-cont':    { t: '上涨中继',  k: 'stk-hold', a: '涨幅与换手都还没到过热区 —— 拿住，别涨一点就跑',
                    rate: '历史上这类状态：52% 继续涨、20% 大跌（同类平均 49% / 25%）' },
    'overheat':   { t: '过热警戒',  k: 'stk-warn', a: '涨得急了 —— 可先减一半，剩下的设个止盈线',
                    rate: '历史上这类状态：46% 继续涨、32% 大跌（同类平均 49% / 25%）' },
    'top-risk':   { t: '见顶风险',  k: 'stk-risk', a: '急涨与高换手同时出现 —— 落袋，别贪最后一段',
                    rate: '历史上这类状态：39% 继续涨、44% 大跌（同类平均 49% / 25%）' },
    'pullback':   { t: '健康回调',  k: 'stk-hold', a: '关键结构还在（MA60 上方、回撤不深、非高位回落）—— 是深蹲，拿住别被洗出去',
                    rate: '300 只池统计（2024-01~2026-09，持有到切出，高位回落型已剔除）：平均 +0.6%、深套>10% 概率 8.0%、深套>20% 仅 0.2%' },
    'down-shift': { t: '转势下跌',  k: 'stk-risk', a: '关键结构已破 —— 这里不是买点：反弹会有，但 20 日内再深套 >10% 的概率 19%（健康回调仅 7%），轻仓或离场，别扛单',
                    rate: '300 只池（2021~2026 三时段）：40 日内收复 60 日高点的概率 40.2%；信号后 20 日深套>10% 概率 19.1% —— 它是风险标记，不是择时卖出信号' },
    'trend':      { t: '趋势运行中', k: 'stk-flat', a: '没到关键位置 —— 按原计划持有，无需操作', rate: '' }
  };

  /* ---------------- 特征：60 日高低 / MA60 / 20 日涨幅 / 换手 ---------------- */
  function stageFeatAt(bars, i, turn) {
    if (!bars || i < 60 || i >= bars.length) return null;
    var c = closeAt(bars, i);
    if (!isFinite(c) || c <= 0) return null;
    var h60 = -Infinity, l60 = Infinity;
    for (var k = i - 59; k <= i; k++) {
      var a = highAt(bars, k), b = lowAt(bars, k);
      if (isFinite(a) && a > h60) h60 = a;
      if (isFinite(b) && b < l60) l60 = b;
    }
    var sum = 0, cnt = 0;
    for (var m2 = 0; m2 < 60; m2++) { var v = closeAt(bars, i - m2); if (isFinite(v)) { sum += v; cnt++ } }
    var ma60 = cnt ? sum / cnt : NaN;
    var c20 = closeAt(bars, i - 20);
    return {
      c: c, h60: h60, l60: l60, ma60: ma60,
      ddHi: (isFinite(h60) && h60 > 0) ? c / h60 - 1 : NaN,
      upLo: (isFinite(l60) && l60 > 0) ? c / l60 - 1 : NaN,
      ret20: (isFinite(c20) && c20 > 0) ? c / c20 - 1 : NaN,
      aboveMa60: (isFinite(ma60) && ma60 > 0) ? c / ma60 - 1 : NaN,
      turn: (typeof turn === 'number' && isFinite(turn) && turn > 0) ? turn : NaN
    };
  }

  /* ---------------- raw 阶段判定（阈值唯一出处；顺带回传破位/过热分供展示） ---------------- */
  function stageRawFromFeat(f) {
    if (!f) return { raw: null, brkHit: 0, brkItems: 0, hotHit: 0, hotItems: 0 };
    var brkHit = 0, brkItems = 0;
    if (isFinite(f.aboveMa60)) { brkItems++; if (f.aboveMa60 < 0) brkHit++ }
    if (isFinite(f.ddHi)) { brkItems++; if (f.ddHi <= -0.15) brkHit++ }
    if (isFinite(f.ret20)) { brkItems++; if (f.ret20 <= -0.10) brkHit++ }
    var hotHit = 0, hotItems = 0;
    if (isFinite(f.ret20)) { hotItems++; if (f.ret20 >= 0.20) hotHit++ }
    if (isFinite(f.upLo)) { hotItems++; if (f.upLo >= 0.30) hotHit++ }
    if (isFinite(f.turn)) { hotItems++; if (f.turn > 3) hotHit++ }
    var raw = 'trend';
    if (isFinite(f.ddHi) && f.ddHi <= -0.08 && brkItems >= 2) {
      /* ★ 高位回落剔除（2026-09-26）：确认日 ret20≥15% 或 MA60 上方≥20% 的"回调"
         实为崩塌前段（深套率 39.4% vs 7.6%，2021-2023 新鲜样本独立确认），划归转势下跌 */
      var highPos = (isFinite(f.ret20) && f.ret20 >= 0.15) || (isFinite(f.aboveMa60) && f.aboveMa60 >= 0.20);
      raw = (brkHit >= 2 || highPos) ? 'down-shift' : 'pullback';
    } else if (isFinite(f.upLo) && f.upLo >= 0.15 && hotItems >= 2) {
      var need = hotItems >= 3 ? 3 : 2;
      raw = (hotHit >= need) ? 'top-risk' : ((hotHit === need - 1) ? 'overheat' : 'up-cont');
    }
    return { raw: raw, brkHit: brkHit, brkItems: brkItems, hotHit: hotHit, hotItems: hotItems, highPos: !!highPos };
  }

  /* ---------------- 健康回调·深回撤提示（2026-09-26 提示层，不改判定） ----------------
   * 依据：300 只池基线 pullback 日按 ddHi 分桶的 20 日收复率单调坍缩（55%→32.5%→28.2%→12.5%）。
   * 只给条件统计，不做方向预测；调用方拿 null 就不显示。 */
  function pullbackDepthWarn(ddHi) {
    if (!isFinite(ddHi)) return null;
    if (ddHi <= -0.20) return { level: 'deep', text: '本轮回撤已 ≥20%：历史同类 20 日收复率仅约 12.5% —— 深回撤的"回调"多数不是回调，请预设止损位' };
    if (ddHi <= -0.16) return { level: 'mid', text: '本轮回撤较深：历史同类 20 日收复率约 28%（浅回调约 55%），转成持续下跌的风险升高' };
    return null;
  }

  /* ---------------- 历史回溯：阶段段（episodes）切分 ----------------
   * 与 console.stageStable 同一套防抖：首个 raw 直接确立；其后切换需连续 confirm 天。
   * 返回 [{key, s, e, next}]：s=确认日下标、e=终止切换日下标；末端未终止的不返回。 */
  function stageEpisodes(bars, opts) {
    opts = opts || {};
    var confirm = opts.confirm || 2;
    var turnAt = opts.turnAt || function () { return NaN };
    var eps = [];
    if (!bars || bars.length < 62) return eps;
    var key = null, pend = null, pendN = 0, epStart = -1;
    for (var i = 60; i < bars.length; i++) {
      var f = stageFeatAt(bars, i, turnAt(i));
      var raw = stageRawFromFeat(f).raw;
      if (raw == null) continue;
      if (key === null) { key = raw; pend = raw; pendN = 1; epStart = i; continue }
      if (raw !== pend) { pend = raw; pendN = 1 } else { pendN++ }
      if (raw !== key && pendN >= confirm) {
        eps.push({ key: key, s: epStart, e: i, next: raw });
        key = raw; pend = raw; pendN = 1; epStart = i;
      }
    }
    return eps;
  }

  /* ---------------- 单段结果度量（收盘价口径） ---------------- */
  function stageEpisodeOutcome(bars, ep) {
    var c0 = closeAt(bars, ep.s), cE = closeAt(bars, ep.e);
    if (!isFinite(c0) || c0 <= 0 || !isFinite(cE)) return null;
    var minR = Infinity, maxR = -Infinity;
    for (var t = ep.s; t <= ep.e; t++) {
      var r = closeAt(bars, t) / c0 - 1;
      if (isFinite(r)) { if (r < minR) minR = r; if (r > maxR) maxR = r }
    }
    return {
      key: ep.key, next: ep.next, days: ep.e - ep.s,
      ret: cE / c0 - 1,          /* 确认日收盘 → 终止切换日收盘 */
      minRet: minR, maxRet: maxR
    };
  }

  /* ---------------- 聚合：四类信号的有效性统计 ----------------
   * feeds: [{ bars, turnAt }]；返回 { 'down-shift': {...}, pullback: {...}, overheat: {...}, 'top-risk': {...} } */
  function stageStatsFromFeeds(feeds, opts) {
    opts = opts || {};
    var confirm = opts.confirm || 2;
    var byKey = { 'down-shift': [], 'pullback': [], 'overheat': [], 'top-risk': [] };
    var arr = feeds || [];
    for (var fi = 0; fi < arr.length; fi++) {
      var bars = arr[fi].bars;
      var eps = stageEpisodes(bars, { confirm: confirm, turnAt: arr[fi].turnAt });
      for (var ei = 0; ei < eps.length; ei++) {
        var oc = stageEpisodeOutcome(bars, eps[ei]);
        if (oc && byKey[oc.key]) byKey[oc.key].push(oc);
      }
    }
    function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y }, 0) / a.length : NaN }
    function share(a, fn) { return a.length ? a.filter(fn).length / a.length : NaN }
    function pct(v) { return (v * 100).toFixed(1) + '%' }
    var out = {};
    for (var k in byKey) {
      var g = byKey[k];
      if (!g.length) { out[k] = { n: 0 }; continue }
      var base = {
        n: g.length,
        avgDays: mean(g.map(function (o) { return o.days }))
      };
      if (k === 'down-shift') {
        base.avgRet = mean(g.map(function (o) { return o.ret }));
        base.downProb = share(g, function (o) { return o.ret < 0 });
        base.text = '确认→终止切换平均累计涨跌幅 ' + pct(base.avgRet) + ' · 下跌概率 ' + pct(base.downProb);
      } else if (k === 'pullback') {
        base.pullProb = share(g, function (o) { return o.minRet < 0 });
        base.avgPull = mean(g.map(function (o) { return o.minRet }));
        base.toDownProb = share(g, function (o) { return o.next === 'down-shift' });
        base.recoverProb = share(g, function (o) { return o.maxRet >= 0 });
        base.text = '继续回调 ' + pct(base.pullProb) + ' · 平均回调 ' + pct(base.avgPull) +
          ' · 转为转势下跌 ' + pct(base.toDownProb) + ' · 收复信号日收盘 ' + pct(base.recoverProb);
      } else {
        base.avgRet = mean(g.map(function (o) { return o.ret }));
        base.upProb = share(g, function (o) { return o.ret >= 0 });
        base.text = '至阶段切换平均涨跌幅 ' + pct(base.avgRet) + '（上涨占比 ' + pct(base.upProb) + '）';
      }
      out[k] = base;
    }
    return out;
  }

  return {
    STAGE_META: STAGE_META,
    stageFeatAt: stageFeatAt,
    stageRawFromFeat: stageRawFromFeat,
    pullbackDepthWarn: pullbackDepthWarn,
    stageEpisodes: stageEpisodes,
    stageEpisodeOutcome: stageEpisodeOutcome,
    stageStatsFromFeeds: stageStatsFromFeeds
  };
});
