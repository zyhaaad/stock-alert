/* ============================================================
 *  筹码透视 · 核心算法  chip-core.js
 * ============================================================
 *  设计原则（与 fng-core.js / signal-core.js / position-core.js 同规格）
 *  1) 单一真源：云端（Node）与手机控制台（浏览器）共用**同一份代码**，
 *     浏览器版由 _tests/inject-core.js 原样注入 console.html 的
 *     CHIP-CORE 标记块，杜绝两端算不一致。
 *  2) 纯函数：不碰 DOM、不发请求、不读配置；K线与资金流由调用方传入。
 *  3) 只做一件事 —— **看清散户在干什么，然后站到主力那边**。
 *
 *  用户 2026-09-17 点名要看的九件事（一份输出里全给）：
 *     散户割肉 / 追高接筹码 / 抄底   →  retailBehavior
 *     主力成本 / 散户成本            →  chips.mainCost / chips.retailCost
 *     主力建仓信号 / 出货信号 / 锁仓  →  mainBehavior
 *     「我该站哪边、怎么操作」        →  stance
 *
 *  ── 方法：两路证据交叉验证，任何一路都不单独下结论 ──────────────
 *  A. 筹码分布（三角形分布 + 换手衰减，通达信同源口径）
 *     只用「K线 + 流通股本」就能回答"谁的成本压在哪里"：
 *       低位密集峰 = 主力成本（吸筹区，通常也是最强支撑）
 *       高位密集峰 = 散户成本（套牢/追高区，通常也是最强压力）
 *       获利盘比例 / 筹码集中度 / 90% 筹码区间 / 支撑压力位
 *     注：筹码分布是**基于换手衰减假设的估算**，不是真实持仓名册，
 *         但方向性判断（主力库存高不高、上方套牢重不重）非常可靠。
 *
 *  B. 资金流结构（东财逐日：超大单/大单=主力，中单/小单=散户）
 *     ⚠️ 关键认知：主力的钱与散户的钱是**同一笔交易的两面**
 *        （主力净额 = −散户净额，恒等），所以只看资金流是分不出
 *        "散户在割肉"还是"散户在追高"的，**必须叠加价格方向**：
 *          跌 + 主力买 = 散户在割肉（恐慌交筹码）    → 好事，跟主力
 *          跌 + 主力卖 = 散户在抄底（越跌越买）      → 坏事，别抄
 *          涨 + 主力买 = 散户在获利了结（拿不住）    → 健康
 *          涨 + 主力卖 = 散户在追高接筹码           → 最危险，减仓
 *        再把「超大单」单独拆出来看：超大单买+大单卖 = 真机构接游资货。
 *
 *  C. 量能/换手（全部用**相对自身历史**的口径，大小盘股才可比）
 *     缩量 + 筹码集中 + 价格横 = 锁仓；放量 + 高位 + 主力卖 = 派发。
 *
 *  ⚠️ 定位：研究型参考，**不是投资建议**。数据来自公开接口，可能有误。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChipCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var RULE_VERSION = 'C1';

  /* ---------------- 参数（集中在这一处，改参数必须同时升 RULE_VERSION） ---------------- */
  var P = {
    buckets: 120,        // 价格分桶数（分辨率：区间宽度/120）
    decay: 1.0,          // 换手衰减系数。1.0 = 通达信经典口径（历史筹码按换手率全额衰减）
    maxTurnover: 0.6,    // 单日换手率上限（防止极端换手把历史筹码一次性抹平）
    peakWin: 9,          // 密集峰滑窗宽度（桶）。太小会把噪声当峰，太大相邻峰分不开
    minPeakRatio: 0.10,  // 一个密集峰至少占总量 10% 才算「有效峰」
    lowZone: 0.97,       // 「低位区」= 现价 × 0.97 以下
    highZone: 1.03,      // 「高位区」= 现价 × 1.03 以上
    flowShort: 5,        // 资金流短周期（判定"最近在干什么"）
    flowLong: 20,        // 资金流长周期（判定"这一波在干什么"）
    flatBand: 0.02,      // 近 5 日涨跌在 ±2% 内算「横盘」
    strongDom: 0.04,     // 主力净额占区间成交额 ≥4% 算「明显」（A股实测：大盘股 1~5%，活跃股 5~15%）
    midDom: 0.012,       // ≥1.2% 算「温和」。⚠️ 必须比 judgeRetail 用的一致，
                         //    否则会出现「散户在净买」+「主力无方向」这种自相矛盾
                         //    （两者是同一笔钱的两面，方向必然相反）
    lockVolRatio: 0.75,  // 近5日均量 / 近60日均量 < 0.75 视为缩量
    lockTurnoverRank: 0.40, // 换手率处于自身近 250 日 40% 分位以下算「低换手」
    bigMove: 0.15,       // 现价相对主力成本的上浮超过 15% 视为「主力已有获利空间」
    chaseGain: 0.10,     // 高位 + 近20日涨幅超 10% 视为「追高区」
    profitHeavy: 0.85,   // 获利盘比例 ≥85% 视为「几乎全员浮盈」（抛压潜在）
    profitLight: 0.30    // 获利盘比例 ≤30% 视为「多数人套着」
  };

  /* ============================================================
   *  基础工具
   * ============================================================ */

  /** 稳妥转数字：空串/null/非数字 → NaN */
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  /** NaN → 0（求和场景用） */
  function nz(v) { return isFinite(v) ? v : 0; }

  /**
   * 规范化 K 线：腾讯接口原始行 [日期, 开, 收, 高, 低, 量(手)]
   * @returns [{d,o,c,h,l,v}]（按日期升序），脏行丢弃
   */
  function normBars(raw) {
    var out = [], list = raw || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !r[0]) continue;
      var o = num(r[1]), c = num(r[2]), h = num(r[3]), l = num(r[4]), v = num(r[5]);
      if (!(c > 0)) continue;
      if (!(h >= l)) continue;
      out.push({ d: String(r[0]), o: o, c: c, h: h, l: l, v: v });
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    return out;
  }

  /**
   * 规范化资金流：东财 klines 行 "日期,主力,小单,中单,大单,超大单"（单位：元）
   *   ⚠️ 字段顺序已按实测闭合校验：主力 = 大单 + 超大单；小单 + 中单 = −主力
   * @returns [{d,main,small,mid,big,huge}]（升序）。“散户”= small + mid
   */
  function normFlows(raw) {
    var out = [], list = raw || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var parts = (typeof r === 'string') ? r.split(',') : (r || []);
      if (!parts || !parts[0]) continue;
      var main = num(parts[1]);
      if (!isFinite(main)) continue;
      out.push({
        d: String(parts[0]).slice(0, 10),
        main: main,
        small: nz(num(parts[2])),
        mid: nz(num(parts[3])),
        big: nz(num(parts[4])),
        huge: nz(num(parts[5]))
      });
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    return out;
  }

  /** 一根 K 线的成交额估算（元）：量(手)×100×均价，均价用 (高+低+收)/3 */
  function amtOf(bar) {
    var v = num(bar.v);
    if (!isFinite(v) || v <= 0) return 0;
    var p = (nz(num(bar.h)) + nz(num(bar.l)) + nz(num(bar.c))) / 3;
    return v * 100 * p;
  }

  /** 区间求和（含 from、to；越界自动裁剪） */
  function sumRange(arr, from, to, pick) {
    var s = 0, n = arr.length;
    if (from < 0) from = 0;
    if (to > n - 1) to = n - 1;
    for (var i = from; i <= to; i++) s += nz(pick ? pick(arr[i]) : arr[i]);
    return s;
  }

  /** 某一序列最后一个有限值（取不到 → NaN） */
  function lastFinite(arr) {
    if (!arr) return NaN;
    for (var i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
    return NaN;
  }

  /** v 在 arr[0..idx] 中的分位（0~1）；样本不足 → NaN */
  function pctRank(arr, idx, minN) {
    if (!arr || idx < 0 || idx >= arr.length) return NaN;
    var v = arr[idx];
    if (!isFinite(v)) return NaN;
    var c = 0, n = 0, from = Math.max(0, idx - 249);   // 近 250 个交易日窗口（约一年）
    for (var i = from; i <= idx; i++) {
      if (!isFinite(arr[i])) continue;
      n++;
      if (arr[i] <= v) c++;
    }
    if (n < (minN || 30)) return NaN;
    return c / n;
  }

  /* ============================================================
   *  A. 筹码分布（三角形分布 + 换手率衰减）
   * ============================================================
   *  逐日推进。每一天做两件事：
   *    ① 历史筹码按当日换手率衰减：chips *= (1 − 换手率 × decay)
   *       —— 换手率 3% 意味着当天有 3% 的筹码换了主人，老持有者的
   *          成本分布随之稀释。decay=1.0 即经典口径。
   *    ② 当日新增筹码按**三角形分布**落在 [最低, 最高] 区间，
   *       顶点在当日均价 —— 一天之内价格在中枢停留最久，成交量在
   *       两端的分布自然最少，三角形比均匀分布更贴近真实。
   *
   *  ⚠️ 初始化：把期初全部流通筹码放在**第一根 K 线的价格区间**上。
   *     这一点很关键 —— 若从 0 起算，低换手股（如日换手 0.1% 的大盘股）
   *     算出来的总筹码会远小于真实流通盘，近端筹码被严重放大。
   *
   *  @param bars    normBars 产物（升序）
   *  @param floatShares 流通股本（股）
   *  @returns null 或 { N, lo, hi, step, chips[], total, float, days }
   */
  function chipsDistribution(bars, floatShares, opt) {
    opt = opt || {};
    var N = opt.buckets || P.buckets;
    var decay = (opt.decay === undefined) ? P.decay : opt.decay;
    var maxTr = opt.maxTurnover || P.maxTurnover;
    var fs = num(floatShares);
    if (!bars || bars.length < 20) return null;
    if (!(fs > 0)) return null;

    /* 价格区间：覆盖整段 K 线的最高/最低 */
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (isFinite(b.l) && b.l < lo) lo = b.l;
      if (isFinite(b.h) && b.h > hi) hi = b.h;
    }
    if (!(hi > lo) || !isFinite(lo)) return null;
    /* 上下各留 2% 余量，避免边界筹码落在桶外 */
    var pad = (hi - lo) * 0.02;
    lo -= pad; hi += pad;
    var step = (hi - lo) / N;
    if (!(step > 0)) return null;

    function bucketOf(p) {
      var k = Math.floor((p - lo) / step);
      if (k < 0) k = 0;
      if (k > N - 1) k = N - 1;
      return k;
    }

    var chips = new Array(N);
    for (var z = 0; z < N; z++) chips[z] = 0;

    /* ---- 初始化：期初筹码铺在第一根 K 线的价格区间上 ---- */
    var b0 = bars[0];
    var k0 = bucketOf(b0.l), k1 = bucketOf(b0.h);
    var span0 = k1 - k0 + 1;
    for (var w0 = k0; w0 <= k1; w0++) chips[w0] = fs / span0;

    /* ---- 逐日推进 ---- */
    for (var t = 0; t < bars.length; t++) {
      var bar = bars[t];
      var vol = num(bar.v) * 100;                      // 手 → 股
      if (!(vol > 0)) continue;
      var tr = vol / fs;
      if (!isFinite(tr) || tr <= 0) continue;
      if (tr > maxTr) tr = maxTr;

      /* ① 历史筹码衰减 */
      var keep = 1 - tr * decay;
      if (keep < 0) keep = 0;
      if (keep < 1) {
        for (var q = 0; q < N; q++) chips[q] *= keep;
      }

      /* ② 当日新增筹码：三角形分布，顶点=均价 */
      var hl = num(bar.h), ll = num(bar.l), cl = num(bar.c);
      var avg = (hl + ll + cl) / 3;
      if (!(avg > 0)) continue;
      /* 三角形两端不得重合（一字板）→ 退化时直接用单桶 */
      var bandLo = Math.max(lo, Math.min(ll, avg));
      var bandHi = Math.min(hi, Math.max(hl, avg));
      var kLo = bucketOf(bandLo), kHi = bucketOf(bandHi);
      if (kHi < kLo) kHi = kLo;

      var ws = [], sw = 0, j;
      if (kHi === kLo) {
        ws[0] = 1; sw = 1;
      } else {
        var A = bandLo, B = bandHi, W = B - A;
        for (j = kLo; j <= kHi; j++) {
          var pc = lo + step * (j + 0.5);
          var f;
          if (pc <= avg) f = (avg > A) ? 2 * (pc - A) / ((avg - A) * W) : 0;
          else f = (B > avg) ? 2 * (B - pc) / ((B - avg) * W) : 0;
          if (!(f > 0)) f = 0;
          ws[j - kLo] = f;
          sw += f;
        }
        if (!(sw > 0)) {                       // 退化兜底：均匀
          for (j = 0; j < ws.length; j++) ws[j] = 1;
          sw = ws.length;
        }
      }
      for (j = kLo; j <= kHi; j++) chips[j] += vol * (ws[j - kLo] / sw);
    }

    var total = 0;
    for (var s = 0; s < N; s++) total += chips[s];
    if (!(total > 0)) return null;

    return { N: N, lo: lo, hi: hi, step: step, chips: chips, total: total, float: fs, days: bars.length };
  }

  /**
   * 在筹码分布里找「密集峰」：滑窗平滑 → 局部极大 → 按质量排序 → 非极大值抑制。
   * @returns [{i, price, mass, ratio}]（按 mass 降序，ratio = 该峰筹码占总量比）
   */
  function findPeaks(chips, lo, step, win, minRatio, total) {
    var N = chips.length, half = Math.floor(win / 2);
    var sm = new Array(N);
    for (var i = 0; i < N; i++) {
      var s = 0, c = 0;
      for (var k = Math.max(0, i - half); k <= Math.min(N - 1, i + half); k++) { s += chips[k]; c++; }
      sm[i] = c ? s / c : 0;
    }
    var raw = [];
    for (var j = 1; j < N - 1; j++) {
      if (!(sm[j] >= sm[j - 1] && sm[j] > sm[j + 1])) continue;
      var w0 = Math.max(0, j - half), w1 = Math.min(N - 1, j + half);
      var mass = 0, sp = 0;
      for (var q = w0; q <= w1; q++) { mass += chips[q]; sp += chips[q] * (lo + step * (q + 0.5)); }
      if (!(mass > 0)) continue;
      var ratio = total > 0 ? mass / total : 0;
      if (ratio < (minRatio || 0)) continue;
      raw.push({ i: j, price: sp / mass, mass: mass, ratio: ratio });
    }
    raw.sort(function (a, b) { return b.mass - a.mass; });
    var out = [];
    for (var p = 0; p < raw.length; p++) {
      var dup = false;
      for (var o = 0; o < out.length; o++) {
        if (Math.abs(raw[p].i - out[o].i) < win) { dup = true; break; }
      }
      if (!dup) out.push(raw[p]);
    }
    return out;
  }

  /**
   * 从筹码分布提取成本与关键价位。
   * @param dist  chipsDistribution 产物
   * @param price 现价
   * @returns { avgCost, profitRatio, concentration, mainCost, mainMass,
   *            retailCost, retailMass, support, pressure, band90:[lo,hi], peaks }
   *
   * 口径说明（这是用户最关心的两个数，必须说清定义）：
   *   主力成本 = **低位区（现价×0.97 以下）筹码最集中的价位**
   *              → 代表主力吸筹的主要成本区，通常也是最硬的支撑
   *   散户成本 = **高位区（现价×1.03 以上）筹码最集中的价位**
   *              → 代表散户追高/套牢的主要成本区，通常也是最硬的压力
   *   两者都取不到时返回 NaN（例如股价正好在历史最高位，上方没有套牢盘）
   */
  function analyzeChips(dist, price, opt) {
    opt = opt || {};
    if (!dist || !dist.chips) return null;
    var N = dist.N, chips = dist.chips, lo = dist.lo, step = dist.step;
    var total = dist.total;
    var px = num(price);
    if (!(total > 0)) return null;

    /* 加权平均成本 + 获利盘比例 */
    var sumPV = 0, profit = 0;
    for (var i = 0; i < N; i++) {
      var pc = lo + step * (i + 0.5);
      sumPV += chips[i] * pc;
      if (isFinite(px) && pc <= px) profit += chips[i];
    }
    var avgCost = sumPV / total;
    var profitRatio = (isFinite(px) && total > 0) ? profit / total : NaN;

    /* 90% 筹码区间（去掉上下各 5% 的尾部） */
    var acc = 0, lo90 = NaN, hi90 = NaN, cutLo = total * 0.05, cutHi = total * 0.95;
    for (var j = 0; j < N; j++) {
      acc += chips[j];
      if (!isFinite(lo90) && acc >= cutLo) lo90 = lo + step * (j + 0.5);
      if (!isFinite(hi90) && acc >= cutHi) { hi90 = lo + step * (j + 0.5); break; }
    }
    if (!isFinite(lo90)) lo90 = lo;
    if (!isFinite(hi90)) hi90 = dist.hi;
    /* spread = 90% 筹码价格带宽 / 均价（越小越集中，是个"分散度"）
       集中度 concentration = 现价 ±10% 区间内的筹码占比（越大越集中）——
       后者才是界面上「筹码集中度」那个数，也更贴近"买盘能不能托住"的直觉 */
    var spread = (avgCost > 0) ? (hi90 - lo90) / avgCost : NaN;
    var bandPct = opt.concBand === undefined ? 0.10 : opt.concBand;
    var conc = 0;
    if (isFinite(px) && avgCost > 0) {
      var bLo = px * (1 - bandPct), bHi = px * (1 + bandPct);
      for (var q2 = 0; q2 < N; q2++) {
        var pq = lo + step * (q2 + 0.5);
        if (pq >= bLo && pq <= bHi) conc += chips[q2];
      }
      conc /= total;
    }

    /* 所有密集峰 */
    var peaks = findPeaks(chips, lo, step, opt.peakWin || P.peakWin, P.minPeakRatio, total);

    /* 主力成本：低位区（现价 × 0.97 以下）最大峰 */
    var mainCost = NaN, mainMass = NaN, r, p;
    var lowCut = isFinite(px) ? px * P.lowZone : -Infinity;
    var mainPick = null;
    for (r = 0; r < peaks.length; r++) {
      p = peaks[r];
      if (p.price < lowCut) { if (!mainPick || p.mass > mainPick.mass) mainPick = p; }
    }
    if (!mainPick) {
      /* 低位没有明显峰 → 退化为「现价下方筹码的加权重心」，
         但只有下方筹码占比够大时才给值，否则说明成本全在头上，不该硬给 */
      var belowM = 0, belowP = 0;
      for (var m = 0; m < N; m++) {
        var pm = lo + step * (m + 0.5);
        if (isFinite(px) && pm <= px) { belowM += chips[m]; belowP += chips[m] * pm; }
      }
      if (belowM / total >= 0.15) { mainCost = belowP / belowM; mainMass = belowM / total; }
    } else { mainCost = mainPick.price; mainMass = mainPick.ratio; }

    /* 散户成本：高位区（现价 × 1.03 以上）最大峰 */
    var retailCost = NaN, retailMass = NaN;
    var highCut = isFinite(px) ? px * P.highZone : Infinity;
    var retailPick = null;
    for (r = 0; r < peaks.length; r++) {
      p = peaks[r];
      if (p.price > highCut) { if (!retailPick || p.mass > retailPick.mass) retailPick = p; }
    }
    if (retailPick) { retailCost = retailPick.price; retailMass = retailPick.ratio; }

    /* 支撑 / 压力：现价下方最近的有效峰 / 上方最近的有效峰 */
    var support = NaN, supportMass = NaN, pressure = NaN, pressureMass = NaN;
    for (r = 0; r < peaks.length; r++) {
      p = peaks[r];
      if (!isFinite(px)) break;
      if (p.price < px) {
        if (!isFinite(support) || p.price > support) { support = p.price; supportMass = p.ratio; }
      } else if (p.price > px) {
        if (!isFinite(pressure) || p.price < pressure) { pressure = p.price; pressureMass = p.ratio; }
      }
    }

    return {
      avgCost: avgCost, profitRatio: profitRatio,
      concentration: conc, spread: spread,
      mainCost: mainCost, mainMass: mainMass,
      retailCost: retailCost, retailMass: retailMass,
      support: support, supportMass: supportMass,
      pressure: pressure, pressureMass: pressureMass,
      band90: [lo90, hi90], peaks: peaks
    };
  }

  /* ============================================================
   *  B. 资金流结构
   * ============================================================
   *  东财口径：主力 = 大单 + 超大单；散户 = 中单 + 小单（= −主力）
   *  强度用「主力净额 / 区间成交额」衡量 —— 比绝对值更能跨股比较，
   *  也避免了大小盘股用同一套金额阈值的荒谬。
   */
  function flowStats(flows, bars, price, opt) {
    opt = opt || {};
    var out = { days: 0, main5: NaN, main20: NaN, dom5: NaN, dom20: NaN,
      huge5: NaN, big5: NaN, retail5: NaN, retail20: NaN,
      mainToday: NaN, domToday: NaN };
    if (!flows || !flows.length || !bars || !bars.length) return out;

    /* 用得最多的那一段：以资金流的天数为准（通常比 K 线短） */
    var n = flows.length;
    out.days = n;

    /* K 线按日期建索引，用于取同日成交额 */
    var barByDate = {};
    for (var b = 0; b < bars.length; b++) barByDate[bars[b].d] = bars[b];
    /* 资金流日期可能带时间/格式差异，统一按 YYYY-MM-DD 匹配；匹配不到就用最后一根 */
    function barOf(f, fallbackIdx) {
      var d = String(f.d).slice(0, 10);
      if (barByDate[d]) return barByDate[d];
      var bi = bars.length - 1 - fallbackIdx;
      return (bi >= 0) ? bars[bi] : bars[bars.length - 1];
    }

    function windowSum(k) {
      var f0 = Math.max(0, n - k);
      var main = 0, huge = 0, big = 0, amt = 0, last = null;
      for (var i = f0; i < n; i++) {
        var f = flows[i];
        main += nz(f.main);
        huge += nz(f.huge);
        big += nz(f.big);
        amt += amtOf(barOf(f, n - 1 - i));
        last = f;
      }
      return { main: main, huge: huge, big: big, amt: amt, last: last };
    }

    var w5 = windowSum(P.flowShort), w20 = windowSum(P.flowLong);
    out.main5 = w5.main; out.main20 = w20.main;
    out.huge5 = w5.huge; out.big5 = w5.big;
    out.retail5 = -w5.main; out.retail20 = -w20.main;      // 恒等式：散户净额 = −主力净额
    out.amt5 = w5.amt; out.amt20 = w20.amt;
    out.dom5 = w5.amt > 0 ? w5.main / w5.amt : NaN;
    out.dom20 = w20.amt > 0 ? w20.main / w20.amt : NaN;
    var lastF = flows[n - 1];
    out.mainToday = nz(lastF.main);
    var lastAmt = amtOf(barOf(lastF, 0));
    out.domToday = lastAmt > 0 ? out.mainToday / lastAmt : NaN;
    return out;
  }

  /* ============================================================
   *  C. 量能与换手（全部相对自身历史，跨股可比）
   * ============================================================ */
  function volumeStats(bars, floatShares) {
    var out = { vol5: NaN, vol20: NaN, vol60: NaN, volRatio: NaN, volRatio60: NaN,
      turnover5: NaN, turnoverRank: NaN, ret5: NaN, ret20: NaN, ret60: NaN };
    if (!bars || bars.length < 21) return out;
    var i = bars.length - 1, fs = num(floatShares);
    out.vol5 = sumRange(bars, i - 4, i, function (b) { return b.v; }) / 5;
    out.vol20 = sumRange(bars, i - 19, i, function (b) { return b.v; }) / 20;
    if (bars.length >= 60) out.vol60 = sumRange(bars, i - 59, i, function (b) { return b.v; }) / 60;
    if (isFinite(out.vol20) && out.vol20 > 0) out.volRatio = out.vol5 / out.vol20;
    if (isFinite(out.vol60) && out.vol60 > 0) out.volRatio60 = out.vol5 / out.vol60;

    if (fs > 0) {
      var trs = [];
      for (var k = 0; k < bars.length; k++) {
        var v = num(bars[k].v);
        trs.push((isFinite(v) && v > 0) ? (v * 100 / fs) : NaN);
      }
      out.turnover5 = sumRange(trs, i - 4, i) / 5;
      out.turnoverRank = pctRank(trs, i, 60);
    }
    var c = bars[i].c;
    if (i - 5 >= 0 && bars[i - 5].c > 0) out.ret5 = c / bars[i - 5].c - 1;
    if (i - 20 >= 0 && bars[i - 20].c > 0) out.ret20 = c / bars[i - 20].c - 1;
    if (i - 60 >= 0 && bars[i - 60].c > 0) out.ret60 = c / bars[i - 60].c - 1;
    return out;
  }

  /* ============================================================
   *  D. 行为判定
   * ============================================================ */

  function flowDir(dom) {
    if (!isFinite(dom)) return 'unknown';
    if (dom >= P.strongDom) return 'strong-in';
    if (dom >= P.midDom) return 'in';
    if (dom <= -P.strongDom) return 'strong-out';
    if (dom <= -P.midDom) return 'out';
    return 'flat';
  }

  /** 近 N 日资金方向的文字标签 */
  function dirText(dom) {
    var d = flowDir(dom);
    if (d === 'strong-in') return '明显净流入';
    if (d === 'in') return '小幅净流入';
    if (d === 'strong-out') return '明显净流出';
    if (d === 'out') return '小幅净流出';
    if (d === 'flat') return '基本持平';
    return '数据不足';
  }

  function yi(v) {                                   // 元 → 亿元（保留 2 位）
    if (!isFinite(v)) return '—';
    var y = v / 1e8;
    if (Math.abs(y) >= 1) return y.toFixed(2) + ' 亿';
    return (v / 1e4).toFixed(0) + ' 万';
  }

  /**
   * 主力在干什么。
   * 判据 = 资金方向 × 价格位置（相对主力成本） × 量能
   */
  function judgeMain(m) {
    var dom5 = m.flows.dom5, dom20 = m.flows.dom20;
    var ret20 = m.vol.ret20, ret5 = m.vol.ret5;
    var vr60 = m.vol.volRatio60;
    var profit = m.chips ? m.chips.profitRatio : NaN;
    var overCost = (m.chips && isFinite(m.chips.mainCost) && m.chips.mainCost > 0)
      ? (m.price / m.chips.mainCost - 1) : NaN;

    /* 锁仓：极度缩量 + 低换手 + **资金没有方向**。
       ⚠️ 必须带最后这个条件 —— 否则"缩量但主力在猛买"会被误判成没人要，
       那种情况该说的是"缩量吸筹"，而不是"等风来"。 */
    var locked = isFinite(vr60) && vr60 < P.lockVolRatio &&
      (!isFinite(m.vol.turnoverRank) || m.vol.turnoverRank <= P.lockTurnoverRank) &&
      flowDir(dom20) === 'flat';

    if (locked) {
      return { tag: '锁仓', tone: 'mute', key: 'lock',
        desc: '近 5 日均量只有近 60 日的 ' + Math.round(vr60 * 100) + '%，换手率处在自身低位 —— 没人愿意卖，筹码锁得很死，主力也走不掉，等风来。' };
    }

    if (flowDir(dom20) === 'strong-in' || flowDir(dom20) === 'in') {
      /* 主力在收筹码：看价格已经离成本多远 */
      if (isFinite(overCost) && overCost >= P.bigMove) {
        return { tag: '拉升中', tone: 'good', key: 'lift',
          desc: '近 20 日主力净流入 ' + yi(m.flows.main20) + '，股价已高出主力成本 ' + Math.round(overCost * 100) + '%，主力在拉也在攒利润，跟可以，但别再往上加仓。' };
      }
      if (isFinite(ret20) && ret20 < 0.08) {
        return { tag: '建仓/吸筹', tone: 'good', key: 'accumulate',
          desc: '近 20 日主力净流入 ' + yi(m.flows.main20) + '（占成交额 ' + Math.round(Math.abs(dom20) * 100) + '%），股价还没怎么涨 —— 这是主力在低位收筹码，最值得跟的阶段。' };
      }
      return { tag: '主力流入', tone: 'good', key: 'inflow',
        desc: '近 20 日主力净流入 ' + yi(m.flows.main20) + '，资金是往这边走的。' };
    }

    if (flowDir(dom20) === 'strong-out' || flowDir(dom20) === 'out') {
      /* 主力在出：先分清是「高位派发」「下跌中减仓」还是「缩量阴跌」 */
      if (isFinite(ret20) && ret20 > 0.05) {
        return { tag: '高位派发', tone: 'bad', key: 'distribute',
          desc: '近 20 日主力净流出 ' + yi(m.flows.main20) + '（占成交额 ' + Math.round(Math.abs(dom20) * 100) + '%），股价却还在涨 —— 这是边拉边卖，主力在把筹码交给接手的人。' };
      }
      if (isFinite(ret20) && ret20 < -0.08) {
        return { tag: '下跌中减仓', tone: 'bad', key: 'driftdown',
          desc: '近 20 日股价 ' + (ret20 * 100).toFixed(1) + '%、主力净流出 ' + yi(m.flows.main20) +
            '（占成交额 ' + Math.round(Math.abs(dom20) * 100) + '%）—— 跌势里主力还在走，说明承接意愿不足，别指望它自己止跌。' };
      }
      if (isFinite(vr60) && vr60 < 0.9) {
        return { tag: '缩量阴跌', tone: 'warn', key: 'driftdown',
          desc: '近 20 日主力净流出 ' + yi(m.flows.main20) + '，量能萎缩 —— 阴跌比急跌更难熬，急跌有恐慌底，阴跌没有。' };
      }
      return { tag: '主力在撤', tone: 'warn', key: 'outflow',
        desc: '近 20 日主力净流出 ' + yi(m.flows.main20) + '（占成交额 ' + Math.round(Math.abs(dom20) * 100) + '%），主力在往外走。' };
    }

    return { tag: '主力观望', tone: 'mute', key: 'flat',
      desc: '近 20 日主力资金基本持平，没有明确方向。' };
  }

  /**
   * 散户在干什么 —— 用户最关心的一栏。
   * ⚠️ 核心：单看资金流分不出"割肉"和"追高"，**必须叠加价格方向**。
   *   跌 + 主力买(散户卖) = 割肉      跌 + 主力卖(散户买) = 抄底
   *   涨 + 主力买(散户卖) = 获利了结   涨 + 主力卖(散户买) = 追高接筹码
   *
   * ★ 2026-09-22 文案口径（用户要求：只留一个方向结论，信息多了是干扰）：
   *   上面那行「主力买/主力卖」是**判定口径**（散户方向 = −主力方向，分不开），
   *   但 desc **只描述散户自己在干什么**，不再写「而主力正在卖给他们」「主力在悄悄给货」
   *   这类独立的主力结论 —— 那是另一个维度的判断，与界面上的「趋势阶段」行会互相矛盾。
   *   ⚠️ 只改文案措辞：判定条件、tone、key 一个都没动。
   */
  function judgeRetail(m) {
    var ret5 = m.vol.ret5, ret20 = m.vol.ret20;
    var dom5 = m.flows.dom5;
    var flat = P.flatBand;
    /* 散户方向 = −主力方向 */
    var retailBuying = isFinite(dom5) && dom5 <= -P.midDom;
    var retailSelling = isFinite(dom5) && dom5 >= P.midDom;
    var px = isFinite(ret5) ? ret5 : (isFinite(ret20) ? ret20 : 0);
    var money = yi(Math.abs(isFinite(m.flows.main5) ? m.flows.main5 : 0));
    var pct = isFinite(dom5) ? Math.round(Math.abs(dom5) * 100) : NaN;
    var moneyTxt = money + (isFinite(pct) ? '（占近5日成交额 ' + pct + '%）' : '');
    var pctMove = (px >= 0 ? '+' : '') + (px * 100).toFixed(1) + '%';

    if (px < -flat) {
      if (retailBuying) {
        return { tag: '散户在抄底', tone: 'bad', key: 'dip-buy',
          desc: '近 5 日股价 ' + pctMove + '，散户净买入 ' + moneyTxt + ' —— 越跌越买是散户最典型的动作，下跌途中的抄底通常是在接刀。' };
      }
      if (retailSelling) {
        return { tag: '散户在割肉', tone: 'good', key: 'surrender',
          desc: '近 5 日股价 ' + pctMove + '，散户净卖出 ' + moneyTxt + ' —— 恐慌盘在往外倒，筹码正从散户手里出来。' };
      }
      return { tag: '散户在观望', tone: 'mute', key: 'watch',
        desc: '近 5 日股价 ' + pctMove + '，散户资金没什么动作，量能也没跟上，还在磨。' };
    }

    if (px > flat) {
      if (retailBuying) {
        return { tag: '散户在追高接筹码', tone: 'bad', key: 'chase',
          desc: '近 5 日股价 ' + pctMove + '，散户净买入 ' + moneyTxt + ' —— 涨上去才敢买，这是最标准的接盘位置。' };
      }
      if (retailSelling) {
        return { tag: '散户在获利了结', tone: 'good', key: 'take-profit',
          desc: '近 5 日股价 ' + pctMove + '，散户净卖出 ' + moneyTxt + ' —— 涨一点就跑，筹码留不住。' };
      }
      return { tag: '散户在观望', tone: 'mute', key: 'watch-up',
        desc: '近 5 日股价 ' + pctMove + '，散户资金没大动作。' };
    }

    /* 横盘 */
    if (retailBuying) {
      return { tag: '散户在慢慢买', tone: 'warn', key: 'slow-buy',
        desc: '近 5 日横盘（' + pctMove + '），散户在小幅净买入 ' + moneyTxt + ' —— 横盘里还在小幅加仓，这种换手要当心。' };
    }
    if (retailSelling) {
      return { tag: '散户在磨走', tone: 'good', key: 'slow-sell',
        desc: '近 5 日横盘（' + pctMove + '），散户在小幅净卖出 ' + moneyTxt + '，拿不住的先走了，筹码在集中。' };
    }
    return { tag: '散户在僵持', tone: 'mute', key: 'stalemate',
      desc: '近 5 日股价横着走（' + pctMove + '），买卖双方都基本持平，谁也占不到便宜。' };
  }

  /**
   * 站队结论 —— 用户要的「我该站哪边、怎么操作」。
   * 综合：主力方向 + 价格相对主力成本的位置 + 散户在做什么 + 获利盘压力 + 锁仓
   */
  function judgeStance(m) {
    var main = m.mainBehavior, retail = m.retailBehavior;
    var profit = m.chips ? m.chips.profitRatio : NaN;
    var overCost = (m.chips && isFinite(m.chips.mainCost) && m.chips.mainCost > 0)
      ? (m.price / m.chips.mainCost - 1) : NaN;

    /* ① 锁仓：不动 */
    if (main.key === 'lock') {
      return { tag: '等风来', tone: 'mute', action: 'hold', actionText: '拿住不动',
        desc: '主力没走、也没人卖，这种时候动得越多错得越多。守住就行，等放量选方向。' };
    }

    /* ② 主力在收 + 价格没透支 → 跟主力站一起（最理想） */
    if ((main.key === 'accumulate' || main.key === 'inflow') &&
        (!isFinite(overCost) || overCost < P.bigMove)) {
      var extra = (retail.key === 'surrender')
        ? '而且散户正在割肉离场 —— 筹码从散户转手到主力，这个位置是站在少数人这边的。'
        : (retail.key === 'chase' ? '但短线已经有人在追高，别跟着一起冲，回踩再要。'
          : '位置还在主力成本附近，风险收益比合适。');
      return { tag: '跟主力站一起', tone: 'good', action: 'hold', actionText: '拿住 / 回调可加',
        desc: '主力在收筹码、股价还没透支' + (isFinite(overCost) ? '（高出主力成本约 ' + Math.round(overCost * 100) + '%）' : '') +
          '。' + extra };
    }

    /* ③ 主力还在拉，但已明显获利 → 持有但别追 */
    if (main.key === 'lift') {
      return { tag: '跟但别追', tone: 'warn', action: 'hold', actionText: '持有 / 不加仓',
      desc: '主力在拉升也已有明显利润' + (isFinite(profit) ? '（获利盘 ' + Math.round(profit * 100) + '%）' : '') +
        '。趋势没坏就别下车，但这里加仓是把自己的成本架在主力之上，不划算。' };
    }

    /* ④ 散户在追高、主力在派发 → 最危险，减 */
    if (retail.key === 'chase' && (main.key === 'distribute' || main.key === 'outflow')) {
      return { tag: '别当接棒的', tone: 'bad', action: 'trim', actionText: '逢高减仓',
        desc: '主力在高位往外派发，散户在追高接筹码 —— 两边站反了。这种位置继续拿着，就是替主力完成最后一段派发。' };
    }

    /* ⑤ 散户在抄底、主力在走 → 别抄底 */
    if (retail.key === 'dip-buy' && (main.key === 'outflow' || main.key === 'distribute' || main.key === 'driftdown')) {
      return { tag: '别去抄底', tone: 'bad', action: 'wait', actionText: '等主力回来再说',
        desc: '下跌里散户在越跌越买、主力在往外走 —— 这是典型的"下跌中继"，不是底部。底部要等主力先回来（资金转正 + 缩量止跌）。' };
    }

    /* ⑥ 主力派发但散户没在接 → 谨慎 */
    if (main.key === 'distribute' || main.key === 'outflow' || main.key === 'driftdown') {
      return { tag: '主力在撤', tone: 'warn', action: 'trim', actionText: '减仓/反弹离场',
        desc: '主力资金持续往外走' + (isFinite(profit) && profit >= P.profitHeavy ? '，而且几乎全员浮盈，抛压随时会来' : '') + '。反弹是走的机会，不是加的机会。' };
    }

    /* ⑦ 其他：观望 */
    return { tag: '观望', tone: 'mute', action: 'wait', actionText: '先别动手',
      desc: '主力资金没有明确方向，散户资金也没成气候，等信号更清楚再说。' };
  }

  /* ============================================================
   *  总入口
   * ============================================================
   * @param input {
   *   bars:       腾讯日线原始行 或 normBars 产物（升序）
   *   flows:      东财资金流原始行 或 normFlows 产物
   *   floatShares:流通股本（股）
   *   price:      现价（不传则用最后一根收盘价）
   *   name/code:  仅用于回显
   * }
   * @returns 统一结构（任何一路数据缺失都会降级，不会抛错）
   *   { ok, version, ruleVersion, code, name, price, date,
   *     chips:{...}|null, flows:{...}, vol:{...},
   *     mainBehavior:{tag,tone,desc}, retailBehavior:{tag,tone,desc},
   *     stance:{tag,tone,action,actionText,desc},
   *     notes:[...] }
   */
  function analyze(input) {
    input = input || {};
    var rawBars = input.bars || [];
    var bars = (rawBars.length && typeof rawBars[0] === 'object' && !Array.isArray(rawBars[0])) ? rawBars : normBars(rawBars);
    if (!bars || bars.length < 21) {
      return { ok: false, msg: 'K线不足（至少 21 根）', notes: [] };
    }
    var flows = input.flows || [];
    if (flows.length && typeof flows[0] === 'string') flows = normFlows(flows);
    var fs = num(input.floatShares);
    var i = bars.length - 1;
    var price = num(input.price);
    if (!(price > 0)) price = bars[i].c;

    var notes = [];
    var chips = null;
    if (fs > 0) {
      var dist = chipsDistribution(bars, fs);
      if (dist) chips = analyzeChips(dist, price);
      else notes.push('筹码分布：K 线或股本不足，已跳过');
    } else {
      notes.push('筹码分布：缺流通股本，已跳过（主力成本/散户成本不可用）');
    }

    var fl = flowStats(flows, bars, price);
    if (!fl.days) notes.push('资金流：无数据，主力/散户方向按量能与价格推断');

    var vol = volumeStats(bars, fs);

    var m = {
      bars: bars, price: price, date: bars[i].d,
      chips: chips, flows: fl, vol: vol
    };

    /* 资金流缺失时的降级：用「量价」近似主力方向（放量上涨≈资金进） */
    if (!fl.days && isFinite(vol.volRatio) && isFinite(vol.ret5)) {
      var proxy = (vol.volRatio - 1) * (vol.ret5 >= 0 ? 1 : -1);
      fl.dom5 = Math.max(-0.2, Math.min(0.2, proxy * 0.1));
      fl.dom20 = fl.dom5;
      notes.push('资金流缺失，主力方向为量价推算的近似值');
    }

    var mainBehavior = judgeMain(m);
    m.mainBehavior = mainBehavior;              // ⚠️ 必须回写：judgeStance 要靠它做综合判断
    var retailBehavior = judgeRetail(m);
    m.retailBehavior = retailBehavior;
    var stance = judgeStance(m);

    return {
      ok: true,
      version: VERSION, ruleVersion: RULE_VERSION,
      code: input.code || '', name: input.name || '',
      price: price, date: bars[i].d, bars: bars.length, flowDays: fl.days,
      chips: chips, flows: fl, vol: vol,
      mainBehavior: mainBehavior, retailBehavior: retailBehavior, stance: stance,
      notes: notes
    };
  }

  return {
    VERSION: VERSION,
    RULE_VERSION: RULE_VERSION,
    P: P,
    num: num,
    normBars: normBars,
    normFlows: normFlows,
    amtOf: amtOf,
    pctRank: pctRank,
    chipsDistribution: chipsDistribution,
    findPeaks: findPeaks,
    analyzeChips: analyzeChips,
    flowStats: flowStats,
    volumeStats: volumeStats,
    flowDir: flowDir,
    dirText: dirText,
    yi: yi,
    judgeMain: judgeMain,
    judgeRetail: judgeRetail,
    judgeStance: judgeStance,
    analyze: analyze
  };
});
