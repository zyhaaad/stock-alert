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
const NOSTK = process.argv.includes('--nostk')   /* 跳过「板块→前5个股」段（调试用） */
const KEEP = 60
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' }
const MON_GAP_MS = 400   /* ★ 2026-10-09 由 250ms 提到 700ms：东财对高频是**直接断连**
                          *   （实测 ECONNRESET / UND_ERR_SOCKET / 502），250ms 连续打 589 个
                          *   必被掐 → 整个 run 卡到超时被 cancel，存档停在 09-30。
                          * ★ 2026-10-10 由 700ms 降到 400ms：700ms × 589 个 = 6.9 分钟纯等待，
                          *   加上单请求耗时必然超出 8 分钟预算 ⇒ 断档月永远补不齐。
                          *   400ms（2.5 请求/秒）仍是保守值，且 mon 预算同步提到 11 分钟。 */

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

/* ================= datacenter-web 通道（★ 2026-10-10 新增）=================
 * 解决什么问题：页面「点板块 → 主力净流入前 5 个股」原来靠
 *   push2.eastmoney.com/api/qt/clist/get?fs=b:BKxxxx&fid=f62
 * 这条**个股级 clist** 现在两头都被拒：
 *   · 用户出口（= 本机出口）：东财 **IP 级封禁** —— 实测连**板块级** clist 都直接拒连，
 *     「第一次就拒」是 IP 级封禁的判据（频率风控是「前几次 200、后段 502」）⇒
 *     降频 / 重试 / 换域名(push2/push2delay/push2his) / 等冷却 **全部无效**；
 *   · Actions 出口：实测同样被 502 拒（2026-09-30 记录：个股 clist 从 Actions 不可达，
 *     板块级 clist 正常 —— 东财风控分级）。
 * 已否掉的旁路：换源新浪（板块分级匹配率仅 13.8%，颗粒度差太远）、公开 CORS 中转（全挂：超时/401/429/503）。
 *
 * ★ 解法 = **换接口域**，不是换出口：`datacenter-web.eastmoney.com` 是另一套风控域
 *   （本机实测 http=200 可用），它有两个报表正好能把这件事拼出来：
 *     · RPT_BOARD_CONSTITUENT   板块 → 成分股（94,304 行；pageSize 2000 × 48 页，实测 ~40s）
 *     · RPT_DMSK_TS_STOCKNEW    全市场个股**当日**主力资金（5,200 只；pageSize 500 × 11 页，实测 ~6s）
 *   两者 join ⇒「板块 → 当日主力净流入前 5 个股」，写进 flow-history.json 的 stk 段；
 *   页面端**直接读档、东财请求数 = 0**，彻底绕开被封的 IP。
 * ⚠️ 口径：PRIME_INFLOW 单位 = 元，与 push2 的 f62「主力净流入（超大单+大单）」同义；
 *   本段**只做个股明细展示**，不参与任何排序、判定或信号（板块榜排序口径仍是 mon/当日 f62）。
 * ⚠️ 成本：每天多 59 个请求、间隔 450ms、实测无风控；仍受全局 13 分钟预算约束，
 *   预算到点即停并保留上一次的 stk 存档（宁可旧，不可脏）。
 * ⚠️ RPT_BOARD_CONSTITUENT 的 filter **不支持** BOARD_CODE_BK（实测 result=null），
 *   所以只能全量拉 48 页再本地取，不能只拉关心的 360 个板块。 */
const DC_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get?'
const DC_GAP_MS = 450
const STK_TOP_N = 5
const PAGE_MEMBER = 2000   /* RPT_BOARD_CONSTITUENT pageSize：实测 2000 可用（pages=48） */
const PAGE_STKFLO = 500    /* RPT_DMSK_TS_STOCKNEW pageSize：实测硬上限 500（传 1000 也只回 500） */

