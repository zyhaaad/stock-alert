/* ============================================================
 *  A股恐贪指数 · 核心算法  fng-core.js
 * ============================================================
 *  设计原则
 *  1) 单一真源：云端每日记录（Node）与手机控制台（浏览器）用的是
 *     **同一份文件、同一段代码**，浏览器版由构建脚本原样注入，
 *     从根上杜绝"两端算得不一样"。
 *  2) 当天定稿即永久不变：每个交易日的分值只用"截至当天"的历史
 *     计算（滚动百分位），因此一旦写入存档，日后回看永远一致。
 *  3) 只用可回溯 3 年的数据源，保证"2年 / 全部"曲线不是从零开始。
 *
 *  指数构成（0-100，越大越贪婪）
 *    趋势动量   20%  中证全指 收盘 / MA20 - 1
 *    波动率     15%  中证全指 20 日对数收益年化波动率（**反向**：波动越大越恐慌）
 *    量能热度   15%  中证全指 5 日均量 / 20 日均量 - 1
 *    融资余额动能 25% 融资余额近 20 个交易日变化率
 *    融资净买入强度 25% 近 5 日融资净买入合计 / 流通市值
 *
 *  归一化：每个分项在"过去 252 个交易日"窗口内取中位秩百分位（0-100），
 *          再按权重加权求和。分项原始值随存档保存，控制台可用同一窗口
 *          现场算出"今天"的盘中值。
 *
 *  数据源（均为公开接口）
 *    中证全指日线：腾讯 web.ifzq.gtimg.cn（支持 CORS，浏览器可直连）
 *    两融历史    ：东方财富 datacenter-web（T+1 披露，取"最近已披露"值）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FNGCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var VERSION = 1;

  /** 分项定义：k=存档键名，w=权重，invert=true 表示原始值越大越"恐惧" */
  var COMPONENTS = [
    { k: 'mom', name: '趋势动量', w: 0.20, invert: false, desc: '中证全指相对 20 日均线的偏离' },
    { k: 'vol', name: '波动率', w: 0.15, invert: true, desc: '20 日年化波动率，波动越大越恐慌' },
    { k: 'vlm', name: '量能热度', w: 0.15, invert: false, desc: '5 日均量相对 20 日均量的放大程度' },
    { k: 'mgn', name: '融资余额动能', w: 0.25, invert: false, desc: '融资余额近 20 个交易日变化率' },
    { k: 'mbs', name: '融资净买入强度', w: 0.25, invert: false, desc: '5 日融资净买入合计 / 流通市值' }
  ];

  var WIN = 252;      // 百分位窗口（交易日）
  var MIN_WIN = 60;   // 窗口最少样本数，不足则当日不出值
  var ANN = 244;      // 年化交易日数

  /** 情绪分区（越大越贪婪）。hint 必须是有指向的提示，不能是「观望为主」这类通用话术 */
  var ZONES = [
    { min: 75, lvl: 4, text: '极度贪婪', hint: '情绪亢奋、赚钱效应最好，也最容易套人' },
    { min: 60, lvl: 3, text: '贪婪', hint: '资金活跃、情绪偏热，适合逐步兑现而非继续加仓' },
    { min: 40, lvl: 2, text: '中性', hint: '多空相对均衡，情绪本身不提供方向' },
    { min: 25, lvl: 1, text: '恐惧', hint: '情绪偏冷，是分批布局的区间而不是清仓的区间' },
    { min: -1, lvl: 0, text: '极度恐惧', hint: '情绪冰冷、持股难受，但往往离回暖最近——别割在低点' }
  ];

  /** 曲线周期（n=交易日数，0 表示全部） */
  var PERIODS = [
    { k: '7d', name: '7天', n: 7 },
    { k: '30d', name: '30天', n: 30 },
    { k: '90d', name: '90天', n: 90 },
    { k: '6m', name: '6个月', n: 126 },
    { k: '1y', name: '1年', n: 252 },
    { k: '2y', name: '2年', n: 504 },
    { k: 'all', name: '全部', n: 0 }
  ];

  /* ---------------- 基础统计 ---------------- */

  function mean(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  /** 总体标准差 */
  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
    return Math.sqrt(s / a.length);
  }

  /**
   * 中位秩百分位：v 在 win 中的位置，返回 0-100。
   * 用中位秩（相等值各算半个）保证单调、对称，且不会出现 0 或 100 的边界死值。
   */
  function pctRank(win, v) {
    var n = win.length;
    if (!n || v == null || isNaN(v)) return null;
    var below = 0, eq = 0;
    for (var i = 0; i < n; i++) {
      var x = win[i];
      if (x == null || isNaN(x)) continue;
      if (x < v) below++;
      else if (x === v) eq++;
    }
    return 100 * (below + 0.5 * eq) / n;
  }

  function validNum(x) { return x != null && typeof x === 'number' && !isNaN(x) && isFinite(x); }

  /* ---------------- 原始分项值 ---------------- */

  /**
   * 取"日期严格早于 d"的最近一条两融记录的下标（两融 T+1 披露）。
   * margin 必须按日期升序排列。
   */
  function marginIndexBefore(margin, d) {
    if (!margin || !margin.length) return -1;
    for (var i = margin.length - 1; i >= 0; i--) {
      if (margin[i].d < d) return i;
    }
    return -1;
  }

  /**
   * 计算第 i 天的 5 个分项原始值。
   * kline: { d:[], o:[], c:[], h:[], l:[], v:[] }（升序，含当天）
   * margin: [{d,rzye,rzjme,ltsz}]（升序）
   */
  function rawsAt(kline, margin, i) {
    var out = { mom: null, vol: null, vlm: null, mgn: null, mbs: null };
    var c = kline.c, v = kline.v, d = kline.d;

    // 趋势动量：收盘 / MA20 - 1
    if (i >= 19) {
      var s = 0;
      for (var j = i - 19; j <= i; j++) s += c[j];
      out.mom = c[i] / (s / 20) - 1;
    }

    // 波动率：20 日对数收益年化标准差
    if (i >= 20) {
      var r = [];
      for (var k = i - 19; k <= i; k++) r.push(Math.log(c[k] / c[k - 1]));
      out.vol = stdev(r) * Math.sqrt(ANN);
    }

    // 量能热度：5 日均量 / 20 日均量 - 1
    if (i >= 19) {
      var s5 = 0;
      for (var a = i - 4; a <= i; a++) s5 += v[a];
      var s20 = 0;
      for (var b = i - 19; b <= i; b++) s20 += v[b];
      if (s20 > 0) out.vlm = (s5 / 5) / (s20 / 20) - 1;
    }

    // 融资类：用"日期严格早于当天"的最近一条两融记录
    var mi = marginIndexBefore(margin, d[i]);
    if (mi >= 20) {
      var cur = margin[mi];
      if (validNum(cur.rzye) && validNum(margin[mi - 20].rzye) && margin[mi - 20].rzye !== 0) {
        out.mgn = cur.rzye / margin[mi - 20].rzye - 1;
      }
      var jm = 0, ok = true;
      for (var q = mi - 4; q <= mi; q++) {
        if (!validNum(margin[q].rzjme)) { ok = false; break; }
        jm += margin[q].rzjme;
      }
      if (ok && validNum(cur.ltsz) && cur.ltsz !== 0) out.mbs = jm / cur.ltsz;
    }
    return out;
  }

  /**
   * 用"历史 raw 序列 + 当天的 raw"算出当天分值 —— 盘中与收盘共用此函数。
   * histRaws: 截至**前一日**的 raw 数组（升序，可任意长，只取最近 win-1 个）
   * curRaw  : 当天的 raw
   * 返回 { v, parts, used } ；样本不足返回 { v:null, reason }
   */
  function computeLive(histRaws, curRaw, opts) {
    opts = opts || {};
    var win = opts.win || WIN;
    var minWin = opts.minWin || MIN_WIN;
    var comps = opts.components || COMPONENTS;

    if (!curRaw) return { v: null, reason: 'no-raw' };

    var tail = histRaws.length > win - 1 ? histRaws.slice(histRaws.length - (win - 1)) : histRaws;
    var parts = {}, total = 0, wsum = 0;

    for (var i = 0; i < comps.length; i++) {
      var cp = comps[i], k = cp.k;
      var cv = curRaw[k];
      if (!validNum(cv)) return { v: null, reason: 'raw-missing:' + k };

      var w = [];
      for (var j = 0; j < tail.length; j++) {
        if (validNum(tail[j][k])) w.push(tail[j][k]);
      }
      if (w.length < minWin) return { v: null, reason: 'window-too-short:' + k };

      var p = pctRank(w.concat([cv]), cv);
      if (p == null) return { v: null, reason: 'pct-fail:' + k };
      if (cp.invert) p = 100 - p;

      parts[k] = Math.round(p * 10) / 10;
      total += cp.w * p;
      wsum += cp.w;
    }

    if (!wsum) return { v: null, reason: 'no-weight' };
    return { v: Math.round(total / wsum * 10) / 10, parts: parts };
  }

  /* ---------------- 序列构建 ---------------- */

  /**
   * 构建完整序列。
   * days  : [{d,o,c,h,l,v}] 升序
   * margin: [{d,rzye,rzjme,ltsz}] 升序
   * 返回 { raws:[...], series:[{d,v,parts,raw}], margin }
   */
  function buildSeries(days, margin, opts) {
    var kline = { d: [], o: [], c: [], h: [], l: [], v: [] };
    for (var i = 0; i < days.length; i++) {
      var x = days[i];
      kline.d.push(x.d); kline.o.push(x.o); kline.c.push(x.c);
      kline.h.push(x.h); kline.l.push(x.l); kline.v.push(x.v);
    }
    var raws = [];
    for (var a = 0; a < days.length; a++) raws.push(rawsAt(kline, margin, a));

    var series = [];
    for (var b = 0; b < days.length; b++) {
      var r = computeLive(raws.slice(0, b), raws[b], opts);
      series.push({ d: days[b].d, v: r.v, parts: r.parts || null, raw: raws[b] });
    }
    return { raws: raws, series: series, kline: kline };
  }

  /** 两融快照：供控制台在盘中算"今天"的融资类分项 */
  function marginSnapshot(margin) {
    if (!margin || margin.length < 21) return null;
    var mi = margin.length - 1;
    var jm = 0;
    for (var q = mi - 4; q <= mi; q++) jm += margin[q].rzjme;
    var rzye20 = margin[mi - 20].rzye;
    return {
      d: margin[mi].d,
      rzye: margin[mi].rzye,
      rzye20: rzye20,
      rzjme5: jm,
      ltsz: margin[mi].ltsz
    };
  }

  /** 由两融快照得到当天的融资类 raw（与云端同日算法一致） */
  function rawsFromMarginSnap(snap) {
    if (!snap || !validNum(snap.rzye) || !validNum(snap.rzye20) || !snap.rzye20) return { mgn: null, mbs: null };
    return {
      mgn: snap.rzye / snap.rzye20 - 1,
      mbs: (validNum(snap.ltsz) && snap.ltsz) ? snap.rzjme5 / snap.ltsz : null
    };
  }

  /* ---------------- 展示辅助 ---------------- */

  function zone(v) {
    if (!validNum(v)) return { lvl: -1, text: '暂无数据', hint: '历史样本积累中' };
    for (var i = 0; i < ZONES.length; i++) {
      if (v >= ZONES[i].min) return ZONES[i];
    }
    return ZONES[ZONES.length - 1];
  }

  /** 取最近 n 个交易日（n=0 或省略则全部），自动跳过早期空值 */
  function slicePeriod(series, n) {
    var s = series || [];
    var out = n > 0 ? s.slice(Math.max(0, s.length - n)) : s.slice(0);
    while (out.length && out[0].v == null) out.shift();
    return out;
  }

  /** 区间统计：最高/最低/均值/当前 */
  function stats(series) {
    var vs = [];
    for (var i = 0; i < series.length; i++) if (validNum(series[i].v)) vs.push(series[i].v);
    if (!vs.length) return null;
    return {
      n: vs.length,
      cur: series[series.length - 1].v,
      max: Math.max.apply(null, vs),
      min: Math.min.apply(null, vs),
      avg: Math.round(mean(vs) * 10) / 10
    };
  }

  /** 存档序列化：数组紧凑格式，减小文件体积 */
  function packSeries(series, raws) {
    var arr = [];
    for (var i = 0; i < series.length; i++) {
      var r = raws[i];
      arr.push([
        series[i].d,
        series[i].v == null ? null : series[i].v,
        sig(r.mom), sig(r.vol), sig(r.vlm), sig(r.mgn), sig(r.mbs)
      ]);
    }
    return arr;
  }

  /** 6 位有效数字，既保精度又压体积 */
  function sig(x) {
    if (!validNum(x)) return null;
    if (x === 0) return 0;
    return Number(x.toPrecision(6));
  }

  function unpackSeries(arr) {
    var series = [], raws = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var row = arr[i];
      var raw = { mom: num(row[2]), vol: num(row[3]), vlm: num(row[4]), mgn: num(row[5]), mbs: num(row[6]) };
      raws.push(raw);
      series.push({ d: row[0], v: num(row[1]), raw: raw });
    }
    return { series: series, raws: raws };
  }

  function num(x) { return (x == null || x === '') ? null : Number(x); }

  /** 交易日推算：把 n 个交易日折算成日历天数（用于抓取足够的 K 线） */
  function calendarDaysFor(n) { return Math.ceil(n * 365 / ANN * 1.15) + 30; }

  /* ---------------- 操作建议（与 ZONES 一一对应，索引 = lvl） ----------------
   * 分组前瞻收益为实证结果：2022-02 ~ 2026-09 共 1120 个有效交易日，
   * 按当日分值分组后统计「之后 60 个交易日」的平均涨跌幅。
   * 建议必须与所处阶段强相关，禁止出现"观望为主"这种放之四海皆准的空话。
   * -------------------------------------------------------------------- */

  var FORWARD = {
    fear:    { n: 380, r60:  4.02, label: '恐惧区（<40）' },
    neutral: { n: 357, r60:  0.63, label: '中性区（40–60）' },
    greed:   { n: 383, r60: -0.67, label: '贪婪区（≥60）' }
  };

  /** lvl → 前瞻统计分组键 */
  function zoneKey(lvl) { return lvl <= 1 ? 'fear' : (lvl === 2 ? 'neutral' : 'greed'); }

  var SHARED_NOTE = '以上是历史统计规律，不是对点位的预测。它的用处只有一个：'
    + '在别人最恐慌的时候别割肉，在别人最亢奋的时候别追高。这两件事做到，长期结果就明显不同。';

  var ADVICE = [
    { /* lvl 0 极度恐惧 */
      view: '近一年最冷的位置。历史上这一类区间之后 60 个交易日平均是「涨」的，但过程通常很难受：'
        + '可能还有最后一跌，阴跌、放量杀跌、反复磨底都很常见。'
        + '换句话说——「持股体验最差」和「离回暖最近」，往往就是同一段时间。',
      do: [
        '这本来就是给「想买但一直没敢买」的人准备的区间：把计划资金分成 3~4 份，逢大跌加一份，而不是等「跌到位」再一次性买。',
        '已经持仓的，先确认基本面有没有变坏；没变坏就扛住，不要在这里降低仓位。',
        '定投照常扣款，手上有闲钱可以适度加大。'
      ],
      dont: [
        '不要在这个位置割肉。恐贪到冰点时卖出，等于把最差的持股体验兑现成实际亏损，而后面大概率出现的回暖就与你无关了。',
        '不要因为「跌得看不懂」就清仓重来——那通常是恐慌传染，不是分析结论。'
      ]
    },
    { /* lvl 1 恐惧 */
      view: '情绪偏冷但还没到极端。历史同类区间之后 60 日的平均收益仍为正，只是幅度小于极度恐惧，'
        + '中间往往还有一两次反复，别指望一买就涨。',
      do: [
        '分批建仓的合适区间：先建到计划仓位的一半左右，留出后续加仓空间。',
        '已有仓位继续持有；现金比例别压到 0，也别全留现金。',
        '重点看那些「跌了很久、但基本面没坏」的品种，这类在回暖初期弹性通常最大。'
      ],
      dont: [
        '不要因为「还没跌够」就一直等——等你确认反转时，第一波涨幅往往已经走完。',
        '也不要一次把子弹打光，情绪还有继续变冷的空间。'
      ]
    },
    { /* lvl 2 中性 */
      view: '多空相对均衡。历史上中性区间之后 60 日平均只有 +0.6% 左右，接近随机：'
        + '这个阶段的涨跌主要由基本面和事件驱动，情绪本身不提供方向。',
      do: [
        '按你原本的计划执行：定投照常、调仓照常。这个阶段靠的是选股和纪律，不是情绪择时。',
        '把注意力放在持仓质量上：业绩、估值、买入逻辑有没有发生变化。'
      ],
      dont: [
        '不要因为「最近涨了」就加杠杆追进去，也不要因为「最近跌了」就恐慌减仓——这是情绪信号最弱、最容易两头挨打的区间。'
      ]
    },
    { /* lvl 3 贪婪 */
      view: '情绪偏热、资金活跃。历史上贪婪区间之后 60 个交易日平均是「负收益」，'
        + '而且回撤往往比预期来得快——高位的第一根大阴线，常常就是情绪反转的开始。',
      do: [
        '开始兑现一部分浮盈：可以按「每涨一档减一点」的节奏，把仓位降到你能睡得着觉的水平。',
        '停止新开仓和加仓，把注意力从「还能赚多少」转到「能保住多少」。'
      ],
      dont: [
        '不要加杠杆。',
        '不要抱着「再赚一波就走」的念头——情绪高位时，大多数人正是被这句话套住的。'
      ]
    },
    { /* lvl 4 极度贪婪 */
      view: '近一年最热的位置：赚钱效应最好、群里最热闹，也最容易套人。'
        + '历史同类区间之后 60 日平均负收益，且常伴随急跌。',
      do: [
        '这个区间的正确动作是「减仓」（不是清仓）：优先卖出涨幅最大、最投机的部分，保留基本面最扎实的底仓。',
        '设好止盈线并执行，把一部分利润真正落袋，而不是停留在浮动收益上。',
        '留出足够现金，为下一次情绪变冷时的分批买入做准备。'
      ],
      dont: [
        '不要在这里追高买入，尤其是「看到别人赚钱」才决定进场——那就是典型的追在高点。',
        '不要满仓过节、满仓过周末。'
      ]
    }
  ];

  /** 取某分值的建议（含前瞻实证），分值非法返回 null */
  function adviceOf(v) {
    if (v == null || isNaN(v)) return null;
    var z = zone(v);
    var a = ADVICE[z.lvl];
    if (!a) return null;
    var f = FORWARD[zoneKey(z.lvl)];
    return {
      lvl: z.lvl, zone: z.text, hint: z.hint,
      view: a.view, do: a.do, dont: a.dont,
      forward: f, note: SHARED_NOTE
    };
  }

  /* ---------------- 情绪极值事件（用于主动推送） ----------------
   * 目的：把"别割在低点、别追在高点"从一句建议，变成在情绪走到极值时
   *       主动响一次的通知。用边沿触发（只在进入/离开极值区那天提醒），
   *       不做每天都推的噪音源。
   * ------------------------------------------------------------ */

  /** 极值提醒阈值；可用 config.json 的 fngAlert 覆盖 */
  var EXTREME = { low: 20, high: 80 };
  /** 长期停在极值区时，每隔这么多个交易日再提醒一次 */
  var REMIND_EVERY = 5;

  var EXTREME_KIND = {
    'enter-low': { dir: 'low', title: '情绪冰点' },
    'enter-high': { dir: 'high', title: '情绪过热' },
    'leave-low': { dir: 'low', title: '情绪回暖' },
    'leave-high': { dir: 'high', title: '情绪降温' }
  };

  function clampThr(v, dft) { return (v == null || isNaN(v)) ? dft : Number(v); }

  /**
   * 判断是否发生"情绪极值切换"（边沿触发）。
   * 没有前值（第一次运行/历史不足）一律返回 null，避免误报。
   * @returns {null | {kind, dir, title, prev, cur}}
   */
  function extremeEvent(prevV, curV, opts) {
    opts = opts || {};
    if (curV == null || isNaN(curV)) return null;
    if (prevV == null || isNaN(prevV)) return null;
    var lo = clampThr(opts.low, EXTREME.low), hi = clampThr(opts.high, EXTREME.high);
    var nowLow = curV <= lo, nowHigh = curV >= hi;
    var wasLow = prevV <= lo, wasHigh = prevV >= hi;
    var kind = null;
    if (nowLow && !wasLow) kind = 'enter-low';
    else if (nowHigh && !wasHigh) kind = 'enter-high';
    else if (wasLow && !nowLow) kind = 'leave-low';
    else if (wasHigh && !nowHigh) kind = 'leave-high';
    if (!kind) return null;
    var m = EXTREME_KIND[kind];
    return { kind: kind, dir: m.dir, title: m.title, prev: prevV, cur: curV };
  }

  /**
   * 截至最后一天、连续处于极值区的交易日数（含最后一天）。
   * 纯函数：只依赖序列本身，所以重复运行不会算出不同结果（幂等）。
   */
  function extremeStreak(series, opts) {
    opts = opts || {};
    var lo = clampThr(opts.low, EXTREME.low), hi = clampThr(opts.high, EXTREME.high);
    var n = 0;
    for (var i = (series || []).length - 1; i >= 0; i--) {
      var v = series[i].v;
      if (v == null || isNaN(v)) break;
      if (v <= lo || v >= hi) n++;
      else break;
    }
    return n;
  }

  /** 长期停在极值区时的周期性提醒（第 5、10、15… 个交易日） */
  function isReminderDay(streak) {
    return streak > 1 && streak % REMIND_EVERY === 0;
  }

  return {
    VERSION: VERSION,
    COMPONENTS: COMPONENTS,
    ZONES: ZONES,
    PERIODS: PERIODS,
    WIN: WIN,
    MIN_WIN: MIN_WIN,
    ANN: ANN,
    mean: mean,
    stdev: stdev,
    pctRank: pctRank,
    validNum: validNum,
    marginIndexBefore: marginIndexBefore,
    rawsAt: rawsAt,
    rawsFromMarginSnap: rawsFromMarginSnap,
    marginSnapshot: marginSnapshot,
    computeLive: computeLive,
    buildSeries: buildSeries,
    zone: zone,
    slicePeriod: slicePeriod,
    stats: stats,
    packSeries: packSeries,
    unpackSeries: unpackSeries,
    sig: sig,
    calendarDaysFor: calendarDaysFor,
    FORWARD: FORWARD,
    ADVICE: ADVICE,
    SHARED_NOTE: SHARED_NOTE,
    zoneKey: zoneKey,
    adviceOf: adviceOf,
    EXTREME: EXTREME,
    REMIND_EVERY: REMIND_EVERY,
    EXTREME_KIND: EXTREME_KIND,
    extremeEvent: extremeEvent,
    extremeStreak: extremeStreak,
    isReminderDay: isReminderDay
  };
});
