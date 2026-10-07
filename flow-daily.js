#!/usr/bin/env node
/* 板块资金流日更存档（2026-09-29；2026-09-30 加月度累计全量）
 * 作用：每交易日收盘后跑一次，把「行业板块全量 + 概念板块前 80」的当日主力净流入
 *       增量写入 flow-history.json（保留最近 60 个交易日）。
 *       2026-09-30 起追加 mon 字段：逐板块拉 daykline(35 天) 算「当月累计主力净额 +
 *       月内连续天数」全量存档——页面端主排序口径是当月累计（用户原话「抓的不是
 *       当日的 TOP，是当月累计的 TOP」），但云端日档只有逐日增量、算不出真月累计
 *       （电池技术 9 月真实 -806 亿，2 天日档却算出 +1.9 亿 → 板块从榜上消失）。
 * 页面（资金流向监控）直读这份存档作主数据源/兜底：
 *   https://raw.githubusercontent.com/zyhaaad/stock-alert/main/flow-history.json
 *
 * 用法：node flow-daily.js [--dry] [--nomon]
 *
 * 设计要点：
 *   - **交易日闸门**（2026-10-07）：非交易日直接退出、不写盘。cron 是 `1-5` 工作日制，
 *     不认 A 股节假日；否则假期每天都跑（超时浪费配额），侥幸跑通还会把上一交易日
 *     数据写成假期当天的条目（脏数据）。双信号取「或」防单接口滞后误跳过。
 *   - clist 4 请求（行业/概念 × 流入/流出侧，每交易日固定）+ daykline **增量回补**
 *     （只为「当月交易日没补全」的板块发请求，覆盖率对齐交易日历；稳态 0 请求）。
 *     GitHub Actions 的 IP 干净：push2his 板块日资金流从 Actions 可达
 *     （个股 clist 从 Actions 被 502 拒绝，板块级没问题——东财风控分级，2026-09-30 实测），
 *     但**高频会被限流**（2026-09-30 首跑 61/200 成功≈30%），所以失败的板块次日重试、逐日收敛。
 *   - f62 取万元整数、f3 存涨跌幅 bp，mon 存 [当月累计万元, 月内连续天数(±)]，
 *     控制存档体积（60 天约 150KB）
 *   - 幂等：days 里当天覆盖；mon = 当月日档直接求和（不发额外请求）
 *   - mon 段整体 try/catch：被限流卡死时不能让 mon 拖 cancel 掉整个 run，
 *     否则 commit 在其后的当日 days 增量也会丢
 */
'use strict'
const fs = require('fs')
const path = require('path')

const DIR = __dirname
const HIST_PATH = path.join(DIR, 'flow-history.json')
const DRY = process.argv.includes('--dry')
const NOMON = process.argv.includes('--nomon')
const KEEP = 60
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' }
const MON_GAP_MS = 250   /* daykline 单并发间隔：360 板块（行业200+概念160）≈ 3-5 分钟 */

/* daykline 轻量重试（mon 用）：2 次尝试，避免个别 502 吃掉长退避拖垮 workflow 时限；
 * 失败板块直接跳过（mon 缺条目 → 页面端退回日档近似并标注），次日自动重试补齐 */
async function getJSONFast(url) {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  let lastErr
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers: UA })
      if (res.ok) return res.json()
      lastErr = new Error('HTTP ' + res.status)
    } catch (e) { lastErr = e }
    if (i < 1) await wait(1500)
  }
  throw lastErr
}

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function getJSON(url) {
  /* push2delay 从 Actions 间歇性 502（08:24Z 成功、12:00Z 失败实测），
   * 退避重试 4 次：3s / 6s / 10s */
  const wait = ms => new Promise(r => setTimeout(r, ms))
  let lastErr
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: UA })
      if (res.ok) return res.json()
      lastErr = new Error('HTTP ' + res.status + ' ' + url.slice(0, 80))
      if (res.status !== 502 && res.status !== 503 && res.status !== 429) throw lastErr
    } catch (e) {
      /* 网络层异常（socket hang up 等）也重试，但 4xx 参数错重试无意义 */
      if (/HTTP 4/.test(String(e && e.message)) && !/HTTP 429/.test(String(e && e.message))) throw e
      lastErr = e
    }
    if (i < 3) await wait([3000, 6000, 10000][i])
  }
  throw lastErr
}

