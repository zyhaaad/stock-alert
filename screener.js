#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  每日备选池任务（龙头战法版） screener.js  · 2026-09-17 重构
 * ============================================================
 *  用户要求（2026-09-17）：按龙头战法/游资打法重做推荐逻辑——
 *   · 研究情绪周期 / 涨跌停家数 / 连板高度 / 题材梯队等环境规律
 *   · 每天推荐 1~2 只「最有可能连板」的票，给最佳买入价与买入理由
 *     （打板 / 首次分歧低吸 / 二波 之类），按当下环境选胜率最高的策略
 *   · 杜绝「推荐进去就接盘连续回调」：硬性防接盘过滤 + 买点纪律
 *   · 显示推荐后涨跌幅度、自己做好回测（回测工具在 _tests/leader-backtest.js）
 *   · **不推送**，只写备选池记录（控制台「今日推荐」页看）；不碰 ST / 科创板
 *
 *  ---------------- 龙头战法引擎设计 ----------------
 *
 *  一、环境判定（情绪周期）——每天收盘后用东财涨停池实时数据：
 *    zt 涨停家数 / dt 跌停家数 / zb 炸板家数 → 炸板率 zb/(zt+zb)
 *    maxLbc 空间板高度 / twoPlus 二板以上家数（梯队）/ 断层检测
 *    prem 昨日涨停股今日平均溢价（游资最看重的情绪温度计）
 *    周期五档：冰点 → 退潮 → 分歧 → 启动/发酵 → 高潮
 *
 *  二、策略与环境匹配（胜率优先）：
 *    冰点/退潮：不推荐接力（唯一能救的是「修复日」允许低吸）
 *    启动/发酵：打板（主线龙头 / 低位连板）+ 分歧低吸，两个口子都开
 *    高潮/分歧：只做首次分歧低吸（高潮追板胜率最差，ref: leader-game 避坑）
 *
 *  三、候选与打分（0~100）：
 *    龙头地位 30（连板高度 / 题材内最高板 / 全场空间板）
 *    梯队完整 15（二板以上家数 / 无断层）
 *    封板质量 20（首封时间早 / 封成比 / 炸板次数）
 *    位置结构 20（低位首板 / 二波形态 / 不追翻倍股）
 *    题材强度 15（板块涨停家数 / 板块高度 / 全场情绪）
 *
 *  四、防接盘硬过滤（一票否决，ref: 高位龙头追涨赔率最差）：
 *    ST/退市、非沪深主板/创业板、流通市值 <20亿 或 >350亿（游资甜区外）、
 *    换手 >45%（末日换手筹码松）、当日炸板 ≥2 次、昨日炸板股、
 *    一字板（根本买不进）、20 日涨幅 >100%（高位加速）、
 *    尾盘偷袭板（首封 ≥14:30，次日溢价差）、6 板及以上且不是全场最高板（鱼尾）
 *
 *  五、买点纪律（写进 plan，防接盘的核心）：
 *    打板单：次日以涨停价打板；高开 >7% 放弃（追高必接盘）、低开 >3% 放弃
 *            （封板质量存疑）；当日不封板，尾盘冲高无力即走
 *    低吸单：次日回踩「分歧日低点上方 2% 与 5 日线上方 1%」的孰低值附近分批；
 *            收盘跌破 10 日线无条件走；跌停或近跌停的分歧（负反馈）前一天已过滤
 *    统一止损：-5%（龙头战法打错必须斩，不许扛）
 *
 *  六、数据源与降级：
 *    · 东财 push2ex 涨停/炸板/跌停池（历史仅保留最近 ~15 个交易日，够用：
 *      每天只需要当天 + 前 6 个交易日的池子算情绪趋势）
 *    · 昨日涨停股今日溢价：腾讯 qt.gtimg 批量实时行情
 *    · 候选 K 线：腾讯 ifzq 130 根日线（结构与均线用）
 *    · 池接口全挂时降级：腾讯全 A 排行榜筛 zdf≥9.7%/19.5% 当伪涨停池，
 *      连板数改由 K 线逐日判定（fbt/fund/炸板字段缺失 → 对应打分项给中性分）
 *
 *  七、胜负口径（与持仓信号一致）：推荐日收盘价起，10 个交易日后 ±2% 定胜负。
 *      低吸单的真实入场价可能更优，此处统一从推荐日收盘计——保守口径。
 *
 *  诚实声明：研究型筛选，不是投资建议；样本 <20 条前胜率数字没有参考价值。
 *
 *  本地调试：
 *    node screener.js --dry        # 只算不写
 *    node screener.js --report     # 打印备选池胜负统计（按策略分桶）
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const S = require('./signal-core.js')

const SRC = __dirname
const PICKS_PATH = path.join(SRC, 'picks-history.json')
const KEEP = 1000            // 最多保留多少条推荐记录
const PICK_VERSION = 'L2'    // 备选池规则版本（与信号 RULE_VERSION 分开演进）。
// L2（2026-09-17）：120 日回测（群体 26 笔 + top-1 口径）三口径一致——
//   ① 低吸只在「分歧 / 退潮修复」出手（启动·低吸 0/4 -10.5%、发酵·低吸 0/6 全止损、高潮·低吸 17% -3.3%）；
//   ② 低吸候选昨日连板 ≤2（3 板 0/4、4 板 0/3 全止损，2 板 -0.5% 最优段）；
//   ③ 低吸分数门槛 50→60（受限群体 60+ 2/2 +25.3%、50-59 1/4 -1.1%）。
// L1→L2 后 top-1 口径：50%/+10.2% → 67%/+15.2%，接盘 1→0。样本仍小，持续用每日实盘验证。

