/* ============================================================
 *  信号引擎 · 核心算法  signal-core.js
 * ============================================================
 *  设计原则（与 fng-core.js / position-core.js 同规格）
 *  1) 单一真源：云端（Node）与手机控制台（浏览器）共用**同一份代码**，
 *     浏览器版由 _tests/inject-core.js 原样注入 console.html 的
 *     SIGNAL-CORE 标记块，杜绝两端算不一致。
 *  2) 纯函数：不碰 DOM、不发请求、不读配置；K 线由调用方传进来。
 *  3) **每条信号都自带可验证的语义**，并落库存档，事后按
 *     「10 个交易日后涨跌 ±2%」判胜负（用户 2026-09-16 指定口径），
 *     用数据说话，而不是拍脑袋。参数集中、带版本号，改参数=换版本，
 *     胜率按版本分开统计，防止新旧规则混在一起看不出来。
 *
 *  ⚠️ 定位：研究型信号 + 胜率追踪，**不是投资建议**。
 *     小样本（前几周）的胜率没有参考意义。
 *
 *  信号口径（R1 版，2026-09-16 与用户确认）：
 *   止盈类（side='sell'，涨太猛先落袋）
 *     HOT_MA5_BIAS   连续 ≥2 日 开盘&收盘都站上 5 日线，且 5 日乖离率 ≥ +6%
 *                    ——即用户说的「连续2天在5日线上」，加上乖离过大才算过热，
 *                      否则按字面会天天喊卖，与中长期持股习惯冲突
 *     NEAR_PREV_HIGH 收盘价距 60 日内前高 ≤ 2%（触及前高压力位）
 *   离场类（side='sell'，防持续阴跌）
 *     TREND_BREAK    收盘跌破 20 日线，且 20 日线自身走平或向下
 *     GRIND_DOWN     连续 10 日收在 20 日线下、20 日累计跌 ≥8%、
 *                    期间单日涨幅 >3% 的天数 ≤1（真阴跌，不是回调）
 *   介入类（side='buy'，供监控清单参考）
 *     BOTTOM_RECLAIM 超跌（距 60 日最高收盘回撤 ≥15%）后，
 *                    收盘从下方向上重新站上 20 日线
 *
 *  胜负判定（judgeOutcome）
 *     卖出/离场信号：10 个交易日后收盘 ≤ 信号日收盘 × (1 − 2%) → 胜
 *     介入信号：    10 个交易日后收盘 ≥ 信号日收盘 × (1 + 2%) → 胜
 *     其余为平/未到期。卖出信号的"胜"= 价格真的跌下去了。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignalCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var RULE_VERSION = 'R1';

  /* ---------------- 参数（集中在这一处，改参数必须同时升 RULE_VERSION） ---------------- */
  var P = {
    biasMa: 5,             // 乖离率用的均线
    biasHoldDays: 2,       // 连续 ≥2 日开盘&收盘都站上该均线
    biasThreshold: 0.06,   // 5 日乖离率 ≥ +6% 视为短线过热
    trendMa: 20,           // 趋势线
    trendMaSlope: 5,       // 用 5 根前的 20 日线判断走向
    grindDays: 10,         // 阴跌：连续收在趋势线下方的天数
    grindDrop: -0.08,      // 阴跌：区间累计跌幅下限
    grindUpDays: 1,        // 阴跌：期间单日涨幅 >3% 的天数上限
    prevHighLookback: 60,  // 前高压力位回看窗口
    prevHighGap: 0.02,     // 距前高 ≤2% 视为"接近压力位"
    prevHighCap: 0.05,     // 但已有效突破前高 5% 以上就不再提示
    reclaimMa: 20,         // 介入：重新站上的均线
    reclaimDrawdown: -0.15,// 介入：距 60 日最高收盘的回撤下限（超跌）
    reclaimVolRatio: 1.1,  // 介入：当日量 / 5 日均量 ≥1.1（放量确认）
    cooldownDays: 5,       // 同一 (code, rule) 在 5 个交易日内不重复发
    winDays: 10,           // 胜率判定：10 个交易日后
    winBand: 0.02          // 胜率判定：±2%
  };

  /** 稳妥转数字：空串/null/非数字 → NaN */
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /**
   * 规范化 K 线数组。
   * @param raw 腾讯接口的原始行：[日期, 开, 收, 高, 低, 量]
   * @returns [{d,o,c,h,l,v}]（按日期升序），字段缺失/非法的行被丢弃
   */
  function normBars(raw) {
    var out = [], list = raw || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !r[0]) continue;
      var o = num(r[1]), c = num(r[2]), h = num(r[3]), l = num(r[4]), v = num(r[5]);
      if (!(c > 0)) continue;                       // 没有收盘价的行没法用
      if (!(h >= l)) continue;                      // 高低倒挂 = 脏数据
      out.push({ d: String(r[0]), o: o, c: c, h: h, l: l, v: v });
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    return out;
  }

  /** 简单移动平均：返回与输入等长的数组，前 n-1 位为 NaN */
  function sma(vals, n) {
    var out = new Array(vals.length);
    for (var i = 0; i < vals.length; i++) {
      if (i < n - 1) { out[i] = NaN; continue; }
      var s = 0;
      for (var k = i - n + 1; k <= i; k++) s += vals[k];
      out[i] = s / n;
    }
    return out;
  }

  /** 乖离率 = 现价 / 均线 − 1 */
  function bias(close, ma) {
    var c = num(close), m = num(ma);
    if (!isFinite(c) || !isFinite(m) || !(m > 0)) return NaN;
    return c / m - 1;
  }

  /** 以第 i 根为终点的 n 日均线（不依赖整段缓存，规则里逐日用自己的均线时用这个） */
  function maAt(bars, i, n) {
    if (!bars || i < n - 1 || i >= bars.length) return NaN;
    var s = 0;
    for (var k = i - n + 1; k <= i; k++) s += bars[k].c;
    return s / n;
  }

  /** 区间内（含 i，往前 n 根，不含 i 之前的）最高价；用于前高压力位 */
  function highestHigh(bars, endIdx, n) {
    var hi = NaN;
    for (var i = Math.max(0, endIdx - n + 1); i <= endIdx; i++) {
      var h = num(bars[i] && bars[i].h);
      if (isFinite(h) && (!(hi === hi) || h > hi)) hi = h;   // NaN 安全比较
    }
    return hi;
  }

  /** 区间内最高**收盘**价（回撤用它，比最高价保守） */
  function highestClose(bars, endIdx, n) {
    var hi = NaN;
    for (var i = Math.max(0, endIdx - n + 1); i <= endIdx; i++) {
      var c = num(bars[i] && bars[i].c);
      if (isFinite(c) && (!(hi === hi) || c > hi)) hi = c;
    }
    return hi;
  }

  /**
   * 计算一组指标（供 evaluate 与界面展示共用，避免算两遍）
   * @returns null（数据不足以算 20 日线）或
   *   { i, ma5, ma10, ma20, ma60, vol5, bias5, prevHigh, prevHighClose, drawdown }
   */
  function indicatorsAt(bars, i) {
    if (!bars || i < 0 || i >= bars.length) return null;
    if (bars.length < P.trendMa) return null;            // 连 20 日线都算不出，不硬给信号
    var closes = [], vols = [];
    for (var k = 0; k < bars.length; k++) { closes.push(bars[k].c); vols.push(bars[k].v); }
    var m5 = sma(closes, 5), m10 = sma(closes, 10), m20 = sma(closes, 20), m60 = sma(closes, 60);
    var v5 = sma(vols, 5), v20 = sma(vols, 20);
    var ph = highestHigh(bars, i - 1, P.prevHighLookback);   // 前高不含今天，否则永远"已突破"
    var pc = highestClose(bars, i - 1, P.prevHighLookback);
    var ind = {
      i: i,
      ma5: m5[i], ma10: m10[i], ma20: m20[i], ma60: m60[i],
      vol5: v5[i], vol20: v20[i],
      bias5: bias(bars[i].c, m5[i]),
      prevHigh: ph, prevHighClose: pc,
      drawdown: bias(bars[i].c, pc)                      // 现价相对区间最高收盘的位置（负数=在下方）
    };
    ind.ma20Prev = (i >= P.trendMaSlope) ? m20[i - P.trendMaSlope] : NaN;
    return ind;
  }

  /* ============================================================
   *  规则本体：每个函数返回 信号对象 或 null。相互独立、可单独关。
   *  统一约定：side='sell' 提醒卖出/离场，side='buy' 提醒关注介入。
   * ============================================================ */

  /** 止盈类：连续 N 日开收都站上**各自当天**的 5 日线 + 乖离过大 → 短线过热
   *  口径（用户 2026-09-16 确认）：每一天都用「截止到当日收盘」算出的 5 日线来比，
   *  即第 k 天跟 maAt(bars, k, 5) 比，不是拿今天的均线去套历史。 */
  function rHotMa5Bias(bars, i, ind) {
    if (!isFinite(ind.ma5) || !isFinite(ind.bias5)) return null;
    var need = P.biasHoldDays;
    if (i < need - 1) return null;
    for (var k = i - need + 1; k <= i; k++) {
      var m = maAt(bars, k, P.biasMa);
      if (!isFinite(m)) return null;
      if (!(bars[k].o > m && bars[k].c > m)) return null;   // 中间只要有一天没站上就不算
    }
    if (!(ind.bias5 >= P.biasThreshold)) return null;
    return {
      rule: 'HOT_MA5_BIAS', side: 'sell',
      title: '短线过热',
      detail: '连续 ' + need + ' 日开盘收盘都站上 5 日线，5 日乖离 +' + Math.round(ind.bias5 * 1000) / 10 + '%，涨得急，按纪律可先落袋一部分',
      price: bars[i].c, at: bars[i].d
    };
  }

  /** 止盈类：收盘价接近 60 日内前高（压力位） */
  function rNearPrevHigh(bars, i, ind) {
    var ph = ind.prevHigh;
    if (!isFinite(ph) || !(ph > 0)) return null;
    var c = bars[i].c;
    var lo = ph * (1 - P.prevHighGap), hi = ph * (1 + P.prevHighCap);
    if (!(c >= lo && c <= hi)) return null;
    return {
      rule: 'NEAR_PREV_HIGH', side: 'sell',
      title: '触及前高压力位',
      detail: '现价距 ' + P.prevHighLookback + ' 日内前高 ' + ph.toFixed(2) + ' 不足 ' + Math.round(P.prevHighGap * 100) + '%，前高常有套牢盘，冲不过去就先减',
      price: c, at: bars[i].d
    };
  }

  /** 离场类：跌破 20 日线且趋势线走平向下 */
  function rTrendBreak(bars, i, ind) {
    if (!isFinite(ind.ma20)) return null;
    if (!(bars[i].c < ind.ma20)) return null;
    var flat = !isFinite(ind.ma20Prev) || ind.ma20 <= ind.ma20Prev;
    if (!flat) return null;
    return {
      rule: 'TREND_BREAK', side: 'sell',
      title: '跌破 20 日线',
      detail: '收盘 ' + bars[i].c.toFixed(2) + ' 已在 20 日线 ' + ind.ma20.toFixed(2) + ' 下方，20 日线走平向下，趋势转弱',
      price: bars[i].c, at: bars[i].d
    };
  }

  /** 离场类：持续阴跌（不是回调）——用户点名要杜绝的情况 */
  function rGrindDown(bars, i, ind) {
    var n = P.grindDays;
    if (i < n) return null;
    for (var k = i - n + 1; k <= i; k++) {
      var m = maAt(bars, k, P.trendMa);
      if (!isFinite(m) || !(bars[k].c < m)) return null;   // 期间每一天都得在趋势线下方
    }
    var base = bars[i - n].c;
    var ret = base > 0 ? bars[i].c / base - 1 : NaN;
    if (!isFinite(ret) || !(ret <= P.grindDrop)) return null;
    var strongUp = 0;
    for (k = i - n + 1; k <= i; k++) {
      var prev = bars[k - 1].c;
      if (prev > 0 && bars[k].c / prev - 1 > 0.03) strongUp++;
    }
    if (strongUp > P.grindUpDays) return null;
    return {
      rule: 'GRIND_DOWN', side: 'sell',
      title: '持续阴跌',
      detail: '连续 ' + n + ' 日收在 20 日线下方，区间累计 ' + Math.round(ret * 1000) / 10 + '%，且没有像样的反弹——下跌趋势中，别用"长期持有"安慰自己',
      price: bars[i].c, at: bars[i].d
    };
  }

  /** 介入类：超跌后重新站上 20 日线（供监控清单参考，不是买入指令） */
  function rBottomReclaim(bars, i, ind) {
    if (!isFinite(ind.ma20) || !isFinite(ind.drawdown)) return null;
    if (i < 1) return null;
    if (!(ind.drawdown <= P.reclaimDrawdown)) return null;   // 必须先超跌
    var prev = bars[i - 1];
    var c = bars[i].c;
    var m20 = ind.ma20;
    if (!(prev.c < m20 && c >= m20)) return null;            // 昨天在线下、今天站上线
    if (isFinite(ind.vol5) && isFinite(ind.vol20) && !(ind.vol5 >= ind.vol20)) return null; // 量能不能萎缩
    var ddPct = Math.round(ind.drawdown * 1000) / 10;
    return {
      rule: 'BOTTOM_RECLAIM', side: 'buy',
      title: '超跌企稳',
      detail: '距 60 日最高收盘仍回撤 ' + ddPct + '%，今日收盘重新站上 20 日线且量能未萎缩——观察是否站稳，别一次满仓',
      price: c, at: bars[i].d
    };
  }

  var RULES = [rHotMa5Bias, rNearPrevHigh, rTrendBreak, rGrindDown, rBottomReclaim];

  /**
   * 对某只股票的最后一根（或指定根）K 线跑全部规则。
   * @param bars 规范化后的 K 线（升序）
   * @returns null（数据不足）或 { ind, signals:[{rule,side,title,detail,price,at}] }
   */
  function evaluate(bars, endIdx) {
    bars = bars || [];
    var i = (endIdx === undefined || endIdx === null) ? bars.length - 1 : endIdx;
    var ind = indicatorsAt(bars, i);
    if (!ind) return null;
    var sigs = [];
    for (var r = 0; r < RULES.length; r++) {
      var s = RULES[r](bars, i, ind);
      if (s) sigs.push(s);
    }
    return { ind: ind, signals: sigs };
  }

  /** 全量跑：对最近 N 根（默认 1 根）逐日评估，用于补算/回测 */
  function evaluateRange(bars, n) {
    bars = bars || [];
    var out = [], from = Math.max(0, bars.length - (n || 1));
    for (var i = from; i < bars.length; i++) {
      var r = evaluate(bars, i);
      if (r && r.signals.length) out.push({ at: bars[i].d, signals: r.signals });
    }
    return out;
  }

  /* ============================================================
   *  胜率判定：10 个交易日后 ±2%（用户指定口径）
   * ============================================================ */

  /** 信号日之后第 n 个交易日的收盘价；不够 n 根 → null（未到期） */
  function closeAfter(bars, dateStr, n) {
    bars = bars || [];
    var idx = -1;
    for (var i = 0; i < bars.length; i++) if (bars[i].d === String(dateStr)) { idx = i; break; }
    if (idx < 0) return null;                     // 存档里日期对不上（停牌/数据缺口）
    var j = idx + n;
    if (j >= bars.length) return null;
    return { date: bars[j].d, price: bars[j].c };
  }

  /**
   * 给一条信号判胜负。
   * @returns {state:'win'|'lose'|'flat'|'pending'|'nodata', ret, resolveDate}
   *   卖出信号：未来跌幅 ≤ −2% → win（提示对了）；涨幅 ≥ +2% → lose；之间 → flat
   *   介入信号：未来涨幅 ≥ +2% → win；跌幅 ≤ −2% → lose
   */
  function judgeOutcome(sig, bars, opt) {
    var n = (opt && opt.winDays) || P.winDays;
    var band = (opt && opt.winBand) || P.winBand;
    var fut = closeAfter(bars, sig.at, n);
    if (!fut) return { state: 'pending', ret: NaN, resolveDate: null };
    var ret = fut.price / sig.price - 1;
    var eff = sig.side === 'buy' ? ret : -ret;     // 卖出信号的"对"= 接下来真跌
    var state = eff >= band ? 'win' : (eff <= -band ? 'lose' : 'flat');
    return { state: state, ret: ret, resolveDate: fut.date };
  }

  /** 把一堆已判定信号按规则汇总（供"规则体检"用） */
  function winrateStats(judged) {
    var by = {};
    var list = judged || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].rule || 'UNKNOWN';
      if (!by[r]) by[r] = { rule: r, n: 0, win: 0, lose: 0, flat: 0, pending: 0, retSum: 0 };
      var b = by[r];
      b.n++;
      var st = list[i].verdict && list[i].verdict.state;
      if (st === 'win') b.win++;
      else if (st === 'lose') b.lose++;
      else if (st === 'flat') b.flat++;
      else b.pending++;
      if (st === 'win' || st === 'lose' || st === 'flat') {
        b.retSum += (isFinite(list[i].verdict.ret) ? list[i].verdict.ret : 0);
      }
    }
    var out = [];
    for (var k in by) {
      if (!Object.prototype.hasOwnProperty.call(by, k)) continue;
      var s = by[k], done = s.win + s.lose + s.flat;
      out.push({
        rule: s.rule, n: s.n, win: s.win, lose: s.lose, flat: s.flat, pending: s.pending,
        done: done,
        winRate: done ? s.win / done : NaN,                 // 胜率只按已判定的算
        avgRet: done ? s.retSum / done : NaN                // 平均收益按全部已判定的算（含平局，那也是真实结果）
      });
    }
    out.sort(function (a, b) { return b.n - a.n; });
    return out;
  }

  return {
    VERSION: VERSION,
    RULE_VERSION: RULE_VERSION,
    P: P,
    num: num,
    normBars: normBars,
    sma: sma,
    maAt: maAt,
    bias: bias,
    highestHigh: highestHigh,
    highestClose: highestClose,
    indicatorsAt: indicatorsAt,
    evaluate: evaluate,
    evaluateRange: evaluateRange,
    closeAfter: closeAfter,
    judgeOutcome: judgeOutcome,
    winrateStats: winrateStats
  };
});
