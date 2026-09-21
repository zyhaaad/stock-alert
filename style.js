#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  大盘风格驾驶舱 style.js · 2026-09-19 新建（STYLE_VERSION = S1）
 * ============================================================
 *  用户需求（2026-09-19）：
 *   · 判断当前大盘风格——大盘股 / 小微盘 / 短线妖股 / 轮动 / 某题材主升浪 /
 *     机构抱团 / 僵尸（无赚钱效应），给明确的判断和操作指南；
 *   · 让用户既不站到没有赚钱效应的僵尸板块，又不在题材过热后进来接盘
 *     （ref: 2026-05/06 半导体、CPO、光模块虹吸全市场；6 月底科技过热接盘）；
 *   · 每天推荐「资金最看好 且 不是顶部结构」的股票 ≤3 只。
 *
 *  ---------------- 引擎设计（S1） ----------------
 *
 *  一、数据源（全部实测可用，2026-09-19）：
 *    · 指数日线：腾讯 ifzq（上证50 sh000016 / 沪深300 sh000300 /
 *      中证1000 sh000852 / 国证2000 sz399303）→ 大盘 vs 小微盘 20 日相对强弱
 *    · 情绪周期：复用 screener.js 的东财涨停池管道（getJson/fetchPool/
 *      fetchTradingDates/emotionOfDay/classifyCycle/themeStats）——一字不改
 *    · 板块资金流：东财 push2delay clist fs=m:90+t:2（行业板块，f62 主力净额）
 *      ★ 注意：push2 直连会 socket hang up，必须走 push2delay（收盘后跑无延迟问题）
 *    · 个股主力净流入榜：push2delay clist fid=f62（f100=行业名，f21=流通市值·元）
 *    · 个股资金流历史：push2delay fflow/daykline（f51 日期 / f52 主力净额）
 *    · 候选 K 线：复用 screener.fetchBars（腾讯 ifzq 130 根）
 *    · 恐贪温度：读本仓 fng-history.json 尾条（days: [date, value, ...]）
 *
 *  二、风格判定（优先级从上到下，一票定档）：
 *    1. 僵尸/冰点  —— 情绪周期为冰点/退潮，或恐贪≤25 且涨停<35 家
 *                     → 「空仓观望」：不接飞刀，等修复日（溢价翻红）再说
 *    2. 题材主升浪 —— 同一题材在近 3 日里 ≥2 日是涨停家数第一，
 *                     且情绪周期不是冰点/退潮 → 明确点名题材
 *    3. 短线妖股   —— 空间板 ≥5 板（连板高度主导的短线情绪市）
 *    4. 轮动市     —— 近 3 日领涨题材日日换（无题材连庄）且涨停 ≥35 家
 *    5. 机构抱团   —— 大盘指数 20 日超额 ≥+2%（大盘股占优）
 *                     ⚠️ 代理指标：没有真实基金持仓数据，如实标注
 *    6. 小微盘     —— 小微指数 20 日超额 ≥+2%
 *    7. 均衡观望   —— 以上都不满足
 *
 *  三、每日优选（≤3 只，「资金最看好 + 非顶部结构」）：
 *    · 候选：个股主力净流入榜前列（所在板块在资金流入前 20）
 *            + 涨停池低位首板/二板（题材在前二主线、非尾盘偷袭、炸板≤1）
 *    · 硬剔除：ST/退市、北交所(8/4 开头)、科创板(688)、流通市值 <30亿、
 *            当日已涨停 >9.5%（打板归龙头战法管，这里不追板）
 *    · 顶部结构闸门（与控制台/Python 引擎 v2.1 同口径的硬规则子集）：
 *            诱多（空头排列+缩量反弹+触 MA20）→ 剔除
 *            破位（破 MA20/破前低/MA5 下穿 MA10，无反转豁免）→ 剔除
 *            天量（VR>3.0）→ 降级（只在名额不满时递补并注明待确认）
 *    · 资金连续性：主力净流入连续 ≥2 日为正才入围，连续天数与
 *            5 日累计净额/流通市值占比计分
 *    · 情绪冰点/退潮日：不出票（宁可空仓，不给接盘候选）
 *    · 止损纪律：统一 -5%（与龙头战法一致，打错必须斩）
 *
 *  四、诚实声明：研究型筛选，不是投资建议；风格判定是「已发生事实」的
 *      归纳，不做点位预测。板块豁免等线上没有的数据一律按保守口径。
 *
 *  本地调试：
 *    node style.js --dry        # 只算不写
 *    node style.js --report     # 打印最近风格快照
 *    node style.js --wait=8     # 等当日数据定型（最多 8 分钟）后再算，收盘即跑用
 *
 *  ---------------- 2026-09-21：收盘后立即更新 ----------------
 *  原来挂在 signals.yml 第 4 步（北京 16:05），且排在 screener/chips 之后 ——
 *  上游任一失败整条 job 就断，风格当天根本不更新。现独立为 style.yml：
 *    北京 15:05 快版（--wait=12，等腾讯当日日K + 东财涨停池当日数据到位）
 *    北京 15:40 定稿版（资金流数据此时已完整，覆盖同一交易日，见下方「同一交易日重跑」）
 *  同一交易日重跑只保留最新一份（h.days 去重 date），所以早晚两版不会重复堆积。
 *  15:30 前生成的快照标记 draft=true（快版），缺源如实写进 notes，不做任何乐观填充。
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const SC = require('./screener.js')

const SRC = __dirname
const STYLE_PATH = path.join(SRC, 'style-history.json')
const KEEP_DAYS = 120
const STYLE_VERSION = 'S1'