/* ---------------- 可调参数（改这里 = 改策略，需同步升 PICK_VERSION） ---------------- */
const P = {
  em: {
    zt: 'https://push2ex.eastmoney.com/getTopicZTPool',
    dt: 'https://push2ex.eastmoney.com/getTopicDTPool',
    zb: 'https://push2ex.eastmoney.com/getTopicZBPool',
    ut: 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fbt%3Aasc'
  },
  emotionDays: 6,            // 情绪趋势回看几个交易日
  // 周期分档阈值
  cycle: {
    iceZt: 25,               // 涨停 ≤25 家 = 冰点
    iceZtPrem: 45,           // 或 ≤45 家且昨涨停溢价 < -4%
    icePrem: -0.04,
    iceLbc: 2,               // 或空间板 ≤2
    retreatPrem: -0.02,      // 昨涨停溢价 < -2% = 退潮
    retreatZbRate: 0.40,     // 或炸板率 ≥40%
    climaxZt: 85,            // 涨停 ≥85 家且高度 ≥5 = 高潮
    climaxLbc: 5,
    climaxLbc2: 6,           // 或空间板 ≥6 板且涨停 ≥50 家（高度打开 = 高潮区，不必等 85 家）
    climaxZt2: 50,
    climaxPrem: 0.05,        // 或昨涨停溢价 ≥+5%
    fermentZt: 55,           // 发酵：涨停 ≥55 且炸板率 ≤30% 且 2 板以上 ≥5
    fermentZbRate: 0.30,
    fermentTwoPlus: 5,
    launchZt: 35,            // 启动：涨停 ≥35 且溢价 >0 且炸板率 ≤35%
    launchZbRate: 0.35
  },
  // 防接盘硬过滤
  guard: {
    minLtsz: 20e8, maxLtsz: 350e8,
    maxHs: 45,               // 当日换手上限 %
    maxZbc: 1,               // 当日炸板次数上限（≥2 剔除）
    maxGain20: 1.00,         // 20 日涨幅上限
    maxLbcTail: 6,           // ≥6 板且非全场最高板 = 鱼尾剔除
    lateFbt: 143000,         // 尾盘偷袭板
    dipMinPct: -6,           // 分歧低吸：今日跌幅浅于 -6%（深水分歧=负反馈，回测教训）
    dipMaxPct: 1.5,          // 分歧低吸：今日未回封（≤+1.5%）
    dipMaxLbc: 2             // 低吸候选昨日连板上限（L2：3 板以上首次分歧=接高位筹码，回测 0/7 全负）
  },
  boardMinScore: 55,         // 打板候选最低分
  dipMinScore: 60,           // 低吸候选最低分（L2：50→60，受限群体 60+ 显著优于 50-59）
  dipScoreBias: 0,           // 低吸分加成（回测校准用）
  pickCount: 2,
  minAmountLtszHs: 2         // 换手低于 2% 的涨停（非一字的极端缩量）剔除
}

/* 用 https.get 而不是 fetch：实测腾讯/东财接口在部分运行时下
 * undici 会抛 UND_ERR_SOCKET，https.get 稳定。带超时与重试。 */
function getJson(url, tries) {
  const n = tries === undefined ? 2 : tries
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' },
        timeout: 15000
      }, res => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', d => (b += d))
        res.on('end', () => {
          try { resolve(JSON.parse(b)) }
          catch (e) {
            if (left > 0) return attempt(left - 1)
            reject(new Error('返回不是 JSON：' + b.slice(0, 80)))
          }
        })
      })
      req.on('error', e => {
        if (left > 0) return setTimeout(() => attempt(left - 1), 800)
        reject(new Error('请求失败: ' + (e && e.message ? e.message : e)))
      })
      req.on('timeout', () => {
        req.destroy()
        if (left > 0) return setTimeout(() => attempt(left - 1), 800)
        reject(new Error('请求超时'))
      })
    }
    attempt(n)
  })
}

function bjDate(d) {
  const t = d || new Date()
  return new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000).toISOString().slice(0, 10)
}

function loadPicks() {
  try {
    const j = JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8'))
    if (j && Array.isArray(j.picks)) return j
  } catch (e) { /* 首次运行 */ }
  return {
    _说明: '每日备选池·龙头战法版（不推送，只在控制台展示）。每条记录情绪周期/策略/买入价/止损，' +
      '10 个交易日后回填 ret10 与胜负（±2% 口径，从推荐日收盘保守起算）。内容没变不重写文件。',
    ruleVersion: PICK_VERSION, picks: []
  }
}

/* ---------------- 东财池接口 ---------------- */

async function fetchPool(kind, date) {
  const j = await getJson(P.em[kind] + '?' + P.em.ut + '&date=' + date.replace(/-/g, ''), 1)
  const pool = j && j.data && Array.isArray(j.data.pool) ? j.data.pool : null
  if (!pool) throw new Error('池接口无数据 ' + kind + ' ' + date)
  return pool.map(r => ({
    code: String(r.c), name: String(r.n || ''), price: Number(r.p) / 1000,
    pct: Number(r.zdp) / 100, ltsz: Number(r.ltsz), hs: Number(r.hs),
    lbc: Number(r.lbc) || 0, fbt: Number(r.fbt) || 0, lbt: Number(r.lbt) || 0,
    fund: Number(r.fund) || 0, zbc: Number(r.zbc) || 0, hybk: String(r.hybk || ''),
    zttj: r.zttj || null, amount: Number(r.amount) || 0
  }))
}

/** 腾讯批量实时行情：昨涨停股今日溢价用。返回 { code: { pct } } */
async function fetchQuotes(codes) {
  const out = {}
  const CHUNK = 50
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK)
    const q = part.map(c => (c[0] === '6' ? 'sh' : 'sz') + c).join(',')
    try {
      const txt = await new Promise((resolve, reject) => {
        const req = https.get('https://qt.gtimg.cn/q=' + q, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
          let b = ''
          res.setEncoding('utf8')
          res.on('data', d => (b += d))
          res.on('end', () => resolve(b))
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      })
      for (const seg of txt.split(';')) {
        const m = seg.match(/v_(sh|sz)(\d{6})="([^"]+)"/)
        if (!m) continue
        const f = m[3].split('~')
        const px = Number(f[3]), prev = Number(f[4])
        if (isFinite(px) && isFinite(prev) && prev > 0) out[m[2]] = { price: px, pct: px / prev - 1 }
      }
    } catch (e) { /* 单批失败跳过 */ }
  }
  return out
}

/** 腾讯日线（结构与均线用） */
async function fetchBars(code) {
  const secid = (String(code)[0] === '6' ? 'sh' : 'sz') + code
  const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + secid + ',day,,,130,qfq')
  const key = j.data && Object.keys(j.data)[0]
  const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
  return raw ? S.normBars(raw) : null
}

/** 交易日历：用指数（中证全指）最近日期推导，避免节假日把「0 涨停」误判成情绪冰点
 *  ⚠️ 2026-09-19 修 bug：URL 是 param=code,day,起,止,根数,qfq 五段，中间起止两个空位
 *     必须三个逗号（day,,,17）。之前写成 day,,17 → gtimg 返回 param error，
 *     fetchTradingDates 静默返回 null，情绪周期在生产上一直拿不到日历。 */
async function fetchTradingDates(n) {
  try {
    const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000985,day,,,' + (n + 10) + ',qfq')
    const key = j.data && Object.keys(j.data)[0]
    const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
    if (!raw) return null
    return raw.map(r => String(r[0])).slice(-n)
  } catch (e) { return null }
}

/* ---------------- 情绪周期判定 ---------------- */

/** 汇总某一天的池子 → 情绪快照。poolByDate: {date: rows}, quoteMap 可空 */
function emotionOfDay(date, pools, quoteMap) {
  const zt = (pools.zt[date] || []).filter(r => r.code[0] !== '4' && r.code[0] !== '8')
  const zb = pools.zb[date] || []
  const dt = pools.dt[date] || []
  const lbcList = zt.map(r => r.lbc || 1)
  const maxLbc = lbcList.length ? Math.max.apply(null, lbcList) : 0
  const twoPlus = lbcList.filter(x => x >= 2).length
  const threePlus = lbcList.filter(x => x >= 3).length
  const zbRate = (zt.length + zb.length) > 0 ? zb.length / (zt.length + zb.length) : 0
  // 昨涨停溢价：昨日 ZT 池股票今天的平均涨幅
  let prem = NaN
  const prevDates = Object.keys(pools.zt).filter(d => d < date).sort()
  if (prevDates.length && quoteMap && Object.keys(quoteMap).length) {
    const prev = pools.zt[prevDates[prevDates.length - 1]] || []
    const pcts = prev.map(r => quoteMap[r.code] ? quoteMap[r.code].pct : NaN).filter(x => isFinite(x))
    if (pcts.length) prem = pcts.reduce((a, b) => a + b, 0) / pcts.length
  }
  return { date, zt: zt.length, dt: dt.length, zb: zb.length, zbRate, maxLbc, twoPlus, threePlus, prem, rows: zt }
}