/* type: 2=行业板块 3=概念板块；返回 { bk: [名称, f62万元, chgBp] }
 * ⚠️ 必须走 push2delay + ut 令牌：push2 直连从 Actions 是 502/socket hang up
 *    （style.js 已踩过的坑，注释原话），push2delay 收盘后跑无延迟问题 */
async function fetchBoards(type, pz) {
  /* po=1 按净流入降序（流入侧 TOP），po=0 升序（流出侧 TOP）。
   * 两侧都要抓：只抓 po=1 会让存档没有净流出板块（2026-09-30 实测 total=80 pos=80 neg=0） */
  const mk = function (po) {
    return 'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=' + pz +
      '&po=' + po + '&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:' + type +
      '&fields=f12,f14,f2,f3,f62&ut=b2884a393a59ad64002292a3e90d46a5'
  }
  const j1 = await getJSON(mk(1))
  const j0 = await getJSON(mk(0))
  const d1 = (j1 && j1.data && j1.data.diff) || []
  const d0 = (j0 && j0.data && j0.data.diff) || []
  const diff = d1.concat(d0)
  if (!Array.isArray(diff) || !diff.length) throw new Error('clist 返回空（t=' + type + '）')
  const out = {}
  for (const d of diff) {
    if (!d.f12) continue
    out[String(d.f12)] = [
      String(d.f14 || '').trim(),
      Math.round((Number(d.f62) || 0) / 1e4),
      Math.round((Number(d.f3) || 0) * 100)
    ]
  }
  return out
}

/* 单板块 daykline(35 天) → 当月累计(元→万元取整) + 月内连续天数(±) */
async function fetchMonth(bk, monthPrefix) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=35&klt=101&secid=90.' + bk +
    '&fields1=f1,f2,f3,f7&fields2=f51,f52'
  const j = await getJSONFast(url)
  const kl = (j && j.data && j.data.klines) || []
  let cum = 0, has = false, streak = 0
  for (const line of kl) {
    const p = String(line).split(',')
    if (p.length < 2 || p[0].indexOf(monthPrefix) !== 0) continue
    const f = parseFloat(p[1])
    if (isFinite(f)) { cum += f; has = true }
  }
  for (let i = kl.length - 1; i >= 0; i--) {
    const p = String(kl[i]).split(',')
    if (p.length < 2 || p[0].indexOf(monthPrefix) !== 0) break
    const f = parseFloat(p[1])
    if (!isFinite(f)) break
    if (streak === 0) { if (f > 0) streak = 1; else if (f < 0) streak = -1; else break }
    else if (streak > 0) { if (f > 0) streak++; else break }
    else { if (f < 0) streak--; else break }
  }
  return has ? [Math.round(cum / 1e4), streak] : null
}

/* 交易日历：腾讯中证全指 K 线取最近交易日（与 screener.js 同方案，腾讯域对 Actions 稳定）。
 * ⚠️ 2026-10-07 修 bug：cron 是 `1-5` 工作日，不认 A 股节假日 → 国庆等假期里每次都跑、
 *    都超时取消（浪费配额），且若侥幸跑通会把上一交易日数据写成假期当天的条目（脏数据）。
 *    现在：非交易日直接退出不写盘。 */
async function fetchTradingDates(n) {
  try {
    const j = await getJSONFast('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000985,day,,,' + (n + 10) + ',qfq')
    const key = j.data && Object.keys(j.data)[0]
    const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
    if (!raw) return null
    return raw.map(r => String(r[0])).slice(-n)
  } catch (e) { return null }
}

/* 交易日**交叉验证**（2026-10-07 加）：腾讯实时行情里的行情时间戳（假期时停在上一交易日）。
 * 动机：单靠日线日历有反向风险——若指数日线在收盘后尚未更新，真实交易日会被误判成
 *      「非交易日」而整日跳过（丢一天日档）。两个信号取「或」：只要有一个说今天是交易日就干。
 * 实现：用 latin1 读原始字节（时间戳是 ASCII，不依赖 Node 的 gbk/ICU 支持），
 *      字段为 `~YYYYMMDDHHMMSS~`，实测该 14 位片段在响应中唯一。 */
