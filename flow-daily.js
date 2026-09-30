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

/* 全板块月度累计：逐板块 daykline，单并发 + 间隔（Actions 实测 push2his 可达）。
 * 失败的板块不写 mon 条目（页面端对其退回日档序列近似），不中断整体。 */
async function buildMonth(names, monthPrefix) {
  const bks = Object.keys(names)
  const mon = {}
  let ok = 0, fail = 0
  for (let i = 0; i < bks.length; i++) {
    const bk = bks[i]
    try {
      const m = await fetchMonth(bk, monthPrefix)
      if (m) { mon[bk] = m; ok++ }
    } catch (e) { fail++ }
    if ((i + 1) % 40 === 0) console.log('  mon 进度 ' + (i + 1) + '/' + bks.length)
    await new Promise(r => setTimeout(r, MON_GAP_MS))
  }
  console.log('mon 完成：' + ok + ' 成功 / ' + fail + ' 失败 / ' + bks.length + ' 总数')
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

  /* 月度累计全量（跨月自然重置：monthPrefix=当月，上月数据不进 mon） */
  if (!NOMON) {
    console.log('开始拉取月度累计（' + monthPrefix + '）…')
    hist.mon = { ind: {}, con: {}, month: monthPrefix }
    const monInd = await buildMonth(Object.fromEntries(Object.keys(ind).map(k => [k, 1])), monthPrefix)
    hist.mon.ind = monInd
    const monCon = await buildMonth(Object.fromEntries(Object.keys(con).map(k => [k, 1])), monthPrefix)
    hist.mon.con = monCon
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