function qstr(o) {
  return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&')
}
/* datacenter-web 专用取数：与 push2 不同域，不走 emOnce 的六通道轮询（那是 push2 专用） */
async function dcGet(params, rounds, ms) {
  const url = DC_BASE + qstr(params)
  const n = rounds === undefined ? 3 : rounds
  let lastErr = null
  for (let i = 0; i < n; i++) {
    try { return await httpsGetJson(url, ms || 25000) } catch (e) {
      lastErr = e
      if (outOfBudget()) break
      if (i < n - 1) await wait(1200 * Math.pow(2, i))   /* 1.2s / 2.4s */
    }
  }
  throw lastErr || new Error('datacenter-web 不可用')
}

/* 板块 → 成分股（只留 IS_VALID=1；去重按「板块码#股票码」防分页边界重复） */
async function fetchBoardMembers() {
  const map = {}, seen = {}
  let raw = 0, total = 0, kept = 0
  for (let pn = 1; pn <= 80; pn++) {
    if (outOfBudget()) { console.log('⚠️ 板块成分：预算到点，已抓 ' + raw + '/' + (total || '?') + ' 行'); break }
    const j = await dcGet({
      reportName: 'RPT_BOARD_CONSTITUENT',
      columns: 'BOARD_CODE_BK,SECURITY_CODE,IS_VALID',
      pageSize: PAGE_MEMBER, pageNumber: pn,
      sortColumns: 'BOARD_CODE_BK,SECURITY_CODE', sortTypes: '1,1',
      source: 'WEB', client: 'WEB'
    })
    const r = j && j.result
    const d = (r && r.data) || []
    if (!d.length) break
    total = Number(r.count) || 0
    for (const x of d) {
      raw++
      if (String(x.IS_VALID) !== '1') continue
      const bk = x.BOARD_CODE_BK, cd = x.SECURITY_CODE
      if (!bk || !cd) continue
      const k = bk + '#' + cd
      if (seen[k]) continue
      seen[k] = 1
      if (!map[bk]) map[bk] = []
      map[bk].push(cd)
      kept++
    }
    if (total && raw >= total) break
    await wait(DC_GAP_MS)
  }
  console.log('板块成分：原始 ' + raw + '/' + (total || '?') + ' 行，保留 ' + kept +
    ' 条，板块 ' + Object.keys(map).length + ' 个')
  return map
}

/* 全市场个股当日主力资金。返回 { d: 实际交易日, rows: {代码: [名称, 主力净额万元, 涨跌幅bp, 收盘价]} }，
 * 该交易日无数据 → null（调用方换候选日期重试）。 */
async function fetchStockFlow(dateStr) {
  const rows = {}
  let raw = 0, total = 0
  for (let pn = 1; pn <= 30; pn++) {
    const j = await dcGet({
      reportName: 'RPT_DMSK_TS_STOCKNEW',
      columns: 'SECURITY_CODE,SECURITY_NAME_ABBR,PRIME_INFLOW,CLOSE_PRICE,CHANGE_RATE',
      pageSize: PAGE_STKFLO, pageNumber: pn,
      filter: "(TRADE_DATE='" + dateStr + "')",
      sortColumns: 'SECURITY_CODE', sortTypes: 1,
      source: 'WEB', client: 'WEB'
    })
    const r = j && j.result
    const d = (r && r.data) || []
    if (!d.length) break
    total = Number(r.count) || 0
    for (const x of d) {
      const chg = Number(x.CHANGE_RATE), pr = Number(x.CLOSE_PRICE)
      rows[x.SECURITY_CODE] = [
        String(x.SECURITY_NAME_ABBR || '').trim(),
        Math.round((Number(x.PRIME_INFLOW) || 0) / 1e4),        /* 元 → 万元（与 mon/days 同单位） */
        isFinite(chg) && x.CHANGE_RATE !== null ? Math.round(chg * 100) : null,   /* % → bp */
        isFinite(pr) && x.CLOSE_PRICE !== null ? pr : null
      ]
    }
    raw += d.length
    if (total && raw >= total) break
    if (outOfBudget()) break
    await wait(DC_GAP_MS)
  }
  if (!Object.keys(rows).length) return null
  console.log('个股资金 ' + dateStr + '：' + raw + '/' + (total || '?') + ' 只')
  return { d: dateStr, rows: rows }
}

