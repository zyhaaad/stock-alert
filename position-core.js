/* ============================================================
 *  持仓账本 · 核心算法  position-core.js
 * ============================================================
 *  设计原则（与 fng-core.js 一致）
 *  1) 单一真源：云端（Node，V4 的「按盈亏提醒」要用）与手机控制台
 *     （浏览器）共用**同一份代码**，浏览器版由 _tests/inject-core.js
 *     原样注入 console.html 的 POSITION-CORE 标记块，杜绝两端算不一致。
 *  2) 「没记持仓」≠「持仓为 0」：前者一律返回 null，界面要显示
 *     「未记录持仓」，绝不能显示成 0 元盈亏——那是误导。
 *  3) 纯函数：不碰 DOM、不发请求、不读配置；行情价由调用方传进来。
 *
 *  数据模型（V3 修正后）：持仓与监控是**两个独立的列表**
 *    config.stocks[]   = 监控清单（提醒条件 / 目标价），**不含**成本与股数
 *    config.holdings[] = 持仓清单（code / name / cost / qty）
 *  同一个代码可以同时出现在两个列表里（既监控又持有，最常见），
 *  也可以只出现在其中一个里（**持有着但不想要提醒** / **在监控但还没买**）。
 *  成本价或股数任一缺失、非数、非正数，一律视为「没记持仓」。
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

  /* ============================================================
   *  持仓清单（holdings）—— 与「监控清单」(stocks) 是**两个独立的列表**
   * ============================================================
   *  为什么必须分开：这两件事本来就是两批。
   *    · 持有一只股票，但不需要价格提醒（长期拿着，不想被吵）
   *    · 监控一只股票，但还没买（在等买点）
   *  所以持仓**不写在 stocks[] 上**，而是存在配置的 holdings[] 里：
   *    holdings: [{ code, name, cost, qty, addedAt }]
   *  同一个代码可以同时出现在两个列表里（既监控又持有），这是最常见的情况。
   *
   *  ⚠️ 2026-09-20 规格变更（用户拍板）：**持仓只记「持有哪一只」**，不再记成本/股数。
   *     cost/qty 保留仅为兼容老数据 —— 缺失或为 0 **不再视为无效记录**。
   *     由此浮盈 / 持仓市值 / 成本合计这些「账」在界面上整体撤下（没有基准就不算账）。
   * ============================================================ */

  /**
   * 规范化一条持仓记录。
   * @returns null 表示这条无效（代码不是 6 位数字）——
   *          **绝不因为一条脏数据让整页算错**，所以无效记录一律被丢弃。
   */
  function normHolding(h) {
    if (!h) return null;
    var code = (h.code === null || h.code === undefined) ? '' : String(h.code).trim();
    if (!/^\d{6}$/.test(code)) return null;
    var cost = num(h.cost), qty = num(h.qty);
    return {
      code: code,
      name: h.name ? String(h.name) : code,
      cost: cost > 0 ? cost : 0,
      qty: qty > 0 ? qty : 0,
      addedAt: h.addedAt || null
    };
  }

  /** 只保留有效持仓（过滤残缺记录） */
  function validHoldings(holdings) {
    var out = [], list = holdings || [];
    for (var i = 0; i < list.length; i++) {
      var r = normHolding(list[i]);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * 按代码查一条持仓。
   * 注意：命中了代码但字段残缺时返回 null —— 语义等同「没记持仓」，
   * 而不是返回一个成本为 0 的假记录。
   */
  function findHolding(holdings, code) {
    var c = String(code), list = holdings || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].code) === c) return normHolding(list[i]);
    }
    return null;
  }

  /** 新增或更新一条持仓。返回**新数组**（不改原数组，方便直接赋回配置） */
  function upsertHolding(holdings, rec) {
    var r = normHolding(rec), list = holdings || [];
    if (!r) return list.slice();
    var out = [], done = false;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].code) === r.code) {
        if (!done) {                       // 同代码重复记录只保留第一条（顺手去重）
          out.push({
            code: r.code,
            name: r.name || list[i].name || r.code,
            cost: r.cost,
            qty: r.qty,
            addedAt: list[i].addedAt || r.addedAt || null
          });
          done = true;
        }
        continue;
      }
      out.push(list[i]);
    }
    if (!done) out.push({ code: r.code, name: r.name || r.code, cost: r.cost, qty: r.qty, addedAt: r.addedAt || null });
    return out;
  }

  /** 删除一条持仓（按代码）。返回新数组 */
  function removeHolding(holdings, code) {
    var c = String(code), out = [], list = holdings || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].code) !== c) out.push(list[i]);
    }
    return out;
  }

  /**
   * 给每条持仓标上"是否也在监控中"。
   * 界面据此显示「监控中」标签，或给"未监控"的持仓提供「加入监控」入口。
   * @returns [{ holding, monitored }]
   */
  function holdingsWithFlag(holdings, stocks) {
    var codes = {}, i, list = stocks || [];
    for (i = 0; i < list.length; i++) codes[String(list[i].code)] = true;
    var out = [], hs = holdings || [];
    for (i = 0; i < hs.length; i++) {
      var r = normHolding(hs[i]);
      if (r) out.push({ holding: r, monitored: !!codes[r.code] });
    }
    return out;
  }

  /** 在监控列表里、但还没记持仓的股票（界面用来提供"快速添加持仓"） */
  function monitoredWithoutHolding(stocks, holdings) {
    var held = {}, i, list = stocks || [], hs = holdings || [];
    for (i = 0; i < hs.length; i++) {
      var r = normHolding(hs[i]);
      if (r) held[r.code] = true;
    }
    var out = [];
    for (i = 0; i < list.length; i++) {
      if (!held[String(list[i].code)]) out.push(list[i]);
    }
    return out;
  }

  /**
   * 旧结构迁移（V3 第一版把成本/股数写在了 stocks[] 上）。
   * 把 stocks[].cost/qty 挪进 holdings，并把这两个字段从股票上摘掉。
   * 幂等：已经迁移过再跑一次不会重复添加、也不会改动任何东西。
   * @returns { stocks, holdings, changed }
   */
  function migrateLegacy(stocks, holdings) {
    var hs = (holdings || []).slice(), outStocks = [], changed = false, list = stocks || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i], s2 = {}, k;
      for (k in s) {
        if (Object.prototype.hasOwnProperty.call(s, k) && k !== 'cost' && k !== 'qty') s2[k] = s[k];
      }
      if (s.cost !== undefined || s.qty !== undefined) {
        var r = normHolding(s);
        if (r && !findHolding(hs, s.code)) hs = upsertHolding(hs, r);
        changed = true;
      }
      outStocks.push(s2);
    }
    return { stocks: outStocks, holdings: hs, changed: changed };
  }

  return {
    VERSION: VERSION,
    FEE_NOTE: FEE_NOTE,
    normHolding: normHolding,
    validHoldings: validHoldings,
    findHolding: findHolding,
    upsertHolding: upsertHolding,
    removeHolding: removeHolding,
    holdingsWithFlag: holdingsWithFlag,
    monitoredWithoutHolding: monitoredWithoutHolding,
    migrateLegacy: migrateLegacy,
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
