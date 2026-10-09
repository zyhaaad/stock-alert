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
const https = require('https')

const DIR = __dirname
const HIST_PATH = path.join(DIR, 'flow-history.json')
const DRY = process.argv.includes('--dry')
const NOMON = process.argv.includes('--nomon')
const KEEP = 60
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' }
const MON_GAP_MS = 700   /* ★ 2026-10-09 由 250ms 提到 700ms：东财对高频是**直接断连**
                          *   （实测 ECONNRESET / UND_ERR_SOCKET / 502），250ms 连续打 589 个
                          *   必被掐 → 整个 run 卡到超时被 cancel，存档停在 09-30。 */

/* ★ 全局硬预算（2026-10-09）：workflow timeout 放宽到 30 分钟是止血，
 *   真正的修复是让脚本自己**在预算内收尾并写盘**。超过 13 分钟立刻停止一切回补，
 *   已拿到的 days 增量照常落盘，剩下的次日重试。 */
const RUN_T0 = Date.now()
const TOTAL_BUDGET_MS = 13 * 60 * 1000
function leftMs() { return TOTAL_BUDGET_MS - (Date.now() - RUN_T0) }
function outOfBudget() { return leftMs() <= 0 }

/* ---------- 网络层：双传输 × 三域名回退（★ 2026-10-09 重写）----------
 * 实测结论（本机 + Actions 双向验证）：
 *   · fetch(undici) 打东财**高频即断连**：先 `UND_ERR_SOCKET: other side closed`，
 *     攒够次数后变 HTTP 502（10-09 run 37940977435 就死在这）；
 *   · https.get 同样会 ECONNRESET（限流与传输无关），但**带 timeout 后不会挂死**；
 *   · 三个域名 push2 / push2delay / push2his 共享同一风控，只能当**回退通道**，
 *     不能靠换域名突破限流 —— 真正的解药是**降频 + 退避 + 记忆上次成功的通道**。
 * ⇒ 传输方式 [https.get, fetch] × 域名 [delay, push2, his]，按上次成功通道优先。 */
const EM_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']
const EM_METHODS = ['https', 'fetch']
var EM_CHAN = { m: 'https', h: 'push2delay.eastmoney.com' }
const wait = ms => new Promise(r => setTimeout(r, ms))

function emSwap(url, host) { return String(url).replace(/push2(?:delay|his)?\.eastmoney\.com/, host) }