/**
 * 情绪周期五档。hist: 按日期升序的情绪快照数组（最后一项是今天）。
 * 返回 { cycle, why, repaired } —— repaired=退潮但溢价翻红（修复日，允许低吸）
 */
function classifyCycle(hist) {
  const m = hist[hist.length - 1]
  const C = P.cycle
  const why = []
  const prem3 = hist.slice(-3).map(x => x.prem).filter(x => isFinite(x))
  const prevPrem = hist.length >= 2 && isFinite(hist[hist.length - 2].prem) ? hist[hist.length - 2].prem : NaN
  const maxLbcPeak = Math.max.apply(null, hist.slice(-4).map(x => x.maxLbc).concat([0]))
  if (m.zt <= C.iceZt || (m.zt <= C.iceZtPrem && isFinite(m.prem) && m.prem < C.icePrem) || m.maxLbc <= C.iceLbc) {
    if (m.zt <= C.iceZt) why.push('涨停 ' + m.zt + ' 家 ≤ ' + C.iceZt)
    if (m.maxLbc <= C.iceLbc) why.push('空间板只有 ' + m.maxLbc + ' 板')
    if (isFinite(m.prem) && m.prem < C.icePrem) why.push('昨涨停溢价 ' + (m.prem * 100).toFixed(1) + '%')
    return { cycle: '冰点', why, repaired: false }
  }
  if ((isFinite(m.prem) && m.prem < C.retreatPrem) || m.zbRate >= C.retreatZbRate ||
      (maxLbcPeak >= 5 && m.maxLbc <= 3)) {
    if (isFinite(m.prem) && m.prem < C.retreatPrem) why.push('昨涨停溢价 ' + (m.prem * 100).toFixed(1) + '% < ' + (C.retreatPrem * 100) + '%')
    if (m.zbRate >= C.retreatZbRate) why.push('炸板率 ' + Math.round(m.zbRate * 100) + '%')
    if (maxLbcPeak >= 5 && m.maxLbc <= 3) why.push('空间板从 ' + maxLbcPeak + ' 板掉到 ' + m.maxLbc + ' 板')
    const repaired = isFinite(m.prem) && m.prem > 0 && isFinite(prevPrem) && prevPrem < 0
    return { cycle: '退潮', why, repaired }
  }
  if ((m.zt >= C.climaxZt && m.maxLbc >= C.climaxLbc) ||
      (m.maxLbc >= C.climaxLbc2 && m.zt >= C.climaxZt2) ||
      (isFinite(m.prem) && m.prem >= C.climaxPrem)) {
    if (m.zt >= C.climaxZt) why.push('涨停 ' + m.zt + ' 家且空间板 ' + m.maxLbc + ' 板')
    else if (m.maxLbc >= C.climaxLbc2) why.push('空间板 ' + m.maxLbc + ' 板（高度打开）且涨停 ' + m.zt + ' 家')
    if (isFinite(m.prem) && m.prem >= C.climaxPrem) why.push('昨涨停溢价 ' + (m.prem * 100).toFixed(1) + '% ≥ 5%')
    return { cycle: '高潮', why, repaired: false }
  }
  if (m.zt >= C.fermentZt && m.zbRate <= C.fermentZbRate && m.twoPlus >= C.fermentTwoPlus &&
      (!isFinite(m.prem) || m.prem > 0)) {
    why.push('涨停 ' + m.zt + ' 家、炸板率 ' + Math.round(m.zbRate * 100) + '%、2 板以上 ' + m.twoPlus + ' 只、梯队完整')
    return { cycle: '发酵', why, repaired: false }
  }
  if (m.zt >= C.launchZt && (!isFinite(m.prem) || m.prem > 0) && m.zbRate <= C.launchZbRate) {
    why.push('涨停 ' + m.zt + ' 家、溢价 ' + (isFinite(m.prem) ? (m.prem * 100).toFixed(1) + '%' : '缺') + '、炸板率 ' + Math.round(m.zbRate * 100) + '%')
    return { cycle: '启动', why, repaired: false }
  }
  why.push('涨停 ' + m.zt + ' 家、炸板率 ' + Math.round(m.zbRate * 100) + '%、高度 ' + m.maxLbc + ' 板')
  return { cycle: '分歧', why, repaired: false }
}

/* ---------------- K 线结构特征 ---------------- */

/** 涨停价：主板 10%，创业板（30）20% */
function limitPrice(code, prevClose) {
  const r = String(code)[0] === '3' ? 1.2 : 1.1
  return Math.round(prevClose * r * 100) / 100
}

function isLimitUpBar(code, bar, prevClose) {
  if (!isFinite(prevClose) || prevClose <= 0) return false
  const lim = limitPrice(code, prevClose)
  return bar.c >= lim - 0.005 && bar.c <= lim + 0.005
}

/**
 * 从 130 根日线提取结构特征。
 * knownLimitUp：池接口已告知今天涨停（回测路径传 null，由 K 线自行判定）
 */
