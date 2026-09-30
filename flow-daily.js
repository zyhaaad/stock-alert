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
 *   - clist 4 请求（行业/概念 × 流入/流出侧）+ daykline 约 200 请求（仅 --nomon 跳过），
 *     GitHub Actions 的 IP 干净、单并发 350ms，实测 push2his 板块日资金流从 Actions 可达
 *     （个股 clist 从 Actions 被 502 拒绝，板块级没问题——东财风控分级，2026-09-30 实测）
 *   - f62 取万元整数、f3 存涨跌幅 bp，mon 存 [当月累计万元, 月内连续天数(±)]，
 *     控制存档体积（60 天约 150KB）
 *   - 幂等：days 里当天覆盖；mon 每天全量重算覆盖
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

/* mon = 当月日档直接求和（零请求）+ daykline 只补缺缺日期（增量回补架构）。
 * ★ push2his 对 Actions IP 高频限流（2026-09-30 首跑 61/200 成功、30% 成功率实测），
 *   所以：当天补不齐没关系，失败的板块次日重试，随每日 cron 逐日补齐；
 *   全覆盖的板块零请求，稳态每天只发 4 个 clist。 */
async function buildMonthIncremental(names, type, monthPrefix, days) {
  const mon = {}
  let need = 0, ok = 0
  const t0 = Date.now()
  for (const bk of Object.keys(names)) {
    /* 该板块当月已有日期集合（来自日档） */
    const have = {}
    for (const d of days) {
      if (d.d.indexOf(monthPrefix) !== 0) continue
      const g = type === 2 ? d.ind : d.con
      if (g && g[bk] && g[bk].length >= 3) have[d.d] = 1
    }
    /* 当月已过交易日（近似=本月天数，月末对齐自然收敛）——有缺口才拉 daykline */
    const monthDayCount = monthPrefix === bjToday().slice(0, 7)
      ? new Date(Date.now() + 8 * 3600 * 1000).getUTCDate()
      : 30
    const covered = Object.keys(have).length >= monthDayCount
    if (!covered) {
      need++
      if (Date.now() - t0 > 8 * 60 * 1000) { mon[bk] = null; continue }   /* 8 分钟预算线，剩余次日再补 */
      try {
        const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=35&klt=101&secid=90.' + bk +
          '&fields1=f1,f2,f3,f7&fields2=f51,f52'
        const j = await getJSONFast(url)
        const kl = (j && j.data && j.data.klines) || []
        /* 把 daykline 里日档缺失的日期并入 days（保持日期序） */
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
  /* mon = 当月日档求和（含刚回补的） */
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
  console.log('mon(' + (type === 2 ? 'ind' : 'con') + '): 回补 ' + need + ' 板块（daykline 成功 ' + ok + '），mon 条目 ' + Object.keys(mon).length)
  return mon
}

async function main() {
  const t = bjToday()
  const monthPrefix = t.slice(0, 7)
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
      hist.mon.con = await buildMonthIncremental(hist.names, 3, monthPrefix, hist.days)
      hist.mon.ind = await buildMonthIncremental(hist.names, 2, monthPrefix, hist.days)
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