/* 配置（阈值集中在顶部，改规则必须升 STYLE_VERSION） */
const C = {
  idxLookback: 21,          // 指数相对强弱回看（20 日涨跌幅）
  idxGap: 0.02,             // 大小盘 20 日超额阈值 ±2%
  fngCold: 25,              // 恐贪 ≤25 视为冰点温度
  rotMinZt: 35,             // 轮动判定最低涨停家数
  runMinLbc: 3,             // 主升浪最低空间板高度
  yaoMinLbc: 5,             // 妖股档最低空间板高度
  // 优选闸门
  minLtsz: 30e8,            // 流通市值下限（元）
  maxPctMain: 9.5,          // 当日涨幅上限（不追已涨停的板，创业板 19.5）
  minStreak: 2,             // 主力净流入连续为正的最少天数
  candLimit: 12,            // 进入精筛（拉资金历史+K线）的候选上限
  vrHigh: 3.0,              // 天量（与 PS v2.1 一致）
  ret20Warn: 15             // 20 日涨幅警告线（防过热接盘）
}

/* 指数：大盘两腿 vs 小微两腿 */
const IDX = {
  large: [{ code: 'sh000016', name: '上证50' }, { code: 'sh000300', name: '沪深300' }],
  small: [{ code: 'sh000852', name: '中证1000' }, { code: 'sz399303', name: '国证2000' }]
}

/* ---------------- 数据抓取 ---------------- */

/** 腾讯指数日线 → normBars 对象数组（screener.fetchBars 只认 6 位股票代码，指数单独写） */
async function fetchIndexBars(code, n) {
  const j = await SC.getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,,' + ',' + (n + 5) + ',qfq')
  const key = j.data && Object.keys(j.data)[0]
  const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
  if (!raw || raw.length < n) return null
  const S = require('./signal-core.js')
  return S.normBars(raw)
}

/** 东财板块资金流（必须走 push2delay，push2 直连 socket hang up） */
async function fetchSectorFlow() {
  const url = 'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2' +
    '&fid=f62&fs=m:90+t:2&fields=f12,f14,f3,f62&ut=b2884a393a59ad64002292a3e90d46a5'
  const j = await SC.getJson(url)
  const rows = j.data && Array.isArray(j.data.diff) ? j.data.diff : null
  if (!rows || !rows.length) throw new Error('板块资金流无数据')
  return rows.map(r => ({
    code: String(r.f12), name: String(r.f14 || ''), pct: Number(r.f3),
    mainNet: isFinite(Number(r.f62)) ? Number(r.f62) : 0
  })).filter(r => r.name)
}

/** 东财个股主力净流入榜（全 A，按当日 f62 降序） */
async function fetchStockFlowTop() {
  const url = 'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2' +
    '&fid=f62&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f21,f62,f100&ut=b2884a393a59ad64002292a3e90d46a5'
  const j = await SC.getJson(url)
  const rows = j.data && Array.isArray(j.data.diff) ? j.data.diff : null
  if (!rows || !rows.length) throw new Error('个股主力净流入榜无数据')
  return rows.map(r => ({
    code: String(r.f12), name: String(r.f14 || ''), price: Number(r.f2), pct: Number(r.f3),
    ltsz: Number(r.f21), mainNet: Number(r.f62), sector: String(r.f100 || '')
  })).filter(r => r.name && isFinite(r.mainNet))
}

/**
 * 个股资金流历史（返回 [{date, mainNet}] 升序 + flowDays 可核验天数）。
 * push2his（全历史）优先，被反爬掐掉时降级 push2delay（实测只存最近 1 天）。
 * ⚠️ 降级时如实标注 flowDays=1，连续性闸门按当日口径放行（不伪造连续性）。
 */
async function fetchStockFlowHist(code, lmt) {
  const secid = (String(code)[0] === '6' ? '1.' : '0.') + code
  const qs = '&klt=101&secid=' + secid + '&fields1=f1,f2,f3,f7&fields2=f51,f52&ut=b2884a393a59ad64002292a3e90d46a5'
  const parse = j => {
    const kl = (j && j.data && j.data.klines) || []
    return kl.map(line => {
      const p = String(line).split(',')
      return { date: p[0], mainNet: Number(p[1]) }
    }).filter(x => isFinite(x.mainNet))
  }
  try {
    const out = parse(await SC.getJson('https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=' + (lmt || 8) + qs))
    return { rows: out.slice(-(lmt || 8)), flowDays: out.length }
  } catch (e) {
    const out = parse(await SC.getJson('https://push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=1' + qs))
    return { rows: out, flowDays: out.length }
  }
}

/* ---------------- 顶部结构闸门（PS v2.1 硬规则子集，与控制台/Python 同口径） ---------------- */

/** 从 normBars（{d,o,c,h,l,v}）构造评分行；<21 根返回 null 不评分 */
function psRow(bars) {
  const n = bars.length
  if (!bars || n < 21) return null
  const i = n - 1
  const c = bars[i].c
  if (!(isFinite(c) && c > 0)) return null
  const prevC = bars[i - 1].c
  function maN(k) {
    let s = 0
    for (let j = i - k + 1; j <= i; j++) s += bars[j].c
    return s / k
  }
  const ma5 = maN(5), ma10 = maN(10), ma20 = maN(20)
  const vol = bars[i].v
  let v5 = 0
  for (let j = i - 5; j < i; j++) v5 += bars[j].v
  let high20 = -Infinity, prevLow = Infinity
  for (let j = i - 19; j <= i; j++) if (bars[j].h > high20) high20 = bars[j].h
  for (let j = i - 20; j < i; j++) if (bars[j].l < prevLow) prevLow = bars[j].l
  const c20 = bars[i - 20].c
  return {
    close: c,
    pct: prevC > 0 ? (c / prevC - 1) * 100 : 0,
    volume: vol, volMa5: v5 / 5,
    ma5, ma10, ma20,
    ret20: c20 > 0 ? (c / c20 - 1) * 100 : 0,
    high20: isFinite(high20) ? high20 : null,
    prevLow: isFinite(prevLow) ? prevLow : null
  }
}

