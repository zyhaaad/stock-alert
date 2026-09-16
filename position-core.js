/* ============================================================
 *  持仓账本 · 核心算法  position-core.js
 * ============================================================
 *  设计原则（与 fng-core.js 一致）
 *  1) 单一真源：云端（Node，V4 的「按盈亏提醒」要用）与手机控制台
 *     （浏览器）共用**同一份代码**，浏览器版由 _tests/inject-position-core.js
 *     原样注入 console.html 的 POSITION-CORE 标记块，杜绝两端算不一致。
 *  2) 「没记持仓」≠「持仓为 0」：前者一律返回 null，界面要显示
 *     「未记录持仓」，绝不能显示成 0 元盈亏——那是误导。
 *  3) 纯函数：不碰 DOM、不发请求、不读配置；行情价由调用方传进来。
 *
 *  字段约定（写在配置的股票对象上，两个都可选）
 *    cost  成本价（元/股，与行情同口径）
 *    qty   股数（A股 1 手 = 100 股）
 *  两者都 > 0 才算「记录了持仓」。
 *
 *  盈亏口径
 *    成本金额 = cost × qty
 *    持仓市值 = 最新价 × qty（取不到价 → 「未计价」，不参与盈亏汇总）
 *    浮动盈亏 = (最新价 − cost) × qty
 *    收益率   = 最新价 / cost − 1
 *  不含手续费/印花税——做决策看的是量级，不是分位。
 *
 *  配色语义：涨=红、跌=绿（A股约定），由 pnlClass() 给出。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PositionCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  /** 免手续费说明，界面与文档共用同一句，避免两处不一致 */
  var FEE_NOTE = '未计手续费与印花税';

  /** 稳妥转数字：空串/null/undefined/非数字 → NaN（不返回 0，避免把「没填」当「填了 0」） */
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /** 保存前清洗：合法的正数原样返回，否则返回 undefined（用于「清空该字段」） */
  function cleanNum(v) {
    var n = num(v);
    return (isFinite(n) && n > 0) ? n : undefined;
  }

  /**
   * 解析一条持仓记录。
   * @returns null 表示「没记持仓」；否则 {cost, qty}
   */
  function posOf(stock) {
    if (!stock) return null;
    var cost = num(stock.cost), qty = num(stock.qty);
    if (!(cost > 0) || !(qty > 0)) return null;
    return { cost: cost, qty: qty };
  }

  /** 是否记录了持仓 */
  function hasPosition(stock) { return !!posOf(stock); }

  /**
   * 单只股票在给定最新价下的浮动盈亏。
   * @param stock 配置里的股票对象（cost/qty 可选）
   * @param price 最新价（数字或可转数字）
   * @returns null 未记持仓；否则
   *   { cost, qty, price, hasPrice, costVal, mktVal, pnl, pnlPct }
   *   hasPrice=false 时 price/mktVal/pnl/pnlPct 均为 NaN（未计价）
   */
  function pnlOf(stock, price) {
    var pos = posOf(stock);
    if (!pos) return null;
    var px = num(price);
    var hasPrice = isFinite(px) && px > 0;
    var costVal = pos.cost * pos.qty;
    var mktVal = hasPrice ? px * pos.qty : NaN;
    var pnl = hasPrice ? (px - pos.cost) * pos.qty : NaN;
    var pnlPct = hasPrice ? (px / pos.cost - 1) : NaN;
    return {
      cost: pos.cost, qty: pos.qty,
      price: hasPrice ? px : NaN, hasPrice: hasPrice,
      costVal: costVal, mktVal: mktVal, pnl: pnl, pnlPct: pnlPct
    };
  }

  /**
   * 组合汇总。
   * @param stocks  股票数组
   * @param priceOf 取价函数 (stock) => price；或 {code: price} 对象
   * @returns {
   *   rows:[{stock,pnl}],      // 记录了持仓的（含未计价的）
   *   priced:[{stock,pnl}],    // 其中取到价的
   *   totalCost,               // 全部记录持仓的成本金额（含未计价）
   *   pricedCost, pricedMkt,   // 只统计取到价的
   *   totalPnl, totalPnlPct,   // 只基于取到价的，未计价不参与
   *   count, pricedCount, unpricedCount, unrecordedCount,
   *   hasAny                   // 是否有任何记录持仓
   * }
   * 注意：只要**部分**股票取不到价，总盈亏仍只按可计价的那部分算，
   *       并由 unpricedCount 提示界面「另有 N 只未计价」，绝不混算。
   */
  function portfolioOf(stocks, priceOf) {
    stocks = stocks || [];
    var get;
    if (typeof priceOf === 'function') get = priceOf;
    else if (priceOf && typeof priceOf === 'object') {
      get = function (st) {
        var a = priceOf[st && st.code];
        if (a !== undefined) return a && typeof a === 'object' ? a.price : a;
        return NaN;
      };
    } else get = function () { return NaN; };

    var rows = [], priced = [];
    var totalCost = 0, pricedCost = 0, pricedMkt = 0;
    var unrecordedCount = 0;

    for (var i = 0; i < stocks.length; i++) {
      var st = stocks[i];
      var p = pnlOf(st, get(st));
      if (!p) { unrecordedCount++; continue; }
      rows.push({ stock: st, pnl: p });
      totalCost += p.costVal;
      if (p.hasPrice) {
        priced.push({ stock: st, pnl: p });
        pricedCost += p.costVal;
        pricedMkt += p.mktVal;
      }
    }

    var hasPriced = pricedCost > 0;
    var totalPnl = hasPriced ? (pricedMkt - pricedCost) : NaN;
    var totalPnlPct = hasPriced ? (pricedMkt / pricedCost - 1) : NaN;

    return {
      rows: rows,
      priced: priced,
      totalCost: totalCost,
      pricedCost: pricedCost,
      pricedMkt: pricedMkt,
      totalPnl: totalPnl,
      totalPnlPct: totalPnlPct,
      count: rows.length,
      pricedCount: priced.length,
      unpricedCount: rows.length - priced.length,
      unrecordedCount: unrecordedCount,
      hasAny: rows.length > 0
    };
  }

  /** 涨=红(up)、跌=绿(down)、零=灰(flat)。A股约定。 */
  function pnlClass(v) {
    if (!isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  /** 千分位 + 指定小数位；非有限数 → '—' */
  function fmtNum(v, dec) {
    if (!isFinite(v)) return '—';
    var d = (dec === undefined || dec === null) ? 2 : dec;
    var neg = v < 0;
    var s = Math.abs(v).toFixed(d);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  /**
   * 金额文本。opt: {dec, sign, sym}
   *   sign=true → 正数带 '+'（放在货币符号前：+¥1,240.00）
   *   sym=false → 不带 '¥'
   */
  function fmtMoney(v, opt) {
    opt = opt || {};
    if (!isFinite(v)) return '—';
    var dec = (opt.dec === undefined || opt.dec === null) ? 2 : opt.dec;
    var sym = opt.sym === false ? '' : '¥';
    var sign = v < 0 ? '-' : (opt.sign && v > 0 ? '+' : '');
    return sign + sym + fmtNum(Math.abs(v), dec);
  }

  /** 百分比文本，v 为小数（0.0402 → '+4.02%'） */
  function fmtPct(v, opt) {
    opt = opt || {};
    if (!isFinite(v)) return '—';
    var dec = (opt.dec === undefined || opt.dec === null) ? 2 : opt.dec;
    var sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    return sign + Math.abs(v * 100).toFixed(dec) + '%';
  }

  /** 股数文本：整数不显示小数，非整数最多 2 位 */
  function fmtQty(v) {
    if (!isFinite(v)) return '—';
    var r = Math.round(v);
    if (Math.abs(v - r) < 1e-9) return fmtNum(r, 0);
    return fmtNum(v, 2);
  }

  /** 持仓一句话（界面与推送共用，保证措辞一致） */
  function posLine(p) {
    if (!p) return '未记录持仓';
    return '持仓 ' + fmtQty(p.qty) + ' 股 · 成本 ' + fmtNum(p.cost, 2);
  }

  return {
    VERSION: VERSION,
    FEE_NOTE: FEE_NOTE,
    num: num,
    cleanNum: cleanNum,
    posOf: posOf,
    hasPosition: hasPosition,
    pnlOf: pnlOf,
    portfolioOf: portfolioOf,
    pnlClass: pnlClass,
    fmtNum: fmtNum,
    fmtMoney: fmtMoney,
    fmtPct: fmtPct,
    fmtQty: fmtQty,
    posLine: posLine
  };
});