/* ★ 纯函数（无网络，可单测）：板块成分 × 个股资金 → 每板块主力净流入前 N
 *   行格式 [代码, 名称, 主力净额万元, 涨跌幅bp, 收盘价]；只取 names 里的板块（页面可见全集）。
 *   排序键 = 主力净额（万元）降序；NaN 不进候选（fetchStockFlow 已把 null 转 null，此处 0 视为有效值）。 */
function topStocksForBoards(members, srows, names, topN) {
  const n = topN || STK_TOP_N
  const m = {}
  let nb = 0, ns = 0
  for (const bk of Object.keys(names)) {
    const cs = members[bk]
    if (!cs || !cs.length) continue
    const hits = []
    for (const c of cs) { const v = srows[c]; if (v) hits.push([c, v[0], v[1], v[2], v[3]]) }
    if (!hits.length) continue
    hits.sort((a, b) => b[2] - a[2])
    m[bk] = hits.slice(0, n)
    nb++; ns += m[bk].length
  }
  return { m: m, nb: nb, ns: ns }
}

/* ★ 纯函数（无网络，可单测）：板块成分 × 个股资金 → 每板块的**板块状态**
 *   返回 { BK: [涨家数, 跌家数, 平家数, 涨幅中位bp, 领涨股代码, 领涨股名, 领涨涨幅bp] }
 * 为什么要它（2026-10-10 用户报障「扩散度和核心没了」）：
 *   页面每行的「扩散 X%（涨 a/跌 b）」和「★核心」原来只来自**东财实时 clist 的 f104/f105/f106**。
 *   本机出口 IP 被东财封后，nUp/nDown 全为空 → flowBreadth 返回 NaN → 扩散度不显示、
 *   ★核心（要求扩散≥60%）也标不出来。而这个信息**用已经抓到手的两份数据就能算**：
 *   成分股名单（RPT_BOARD_CONSTITUENT）× 每只票当日涨跌幅（RPT_DMSK_TS_STOCKNEW）。
 *   ⇒ 零额外请求，且是收盘口径、不依赖东财实时。
 * 口径诚实说明：这是**本地按东财板块成分股当日涨跌幅自算**，不是东财官方家数；
 *   停牌/无成交的票不计入（东财官方口径可能不同），差异通常极小，但不得宣称与官方一致。 */
function boardStateFromMembers(members, srows, names) {
  const s = {}
  let nb = 0
  for (const bk of Object.keys(names)) {
    const cs = members[bk]
    if (!cs || !cs.length) continue
    let up = 0, dn = 0, fl = 0, lead = null
    const chgs = []
    for (const c of cs) {
      const v = srows[c]
      if (!v) continue
      const chg = v[2]                 /* bp；null = 当日无数据（停牌等）→ 不计入 */
      if (chg == null || !isFinite(chg)) continue
      if (chg > 0) up++; else if (chg < 0) dn++; else fl++
      chgs.push(chg)
      /* ⚠️ 比较的是 lead[2]（涨幅 bp），不是 lead[1]（名称）—— 拿字符串比数字恒为 false，
         会让"领涨股"永远停在第一个成分股上（写错过一次，靠单测抓出来）。 */
      if (!lead || chg > lead[2]) lead = [c, v[0], chg]
    }
    if (!chgs.length) continue
    chgs.sort((a, b) => a - b)
    const med = chgs[chgs.length >> 1]
    s[bk] = [up, dn, fl, med, lead[0], lead[1], lead[2]]
    nb++
  }
  return { s: s, nb: nb }
}