/**
 * 顶部结构硬规则（S1 口径，注释与 psCalc 逐条对应）：
 *   诱多 → force_no_trade（最高优先级，剔除）
 *   破位 → sell_bias（剔除；v2.1 反转首日豁免：pct≥7% 且 VR≥1.5 且收盘站上 MA5 不判破位）
 *   天量 VR>3.0 → pending_confirm（降级递补）
 * 返回 { score, verdict:'ok'|'reject'|'pending', vr, flags, why }
 */
function psGate(row, sectorHot) {
  if (!row) return { score: null, verdict: 'nodata', vr: NaN, flags: {}, why: 'K线不足21根' }
  const flags = { force_no_trade: false, sell_bias: false, pending_confirm: false, reversal_exempt: false, sector_exempt: false }
  let score = 20
  let why = []
  const maValid = isFinite(row.ma5) && isFinite(row.ma10) && isFinite(row.ma20)
  const vr = row.volMa5 > 0 ? row.volume / row.volMa5 : 1
  if (maValid && row.ma5 < row.ma10 && row.ma10 < row.ma20 && row.pct > 0 &&
      vr < 0.8 && row.high20 != null && row.close >= row.ma20 * 0.98) {
    flags.force_no_trade = true
    return { score: 0, verdict: 'reject', vr, flags, why: ['诱多（空头排列+缩量反弹+触MA20）'] }
  }
  if (maValid) {
    const broken = row.close < row.ma20 ||
      (row.prevLow != null && row.close < row.prevLow) || row.ma5 < row.ma10
    const reversal = row.pct >= 7 && vr >= 1.5 && row.close > row.ma5
    if (broken && reversal) { flags.reversal_exempt = true; why.push('反转首日豁免') }
    else if (broken) { flags.sell_bias = true; score -= 12; why.push('结构破位') }
  }
  if (vr >= 1.2) {
    if (vr <= C.vrHigh) { score += 6; why.push('放量 VR ' + vr.toFixed(2)) }
    else if (sectorHot) { flags.sector_exempt = true; why.push('天量但板块共振豁免') }
    else { flags.pending_confirm = true; why.push('天量 VR ' + vr.toFixed(2) + ' 待确认') }
  }
  if (maValid) {
    if (row.close > row.ma20) score += 5
    if (row.ma5 > row.ma10) score += 4
    if (row.close > row.ma20 && vr < 1) score += 3
  }
  if (isFinite(row.ret20) && row.ret20 > C.ret20Warn) { score -= 4; why.push('20日涨 ' + row.ret20.toFixed(0) + '% 偏热') }
  score = Math.max(0, Math.min(40, score))
  const verdict = flags.force_no_trade || flags.sell_bias ? 'reject'
    : (flags.pending_confirm ? 'pending' : 'ok')
  return { score, verdict, vr, flags, why }
}

/* ---------------- 风格判定（纯函数，可单测） ---------------- */

/** 大盘 vs 小微盘：两腿平均 20 日涨跌幅之差。返回 { dir, gap, ret20Large, ret20Small } */
function idxStyle(barsLarge, barsSmall) {
  const Lg = Array.isArray(barsLarge) ? barsLarge : []
  const Sm2 = Array.isArray(barsSmall) ? barsSmall : []
  function ret20(bars) {
    if (!bars || bars.length < C.idxLookback) return NaN
    const now = bars[bars.length - 1].c
    const then = bars[bars.length - C.idxLookback].c
    return then > 0 ? now / then - 1 : NaN
  }
  const L = [ret20(Lg[0]), ret20(Lg[1])].filter(isFinite)
  const Sm = [ret20(Sm2[0]), ret20(Sm2[1])].filter(isFinite)
  if (!L.length || !Sm.length) return { dir: 'unknown', gap: NaN, ret20Large: NaN, ret20Small: NaN }
  const rl = L.reduce((a, b) => a + b, 0) / L.length
  const rs = Sm.reduce((a, b) => a + b, 0) / Sm.length
  const gap = rl - rs
  const dir = gap >= C.idxGap ? 'large' : (gap <= -C.idxGap ? 'small' : 'flat')
  return { dir, gap, ret20Large: rl, ret20Small: rs }
}

/**
 * 近 3 日涨停池题材榜首序列 → 主线判断。
 * emoHist: 按日期升序的 emotionOfDay 快照（rows 为当日涨停池行）
 * 返回 { leadSeq: ['半导体','半导体','券商'], leadTheme, leadDays, themesToday }
 */
function themeLeaders(emoHist) {
  const seq = []
  for (const emo of emoHist.slice(-3)) {
    const th = SC.themeStats(emo.rows || [])
    const sorted = Object.keys(th).sort((a, b) => th[b].count - th[a].count || th[b].maxLbc - th[a].maxLbc)
    seq.push(sorted[0] || '')
  }
  const today = SC.themeStats(emoHist[emoHist.length - 1].rows || [])
  const themesToday = Object.keys(today)
    .sort((a, b) => today[b].count - today[a].count)
    .slice(0, 5)
    .map(name => ({ name, count: today[name].count, maxLbc: today[name].maxLbc }))
  const leadTheme = seq[seq.length - 1] || ''
  const leadDays = seq.filter(x => x && x === leadTheme).length
  return { leadSeq: seq, leadTheme, leadDays, themesToday }
}