function analyzeBars(code, bars, knownLimitUp) {
  const n = bars.length
  if (n < 60) return { ok: false, why: 'K线不足60根（次新）' }
  const i = n - 1
  const c = bars[i].c, o = bars[i].o, h = bars[i].h, l = bars[i].l
  const prevC = bars[i - 1].c
  const lim = limitPrice(code, prevC)
  const isZt = knownLimitUp === null ? isLimitUpBar(code, bars[i], prevC) : knownLimitUp
  // 连板数：从今天往前数连续涨停（回测路径用；池路径直接用池里的 lbc 校验）
  let streak = 0
  if (isZt) {
    streak = 1
    for (let k = i; k > 0; k--) {
      if (isLimitUpBar(code, bars[k - 1], bars[k - 2] ? bars[k - 2].c : NaN)) streak++
      else break
      if (k - 2 < 0) break
    }
  }
  // 一字板：开=高=收=涨停且全天未离开涨停价 → 根本买不进
  const isOneWord = isZt && o >= lim - 0.005 && Math.abs(h - o) < 0.005 && Math.abs(c - o) < 0.005 && l >= lim - 0.005
  // 20 日涨幅
  const c20 = bars[i - 20] ? bars[i - 20].c : NaN
  const gain20 = isFinite(c20) ? c / c20 - 1 : NaN
  // 60 日高点回撤
  let hi60 = 0
  for (let k = Math.max(0, i - 59); k <= i; k++) if (bars[k].h > hi60) hi60 = bars[k].h
  const dd60 = hi60 > 0 ? c / hi60 - 1 : NaN
  // 均线
  const ma = k => { if (i + 1 < k) return NaN; let s = 0; for (let x = i - k + 1; x <= i; x++) s += bars[x].c; return s / k }
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20)
  // 40 日内是否出过连续 ≥3 板的前龙头（二波判定前提）
  let hadRun = false, runPeak = 0
  let run = 0
  for (let k = Math.max(1, i - 40); k <= i; k++) {
    if (isLimitUpBar(code, bars[k], bars[k - 1].c)) {
      run++
      if (run >= 3) { hadRun = true }
      if (bars[k].h > runPeak) runPeak = bars[k].h
    } else run = 0
  }
  // 前龙头回调幅度（从 runPeak 到今天）
  const pullback = hadRun && runPeak > 0 ? c / runPeak - 1 : NaN
  const isSecondWave = hadRun && isFinite(pullback) && pullback <= -0.10 && pullback >= -0.35 && gain20 < 0.35
  // 今日量 vs 昨日量（分歧缩量判定用）
  const volNow = Number(bars[i].v) || 0, volPrev = Number(bars[i - 1].v) || 0
  return {
    ok: true, isZt, streak, lim, isOneWord, gain20, dd60, ma5, ma10, ma20,
    low: l, high: h, close: c, prevClose: prevC,
    hadRun, pullback, isSecondWave, volNow, volPrev,
    date: bars[i].d
  }
}

/* ---------------- 防接盘硬过滤 ---------------- */

/**
 * 一票否决。cand: 池行（或回测伪池行），feat: analyzeBars 结果，
 * ctx: { isMaxBoard(全场最高板), wasZbYesterday(昨日炸板) }
 * 返回 null=通过，否则字符串=剔除原因
 */
function guardReject(cand, feat, ctx) {
  const G = P.guard
  const name = cand.name || ''
  if (name.indexOf('ST') >= 0 || name.indexOf('退') >= 0) return 'ST/退市'
  if (!/^(60|00|30)/.test(cand.code)) return '非沪深主板/创业板'
  if (feat && !feat.ok) return feat.why
  if (isFinite(cand.ltsz) && cand.ltsz > 0 && (cand.ltsz < G.minLtsz || cand.ltsz > G.maxLtsz))
    return '流通市值 ' + (cand.ltsz / 1e8).toFixed(0) + ' 亿在游资甜区外'
  if (isFinite(cand.hs) && cand.hs > G.maxHs) return '换手 ' + cand.hs.toFixed(0) + '% 末日轮'
  if (isFinite(cand.zbc) && cand.zbc >= G.maxZbc + 1) return '今日炸板 ' + cand.zbc + ' 次'
  if (ctx && ctx.wasZbYesterday) return '昨日炸板股'
  if (feat && feat.isOneWord) return '一字板买不进'
  if (feat && isFinite(feat.gain20) && feat.gain20 > G.maxGain20)
    return '20 日已涨 ' + Math.round(feat.gain20 * 100) + '%（高位加速）'
  if (isFinite(cand.fbt) && cand.fbt > G.lateFbt && cand.fbt !== 0) return '尾盘偷袭板（首封 14:30 后）'
  // 连板数：优先用池官方值（cand.lbc；低吸路径传的是**昨日**连板数），缺了才用 K 线推算
  const lbc = isFinite(cand.lbc) && cand.lbc > 0 ? cand.lbc : (feat ? feat.streak : NaN)
  if (ctx && ctx.isDip && isFinite(lbc) && lbc >= 5) return lbc + ' 板高位大分歧（负反馈开端，不接）'
  if (isFinite(lbc) && lbc >= G.maxLbcTail && ctx && !ctx.isMaxBoard) return lbc + ' 板鱼尾接力'
  if (isFinite(cand.hs) && cand.hs < P.minAmountLtszHs && feat && !feat.isOneWord) return '换手过低封板无对手盘'
  return null
}

/* ---------------- 打分 ---------------- */

/**
 * 打板候选打分（今日涨停股）。返回 { score, reasons }
 * th: { count(题材今日涨停数), maxLbc(题材最高板), isThemeTop, isMaxBoard }
 */
function scoreBoard(cand, feat, emo, th) {
  let score = 0
  const reasons = []
  // 打板路径连板数：优先池官方值，缺了才用 K 线推算（与 guardReject 同一优先级）
  const lbc = isFinite(cand.lbc) && cand.lbc > 0 ? cand.lbc : (feat ? feat.streak : NaN)

  // 一、龙头地位 30
  let pos = 0
  if (lbc >= 5) pos += 12
  else if (lbc === 4) pos += 10
  else if (lbc === 3) pos += 8
  else if (lbc === 2) pos += 6
  else pos += 3
  reasons.push(lbc + ' 连板')
  if (th.isMaxBoard) { pos += 8; reasons.push('全场空间板') }
  else if (th.isThemeTop) { pos += 10; reasons.push(cand.hybk + ' 板块最高板') }
  score += Math.min(30, pos)

  // 二、梯队完整 15
  let lad = 0
  if (emo.twoPlus >= 6) lad += 8
  else if (emo.twoPlus >= 3) lad += 5
  else if (emo.twoPlus >= 1) lad += 2
  reasons.push('全场 2 板以上 ' + emo.twoPlus + ' 只')
  score += Math.min(15, lad)

  // 三、封板质量 20（回测路径缺 fbt/fund/zbc 时给中性 8 分）
  let q = 8
  if (isFinite(cand.fbt) && cand.fbt > 0) {
    if (cand.fbt <= 93500) { q += 6; reasons.push('10 点前首封') }
    else if (cand.fbt <= 103000) q += 4
    else if (cand.fbt <= 140000) q += 2
    else q -= 4
  }
  if (isFinite(cand.fund) && cand.fund > 0 && isFinite(cand.ltsz) && cand.ltsz > 0) {
    const seal = cand.fund / cand.ltsz
    if (seal >= 0.02) { q += 6; reasons.push('封成比 ' + (seal * 100).toFixed(1) + '%') }
    else if (seal >= 0.01) q += 3
    else q -= 2
  }
  if (isFinite(cand.zbc)) {
    if (cand.zbc === 0) { q += 5; }
    else if (cand.zbc === 1) { q += 2; reasons.push('炸板 1 次后回封') }
  }
  score += Math.max(0, Math.min(20, q))

  // 四、位置结构 20
  let st = 0
  if (feat && feat.ok) {
    if (lbc === 1 && isFinite(feat.gain20) && feat.gain20 < 0.25) { st += 6; reasons.push('低位首板（20 日仅涨 ' + Math.round(feat.gain20 * 100) + '%）') }
    if (feat.isSecondWave) { st += 8; reasons.push('二波形态（前龙头回调 ' + Math.round(-feat.pullback * 100) + '% 后再启动）') }
    if (isFinite(feat.dd60) && feat.dd60 > -0.20 && feat.dd60 <= -0.03) st += 4
    if (isFinite(feat.gain20)) {
      if (feat.gain20 <= 0.60) st += 2
      else reasons.push('20 日涨 ' + Math.round(feat.gain20 * 100) + '%（偏高，减分项已计）')
    }
  }
  score += Math.min(20, st)

  // 五、题材强度 15
  let tm = 0
  if (th.count >= 5) { tm += 8; reasons.push(cand.hybk + ' 今日 ' + th.count + ' 家涨停') }
  else if (th.count >= 3) { tm += 5; reasons.push(cand.hybk + ' 今日 ' + th.count + ' 家涨停') }
  else if (th.count >= 2) tm += 2
  if (th.maxLbc >= 3) tm += 4
  if (emo.zt >= 60) { tm += 3; reasons.push('全场涨停 ' + emo.zt + ' 家（情绪配合）') }
  score += Math.min(15, tm)

  return { score, reasons }
}

