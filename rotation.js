#!/usr/bin/env node
/* 板块轮动状态日更存档（2026-10-07）
 *
 * 作用：每交易日收盘后跑一次，把「全市场板块（一级行业 90 / 二级行业 136 / 概念 374）」
 *       的**轮动状态**算出来写进 rotation.json，供前端「板块轮动」页直读。
 *   页面：https://raw.githubusercontent.com/zyhaaad/stock-alert/main/rotation.json
 *
 * 用法：node rotation.js [--dry] [--limit N] [--conc 3] [--gap 120]
 *
 * ★ 为什么不用东财：push2 / push2his / push2delay 在部分网络下**间歇性 UND_ERR_SOCKET
 *   （连接被对端重置）**，实测持续 40 分钟未恢复 → 不能作为状态判定的主口径输入。
 *   同花顺板块日线（d.10jqka.com.cn/v6/line/bk_XXXXXX/01/{年}.js，JSONP）稳定可用，
 *   且**回溯到 2007 年**，是本系统的地基数据源。
 *
 * ★ 只取「去年 + 今年」两个文件即可：今年文件已含最新交易日，两年合计 ≥ 400 根，
 *   而特征最长回看窗口是 250 根（p250）。2026-10-07 实测：2026 文件 181 根 + 2025 文件 243 根。
 *
 * ★ 判定与口径全部走 rotation-state.js / rotation-report.js（本地 _research/rotation/ 的副本），
 *   本文件只负责抓取 + 组装，禁止在这里写任何阈值或口径。
 *
 * 设计要点：
 *   - **交易日闸门**（复用 trade-day.js 单一真源）：非交易日直接退出不写盘（cron 是工作日制，
 *     不认 A 股节假日；假期跑一遍不但白烧 1200 个请求，还可能把上一交易日数据写成假期条目）
 *   - 全局冷却：同花顺限流（504）时所有 worker 一起指数退避；单板块重试 3 次仍失败就跳过
 *   - **容错写入**：成功率 < SUCCESS_FLOOR(60%) 时**不写盘**并 exit 1（宁可保留上一份好数据，
 *     也不要用残缺清单覆盖 —— 残清单会让页面上整片板块凭空消失）
 *   - 失败板块保留上一份 rotation.json 里的旧条目并打 `stale:1` 标记，前端如实提示
 *   - 幂等：同一交易日重跑结果一致（generated 时间戳除外）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROT = require('./rotation-state.js')
const REPORT = require('./rotation-report.js')
const TD = require('./trade-day.js')
const BOARDS = require('./rotation-boards.json').boards

const OUT = path.join(__dirname, 'rotation.json')
const DRY = process.argv.includes('--dry')
const argv = process.argv.slice(2)
function argOf(name, dflt) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const LIMIT = Number(argOf('limit', 0)) || 0
const CONC = Number(argOf('conc', 3)) || 3
const GAP = Number(argOf('gap', 120)) || 120
const BUDGET_MS = Number(argOf('budget', 10)) * 60 * 1000   /* 抓取预算，防 workflow 超时 */
const SUCCESS_FLOOR = 0.60

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const HEAD = { 'User-Agent': UA, 'Referer': 'https://q.10jqka.com.cn/' }

const todo = LIMIT ? BOARDS.slice(0, LIMIT) : BOARDS

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function bjToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) }

/* ---- 全局冷却：同花顺一限流，所有 worker 一起退避 ---- */
let cooldownUntil = 0
async function gate() { const w = cooldownUntil - Date.now(); if (w > 0) await sleep(w) }
function cool(ms) { cooldownUntil = Math.max(cooldownUntil, Date.now() + ms) }
let coolHits = 0

function parseJs(txt) {
  const m = String(txt).match(/^[A-Za-z0-9_$]+\((.*)\);?\s*$/s)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch (e) { return null }
}

/* 返回 { txt } / { notFound:true } / null（重试耗尽） */
async function fetchJs(url) {
  for (let a = 0; a < 3; a++) {
    await gate()
    try {
      const r = await fetch(url, { headers: HEAD })
      if (r.status === 404) return { notFound: true }
      if (r.status === 200) return { txt: await r.text() }
      coolHits++
      cool(2000 * Math.pow(2, a))          /* 2s / 4s / 8s */
      await sleep(400 * (a + 1))
    } catch (e) {
      coolHits++
      cool(1200 * Math.pow(2, a))
      await sleep(500 * (a + 1))
    }
  }
  return null
}

function rowToBar(s) {
  const p = String(s).split(',')
  if (p.length < 7) return null
  if (!/^\d{8}$/.test(p[0])) return null
  const o = +p[1], h = +p[2], l = +p[3], c = +p[4], v = +p[5], amt = +p[6]
  if (!isFinite(o) || !isFinite(c) || c <= 0) return null
  return [p[0], o, h, l, c, isFinite(v) ? v : 0, isFinite(amt) ? amt : 0]
}