/**
 * 风格判定主入口（纯函数）。
 * ctx: { cycle, emo(今日快照), fng, idx(idxStyle结果), themes(themeLeaders结果) }
 * 返回 { id, name, why[], guide, themes }
 */
function classifyStyle(ctx) {
  const { cycle, emo, fng, idx, themes } = ctx
  const why = []
  const zt = emo ? emo.zt : NaN

  /* 1. 僵尸/冰点：优先级最高——没有赚钱效应，说什么都是白搭 */
  const coldByCycle = cycle && (cycle.cycle === '冰点' || cycle.cycle === '退潮')
  const coldByFng = isFinite(fng) && fng <= C.fngCold && isFinite(zt) && zt < C.rotMinZt
  if (coldByCycle || coldByFng) {
    if (coldByCycle) why.push('情绪周期：' + cycle.cycle + (cycle.repaired ? '（今日溢价翻红=修复日）' : ''))
    if (coldByFng) why.push('恐贪 ' + fng + ' 且涨停仅 ' + zt + ' 家')
    return {
      id: 'defense', name: '僵尸/冰点（无赚钱效应）',
      why: why.concat(cycle && cycle.why ? cycle.why : []),
      guide: '空仓观望，不接飞刀。涨停/跌停家数与昨涨停溢价修复之前，任何「便宜」都可能是更便宜。' +
        (cycle && cycle.repaired ? '今日昨涨停溢价已翻红（修复日信号出现），可小仓试错主线龙头，错了立刻走。' : '等修复日信号（昨涨停溢价翻红）再看。')
    }
  }

  /* 2. 题材主升浪：同一题材 ≥2/3 日霸榜涨停家数 + 高度 ≥3 */
  if (themes.leadDays >= 2 && emo && emo.maxLbc >= C.runMinLbc) {
    why.push('「' + themes.leadTheme + '」近 3 日 ' + themes.leadDays + ' 日涨停家数第一')
    why.push('空间板 ' + emo.maxLbc + ' 板、涨停 ' + zt + ' 家、炸板率 ' + Math.round(emo.zbRate * 100) + '%')
    return {
      id: 'theme-run', name: '题材主升浪 · ' + themes.leadTheme,
      why: why.concat(cycle ? ['情绪周期：' + cycle.cycle] : []),
      guide: '只在主线里做：持有主线内不追高（20 日涨幅 >15% 的不新开仓），低位分支可低吸；' +
        '主线外的一律不加不做——5/6 月半导体虹吸期，站错板块怎么分析都赚不到钱。' +
        '警惕过热信号：空间板断崖（高度从 5+ 掉到 ≤3）或昨涨停溢价转负就是退潮前兆，见信号先减仓不幻想。'
    }
  }

  /* 3. 短线妖股：连板高度主导 */
  if (emo && emo.maxLbc >= C.yaoMinLbc) {
    why.push('空间板 ' + emo.maxLbc + ' 板、2 板以上 ' + emo.twoPlus + ' 只、梯队完整')
    return {
      id: 'short-term', name: '短线妖股/连板情绪市',
      why: why.concat(cycle ? ['情绪周期：' + cycle.cycle] : []),
      guide: '这是游资打板环境，接力逻辑看连板梯队不看基本面：跟着龙头战法页的推荐走，' +
        '只做主线最高板或低位首板，鱼尾板（6 板且非最高板）不碰。止损 -5% 铁律。'
    }
  }

  /* 4. 轮动市：领涨题材日日换 */
  const leaders = themes.leadSeq.filter(Boolean)
  const distinct = new Set(leaders).size
  if (leaders.length >= 3 && distinct >= 3 && isFinite(zt) && zt >= C.rotMinZt) {
    why.push('近 3 日题材榜首日日换：' + leaders.join(' → '))
    why.push('涨停 ' + zt + ' 家，赚钱效应在但没主线')
    return {
      id: 'rotation', name: '快速轮动市',
      why,
      guide: '轮动市不恋战：当日强不要追（次日大概率换板块），买在分歧卖在一致；' +
        '持仓以「低吸分支龙头 + 次日冲高即走」为主，重仓单一题材是轮动市最大的亏钱姿势。'
    }
  }

  /* 5. 机构抱团（代理指标：大盘股 20 日超额） */
  if (idx.dir === 'large') {
    why.push('大盘股 20 日超额 +' + (idx.gap * 100).toFixed(1) + '%（上证50/沪深300 vs 中证1000/国证2000）')
    return {
      id: 'crowd-large', name: '机构抱团 · 大盘权重',
      why: why.concat(['⚠️ 机构抱团为代理指标（指数相对强弱），没有真实基金持仓数据']),
      guide: '做指数权重与大票龙头（资金偏好大盘），放弃小票博弈；' +
        '用沪深300ETF/行业龙头替代个股追涨，个股只做放量突破平台的大票。'
    }
  }

  /* 6. 小微盘 */
  if (idx.dir === 'small') {
    why.push('小微盘 20 日超额 +' + (-idx.gap * 100).toFixed(1) + '%（中证1000/国证2000 占优）')
    return {
      id: 'small-cap', name: '小微盘占优',
      why,
      guide: '小票弹性大但退潮也快：只做有题材+有量的低位小票，仓位低于主线行情；' +
        '盯紧涨停家数——跌破 35 家就是小微盘情绪退坡信号，先减仓。'
    }
  }

  /* 7. 默认：均衡观望 */
  why.push('大小盘超额 ' + (isFinite(idx.gap) ? (idx.gap * 100).toFixed(1) + '%' : '数据缺') +
    '、涨停 ' + zt + ' 家、空间板 ' + (emo ? emo.maxLbc : '?') + ' 板，无明确方向')
  return {
    id: 'mixed', name: '均衡/观望',
    why,
    guide: '方向不明就降低动作频率：持仓按信号纪律执行，新开仓等风格明确（题材连庄或大小盘分化）再动。'
  }
}