async function fetchQuoteDate() {
  try {
    const res = await fetch('https://qt.gtimg.cn/q=sh000985', { headers: UA })
    if (!res.ok) return null
    const txt = Buffer.from(await res.arrayBuffer()).toString('latin1')
    const m = txt.match(/~(\d{14})~/)
    return m ? m[1].slice(0, 8) : null   /* YYYYMMDD | null */
  } catch (e) { return null }
}

/* mon = 当月日档直接求和（零请求）+ daykline 只补日档缺失的交易日（增量回补架构）。
 * ★ push2his 对 Actions IP 高频限流（2026-09-30 首跑 61/200 成功、30% 成功率实测），
 *   所以：当天补不齐没关系，失败的板块次日重试，随每日 cron 逐日补齐；
 *   全部交易日已覆盖的板块零请求，稳态每天只发 4 个 clist。 */
async function buildMonthIncremental(names, type, monthPrefix, days, tradeDates, todayStr) {
  const mon = {}
  const monthTrade = (tradeDates || []).filter(d => d.indexOf(monthPrefix) === 0)
  const lastTradeDay = monthTrade.length ? monthTrade[monthTrade.length - 1] : todayStr
  let need = 0, ok = 0
  const t0 = Date.now()
  for (const bk of Object.keys(names)) {
    /* 该板块当月已有日期集合（来自日档 + 历次 daykline 回补） */
    const have = {}
    for (const d of days) {
      if (d.d.indexOf(monthPrefix) !== 0) continue
      const g = type === 2 ? d.ind : d.con
      if (g && g[bk] && g[bk].length >= 3) have[d.d] = 1
    }
    /* 覆盖判定：当月全部「已过交易日」都有 → 零请求（对齐交易日历，不再用自然日） */
    const covered = monthTrade.length
      ? monthTrade.every(d => have[d])
      : Object.keys(have).length > 0
    if (!covered) {
      need++
      if (Date.now() - t0 > 8 * 60 * 1000) continue   /* 8 分钟预算线，剩余次日再补 */
      try {
        const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=35&klt=101&secid=90.' + bk +
          '&fields1=f1,f2,f3,f7&fields2=f51,f52'
        const j = await getJSONFast(url)
        const kl = (j && j.data && j.data.klines) || []
        let added = 0
        for (const line of kl) {
          const p = String(line).split(',')
          if (p.length < 2 || p[0].indexOf(monthPrefix) !== 0) continue
          if (have[p[0]]) continue
          const f = Math.round((parseFloat(p[1]) || 0) / 1e4)
          let slot = days.find(x => x.d === p[0])
          if (!slot) { slot = { d: p[0], ind: {}, con: {} }; days.push(slot); days.sort((a, b) => a.d < b.d ? -1 : 1) }
          const g = type === 2 ? slot.ind : slot.con
          if (!g[bk]) { g[bk] = [String(names[bk] && names[bk][0] || bk), f, 0]; added++ }
        }
        if (added) ok++
      } catch (e) { /* 失败次日重试 */ }
      await new Promise(r => setTimeout(r, 250))
    }
  }
  /* mon = 当月日档求和（含刚回补的）；连续天数按月内末段方向 */
  for (const bk of Object.keys(names)) {
    let cum = 0, has = false, streak = 0
    const seq = []
    for (const d of days) {
      if (d.d.indexOf(monthPrefix) !== 0) continue
      const g = type === 2 ? d.ind : d.con
      if (g && g[bk] && g[bk].length >= 3) seq.push({ d: d.d, f: g[bk][1] })
    }
    for (const x of seq) { cum += x.f; has = true }
    for (let i = seq.length - 1; i >= 0; i--) {
      const f = seq[i].f
      if (streak === 0) { if (f > 0) streak = 1; else if (f < 0) streak = -1; else break }
      else if (streak > 0) { if (f > 0) streak++; else break }
      else { if (f < 0) streak--; else break }
    }
    if (has) mon[bk] = [cum, streak]
  }
  console.log('mon(' + (type === 2 ? 'ind' : 'con') + '): 回补 ' + need + ' 板块（daykline 成功 ' + ok +
    '），mon 条目 ' + Object.keys(mon).length + '，当月交易日 ' + monthTrade.length + ' 天（最新 ' + lastTradeDay + '）')
  return mon
}