/* 单板块：去年 + 今年两个 JSONP 文件合并去重 → bars 升序 */
async function fetchBoard(code, years) {
  const map = new Map()
  let name = ''
  for (const y of years) {
    const res = await fetchJs('https://d.10jqka.com.cn/v6/line/bk_' + code + '/01/' + y + '.js')
    if (res === null) return null                    /* 一次失败即放弃该板块（避免拖垮全局预算） */
    if (!res.notFound && res.txt) {
      const j = parseJs(res.txt)
      if (j) {
        if (j.name && !name) name = j.name
        if (j.data) String(j.data).split(';').filter(Boolean).forEach(s => {
          const bar = rowToBar(s); if (bar) map.set(bar[0], bar)
        })
      }
    }
    await sleep(GAP)
  }
  if (!map.size) return { name: name, bars: [] }
  const bars = [...map.values()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
  return { name: name, bars: bars }
}

/* bars → 一行汇总（与本地 make-rotation.js 完全同口径） */
function toRow(code, name, kind, bars) {
  if (!bars || bars.length < 300) return null
  const st = ROT.run(bars)
  if (!st.length) return null
  const last = st[st.length - 1]
  let days = 1
  for (let k = st.length - 2; k >= 0; k--) { if (st[k].state === last.state) days++; else break }
  const i = last.i, f0 = last.f
  return {
    code: String(code), name: name, kind: kind, state: last.state, days: days, date: last.date,
    chg5: +(100 * (bars[i][4] / bars[i - 5][4] - 1)).toFixed(2),
    chg20: +(100 * (bars[i][4] / bars[i - 20][4] - 1)).toFixed(2),
    mf5: +(100 * f0.mf5).toFixed(1),
    mf20: +(100 * f0.mf20).toFixed(1),
    amt: Math.round(bars[i][6] / 1e8 * 10) / 10,
    vr5: +f0.vr5.toFixed(2),
    p250: +f0.p250.toFixed(2),
    dd60: +(100 * f0.dd60).toFixed(1)
  }
}

function loadPrev() {
  try {
    if (!fs.existsSync(OUT)) return null
    const j = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    return j && Array.isArray(j.boards) ? j : null
  } catch (e) { return null }
}

async function main() {
  const t = bjToday()
  const Y = Number(t.slice(0, 4))
  const years = [Y - 1, Y]

  /* 交易日闸门（trade-day.js 单一真源，双信号取「或」） */
  let g = null
  try { g = await TD.gate(t) } catch (e) { console.log('⚠️ 交易日判定异常，按原流程继续：' + e.message) }
  if (g && g.isTrading === false) {
    console.log('非交易日（' + TD.describe(g) + '）→ 跳过，不写盘')
    return
  }
  if (g && g.isTrading === null) console.log('⚠️ 交易日历与行情时间戳都取不到（' + TD.describe(g) + '），按原流程继续')

  const prev = loadPrev()
  const prevByCode = {}
  if (prev) prev.boards.forEach(b => { prevByCode[b.code] = b })

  console.log('板块轮动日更 · ' + t + ' · 待抓 ' + todo.length + ' 个 · 并发 ' + CONC + ' · 年份 ' + years.join('/'))
  const t0 = Date.now()
  const rows = []
  const fails = []
  let idx = 0, done = 0, budgetHit = false

  async function worker() {
    while (true) {
      const i = idx++
      if (i >= todo.length) return
      if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; return }
      const b = todo[i]
      const code = String(b.code)
      let got = null
      try { got = await fetchBoard(code, years) } catch (e) { got = null }
      const nm = (got && got.name) || b.name
      const row = got && got.bars && got.bars.length ? toRow(code, nm, b.kind, got.bars) : null
      if (row) rows.push(row)
      else {
        fails.push(code)
        /* 失败 → 保留上一份该板块条目并打 stale 标记（前端如实提示，不用假数据顶替） */
        const p = prevByCode[code]
        if (p) { const q = Object.assign({}, p); q.stale = 1; rows.push(q) }
      }
      done++
      if (done % 50 === 0) {
        console.log('  ' + done + '/' + todo.length + ' 成功 ' + (rows.length - fails.filter(c => prevByCode[c]).length) +
          ' 失败 ' + fails.length + ' 冷却 ' + coolHits + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's')
      }
      await sleep(GAP)
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()))

  const okCount = rows.filter(r => !r.stale).length
  const fresh = rows.filter(r => !r.stale)
  const covered = okCount / todo.length
  console.log('抓取完成：成功 ' + okCount + ' / ' + todo.length + '（' + (100 * covered).toFixed(1) + '%）· 失败 ' +
    fails.length + ' · 冷却命中 ' + coolHits + ' · 耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's' +
    (budgetHit ? ' · ⚠️ 触及预算线，剩余未抓' : ''))

  if (!covered && !rows.length) { console.error('❌ 全量失败（同花顺可能对该出口 IP 不可达），不写盘'); process.exit(1) }
  if (covered < SUCCESS_FLOOR) {
    console.error('❌ 成功率 ' + (100 * covered).toFixed(1) + '% < ' + (100 * SUCCESS_FLOOR) +
      '% 门槛，保留上一份 rotation.json 不覆盖（残清单会让页面整片板块凭空消失）')
    process.exit(1)
  }

  const out = REPORT.build(rows)
  if (prev && prev.date === out.date) {
    /* 同一数据日重跑：保持幂等，仅刷新 generated */
  }
  out.fails = fails.length
  const body = JSON.stringify(out)

  const c = out.market.counts
  const hy = out.market.industry
  console.log('数据日 ' + out.date + ' · 板块 ' + out.market.count +
    ' · 全市场 ' + REPORT.STATE_ORDER.map(s => ROT.STATE_META[s].cn + '=' + c[s]).join(' ') )
  console.log('一级行业(' + hy.count + ')资金面 ' + hy.up + ' 正 / ' + hy.down + ' 负 · mf5 中位 ' + hy.mf5Med +
    '% · 注意力集中度 ' + (100 * out.market.focusTop10).toFixed(1) + '% · ' + Math.round(body.length / 1024) + 'KB')

  if (DRY) { console.log('[dry] 不写盘'); return }
  fs.writeFileSync(OUT, body)
  console.log('已写 rotation.json')
}

main().catch(function (e) {
  console.error('rotation 失败: ' + (e && e.message ? e.message : e))
  process.exit(1)
})