/* ---------------- 优选打分（纯函数，可单测） ---------------- */

/**
 * 资金连续性闸门（纯函数）。
 * 历史 ≥3 天可核验：要求连续 ≥minStreak 日净流入；
 * 历史仅 1 天（push2his 被掐、delay 兜底）：按当日口径放行但如实降级标注；
 * 历史为 0：不放行。
 * 返回 { pass, why?, degraded? }
 */
function passFlow(c) {
  if (!isFinite(c.mainStreak)) return { pass: false, why: '资金流历史不可得' }
  if (c.mainStreak >= C.minStreak) return { pass: true }
  if (c.flowDays === 1 && c.mainStreak >= 1) {
    return { pass: true, degraded: '资金历史仅1日可核验，按当日口径' }
  }
  return { pass: false, why: '主力净流入连续不足 ' + C.minStreak + ' 日' + (c.flowDays === 1 ? '（历史仅1日可核验）' : '') }
}

/**
 * 候选打分。c: { code,name,sector,pct,ltsz,mainNet,mainStreak,mainSum5,ps,ret20,sectorRank,flowDays }
 * 返回 { score, reasons[], pass, why }
 */
function scoreCandidate(c) {
  const reasons = []
  /* 资金连续性（35 分）：连续净流入天数为主，5 日累计净额/流通市值为辅 */
  const streakScore = Math.min(c.mainStreak, 5) / 5
  const intensity = c.ltsz > 0 ? c.mainSum5 / c.ltsz : 0
  const flowScore = Math.min(Math.max(intensity, 0) * 20, 1)
  const flowPts = 35 * (streakScore * 0.6 + flowScore * 0.4)
  if (c.flowDays === 1) {
    reasons.push('主力当日净流入 ' + (c.mainNet / 1e8).toFixed(1) + ' 亿（历史仅1日可核验）')
  } else {
    reasons.push('主力连续 ' + c.mainStreak + ' 日净流入，5 日累计 ' + (c.mainSum5 / 1e8).toFixed(1) + ' 亿')
  }

  /* 板块地位（25 分）：所在板块当日主力净流入排名 */
  const sectorPts = 25 * Math.max(0, 1 - (c.sectorRank - 1) / 15)
  reasons.push('板块「' + c.sector + '」当日主力净流入第 ' + c.sectorRank + ' 名')

  /* 顶部结构（25 分）：psGate 分数归一（10~34 → 0~1），拒绝候选根本不会进来 */
  const psPts = c.ps && isFinite(c.ps.score) ? 25 * Math.min(Math.max((c.ps.score - 10) / 24, 0), 1) : 10
  if (c.ps && c.ps.why && c.ps.why.length) reasons.push('结构：' + c.ps.why.join('、'))

  /* 位置（15 分）：20 日涨幅适中最好，过热扣 */
  let posPts = 15, posNote = ''
  if (isFinite(c.ret20)) {
    if (c.ret20 > 30) { posPts = 0; posNote = '20日涨 ' + c.ret20.toFixed(0) + '% 过热' }
    else if (c.ret20 > C.ret20Warn) { posPts = 6; posNote = '20日涨 ' + c.ret20.toFixed(0) + '% 偏热' }
    else if (c.ret20 >= 0) { posPts = 15; posNote = '20日涨 ' + c.ret20.toFixed(0) + '% 位置适中' }
    else { posPts = 10; posNote = '20日跌 ' + (-c.ret20).toFixed(0) + '%（低位待启动）' }
    reasons.push('位置：' + posNote)
  }
  return {
    score: Math.round(flowPts + sectorPts + psPts + posPts),
    reasons,
    pass: c.mainStreak >= C.minStreak,
    why: c.mainStreak < C.minStreak ? '主力净流入连续不足 ' + C.minStreak + ' 日' : ''
  }
}

/** 候选硬剔除（同步规则，不联网）。返回 null=通过，否则返回剔除原因 */
function guardCandidate(c) {
  if (!c.code || !/^[0-9]{6}$/.test(c.code)) return '代码非法'
  if (/ST|退/i.test(c.name)) return 'ST/退市'
  const c0 = c.code[0]
  if (c0 === '8' || c0 === '4' || c0 === '9') return '北交所/老三板'
  if (c.code.slice(0, 3) === '688' || c.code.slice(0, 3) === '689') return '科创板'
  if (isFinite(c.ltsz) && c.ltsz < C.minLtsz) return '流通市值不足 ' + Math.round(C.minLtsz / 1e8) + ' 亿'
  const lim = c.code[0] === '3' ? 19.5 : C.maxPctMain
  if (isFinite(c.pct) && c.pct > lim) return '当日已涨停（追板归龙头战法，这里不追）'
  if (isFinite(c.pct) && c.pct < -3) return '当日大跌（逆势股不碰）'
  return null
}