/* 组装 stk 段：{ d, m, s, nb, ns, nbs }（网络部分；两个 join 都走上面的纯函数）
 *   m = 每板块主力净流入前 5 个股；s = 每板块状态（涨跌家数 / 领涨股），供页面补扩散度与★核心。 */
async function buildBoardTopStocks(candDates, names) {
  const members = await fetchBoardMembers()
  if (!Object.keys(members).length) throw new Error('板块成分为空（datacenter-web 无返回）')
  let sf = null
  for (const dt of candDates) {
    if (!dt) continue
    sf = await fetchStockFlow(dt)
    if (sf) break
    console.log('⚠️ ' + dt + ' 无个股资金（未更新？）→ 换候选交易日')
    await wait(DC_GAP_MS)
  }
  if (!sf) throw new Error('候选交易日 ' + candDates.filter(Boolean).join('/') + ' 均无个股资金')
  const r = topStocksForBoards(members, sf.rows, names, STK_TOP_N)
  const st = boardStateFromMembers(members, sf.rows, names)
  return { d: sf.d, m: r.m, s: st.s, nb: r.nb, ns: r.ns, nbs: st.nb }
}

/* 自检模式（node flow-daily.js --stkcheck）：下载云端现有存档取 names，只跑 stk 段并打印，
 * 写/不写由 --dry 决定。用途 = 在不碰 push2（本机被封）的前提下验证这段链路。 */