/**
 * 分歧低吸候选打分（昨日涨停、今日未回封、跌而不崩）。
 * dip: { pct(今日涨幅), ylbc(昨日连板), volRatio(今昨量比), feat }
 * th: { count(题材今日仍有几板), maxLbc }
 */
function scoreDip(dip, th, emo) {
  let score = 0
  const reasons = []
  // 地位：昨天几板。★ 2-3 板是首次分歧低吸的甜区：1 板没地位，≥5 板的高位大分歧是负反馈
  // 开端（回测教训：宜宾纸业 5 板分歧低吸 -27%、沪电股份 1 板分歧低吸 -21%，都在这上面亏的）
  let pos = 0
  if (dip.ylbc === 2 || dip.ylbc === 3) pos += 14
  else if (dip.ylbc === 4) pos += 8
  else pos += 4
  reasons.push('昨日 ' + dip.ylbc + ' 板今日首次分歧')
  score += Math.min(30, pos)
  // 分歧质量 25：跌而不崩 + 缩量
  let q = 0
  if (dip.pct >= -4) { q += 10; reasons.push('今日仅 ' + (dip.pct * 100).toFixed(1) + '%（强势分歧）') }
  else if (dip.pct >= -6) { q += 6; reasons.push('今日 ' + (dip.pct * 100).toFixed(1) + '%（中继分歧）') }
  else q += 2
  if (isFinite(dip.volRatio) && dip.volRatio < 1.3) { q += 8; reasons.push('分歧缩量（量比 ' + dip.volRatio.toFixed(2) + '）') }
  else if (isFinite(dip.volRatio) && dip.volRatio < 1.8) q += 4
  if (dip.feat && dip.feat.ok && dip.feat.close > dip.feat.ma5) { q += 4; reasons.push('仍站上 5 日线') }
  else if (dip.feat && dip.feat.ok && dip.feat.close > dip.feat.ma10) { q += 2; reasons.push('仍站上 10 日线') }
  score += Math.min(25, q)
  // 题材未死 25：今天同板块仍有涨停
  let tm = 0
  if (th.count >= 3) { tm += 15; reasons.push(dip.hybk + ' 今日仍 ' + th.count + ' 家涨停（题材未死）') }
  else if (th.count >= 2) { tm += 10; reasons.push(dip.hybk + ' 今日仍 ' + th.count + ' 家涨停') }
  else if (th.count >= 1) { tm += 4 }
  else return null                      // 板块今天没有任何涨停 → 题材退潮，不接
  if (th.maxLbc >= 3) tm += 5
  score += Math.min(25, tm)
  // 前期结构 20
  let st = 0
  if (dip.feat && dip.feat.ok) {
    if (dip.feat.isSecondWave) { st += 8; reasons.push('二波中继') }
    if (isFinite(dip.feat.gain20) && dip.feat.gain20 <= 0.5) st += 4
    if (isFinite(dip.feat.dd60) && dip.feat.dd60 > -0.15) st += 4
  }
  if (emo.zt >= 45) st += 4
  score += Math.min(20, st)
  return { score: score + P.dipScoreBias, reasons }
}

/** 低吸买入价：min(今日低点×1.02, 5日线×1.01)，且必须 ≥10日线×0.98（破位不接） */
function dipBuyPrice(feat) {
  if (!feat || !feat.ok) return NaN
  const bp = Math.min(feat.low * 1.02, feat.ma5 * 1.01)
  if (bp < feat.ma10 * 0.98) return NaN     // 分歧已破 10 日线，不接
  return Math.round(bp * 100) / 100
}

/* ---------------- 候选汇总 ---------------- */