/* ---------------- 存档 ---------------- */

function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(STYLE_PATH, 'utf8'))
    if (Array.isArray(j.days)) return j
  } catch (e) { /* 首次运行 */ }
  return { v: STYLE_VERSION, updated: '', days: [] }
}

/* ---------------- 收盘后「数据就绪」等待（2026-09-21 新增） ---------------- */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** 给任意 promise 套硬超时：数据来源卡住时不能拖死整个 workflow */
function withTimeout(p, ms, fallback) {
  return new Promise(resolve => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback) } }, ms)
    Promise.resolve(p).then(v => { if (!done) { done = true; clearTimeout(t); resolve(v) } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(fallback) } })
  })
}

/** 北京时间当天的分钟数（0~1439），与本机时区无关 */
function bjMinutes(d) {
  const ms = d ? new Date(d).getTime() : Date.now()
  const t = new Date(ms + 8 * 3600e3)
  return t.getUTCHours() * 60 + t.getUTCMinutes()
}

/** 周六/周日肯定不开市（法定节假日靠下面的日K兜底判断） */
function isWeekend(dateStr) {
  const w = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  return w === 0 || w === 6
}

/**
 * 等「今天」的交易数据真正定型再开工。
 * 就绪判据（两条都要满足，缺一不可）：
 *   ① 腾讯中证全指当日日K已出  → 说明今天确实是交易日且已收盘
 *   ② 东财涨停池当日返回非空    → 说明情绪侧数据已落库（否则 style/picks 全是空的）
 * 超时不报错、不 exit 1 —— 拿现有数据照常跑，缺源如实记进 notes。
 *
 * @returns {{dates:string[]|null, ready:boolean, waitedMin:number}}
 */