async function stkCheck() {
  const urls = [
    'https://raw.githubusercontent.com/zyhaaad/stock-alert/main/flow-history.json',
    'https://cdn.jsdelivr.net/gh/zyhaaad/stock-alert@main/flow-history.json'
  ]
  let hist = null
  for (const u of urls) {
    try { hist = await fetchGetJson(u, 20000); if (hist && hist.days) break } catch (e) { hist = null }
  }
  if (!hist || !hist.names) throw new Error('云端存档取不到，无法 stk 自检')
  const t = bjToday()
  const cands = [t, hist.updated]
  if (hist.days.length) cands.push(hist.days[hist.days.length - 1].d)
  console.log('stk 自检：names ' + Object.keys(hist.names).length + ' 个板块，候选交易日 ' +
    cands.filter(Boolean).join(' / '))
  const stk = await buildBoardTopStocks(cands, hist.names)
  const kb = Math.round(JSON.stringify(stk.m).length / 1024)
  console.log('[stkcheck] 数据日 ' + stk.d + ' · ' + stk.nb + ' 板块 × 前 ' + STK_TOP_N +
    '（' + stk.ns + ' 行）· ' + kb + 'KB')
  console.log('[stkcheck] 板块状态 ' + stk.nbs + ' 个 · ' + Math.round(JSON.stringify(stk.s).length / 1024) + 'KB')
  const sample = ['BK1033', 'BK1036', 'BK0433'].filter(b => stk.m[b])
  for (const bk of sample) {
    const s = stk.s[bk] || []
    console.log('  ' + bk + ' ' + JSON.stringify(hist.names[bk][0]) + ': ' +
      stk.m[bk].map(x => x[1] + '(' + (x[2] / 1e4).toFixed(2) + '亿)').join(' '))
    if (s.length) console.log('     状态: 涨' + s[0] + '/跌' + s[1] + '/平' + s[2] + ' 扩散 ' +
      (s[0] / Math.max(1, s[0] + s[1] + s[2]) * 100).toFixed(1) + '% 中位涨幅 ' + (s[3] / 100).toFixed(2) +
      '% 领涨 ' + s[5] + '(' + (s[6] / 100).toFixed(2) + '%)')
  }
  if (DRY) { console.log('[dry] 不写盘'); return }
  hist.stk = stk
  fs.writeFileSync(HIST_PATH, JSON.stringify(hist))
  console.log('已写 flow-history.json（含 stk 段）')
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

/* ---------- 当月累计的两个纯函数（★ 2026-10-10 新增，可单测）----------
 * 为什么要把它们抽出来：旧实现**只把 daykline 用来"补 days"**，cum/streak 仍旧从 days 求和。
 * 于是 days 一旦断档（2026-10-08 那次 run 被 15 分钟超时 cancel 掉），当月就只剩 10-09 一天，
 * 「当月累计」退化成单日值、「月内连续天数」全塌成 ±1 —— 这正是用户看到的
 * 「流入都是连续 3 天的，现在变成 1 天」。daykline 一次就返回 35 天，信息本来就在手上。
 * 现在：daykline 的当月序列**直接**算 cum/streak/nCov，与 days 求和取"纳入天数更多"的那个。 */

/* 日期升序的 [{d:'YYYYMMDD', f:万元}] → 当月累计 / 月内连续天数(±) / 纳入交易日数 */
function monthFromSeq(seq, monthPrefix) {
  let cum = 0, has = false, n = 0
  for (const x of seq) {
    if (!x || String(x.d).indexOf(monthPrefix) !== 0) continue
    if (!isFinite(x.f)) continue
    cum += x.f; has = true; n++
  }
  let streak = 0
  for (let i = seq.length - 1; i >= 0; i--) {
    const x = seq[i]
    if (!x || String(x.d).indexOf(monthPrefix) !== 0) break
    const f = x.f
    if (!isFinite(f)) break
    if (streak === 0) { if (f > 0) streak = 1; else if (f < 0) streak = -1; else break }
    else if (streak > 0) { if (f > 0) streak++; else break }
    else { if (f < 0) streak--; else break }
  }
  return has ? [Math.round(cum), streak, n] : null
}

/* 东财 daykline（fields2=f51,f52）→ 日期升序序列，单位元→万元（与 days/mon 一致） */
function seqFromKlines(kl) {
  const seq = []
  for (const line of (kl || [])) {
    const p = String(line).split(',')
    if (p.length < 2) continue
    const f = parseFloat(p[1])
    if (!isFinite(f)) continue
    seq.push({ d: p[0], f: Math.round(f / 1e4) })
  }
  return seq
}

/* 日档 days（[名称, f62万元, chgBp]）→ 该板块的日期升序序列 */
function seqFromDays(days, type, bk) {
  const seq = []
  for (const d of (days || [])) {
    const g = type === 2 ? d.ind : d.con
    const v = g && g[bk]
    if (v && v.length >= 3 && isFinite(v[1])) seq.push({ d: d.d, f: v[1] })
  }
  return seq
}

/* mon = 当月累计 + 月内连续天数 + 纳入交易日数。
 * 增量架构不变（covered 的板块零请求）；区别是**请求到的 daykline 会直接被采用**，
 * 不再依赖 days 是否被补齐 ⇒ 断档月的数值立刻正确，回补只跑完一半也有意义（跑完的板块是对的）。
 * ★ push2his 对 Actions IP 高频限流（2026-09-30 首跑 61/200 成功、30% 成功率实测），
 *   所以：当天补不齐没关系，失败的板块次日重试，随每日 cron 逐日补齐；
 *   全部交易日已覆盖的板块零请求，稳态每天只发 4 个 clist。 */
async function buildMonthIncremental(names, type, monthPrefix, days, tradeDates, todayStr) {
  const mon = {}
  const monthTrade = (tradeDates || []).filter(d => d.indexOf(monthPrefix) === 0)
  const lastTradeDay = monthTrade.length ? monthTrade[monthTrade.length - 1] : todayStr
  let need = 0, ok = 0, direct = 0
  const t0 = Date.now()
  /* 回补预算 = min(全局剩余 − 90s 预留给写盘, 11 分钟)。
   * ★ 2026-10-10 由 8 分钟提到 11 分钟：589 个板块 × 400ms 间隔本身就是 3.9 分钟纯等待，
   *   加上单请求耗时，8 分钟不够跑完一整轮 ⇒ 断档月永远补不齐（用户看到连续天数塌成 ±1）。
   *   daykline 走 push2his，与 clist 是同一风控域但不同端点，400ms 仍属保守。 */
  const MON_BUDGET_MS = Math.max(0, Math.min(11 * 60 * 1000, leftMs() - 90000))
  for (const bk of Object.keys(names)) {
    /* ★ 2026-10-10：只处理属于本 type 的板块。
     * names[bk] = [名称, 2|3]（2=行业 3=概念），两趟回补各扫 524 个名字。
     * 不加这个闸门时，概念趟会为 268 个行业板块发 daykline（seqD 恒空 → covered 恒 false），
     * 每个板块被请求两次 ⇒ 1048 个请求 ≈ 7 分钟，正是「一轮跑不完、断档月永远补不齐」的原因之一。 */
    if (names[bk] && names[bk][1] && names[bk][1] !== type) continue
    const seqD = seqFromDays(days, type, bk)
    const have = {}
    for (const x of seqD) have[x.d] = 1
    /* 增量判定：当月全部「已过交易日」都在日档里 → 零请求（对齐交易日历，不用自然日） */
    const covered = monthTrade.length
      ? monthTrade.every(d => have[d])
      : seqD.length > 0
    let best = monthFromSeq(seqD, monthPrefix)
    if (!covered) {
      need++
      if (Date.now() - t0 > MON_BUDGET_MS) { if (best) mon[bk] = best; continue }  /* 预算到点：用已有的，剩余次日再补 */
      try {
        const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=35&klt=101&secid=90.' + bk +
          '&fields1=f1,f2,f3,f7&fields2=f51,f52'
        const j = await getJSONFast(url)
        const kl = (j && j.data && j.data.klines) || []
        /* ① 直接用 daykline 的当月序列算 cum/streak（不依赖 days 是否补齐）——本段的核心修复 */
        const fromK = monthFromSeq(seqFromKlines(kl), monthPrefix)
        if (fromK && (!best || fromK[2] > best[2])) { best = fromK; direct++ }
        /* ② 顺带把日档缺的日期写回 days（保持 days 语义完整，供其它功能/交叉核对用） */
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
        ok++
        if (added) console.log('  · ' + bk + ' 回补 ' + added + ' 个缺失交易日')
      } catch (e) { /* 失败次日重试 */ }
      await new Promise(r => setTimeout(r, MON_GAP_MS))
    }
    if (best) mon[bk] = best
  }
  const cov = Object.keys(mon).map(k => mon[k][2]).sort((a, b) => a - b)
  const med = cov.length ? cov[cov.length >> 1] : 0
  console.log('mon(' + (type === 2 ? 'ind' : 'con') + '): 回补 ' + need + ' 板块（成功 ' + ok +
    '，其中直接采信 daykline ' + direct + '），mon 条目 ' + Object.keys(mon).length +
    '，当月交易日 ' + monthTrade.length + ' 天（最新 ' + lastTradeDay + '），纳入天数中位 ' + med)
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
  let prevStk = null
  if (fs.existsSync(HIST_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'))
      if (prev && prev.days) {
        /* ★ 2026-10-10：stk（板块→前5个股）必须一并继承，否则本段失败时会丢上一次的存档 */
        hist = { names: prev.names || {}, days: prev.days, mon: prev.mon, stk: prev.stk }
        prevStk = prev.stk || null
      }
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

  /* ---- 板块 → 当日主力净流入前 5 个股（★ 2026-10-10 新增，见文件上半部说明）----
   * 放在 mon 回补**之前**：本段 ~50s 确定性完成，mon 是增量回补（部分完成也有价值）；
   * 顺序反过来会让 mon 把预算吃光、stk 当天落空。
   * 失败只降级（保留上次存档），绝不阻断日档写出。 */
  if (!NOSTK) {
    try {
      const cands = [t]
      if (tradeDates && tradeDates.length) cands.push(tradeDates[tradeDates.length - 1])
      console.log('开始抓「板块→前5个股」（datacenter-web，' + cands.filter(Boolean).join(' / ') + '）…')
      const stk = await buildBoardTopStocks(cands, hist.names)
      if (stk && stk.nb) {
        hist.stk = stk
        console.log('stk: ' + stk.nb + ' 板块 × 前 ' + STK_TOP_N + '（' + stk.ns + ' 行）+ 板块状态 ' +
          stk.nbs + ' 个，数据日 ' + stk.d + '，约 ' +
          Math.round((JSON.stringify(stk.m).length + JSON.stringify(stk.s).length) / 1024) + 'KB')
      } else {
        console.log('⚠️ stk 为空 → 保留上次存档')
        if (prevStk) hist.stk = prevStk
      }
    } catch (e) {
      console.log('⚠️ stk 生成失败（不阻断日档，保留上次）：' + e.message)
      if (prevStk) hist.stk = prevStk
    }
  }

  /* 月度累计（增量回补）：概念优先（用户关注度较高），行业随后；8 分钟预算线防超时。
   * ⚠️ mon 必须容错：mon 被限流卡死时不能 cancel 掉整个 run（否则当日 days 增量
   *    也丢——commit 在 mon 之后）。mon 失败 → 本日 mon 空缺，页面端浏览器
   *    daykline 兜底，次日 cron 重试。 */
  if (!NOMON) {
    try {
      console.log('开始月度累计增量回补（' + monthPrefix + '）…')
      hist.mon = { ind: {}, con: {}, month: monthPrefix }
      hist.mon.con = await buildMonthIncremental(hist.names, 3, monthPrefix, hist.days, tradeDates, t)
      hist.mon.ind = await buildMonthIncremental(hist.names, 2, monthPrefix, hist.days, tradeDates, t)
      /* ★ 当月「应有交易日数」：页面据此判断当月累计是否完整。
       * 每板块的纳入天数在 mon[bk][2]（nCov）；nCov < nTrade 就说明这个板块的月累计不完整，
       * 页面必须如实标注，不许再一律宣称「全月真值」。 */
      hist.mon.nTrade = (tradeDates || []).filter(d => d.indexOf(monthPrefix) === 0).length
    } catch (e) {
      console.log('⚠️ mon 回补失败（不阻断日档保存，次日重试）：' + e.message)
      delete hist.mon
    }
  }

  hist.updated = t
  const body = JSON.stringify(hist)
  const nMon = hist.mon ? (Object.keys(hist.mon.ind).length + Object.keys(hist.mon.con).length) : 0
  const nStk = hist.stk && hist.stk.m ? Object.keys(hist.stk.m).length : 0
  const summary = t + '  行业 ' + nInd + ' + 概念 ' + nCon + '  存档 ' + hist.days.length +
    ' 天  mon ' + nMon + '  stk ' + nStk + '板块@' + (hist.stk ? hist.stk.d : '—') +
    '  ' + Math.round(body.length / 1024) + 'KB'
  if (DRY) {
    console.log('[dry] ' + summary)
    return
  }
  fs.writeFileSync(HIST_PATH, body)
  console.log('已写 flow-history.json：' + summary)
}

/* 作为脚本运行才执行 main；被 require 时只导出（供 _tests 调用真实实现，不复制逻辑） */
if (require.main === module) {
  const entry = process.argv.includes('--stkcheck') ? stkCheck : main
  entry().catch(function (e) {
    console.error('flow-daily 失败: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
} else {
  module.exports = {
    topStocksForBoards: topStocksForBoards,
    boardStateFromMembers: boardStateFromMembers,
    monthFromSeq: monthFromSeq,
    seqFromKlines: seqFromKlines,
    seqFromDays: seqFromDays,
    STK_TOP_N: STK_TOP_N,
    qstr: qstr
  }
}