function httpsGetJson(url, ms) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: UA, timeout: ms || 15000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return }
      let b = ''
      res.setEncoding('utf8')
      res.on('data', d => (b += d))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(new Error('非 JSON：' + b.slice(0, 60))) } })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')) })
    req.on('error', e => reject(new Error('请求失败: ' + (e && e.message ? e.message : e))))
  })
}
async function fetchGetJson(url, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const to = setTimeout(() => { try { ctl && ctl.abort() } catch (e) { } }, ms || 15000)
  try {
    const r = await fetch(url, { headers: UA, signal: ctl ? ctl.signal : undefined })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally { clearTimeout(to) }
}

/* 单次「全通道」尝试：按记忆通道优先，把 6 种组合轮一遍，成功即记忆并退出 */
async function emOnce(url, ms) {
  const methods = [EM_CHAN.m].concat(EM_METHODS.filter(x => x !== EM_CHAN.m))
  const hosts = [EM_CHAN.h].concat(EM_HOSTS.filter(x => x !== EM_CHAN.h))
  let lastErr = null
  for (const m of methods) {
    for (const h of hosts) {
      try {
        const u = emSwap(url, h)
        const j = (m === 'https') ? await httpsGetJson(u, ms) : await fetchGetJson(u, ms)
        EM_CHAN = { m: m, h: h }
        return j
      } catch (e) { lastErr = e }
    }
  }
  throw lastErr || new Error('东财全通道不可用')
}

/* 带指数退避的重试（2 次以上才有意义；每次内部已轮 6 通道） */
async function getJSON(url, rounds) {
  const n = rounds === undefined ? 2 : rounds
  let lastErr = null
  for (let i = 0; i < n; i++) {
    try { return await emOnce(url, 15000) } catch (e) {
      lastErr = e
      if (outOfBudget()) break
      if (i < n - 1) await wait(3000 * Math.pow(2, i))   /* 3s / 6s */
    }
  }
  throw lastErr
}

/* daykline 单次（mon 回补用）：只走记忆通道 + 一次退避，绝不吃掉长等待 */
async function getJSONFast(url) {
  try { return await emOnce(url, 12000) } catch (e) {
    if (outOfBudget()) throw e
    await wait(2000)
    return await emOnce(url, 12000)
  }
}

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/* type: 2=行业板块 3=概念板块；返回 { bk: [名称, f62万元, chgBp] }
 * ⚠️ 2026-10-09 重写：
 *   · 旧结论「必须走 push2delay」已作废 —— 三个域名共享风控，谁都会被掐；
 *   · 两侧（流入 po=1 / 流出 po=0）**独立容错**：只做成一侧也接受，
 *     否则一个 502 就让当日**整档**丢失（这正是 10-08/10-09 存档停在 09-30 的原因）；
 *   · 两侧都失败才抛错（真故障，需要暴露出来）。 */
async function fetchBoards(type, pz) {
  const mk = function (po) {
    return 'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=' + pz +
      '&po=' + po + '&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:' + type +
      '&fields=f12,f14,f2,f3,f62&ut=b2884a393a59ad64002292a3e90d46a5'
  }
  const d1 = [], d0 = []
  let e1 = null, e0 = null
  try {
    const j1 = await getJSON(mk(1), 3)
    ;((j1 && j1.data && j1.data.diff) || []).forEach(x => d1.push(x))
  } catch (e) { e1 = e }
  if (!outOfBudget()) {
    try {
      const j0 = await getJSON(mk(0), 3)
      ;((j0 && j0.data && j0.data.diff) || []).forEach(x => d0.push(x))
    } catch (e) { e0 = e }
  }
  const diff = d1.concat(d0)
  if (!Array.isArray(diff) || !diff.length) {
    throw new Error('clist 两侧均失败（t=' + type + '）' +
      (e1 ? ' | 流入侧:' + e1.message : '') + (e0 ? ' | 流出侧:' + e0.message : ''))
  }
  if (e1 || e0) console.log('⚠️ t=' + type + ' 只取到一侧（' + (e1 ? '流入侧失败:' + e1.message : '') +
    (e0 ? '流出侧失败:' + e0.message : '') + '）→ 接受部分数据')
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

/* 交易日判定统一走 trade-day.js（单一真源）：日历（日线最新交易日）+ 实时行情时间戳
 * 双信号取「或」，避免任一接口滞后把真实交易日误判成非交易日 */
const TD = require('./trade-day.js')

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
  /* 回补预算 = min(全局剩余 − 60s 预留给写盘，8 分钟)。到点**直接跳出整轮**，
   * 不再逐个 continue（旧实现仍要空转 250ms×剩余板块，白耗时间）。 */
  const MON_BUDGET_MS = Math.max(0, Math.min(8 * 60 * 1000, leftMs() - 60000))
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
      if (Date.now() - t0 > MON_BUDGET_MS) break   /* 预算到点，剩余板块次日再补 */
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
      await new Promise(r => setTimeout(r, MON_GAP_MS))
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
   * 判定逻辑见 trade-day.js（双信号取「或」，防单接口滞后误跳过） */
  const g = await TD.gate(t)
  const tradeDates = g.dates
  if (g.isTrading === false) {
    console.log('非交易日（' + TD.describe(g) + '）→ 跳过，不写盘')
    return
  }
  if (g.isTrading === null) console.log('⚠️ 交易日历与行情时间戳都取不到（' + TD.describe(g) + '），按原有流程继续')
  /* 行业/概念独立容错：一侧全挂也保留另一侧，避免「一次 502 → 当日整档丢失」。
   * 两侧全挂才抛错（这是真故障，必须让 workflow 报红以便发现）。 */
  let ind = {}, con = {}, eInd = null, eCon = null
  try { ind = await fetchBoards(2, 100) } catch (e) { eInd = e }
  try { con = await fetchBoards(3, 80) } catch (e) { eCon = e }
  const nInd = Object.keys(ind).length
  const nCon = Object.keys(con).length
  if (!nInd && !nCon) {
    throw new Error('行业+概念两侧均取不到数据' +
      (eInd ? ' | 行业:' + eInd.message : '') + (eCon ? ' | 概念:' + eCon.message : ''))
  }
  if (eInd || eCon) console.log('⚠️ 部分数据源失败 → 只写成功的一侧（' +
    (eInd ? '行业:' + eInd.message : '') + (eCon ? ' 概念:' + eCon.message : '') + '）')

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