async function waitReady(today, waitMinutes) {
  const maxMin = Math.max(0, Math.min(30, Number(waitMinutes) || 0))
  if (!maxMin) return { dates: null, ready: true, waitedMin: 0 }   /* 不等：按就绪直接开工 */
  const t0 = Date.now()
  const deadline = t0 + maxMin * 60000
  let dates = null
  for (let i = 1; ; i++) {
    let ok = false
    try {
      const d = await withTimeout(SC.fetchTradingDates(7), 20000, null)
      if (d && d.length) dates = d
      if (d && d.length && d[d.length - 1] === today) {
        const pool = await withTimeout(SC.fetchPool('zt', today), 20000, [])
        ok = Array.isArray(pool) && pool.length > 0
      }
    } catch (e) { ok = false }
    if (ok) return { dates, ready: true, waitedMin: Math.round((Date.now() - t0) / 60000) }
    const rest = deadline - Date.now()
    if (rest <= 0) break
    console.log('  ⏳ ' + today + ' 当日数据尚未定型（第 ' + i + ' 次探测），' +
      Math.round(rest / 1000) + 's 后重试…')
    await sleep(Math.min(60000, rest))
  }
  return { dates, ready: false, waitedMin: Math.round((Date.now() - t0) / 60000) }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const dry = process.argv.includes('--dry')
  const report = process.argv.includes('--report')
  const today = bjDate()

  /* 周末直接收工：不等日K，省下 Actions 时长，也避免给非交易日留下垃圾快照 */
  if (isWeekend(today) && !report) {
    console.log(today + ' 是周末，非交易日 —— 跳过（不写存档）')
    return
  }

  if (report) {
    const h = loadHistory()
    for (const d of h.days.slice(-10)) {
      console.log(d.date + ' [' + (d.style ? d.style.name : '?') + '] 优选 ' +
        (d.picks ? d.picks.length : 0) + ' 只' + (d.picks && d.picks.length ? '：' + d.picks.map(p => p.name).join('、') : ''))
    }
    return
  }

  /* 收盘即跑：等当日日K + 涨停池双双到位（15:05 那次靠它顶住数据源延迟） */
  const waitMinArg = (process.argv.find(a => a.indexOf('--wait=') === 0) || '').split('=')[1]
  let ready = true, waitedMin = 0, datesCache = null
  if (waitMinArg && !dry) {
    const w = await waitReady(today, waitMinArg)
    datesCache = w.dates
    ready = w.ready
    waitedMin = w.waitedMin
    if (ready) console.log('✅ ' + today + ' 当日数据已就绪（等待 ' + waitedMin + ' 分钟）')
  }

  /* 等满了还没等到今天的数据 —— 基本可以断定今天不开市（法定节假日），
     直接收工而不是拿昨天的日K硬算成"今天"，否则驾驶舱会显示一条过期的假快照。 */
  if (waitMinArg && !dry && !ready) {
    console.log(today + ' 当日交易数据始终未定型 —— 判定为非交易日，跳过（不写存档）')
    return
  }

  const notes = []   // 数据缺源如实记录
  console.log('== 段1：指数风格（大盘 vs 小微盘，20 日） ==')
  let idx = { dir: 'unknown', gap: NaN, ret20Large: NaN, ret20Small: NaN }
  try {
    const bl = [], bs = []
    for (const it of IDX.large) bl.push(await fetchIndexBars(it.code, C.idxLookback + 3))
    for (const it of IDX.small) bs.push(await fetchIndexBars(it.code, C.idxLookback + 3))
    idx = idxStyle(bl, bs)
    console.log('  大盘 20 日 ' + (idx.ret20Large * 100).toFixed(2) + '% / 小微 ' + (idx.ret20Small * 100).toFixed(2) +
      '% → ' + (idx.dir === 'large' ? '大盘占优' : idx.dir === 'small' ? '小微占优' : '均衡'))
  } catch (e) { notes.push('指数风格数据缺：' + e.message) }

  console.log('== 段2：情绪周期（复用涨停池管道） ==')
  let cycle = null, emo = null, themes = { leadSeq: [], leadTheme: '', leadDays: 0, themesToday: [] }
  try {
    const dates = datesCache || await SC.fetchTradingDates(7)   /* --wait 已取过就复用，少一次请求 */
    if (!dates || !dates.length) throw new Error('交易日历不可得')
    const pools = { zt: {}, zb: {}, dt: {} }
    for (const d of dates) {
      for (const kind of ['zt', 'zb', 'dt']) {
        try { pools[kind][d] = await SC.fetchPool(kind, d) } catch (e) { pools[kind][d] = [] }
      }
    }
    const hist = dates.map(d => SC.emotionOfDay(d, pools, {}))
    emo = hist[hist.length - 1]
    cycle = SC.classifyCycle(hist)
    themes = themeLeaders(hist)
    console.log('  周期：' + cycle.cycle + '｜涨停 ' + emo.zt + ' 跌停 ' + emo.dt + '｜高度 ' + emo.maxLbc +
      ' 板｜主线：' + themes.leadSeq.join(' → '))
  } catch (e) { notes.push('涨停池数据缺：' + e.message) }

  let fng = NaN, fngDate = ''
  try {
    const f = JSON.parse(fs.readFileSync(path.join(SRC, 'fng-history.json'), 'utf8'))
    if (Array.isArray(f.days) && f.days.length) {
      const tail = f.days[f.days.length - 1]
      fng = Number(tail[1])
      fngDate = String(tail[0] || '')
    }
  } catch (e) { notes.push('恐贪存档不可得') }

  const style = classifyStyle({ cycle, emo, fng, idx, themes })
  console.log('== 段3：风格判定 → ' + style.name + ' ==')
  for (const w of style.why) console.log('  · ' + w)

  console.log('== 段4：每日优选（≤3 只） ==')
  let picks = []
  let pickNote = ''
  let sectors = []
  if (!emo || !cycle) {
    pickNote = '涨停池数据缺，优选停算（缺源不出票）'
    console.log('  ' + pickNote)
  } else if (cycle.cycle === '冰点' || cycle.cycle === '退潮') {
    pickNote = '情绪 ' + cycle.cycle + '，不出票（宁可空仓）'
    console.log('  ' + pickNote)
  } else {
    try {
      sectors = await fetchSectorFlow()
      const sectorRankOf = name => {
        const i = sectors.findIndex(s => s.name === name)
        return i >= 0 ? i + 1 : 99
      }
      const topStocks = await fetchStockFlowTop()
      const seen = {}
      let cands = []
      /* 来源 A：主力净流入榜（板块在流入前 20 或与主线同名） */
      for (const r of topStocks) {
        if (cands.length >= C.candLimit) break
        const g = guardCandidate(r)
        if (g) continue
        if (seen[r.code]) continue
        const rank = sectorRankOf(r.sector)
        if (rank > 20 && r.sector !== themes.leadTheme) continue
        seen[r.code] = 1
        cands.push(Object.assign({ from: 'flow', sectorRank: rank }, r))
      }
      /* 来源 B：涨停池低位板（题材主线内，非尾盘偷袭、炸板 ≤1） */
      if (emo.rows && emo.rows.length) {
        const topThemes = themes.themesToday.map(t => t.name)
        for (const r of emo.rows) {
          if (cands.length >= C.candLimit + 6) break
          const g = guardCandidate({ code: r.code, name: r.name, ltsz: r.ltsz, pct: r.pct })
          if (g) continue
          if (seen[r.code]) continue
          if (r.lbc < 1 || r.lbc > 3) continue
          if (r.zbc > 1) continue
          if (r.fbt && r.fbt >= 143000) continue
          if (topThemes.indexOf(r.hybk) < 0) continue
          seen[r.code] = 1
          cands.push(Object.assign({ from: 'zt', sector: r.hybk, sectorRank: sectorRankOf(r.hybk) }, r))
        }
      }
      console.log('  初筛候选 ' + cands.length + ' 只，精筛前 ' + Math.min(cands.length, C.candLimit) + ' 只…')
      cands = cands.slice(0, C.candLimit)

      /* 精筛：资金连续性 + K 线结构 */
      const scored = []
      for (const c of cands) {
        try {
          const flow = await fetchStockFlowHist(c.code, 8)
          const recent = flow.rows.slice(-6)
          let streak = 0
          for (let i = recent.length - 1; i >= 0 && recent[i].mainNet > 0; i--) streak++
          const sum5 = recent.slice(-5).reduce((a, b) => a + b.mainNet, 0)
          c.mainStreak = streak
          c.mainSum5 = sum5
          c.flowDays = flow.flowDays
          const bars = await SC.fetchBars(c.code)
          c.ps = psGate(psRow(bars), false)
          c.ret20 = bars && bars.length >= 21 ? (bars[bars.length - 1].c / bars[bars.length - 21].c - 1) * 100 : NaN
          if (c.ps.verdict === 'reject') {
            console.log('  ✗ ' + c.name + ' ' + c.code + '：' + c.ps.why.join('、'))
            continue
          }
          const pf = passFlow(c)
          if (!pf.pass) {
            console.log('  ✗ ' + c.name + ' ' + c.code + '：' + pf.why)
            continue
          }
          const sc = scoreCandidate(c)
          if (pf.degraded) sc.reasons.push('⚠️ ' + pf.degraded)
          scored.push(Object.assign(c, sc, { pending: c.ps.verdict === 'pending', flowDegraded: !!pf.degraded }))
        } catch (e) { console.log('  ✗ ' + c.name + ' ' + c.code + '：精筛失败 ' + e.message) }
      }
      /* 天量待确认的排最后：只在名额不满时递补 */
      scored.sort((a, b) => (a.pending - b.pending) || (b.score - a.score))
      picks = scored.slice(0, 3).map(c => ({
        code: c.code, name: c.name, sector: c.sector || '', price: c.price,
        pct: c.pct, score: c.score,
        mainStreak: c.mainStreak, mainSum5: c.mainSum5,
        ps: { score: c.ps.score, bias: c.ps.flags.force_no_trade ? '不操作' : c.ps.flags.sell_bias ? '减仓' : c.ps.flags.pending_confirm ? '待确认(天量)' : '中性', vr: Number(isFinite(c.ps.vr) ? c.ps.vr.toFixed(2) : NaN), why: c.ps.why },
        ret20: isFinite(c.ret20) ? Number(c.ret20.toFixed(1)) : null,
        pending: !!c.pending,
        reasons: c.reasons,
        stop: '止损 -5%（或跌破 10 日线，孰先到孰执行）'
      }))
      const pend = picks.filter(p => p.pending).length
      pickNote = picks.length
        ? ('优选 ' + picks.length + ' 只' + (pend ? '（含 ' + pend + ' 只天量待确认递补）' : ''))
        : '候选全部被闸门拦下（宁缺毋滥）'
      console.log('  ' + pickNote)
      for (const p of picks) console.log('  ★ ' + p.name + ' ' + p.code + ' ' + p.score + '分 ' + p.reasons.join('；'))
    } catch (e) { notes.push('优选停算：' + e.message); pickNote = '优选停算：' + e.message }
  }

  /* 写存档
   * ⚠️ date = **数据对应的交易日**（收盘日，如 09-18），不是脚本运行日（09-19 周六补跑）。
   *    generatedAt 才是运行时间；控制台显示「X 收盘更新」用的是 date。 */
  const dataDate = (emo && emo.date) || today
  /* 15:30 前算出来的算「快版」：此时东财板块/个股资金流可能还没结算完，
     15:40 的定稿版会按同一 date 覆盖它。如实标注，不让用户误以为是终值。 */
  const isDraft = bjMinutes() < 15 * 60 + 30
  const snap = {
    date: dataDate,
    generatedAt: today,
    draft: isDraft,
    styleVersion: STYLE_VERSION,
    style: { id: style.id, name: style.name, why: style.why, guide: style.guide },
    cycle: cycle ? { cycle: cycle.cycle, why: cycle.why, repaired: !!cycle.repaired } : null,
    fng: isFinite(fng) ? fng : null,
    /* ⚠️ fng.js 每天 16:05 才写当天定稿值，而驾驶舱 15:05 就跑 ——
       这时拿到的是**昨天**的恐贪，必须把它的日期一起存下来，
       否则界面上会把昨天的温度当成今天的读数。 */
    fngDate: fngDate || null,
    emo: emo ? { zt: emo.zt, dt: emo.dt, zb: emo.zb, zbRate: Number(emo.zbRate.toFixed(3)), maxLbc: emo.maxLbc, twoPlus: emo.twoPlus, prem: isFinite(emo.prem) ? Number(emo.prem.toFixed(4)) : null } : null,
    idx: { dir: idx.dir, gap: isFinite(idx.gap) ? Number((idx.gap * 100).toFixed(2)) : null, ret20Large: isFinite(idx.ret20Large) ? Number((idx.ret20Large * 100).toFixed(2)) : null, ret20Small: isFinite(idx.ret20Small) ? Number((idx.ret20Small * 100).toFixed(2)) : null },
    themes: themes.themesToday,
    leadSeq: themes.leadSeq,
    sectors: sectors.slice(0, 15).map(s => ({ name: s.name, mainNet: Number((s.mainNet / 1e8).toFixed(2)), pct: s.pct })),
    picks, pickNote,
    notes
  }
  if (isDraft && !dry) notes.push('收盘快版：板块/个股资金流可能尚未结算完，15:40 定稿版会覆盖本条')

  if (!dry) {
    const h = loadHistory()
    h.v = STYLE_VERSION
    h.updated = new Date().toISOString()
    h.days = h.days.filter(d => d.date !== dataDate)   /* 同一交易日重跑只保留最新一份 */
    h.days.push(snap)
    h.days = h.days.slice(-KEEP_DAYS)
    fs.writeFileSync(STYLE_PATH, JSON.stringify(h), 'utf8')
    console.log('已写 style-history.json（累计 ' + h.days.length + ' 天）')
  } else {
    console.log('（--dry 不写存档）')
  }
  if (notes.length) console.log('缺源备注：' + notes.join('；'))
}

/* 北京时间日期（本机时区无关）：传参则按参数取，否则取当前 UTC+8 日期 */
function bjDate(d) {
  const ms = d ? new Date(d).getTime() : Date.now() + 8 * 3600e3
  return new Date(ms).toISOString().slice(0, 10)
}

module.exports = {
  C, IDX, STYLE_VERSION, psRow, psGate, idxStyle, themeLeaders, classifyStyle,
  scoreCandidate, guardCandidate, passFlow, loadHistory,
  bjDate, bjMinutes, isWeekend, waitReady        // 2026-09-21：收盘即跑的就绪判断单独可测
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