async function main() {
  const t = bjToday()
  const monthPrefix = t.slice(0, 7)
  /* 交易日闸门：非交易日直接退出（不写盘）——cron 是工作日制，不认 A 股节假日
   * （国庆假期 2026-10-01~10-07 每次都跑、都超时取消；侥幸跑通会写脏数据）
   * 双信号取「或」：日历（日线最新交易日）+ 实时行情时间戳，避免任一接口滞后导致误跳过 */
  const tradeDates = await fetchTradingDates(60)
  const qDate = await fetchQuoteDate()                       /* YYYYMMDD | null */
  const lastCal = (tradeDates && tradeDates.length) ? tradeDates[tradeDates.length - 1] : null
  const calSay = lastCal === t
  const qSay = qDate === t.replace(/-/g, '')
  if ((lastCal || qDate) && !calSay && !qSay) {
    console.log('非交易日（交易日历最新 ' + (lastCal || '?') + '，行情时间戳 ' + (qDate || '?') +
      '，今天 ' + t + '）→ 跳过，不写盘')
    return
  }
  if (!lastCal && !qDate) console.log('⚠️ 交易日历与行情时间戳都取不到，按原有流程继续')
  const ind = await fetchBoards(2, 100)
  const con = await fetchBoards(3, 80)
  const nInd = Object.keys(ind).length
  const nCon = Object.keys(con).length
  if (nInd < 50) throw new Error('行业板块数量异常：' + nInd)

  let hist = { names: {}, days: [] }
  if (fs.existsSync(HIST_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'))
      if (prev && prev.days) hist = { names: prev.names || {}, days: prev.days, mon: prev.mon }
    } catch (e) { console.log('⚠️ 旧存档解析失败，重建：' + e.message) }
  }

  /* names 只增不改（板块名基本不变），days 里当天覆盖（幂等） */
  for (const bk of Object.keys(ind)) hist.names[bk] = [ind[bk][0], 2]
  for (const bk of Object.keys(con)) if (!hist.names[bk]) hist.names[bk] = [con[bk][0], 3]
  const todayEntry = { d: t, ind: ind, con: con }
  const idx = hist.days.findIndex(x => x.d === t)
  if (idx >= 0) hist.days[idx] = todayEntry
  else hist.days.push(todayEntry)
  if (hist.days.length > KEEP) hist.days = hist.days.slice(-KEEP)

  /* 月度累计（增量回补）：概念优先（用户关注度高），行业随后；8 分钟预算线防超时。
   * ⚠️ mon 必须容错：mon 被限流卡死时不能 cancel 掉整个 run（否则当日 days 增量
   *    也丢——commit 在 mon 之后）。mon 失败 → 本日 mon 空缺，页面端浏览器
   *    daykline 兜底，次日 cron 重试。 */
  if (!NOMON) {
    try {
      console.log('开始月度累计增量回补（' + monthPrefix + '）…')
      hist.mon = { ind: {}, con: {}, month: monthPrefix }
      hist.mon.con = await buildMonthIncremental(hist.names, 3, monthPrefix, hist.days, tradeDates, t)
      hist.mon.ind = await buildMonthIncremental(hist.names, 2, monthPrefix, hist.days, tradeDates, t)
    } catch (e) {
      console.log('⚠️ mon 回补失败（不阻断日档保存，次日重试）：' + e.message)
      delete hist.mon
    }
  }

  hist.updated = t
  const body = JSON.stringify(hist)
  const nMon = hist.mon ? (Object.keys(hist.mon.ind).length + Object.keys(hist.mon.con).length) : 0
  const summary = t + '  行业 ' + nInd + ' + 概念 ' + nCon + '  存档 ' + hist.days.length +
    ' 天  mon ' + nMon + '  ' + Math.round(body.length / 1024) + 'KB'
  if (DRY) {
    console.log('[dry] ' + summary)
    return
  }
  fs.writeFileSync(HIST_PATH, body)
  console.log('已写 flow-history.json：' + summary)
}

main().catch(function (e) {
  console.error('flow-daily 失败: ' + (e && e.message ? e.message : e))
  process.exit(1)
})