function themeStats(rows) {
  const byTheme = {}
  for (const r of rows) {
    const t = r.hybk || '未知'
    if (!byTheme[t]) byTheme[t] = { count: 0, maxLbc: 0 }
    byTheme[t].count++
    if (r.lbc > byTheme[t].maxLbc) byTheme[t].maxLbc = r.lbc
  }
  return byTheme
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const dry = process.argv.includes('--dry')
  const report = process.argv.includes('--report')
  const picks = loadPicks()

  if (report) {
    const done = (picks.picks || []).filter(p => p.verdict && p.verdict.state !== 'pending')
    const wins = done.filter(p => p.verdict.state === 'win').length
    console.log('备选池体检（版本 ' + picks.ruleVersion + '）：共 ' + (picks.picks || []).length + ' 条，已判定 ' + done.length +
      '，胜 ' + wins + '，胜率 ' + (done.length ? Math.round(wins / done.length * 100) + '%' : '—') +
      '（口径：10 个交易日 ±2%，从推荐日收盘起算）')
    const byStrat = {}
    for (const p of done) {
      const k = p.strat || '未知'
      if (!byStrat[k]) byStrat[k] = { n: 0, w: 0 }
      byStrat[k].n++
      if (p.verdict.state === 'win') byStrat[k].w++
    }
    for (const k of Object.keys(byStrat)) {
      console.log('  ' + k + '：' + byStrat[k].w + '/' + byStrat[k].n + ' 胜（' + Math.round(byStrat[k].w / byStrat[k].n * 100) + '%）')
    }
    for (const p of done.slice(-10)) {
      console.log('  ' + p.date + ' [' + (p.cycle || '') + '·' + (p.strat || '') + '] ' + p.name + ' ' + p.code + '  ' +
        (p.verdict.ret >= 0 ? '+' : '') + (p.verdict.ret * 100).toFixed(2) + '%  ' + p.verdict.state)
    }
    return
  }

  console.log('== 段0：回填历史推荐胜负（10 个交易日后 ±2%） ==')
  // ★ 版本隔离：旧动量筛选器的推荐当年被误标成信号版本（R2/R3），而那是另一套策略——
  //   不改标的话 review 按版本隔离统计时会把它们算进 R3 的 PICK 样本（新旧混算）。统一改标 LEGACY。
  let relabeled = 0
  for (const p of (picks.picks || [])) {
    if (!p.strat && p.ruleVersion !== 'LEGACY') { p.ruleVersion = 'LEGACY'; relabeled++ }
  }
  if (relabeled) console.log('  旧动量推荐改标 LEGACY：' + relabeled + ' 条')
  let backfilled = 0
  const todo = (picks.picks || []).filter(p =>
    (!p.verdict || p.verdict.state === 'pending') && p.date !== bjDate())
  for (const p of todo) {
    try {
      const bars = await fetchBars(p.code)
      if (!bars) { p.verdict = { state: 'nodata', ret: NaN, resolveDate: null }; backfilled++; continue }
      const v = S.judgeOutcome({ side: 'buy', at: p.date, price: p.price }, bars)
      if (v.state !== 'pending') { p.verdict = v; backfilled++ }
    } catch (e) { /* 单只失败不影响整体 */ }
  }
  if (todo.length) console.log('  待回填 ' + todo.length + ' 条，本次判定 ' + backfilled + ' 条')

  console.log('== 段1：情绪周期判定（东财涨停池 × ' + P.emotionDays + ' 日） ==')
  const today = bjDate()
  const dates = await fetchTradingDates(P.emotionDays + 1)
  const days = (dates || Array.from({ length: P.emotionDays + 1 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000)
    return new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000).toISOString().slice(0, 10)
  })).reverse()
  const pools = { zt: {}, zb: {}, dt: {} }
  let poolOk = true
  try {
    for (const d of days) {
      const [zt, zb, dt] = await Promise.all([
        fetchPool('zt', d), fetchPool('zb', d).catch(() => []), fetchPool('dt', d).catch(() => [])
      ])
      pools.zt[d] = zt; pools.zb[d] = zb; pools.dt[d] = dt
    }
  } catch (e) {
    poolOk = false
    console.log('  ⚠️ 东财涨停池不可达（' + (e.message || e) + '），降级用腾讯全 A 榜单筛伪涨停池')
  }

  let emoHist = null
  let quoteMap = {}
  if (poolOk) {
    // 昨涨停溢价（含前一日，供「退潮修复」判定）：取最近两个交易日 ZT 池的票今天的涨幅
    const yCodes = (pools.zt[days[days.length - 2]] || []).map(r => r.code)
    const y2Codes = (pools.zt[days[days.length - 3]] || []).map(r => r.code)
    quoteMap = await fetchQuotes(Array.from(new Set(yCodes.concat(y2Codes))))
    emoHist = days.map(d => emotionOfDay(d, pools, quoteMap))
  } else {
    // 降级：腾讯全 A 榜单筛当日 zdf≥9.7%（主板）/≥19.5%（创业板）为伪涨停池
    // 只能算当天，情绪趋势缺历史 → 周期判定降级为单日口径（prem 缺失按中性处理）
    const rows = await fetchUniverse().catch(() => [])
    const ztRows = []
    for (const r of rows) {
      const code = String(r.code || '').replace(/^(sh|sz|bj)/, '')
      const name = String(r.name || '')
      if (name.indexOf('ST') >= 0 || name.indexOf('退') >= 0) continue
      if (!/^(60|00|30)/.test(code)) continue
      const zdf = Number(r.zdf)
      if (!isFinite(zdf)) continue
      if ((code[0] === '3' ? zdf >= 19.5 : zdf >= 9.7)) {
        ztRows.push({ code, name, price: Number(r.zxj), pct: zdf / 100, ltsz: Number(r.zsz) * 1e8,
          hs: Number(r.hsl), lbc: 0, fbt: 0, lbt: 0, fund: 0, zbc: NaN, hybk: '', zttj: null, amount: 0 })
      }
    }
    pools.zt[today] = ztRows
    pools.zb[today] = []; pools.dt[today] = []
    emoHist = [emotionOfDay(today, pools, {})]
    console.log('  伪涨停池 ' + ztRows.length + ' 只（无连板数，将由 K 线补算）')
  }

  const emo = emoHist[emoHist.length - 1]
  const cc = classifyCycle(emoHist)
  console.log('  今日：涨停 ' + emo.zt + '、跌停 ' + emo.dt + '、炸板 ' + emo.zb + '（炸板率 ' + Math.round(emo.zbRate * 100) + '%）、' +
    '空间板 ' + emo.maxLbc + ' 板、2 板以上 ' + emo.twoPlus + ' 只、昨涨停溢价 ' +
    (isFinite(emo.prem) ? (emo.prem * 100).toFixed(1) + '%' : '缺'))
  console.log('  情绪周期判定：' + cc.cycle + (cc.repaired ? '（修复日）' : '') + ' —— ' + cc.why.join('；'))

  if (cc.cycle === '冰点' || (cc.cycle === '退潮' && !cc.repaired)) {
    console.log('  == 今日不推荐：' + cc.cycle + '期不接力（' + cc.why.join('；') + '）。等待修复信号再出手。 ==')
    console.log('（按用户要求：备选池不推送，只在控制台展示）')
    return
  }

  console.log('== 段2：候选构造 ==')
  const ztRows = pools.zt[emo.date] || []
  const yDate = days[days.length - 2]
  const yZtRows = pools.zt[yDate] || []
  const zbYesterday = new Set((pools.zb[yDate] || []).map(r => r.code))
  const ztToday = new Set(ztRows.map(r => r.code))
  const maxBoardAll = emo.maxLbc
  const thToday = themeStats(ztRows)

  // 全部候选拉 K 线：今日涨停（打板）+ 昨日涨停未回封且跌而不崩（低吸）
  const dipRows = yZtRows.filter(r => {
    if (ztToday.has(r.code)) return false
    if ((r.lbc || 0) < 2) return false                       // ★ 1 板没有「龙头分歧」地位，不接（回测教训）
    const q = quoteMap[r.code]
    if (!q) return false
    return q.pct >= P.guard.dipMinPct / 100 && q.pct <= P.guard.dipMaxPct / 100
  })
  const allCodes = ztRows.map(r => r.code).concat(dipRows.map(r => r.code))
  console.log('  打板候选 ' + ztRows.length + '（今日涨停）、分歧低吸候选 ' + dipRows.length + '（昨涨停今日未回封）')

  const barsMap = {}
  let next = 0
  async function worker() {
    while (next < allCodes.length) {
      const i = next++
      try { barsMap[allCodes[i]] = await fetchBars(allCodes[i]) } catch (e) { barsMap[allCodes[i]] = null }
    }
  }
  await Promise.all(new Array(Math.min(5, allCodes.length)).fill(0).map(worker))

  // 打板候选
  const boardCands = []
  for (const r of ztRows) {
    const bars = barsMap[r.code]
    const known = poolOk ? true : null          // 降级路径：由 K 线自行判定涨停
    const feat = bars ? analyzeBars(r.code, bars, known) : { ok: false, why: '无K线' }
    const th = thToday[r.hybk || '未知'] || { count: 0, maxLbc: 0 }
    const rej = guardReject(r, feat, { isMaxBoard: r.lbc >= maxBoardAll && maxBoardAll > 0, wasZbYesterday: zbYesterday.has(r.code) })
    if (rej) { console.log('    × ' + r.name + ' ' + r.code + '：' + rej); continue }
    const sc = scoreBoard(r, feat, emo, { count: th.count, maxLbc: th.maxLbc, isThemeTop: th.maxLbc === r.lbc && th.count >= 2, isMaxBoard: r.lbc >= maxBoardAll && maxBoardAll > 0 })
    boardCands.push({ cand: r, feat, sc })
  }

  // 低吸候选
  const dipCands = []
  for (const r of dipRows) {
    const q = quoteMap[r.code]
    const bars = barsMap[r.code]
    const feat = bars ? analyzeBars(r.code, bars, false) : { ok: false, why: '无K线' }
    const th = thToday[r.hybk || '未知'] || { count: 0, maxLbc: 0 }
    const dip = { pct: q.pct, ylbc: r.lbc || 1, volRatio: feat.ok ? feat.volNow / Math.max(1, feat.volPrev) : NaN, feat, hybk: r.hybk || '未知' }
    const rej = guardReject({ code: r.code, name: r.name, ltsz: r.ltsz, hs: NaN, zbc: NaN, fbt: 0, lbc: r.lbc, hybk: r.hybk },
      feat, { isMaxBoard: false, wasZbYesterday: false, isDip: true })
    if (rej) { console.log('    ×(低吸) ' + r.name + ' ' + r.code + '：' + rej); continue }
    if ((r.lbc || 0) > P.guard.dipMaxLbc) { console.log('    ×(低吸) ' + r.name + ' ' + r.code + '：昨日 ' + r.lbc + ' 板超低吸上限 ' + P.guard.dipMaxLbc + '（L2）'); continue }
    const sc = scoreDip(dip, { count: th.count, maxLbc: th.maxLbc }, emo)
    if (!sc) { console.log('    ×(低吸) ' + r.name + ' ' + r.code + '：题材今日无涨停（退潮不接）'); continue }
    const bp = dipBuyPrice(feat)
    if (!isFinite(bp)) { console.log('    ×(低吸) ' + r.name + ' ' + r.code + '：分歧已破 10 日线'); continue }
    dipCands.push({ cand: r, feat, sc, buyPrice: bp })
  }

  boardCands.sort((a, b) => b.sc.score - a.sc.score || (b.cand.fund || 0) - (a.cand.fund || 0))
  dipCands.sort((a, b) => b.sc.score - a.sc.score)
  console.log('  打板达标（≥' + P.boardMinScore + '）' + boardCands.filter(x => x.sc.score >= P.boardMinScore).length + '、低吸达标（≥' + P.dipMinScore + '）' + dipCands.filter(x => x.sc.score >= P.dipMinScore).length)

  // 策略口子（L2）：打板 = 启动/发酵；低吸 = 只在 分歧 / 退潮修复（回测：启动/发酵/高潮期低吸均为负期望群体）
  const allowBoard = cc.cycle === '启动' || cc.cycle === '发酵'
  const allowDip = cc.cycle === '分歧' || cc.repaired
  const chosen = []
  if (allowBoard) {
    const b = boardCands.find(x => x.sc.score >= P.boardMinScore)
    if (b) chosen.push({ ...b, strat: '打板·' + (b.sc.reasons.indexOf('全场空间板') >= 0 ? '空间板龙头' : b.sc.reasons.some(r => r.indexOf('板块最高板') >= 0) ? '题材龙头' : b.cand.lbc >= 2 ? '梯队接力' : '低位首板'), buyPrice: Math.round((b.feat.ok ? b.feat.lim : b.cand.price) * 100) / 100 })
  }
  if (allowDip && chosen.length < P.pickCount) {
    const d = dipCands.find(x => x.sc.score >= P.dipMinScore && (!chosen.length || chosen[0].cand.code !== x.cand.code))
    if (d) chosen.push({ ...d, strat: '低吸·首次分歧' })
  }
  // 兜底：发酵/启动日打板没有合格候选时，补第二只打板（行业自然错开由题材分保证）
  if (!chosen.length && allowBoard) {
    const b2 = boardCands.filter(x => x.sc.score >= P.boardMinScore - 5)
    if (b2.length >= 2) chosen.push({ ...b2[1], strat: '打板·梯队接力', buyPrice: Math.round((b2[1].feat.ok ? b2[1].feat.lim : b2[1].cand.price) * 100) / 100 })
  }
  if (!chosen.length) {
    console.log('  == 今日没有合格候选（打板/低吸均无达标），不硬凑。 ==')
    console.log('（按用户要求：备选池不推送，只在控制台展示）')
    return
  }

  const fresh = chosen.map(x => {
    const isBoard = x.strat.indexOf('打板') === 0
    const lim = x.feat.ok ? x.feat.lim : x.cand.price
    const buy = isBoard ? Math.round(lim * 100) / 100 : x.buyPrice
    return {
      id: x.cand.code + '|' + today,
      date: today,
      code: x.cand.code,
      name: x.cand.name,
      industry: x.cand.hybk || '',
      price: x.feat.ok ? x.feat.close : x.cand.price,   // 推荐日收盘（胜负回填基准）
      score: x.sc.score,
      cycle: cc.cycle + (cc.repaired ? '·修复' : ''),
      cycleWhy: cc.why.join('；'),
      strat: x.strat,
      buyType: isBoard ? '打板' : '低吸',
      buyPrice: buy,
      reasons: x.sc.reasons,
      plan: {
        // ★ 操作说明（2026-09-17 用户要求明确化）：本引擎是盘后推荐，进场=次日，卖出=次日起（A股 T+1）。
        //   先看竞价再决定挂不挂单——「高开/低开放弃」是在竞价阶段否决整单，不是挂单后撤单。
        buy: isBoard
          ? '【盘后推荐·明日进场】① 竞价 9:15-9:25 只看不动：开盘价 ≥' + (buy * 1.07).toFixed(2) + '（涨停价×1.07）→ 高开 >7% 放弃，本单作废；开盘价 ≤' + (buy * 0.97).toFixed(2) + '（涨停价×0.97）→ 低开 >3% 放弃，本单作废；' +
            '② 开盘价在两者之间 → 也不要开盘就挂单：未涨停时挂涨停价买单会因「价格优先」立即按当前卖一价成交（等于追高买在半山腰）。正确做法是盯盘，等股价快速上攻贴近涨停（卖一价贴到涨停价、涨幅约 9.7% 以上）的瞬间，再以涨停价 ' + buy.toFixed(2) + ' 挂单扫板，封板即成交；' +
            '③ 股价全天冲不到涨停附近 → 不挂单、不成交，无损失；扫板后若炸板回落 → 已成交，立即按卖出纪律 -5% 止损（炸板是打板的固有风险，仓位自控）；' +
            '④ 封板成交：当天 T+1 卖不了，持有到次日，按下方卖出纪律操作；不想盯盘就直接放弃打板单，只做低吸单（低吸限价单可挂等回踩，无需盯盘）'
          : '【盘后推荐·明日进场】① 竞价 9:15-9:25 只看不动：开盘价 ≥' + (buy * 1.03).toFixed(2) + '（买入价×1.03）→ 高开超 3% 不追，本单作废；' +
            '② 开盘价没超 → 以买入价 ' + buy.toFixed(2) + ' 挂限价单（限价低于现价不会立即成交，会一直等着，低吸=等分歧回踩送筹码，绝不追价）；' +
            '③ 当天没回踩到 ' + buy.toFixed(2) + ' → 单子不会成交，收盘前撤单即可，无损失；' +
            '④ 若成交：当天 T+1 卖不了，持有到次日，按下方卖出纪律操作',
        sell: '成交日 T+1 不可卖，次日起执行：统一止损 -5%（跌破 ' + (buy * 0.95).toFixed(2) + ' 当日走）；收盘跌破 10 日线无条件走；' +
          (isBoard ? '次日不封板或封板反复，冲高即兑现' : '反包涨停继续持有，冲高滞涨分批止盈')
      },
      ruleVersion: PICK_VERSION,
      verdict: null
    }
  })
  console.log('今日备选 ' + fresh.length + ' 只：')
  for (const f of fresh) {
    console.log('  [' + f.cycle + '·' + f.strat + '] ' + f.name + ' ' + f.code +
      ' 推荐价 ' + f.price.toFixed(2) + ' / 买入价 ' + f.buyPrice.toFixed(2) + '（' + f.score + ' 分）')
    for (const r of f.reasons) console.log('     · ' + r)
  }

  /* 弱转强观察池（2026-09-18）：盘后筛「今日炸板 + 题材未死 + 位置健康」。
     只是观察池——不计入正式推荐、不参与胜负统计；转强确认在次日竞价（盘后确认不了），
     用户按 confirm 文案盘中自行执行。 */
  const weakPool = []
  if (poolOk && cc.cycle !== '冰点' && cc.cycle !== '高潮') {
    const zbTodayRows = pools.zb[emo.date] || []
    const weakBase = []
    for (const r of zbTodayRows) {
      if (!r.code) continue
      const thw = thToday[r.hybk || '未知'] || { count: 0, maxLbc: 0 }
      if (thw.count < 2) continue                                   // 题材今日仍 ≥2 家涨停（题材未死）
      if (isFinite(r.ltsz) && (r.ltsz < P.guard.minLtsz || r.ltsz > P.guard.maxLtsz)) continue
      if (isFinite(r.hs) && r.hs > P.guard.maxHs) continue
      weakBase.push(r)
    }
    const weakBars = {}
    let wNext = 0
    async function wWorker() {
      while (wNext < weakBase.length) {
        const c = weakBase[wNext++].code
        try { weakBars[c] = await fetchBars(c) } catch (e) { weakBars[c] = null }
      }
    }
    await Promise.all(new Array(Math.min(5, weakBase.length)).fill(0).map(wWorker))
    const wScored = []
    for (const r of weakBase) {
      const bars = weakBars[r.code]
      if (!bars) continue
      const feat = analyzeBars(r.code, bars, true)
      if (!feat.ok) continue
      const pct = feat.close / feat.prevClose - 1
      if (pct < -0.07) continue                                     // 收太深 = 大面，不是弱转强素材
      if (isFinite(feat.gain20) && feat.gain20 > 0.6) continue      // 高位炸板风险大
      wScored.push({ r, pct, gain20: isFinite(feat.gain20) ? feat.gain20 : 0, thCount: (thToday[r.hybk || '未知'] || { count: 0 }).count })
    }
    wScored.sort((a, b) => b.thCount - a.thCount || a.gain20 - b.gain20)
    for (const c of wScored.slice(0, 3)) {
      weakPool.push({
        code: c.r.code, name: c.r.name, industry: c.r.hybk || '未知',
        why: '今日炸板（收盘 ' + (c.pct * 100).toFixed(1) + '%）、题材「' + (c.r.hybk || '未知') + '」今日仍 ' + c.thCount + ' 家涨停、20 日涨幅 ' + Math.round(c.gain20 * 100) + '%（位置健康）',
        confirm: '明日竞价确认：高开 2%-5% 且竞价放量 → 转强，轻仓试探，开盘 5 分钟不破竞价低点再确认；低开 / 平开 / 高开 >7% 一律放弃（弱转弱不接）。成交后 T+1，次日起按 -5% 止损执行。'
      })
    }
    if (weakPool.length) console.log('  弱转强观察池 ' + weakPool.length + ' 只（不计入推荐，次日竞价确认）')
  }

  /* 写存档（幂等：内容没变就不写） */
  const ids = new Set((picks.picks || []).map(p => p.id))
  let added = 0
  for (const f of fresh) if (!ids.has(f.id)) { picks.picks.push(f); added++ }
  if (picks.picks.length > KEEP) picks.picks = picks.picks.slice(picks.picks.length - KEEP)
  picks.ruleVersion = PICK_VERSION
  picks.weakPool = { date: today, rows: weakPool }

  if (!dry) {
    const prevText = fs.existsSync(PICKS_PATH) ? fs.readFileSync(PICKS_PATH, 'utf8') : ''
    const nextText = JSON.stringify(picks)
    if (nextText === prevText) {
      console.log('备选池无变化，不重写文件')
    } else {
      fs.writeFileSync(PICKS_PATH, nextText, 'utf8')
      console.log('已写 picks-history.json：共 ' + picks.picks.length + ' 条（新增 ' + added + '）')
    }
  }
  console.log('（按用户要求：备选池不推送，只在控制台展示）')
}

