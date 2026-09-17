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
 *  信号口径（R3 版，2026-09-17 用户新增"多头排列"前提）：
 *   止盈类（side='sell'，涨太猛先落袋）
 *     MA5_STREAK_EXIT 连续 ≥2 日 开盘&收盘都站上 5 日线 → 提醒卖出
 *                    ——即用户 2026-09-17 说的「连续 2 天及以上都高于 5 日线就提醒卖出」。
 *                      与 HOT_MA5_BIAS 的区别：**不加乖离条件**，门槛更低、更常触发；
 *                      与「持仓页 5 日线标识」用的是同一套天数口径（见 ma5Streak）。
 *     ⚠️ **前提（用户 2026-09-17 追加）：必须均线多头排列 —— MA5 > MA10 > MA20 > MA30，
 *        否则这条判断整体不生效**（不触发推送，持仓页也不显示天数标识）。
 *        理由：均线纠缠/空头排列时，单日"站上 5 日线"只是噪声，不是短线偏热。
 *        实现放在 maAlign()，是这条前提的**单一真源**（规则与界面都走它）。
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
  /* ★ R3（2026-09-17）：MA5_STREAK_EXIT 增加「均线多头排列」前提（MA5>MA10>MA20>MA30）。
     改规则/参数必须升版本：判断口径变了，新旧胜负混在一起统计就白改了。
     ⚠️ 这个"分开统计"不是自动的 —— 调用 winrateStats 时必须显式传 { onlyVersion: RULE_VERSION }，
     忘了传就等于全量混算（2026-09-17 发现过这个缺口，别再踩）。 */
  var RULE_VERSION = 'R3';

  /* ---------------- 参数（集中在这一处，改参数必须同时升 RULE_VERSION） ---------------- */
  var P = {
    biasMa: 5,             // 乖离率用的均线
    biasHoldDays: 2,       // 连续 ≥2 日开盘&收盘都站上该均线
    biasThreshold: 0.06,   // 5 日乖离率 ≥ +6% 视为短线过热
    ma5ExitDays: 2,        // 离场提醒：连续 ≥2 日开盘&收盘都站上 5 日线（用户 2026-09-17 指定，不加乖离条件）
    alignMas: [5, 10, 20, 30],  // ★ 多头排列要逐级比较的均线：MA5 > MA10 > MA20 > MA30（用户 2026-09-17 指定的前提）
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

  /** 止盈类（用户 2026-09-17 指定）：连续 ≥2 日开收盘都站上 5 日线 → 提醒卖出
   *
   *  用户原话：「日线开盘、收盘价格连续 2 天及以上都高于 5 日线价格，就提醒卖出显示及信息提示」。
   *  与 rHotMa5Bias 的区别：**不加 5 日乖离条件**，门槛更低、更常触发。
   *
   *  ⚠️ **前提**（用户 2026-09-17 追加）：「5 日线 > 10 日线 > 20 日线 > 30 日线」时才有效，
   *     其他情况不触发判断。判定在 maAlign（单一真源），这里显式挡一道让规则读得懂；
   *     ma5Streak 内部也会用它，所以推送与持仓页标识**永远同时生效或同时不生效**。
   *
   *  天数口径**直接复用 ma5Streak**（持仓页那个状态标识）——
   *  保证「推送里说的天数」和「持仓页显示的天数」永远是同一个数；
   *  两处各写一份必然会漂移，这是本项目的硬约定（算法单一真源）。
   *
   *  防轰炸：靠 cooldownDays（5 个交易日）。这个条件是**持续满足型**，
   *  不设冷却就会在连涨期间天天喊卖；设了之后最多每 5 个交易日提醒一次。 */
  function rMa5StreakExit(bars, i, ind) {
    if (!isFinite(ind.ma5)) return null;
    if (!maAlign(bars, i).ok) return null;          // ★ 非多头排列 → 不触发判断（用户 2026-09-17）
    var st = ma5Streak(bars, i);
    var need = P.ma5ExitDays;
    if (!(st.days >= need)) return null;
    return {
      rule: 'MA5_STREAK_EXIT', side: 'sell',
      title: '连续站上 5 日线',
      detail: '连续 ' + st.days + ' 天开盘收盘都站上 5 日线（' + st.from + ' 起），且均线多头排列' +
        '（5 日 > 10 日 > 20 日 > 30 日），短线偏热，按纪律可先落袋一部分 —— 是减仓提示，不是必须清仓',
      price: bars[i].c, at: bars[i].d
    };
  }

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

  var RULES = [rMa5StreakExit, rHotMa5Bias, rNearPrevHigh, rTrendBreak, rGrindDown, rBottomReclaim];

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

  /** 把一堆已判定信号按规则汇总（供"规则体检"用）
   *
   *  @param judged 已判定（或待判定）的信号数组
   *  @param opt    { onlyVersion: 'R3' } —— **只统计这个口径版本**的信号，不传则全量。
   *
   *  ⚠️ 为什么要按版本隔离：改规则/参数必须升 RULE_VERSION（见文件头），
   *     升版本就意味着**判断口径变了**。把新旧口径的胜负混进同一个胜率里，
   *     正好抹掉"改完到底变好没有"这个唯一有价值的结论（R3 就是收窄了 MA5_STREAK_EXIT）。
   *     注意隔离的后果：刚升版本时当前版本样本是 0，报告会先空一阵——
   *     这是**如实**的，调用方要把"排除了多少条旧版本"一起打出来，别让报告变成一句空话。 */
  function winrateStats(judged, opt) {
    var onlyVer = (opt && opt.onlyVersion) ? String(opt.onlyVersion) : null;
    var by = {};
    var list = judged || [];
    for (var i = 0; i < list.length; i++) {
      // 版本对不上就跳过（含未标版本的旧数据：宁可不算，也不要算错）
      if (onlyVer && String(list[i] && list[i].ruleVersion) !== onlyVer) continue;
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

  /**
   * 均线多头排列 —— **用户 2026-09-17 明确的判断前提**
   *
   *   原话：「当 5 日线大于 10 日线，10 日线大于 20 日线，20 日线大于 30 日线情况下才有效，
   *          其他情况不触发判断。」
   *
   *   即严格逐级递减：MA5 > MA10 > MA20 > MA30（都用**截止当日**收盘算出来的值）。
   *   任何一级不满足（含数据不足 30 根算不出 30 日线）→ ok=false。
   *
   *  ⚠️ 这是「5 日线连续站上」这条口径的**单一真源**：
   *     · 云端推送规则 rMa5StreakExit 走它；
   *     · 持仓页/首页的 5 日线标识（ma5Streak）也走它。
   *     两者必须同时生效/同时不生效，否则会出现"页面提示落袋、微信却没推"的错位。
   *
   * @param bars   升序 K 线（{d,o,c,h,l,v}）
   * @param endIdx 截止到哪一根（默认最后一根）
   * @returns { ok, ma5, ma10, ma20, ma30 }   ok=false 时四个均线可能含 NaN
   */
  function maAlign(bars, endIdx) {
    var miss = { ok: false, ma5: NaN, ma10: NaN, ma20: NaN, ma30: NaN };
    if (!bars || !bars.length) return miss;
    var i = (typeof endIdx === 'number' && endIdx >= 0 && endIdx < bars.length) ? endIdx : bars.length - 1;
    var ns = P.alignMas, vs = [], k;
    for (k = 0; k < ns.length; k++) {
      var m = maAt(bars, i, ns[k]);
      if (!isFinite(m)) return miss;                 // 少一根均线就算不出来 → 前提不成立（不硬算）
      vs.push(m);
    }
    var ok = true;
    for (k = 1; k < vs.length; k++) {
      if (!(vs[k - 1] > vs[k])) { ok = false; break } // 逐级比：5>10>20>30，相等也不算
    }
    return { ok: ok, ma5: vs[0], ma10: vs[1], ma20: vs[2], ma30: vs[3] };
  }

  /**
   * 5 日线连续站上 —— **用户 2026-09-17 指定的持仓状态标识口径**
   *
   *   「日线开盘、收盘价格连续 2 天及以上都高于 5 日线价格，就提醒卖出并给信息提示；
   *     只有 1 天高于 5 日线就给出天数标识；一天都没有则不显示。」
   *
   *   ⚠️ **前提（用户 2026-09-17 追加）**：必须均线多头排列（MA5>MA10>MA20>MA30，见 maAlign）。
   *      不满足 → 整条判断不生效：days=0、sig=null（持仓页不渲染任何 5 日线标识、推送也不发）。
   *      这不是"扣分项"而是"开关"—— 均线纠缠时站上 5 日线只是噪声。
   *
   *  与 rHotMa5Bias（HOT_MA5_BIAS 信号）的区别，别混：
   *    · rHotMa5Bias 是**云端推送用的过热信号**，额外要求 5 日乖离 ≥ +6%，
   *      门槛高、不常触发，用于"涨太猛了先落袋"。**该规则不受多头排列限制**（它自带乖离门槛）。
   *    · ma5Streak 是**持仓页的状态标识**，只看天数、不加乖离条件，
   *      用于每天都能看到"这只票在 5 日线上站了几天"。
   *
   *  口径细节：每一天都跟「截止到该日收盘算出的 5 日线」比（逐日各用自己的均线），
   *  不是拿今天的均线去套历史 —— 与 rHotMa5Bias 完全一致，避免口径漂移。
   *
   * @param bars   升序 K 线（{d,o,c,h,l,v}）
   * @param endIdx 截止到哪一根（默认最后一根）
   * @returns { days, sig, ma5, from, to, aligned, ma10, ma20, ma30 }
   *   aligned = 是否满足均线多头排列（MA5>MA10>MA20>MA30）—— 为 false 时 days 恒为 0
   *   days = 从最新往前连续站上的天数（0 表示最新一天没站上，或前提不成立）
   *   sig  = days>=2 → 'sell'（提醒卖出）；days===1 → 'watch'（只标天数）；0 → null（不显示）
   */
  function ma5Streak(bars, endIdx) {
    if (!bars || !bars.length) return { days: 0, sig: null, ma5: NaN, from: '', to: '', aligned: false };
    var i = (typeof endIdx === 'number' && endIdx >= 0 && endIdx < bars.length) ? endIdx : bars.length - 1;
    var al = maAlign(bars, i);
    /* ★ 多头排列前提不成立 → 整条判断不生效（用户 2026-09-17：「其他情况不触发判断」）：
       days 直接给 0，界面按既有约定"0 天不渲染"，推送也不会触发。 */
    if (!al.ok) {
      return {
        days: 0, sig: null, ma5: maAt(bars, i, P.biasMa),
        from: '', to: '', aligned: false,
        ma10: al.ma10, ma20: al.ma20, ma30: al.ma30
      };
    }
    var n = 0;
    for (var k = i; k >= 0; k--) {
      var m = maAt(bars, k, P.biasMa);
      if (!isFinite(m)) break;
      if (bars[k].o > m && bars[k].c > m) n++;
      else break;
    }
    var sig = (n >= P.biasHoldDays) ? 'sell' : (n === 1 ? 'watch' : null);
    return {
      days: n, sig: sig,
      ma5: maAt(bars, i, P.biasMa),
      from: n > 0 ? bars[i - n + 1].d : '',
      to: n > 0 ? bars[i].d : '',
      aligned: true,
      ma10: al.ma10, ma20: al.ma20, ma30: al.ma30
    };
  }

  /**
   * 按「清单类型」过滤信号 —— 清单语义的单一真源。
   *
   *   监控清单（listKind='monitor'，只监控、还没买）：
   *     不收 MA5_STREAK_EXIT。用户 2026-09-17 的原话是「**持仓股**……连续 2 天及以上
   *     都高于 5 日线就提醒卖出」—— 对一只还没买的票喊"卖出"没有意义，
   *     反而会让人以为自己持有。其余信号（跌破 20 日线、超跌企稳等）照常收。
   *   持仓清单（'holdings' / 'both'，真金白银在里面）：
   *     全收，含 MA5_STREAK_EXIT。
   *
   * ⚠️ 放在核心里的原因：过滤规则是"业务口径"，测试必须能直接调它，
   *    而不是在测试里复制一遍表达式（复制出来的那份迟早和线上不一致）。
   */
  function signalsForList(signals, listKind) {
    var list = signals || [];
    if (listKind === 'monitor') {
      return list.filter(function (s) { return s.rule !== 'MA5_STREAK_EXIT'; });
    }
    return list.slice();
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
    winrateStats: winrateStats,
    ma5Streak: ma5Streak,
    maAlign: maAlign,
    signalsForList: signalsForList
  };
});