/* ---------------- 降级路径用的全 A 榜单（与旧版一致） ---------------- */

P.universeUrl = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList'
async function fetchUniverse() {
  const out = []
  let offset = 0
  let total = Infinity
  while (offset < total && offset <= 6000) {
    const url = P.universeUrl + '?board_code=aStock&sort_type=price&direct=down&offset=' + offset + '&count=200'
    const j = await getJson(url)
    const d = j && j.data
    if (j.code !== 0 || !d || !Array.isArray(d.rank_list) || !d.rank_list.length) break
    if (isFinite(d.total)) total = d.total
    out.push.apply(out, d.rank_list)
    offset += d.rank_list.length
  }
  console.log('  全 A 榜单拿到 ' + out.length + ' 条')
  return out
}

/* ---------------- 导出（回测工具 _tests/leader-backtest.js 复用引擎） ----------------
 * 2026-09-19 追加导出 getJson/fetchPool/fetchTradingDates/fetchBars/fetchQuotes：
 * 供 style.js（大盘风格驾驶舱）复用同一套数据管道，纯增量、不改任何逻辑。 */
module.exports = {
  P, PICK_VERSION, limitPrice, isLimitUpBar, analyzeBars,
  emotionOfDay, classifyCycle, guardReject, scoreBoard, scoreDip, dipBuyPrice, themeStats,
  getJson, fetchPool, fetchTradingDates, fetchBars, fetchQuotes
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
