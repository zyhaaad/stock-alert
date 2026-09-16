#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  A股恐贪指数 · 每日记录  fng.js
 * ============================================================
 *  作用：每个交易日收盘后跑一次，把当天的恐贪值写进 fng-history.json，
 *        形成"每日一个值、永久保存"的存档，供手机控制台画曲线。
 *
 *  额外（V1）：情绪走到极值时会**主动推一条微信**——
 *        进入极度恐惧（≤20）提醒"别割在低点"、进入极度贪婪（≥80）提醒
 *        "别追在高点"、离开极值区提醒"回暖/降温"；长期停在极值区则每 5 个
 *        交易日提醒一次。只在"确实新增交易日"时推，不会重复打扰。
 *
 *  用法：
 *    node fng.js              正常：补齐缺失交易日 + 刷新两融快照（已存档的日期不会被改写）
 *    node fng.js --backfill   首次全量生成（覆盖重算全部历史）
 *    node fng.js --dry        只打印，不写文件
 *    node fng.js --report     打印最近 15 天数值
 *    node fng.js --no-push     即使触达极值也不推送（调试用）
 *
 *  为什么已存档的日期不重算：
 *    恐贪值一旦写进存档就永久固定。否则日后再看，"历史值"会随窗口滑动
 *    而变化，曲线就不可信了。所以采用"只补新、不改旧"的策略。
 *
 *  数据源：
 *    中证全指日线（腾讯，公开接口，浏览器可直连）
 *    两融历史（东方财富 datacenter，T+1 披露）
 * ============================================================

 */

const fs = require('fs')
const path = require('path')
const core = require('./fng-core.js')
const push = require('./push.js')

const DIR = __dirname
const HIST_PATH = path.join(DIR, 'fng-history.json')
const CONFIG_PATH = path.join(DIR, 'config.json')

const TENCENT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const SYMBOL = 'sh000985'                       // 中证全指：覆盖沪深全部 A 股，最适合代表大盘
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const REPORT_NAME = 'RPTA_RZRQ_LSHJ'            // 沪深两市融资融券历史汇总（T+1 披露）

const FETCH_KLINE = 1200    // 抓取 K 线根数（约 5 年，保证 3 年存档每一天都有足够窗口）
const MARGIN_PAGES = 2      // 两融每页 800 条，2 页约 6.5 年
const MARGIN_PAGE_SIZE = 800
const KEEP = 750            // 存档保留的交易日数（约 3 年）

/* ---------------- 网络 ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson(url, tries) {
  tries = tries == null ? 3 : tries
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20000)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } catch (e) {
    if (tries > 0) { await sleep(1500); return fetchJson(url, tries - 1) }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 数据抓取 ---------------- */

/** 中证全指日线：返回 [{d,o,c,h,l,v}] 升序 */
async function fetchKline() {
  const url = TENCENT + '?param=' + SYMBOL + ',day,,,' + FETCH_KLINE + ',qfq&_=' + Date.now()
  const j = await fetchJson(url)
  const node = j && j.data && j.data[SYMBOL]
  if (!node) throw new Error('腾讯 K 线返回结构异常')
  const rows = node.day || node.qfqday || node.qfq_day
  if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯 K 线无数据')
  const out = []
  for (const r of rows) {
    const o = Number(r[1]), c = Number(r[2]), h = Number(r[3]), l = Number(r[4]), v = Number(r[5])
    if (!r[0] || !isFinite(c)) continue
    out.push({ d: String(r[0]).slice(0, 10), o: o, c: c, h: h, l: l, v: v })
  }
  // 腾讯通常已升序，保险起见排一次
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  return out
}

/** 两融历史：返回 [{d,rzye,rzjme,ltsz}] 升序 */
async function fetchMargin() {
  const acc = []
  for (let p = 1; p <= MARGIN_PAGES; p++) {
    const url = DC + '?reportName=' + REPORT_NAME +
      '&columns=DIM_DATE,RZYE,RZMRE,RZJME,RZCHE,LTSZ&source=WEB&client=WEB' +
      '&sortColumns=DIM_DATE&sortTypes=-1&pageSize=' + MARGIN_PAGE_SIZE + '&pageNumber=' + p + '&_=' + Date.now()
    const j = await fetchJson(url)
    const rows = j && j.result && j.result.data
    if (!Array.isArray(rows) || !rows.length) {
      if (p === 1) {
        throw new Error('两融接口无数据：success=' + (j && j.success) + ' code=' + (j && j.code) +
          ' msg=' + (j && j.message) + ' keys=' + (j ? Object.keys(j).join('|') : 'null') +
          ' result=' + (j && j.result ? typeof j.result : 'null'))
      }
      break
    }
    for (const r of rows) {
      acc.push({
        d: String(r.DIM_DATE).slice(0, 10),
        rzye: Number(r.RZYE),          // 融资余额（元）
        rzmre: Number(r.RZMRE),        // 融资买入额
        rzjme: Number(r.RZJME),        // 融资净买入
        ltsz: Number(r.LTSZ)           // 流通市值
      })
    }
    if (rows.length < MARGIN_PAGE_SIZE) break
    await sleep(800)
  }
  acc.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  // 去重（同日保留最后一条）
  const uniq = []
  for (const r of acc) {
    if (uniq.length && uniq[uniq.length - 1].d === r.d) uniq[uniq.length - 1] = r
    else uniq.push(r)
  }
  return uniq
}

/* ---------------- 存档读写 ---------------- */

function loadHist() {
  try {
    const j = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'))
    const u = core.unpackSeries(j.days || [])
    return { meta: j, series: u.series, raws: u.raws }
  } catch (e) {
    return { meta: null, series: [], raws: [] }
  }
}

function buildFile(series, raws, margin, extra) {
  const packed = core.packSeries(series, raws)
  return Object.assign({
    v: core.VERSION,
    name: 'A股恐贪指数',
    note: '0-100，越大越贪婪（市场过热），越小越恐惧（市场冰冷）',
    win: core.WIN,
    w: core.COMPONENTS.reduce((m, c) => (m[c.k] = c.w, m), {}),
    src: '中证全指(腾讯) + 两融(东财)',
    margin: core.marginSnapshot(margin),
    updated: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00'
  }, extra || {}, { days: packed })
}

/* ---------------- V1：情绪极值主动推送 ---------------- */

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (e) { return {} }
}

function extremeOpts(cfg) {
  const a = (cfg && cfg.fngAlert) || {}
  return { low: a.low, high: a.high }
}

function signed(v, d) { return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' }

function histLine(adv) {
  if (!adv || !adv.forward) return ''
  return '历史同区（' + adv.forward.label + '）样本 ' + adv.forward.n + ' 次，之后 60 个交易日平均 ' +
    signed(adv.forward.r60) + '。'
}

function bjDate(d) {
  return new Date(d + 'T15:00:00+08:00').toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

/** 把一次极值事件/持续提醒渲染成可推送的标题与正文 */
function extremeMessage(ev, cur, streak, peak) {
  const adv = core.adviceOf(cur)
  const z = core.zone(cur)
  const head = (peak ? peak.d + '  恐贪 ' : '恐贪 ') + cur.toFixed(1) + '（' + z.text + '）'

  if (ev && ev.kind === 'enter-low') {
    return {
      title: '情绪冰点：恐贪 ' + cur.toFixed(1) + '，别割在低点',
      body: [
        head,
        '',
        '情绪已进入近一年最冷的位置。记住一句话：',
        '「持股体验最差」和「离回暖最近」，往往就是同一段时间。',
        histLine(adv),
        '',
        '该做的：' + adv.do[0],
        '　　　　' + adv.do[1],
        '',
        '别做的：' + adv.dont[0]
      ].join('\n')
    }
  }

  if (ev && ev.kind === 'enter-high') {
    return {
      title: '情绪过热：恐贪 ' + cur.toFixed(1) + '，别追在高点',
      body: [
        head,
        '',
        '情绪已进入近一年最热的位置：赚钱效应最好，也最容易套人。',
        histLine(adv),
        '',
        '该做的：' + adv.do[0],
        '　　　　' + adv.do[1],
        '',
        '别做的：' + adv.dont[0]
      ].join('\n')
    }
  }

  if (ev && ev.kind === 'leave-low') {
    return {
      title: '情绪回暖：恐贪回到 ' + cur.toFixed(1),
      body: [
        head,
        '',
        '已离开极度恐惧区——最恐慌的一段大概率过去了（此前最低 ' + ev.prev.toFixed(1) + '）。',
        '这不等于马上大涨，回暖通常是一波三折的。',
        '',
        '该做的：按既定节奏继续分批执行，别因为一根大阳线就打乱计划。',
        '别做的：不要此时才急着满仓追进去，也不要把已经买到的筹码轻易换掉。'
      ].join('\n')
    }
  }

  if (ev && ev.kind === 'leave-high') {
    return {
      title: '情绪降温：恐贪回落到 ' + cur.toFixed(1),
      body: [
        head,
        '',
        '已离开极度贪婪区，高位风险开始释放（此前最高 ' + ev.prev.toFixed(1) + '）。',
        '',
        '该做的：继续执行减仓/止盈计划，把浮盈真正落袋。',
        '别做的：不要抢反弹、不要加杠杆，也不要把"回到原价就走"变成"再等等"。'
      ].join('\n')
    }
  }

  // 持续待在极值区的周期性提醒
  const lowSide = cur <= core.EXTREME.low
  return {
    title: (lowSide ? '情绪冰点持续第 ' : '情绪过热持续第 ') + streak + ' 个交易日：恐贪 ' + cur.toFixed(1),
    body: [
      head,
      '',
      '这一段已经在' + (lowSide ? '极度恐惧' : '极度贪婪') + '区连续待了 ' + streak + ' 个交易日。',
      lowSide
        ? '磨底时间长是常态，别因为"怎么还不涨"就交出筹码；分批计划照常执行。'
        : '高位横得越久，越要按纪律减仓，别把浮盈当成已经到手的钱。',
      '',
      '该做的：' + adv.do[0],
      '别做的：' + adv.dont[0]
    ].join('\n')
  }
}

/**
 * 检查并推送情绪极值提醒。
 * 只在"确有新增交易日"时调用 —— 同一天跑第二次（22:05 刷新两融）不会重复打扰。
 */
async function maybeAlertExtreme(cfg, series) {
  if (series.length < 2) return null
  const opts = extremeOpts(cfg)
  const last = series[series.length - 1]
  const prev = series[series.length - 2]
  const ev = core.extremeEvent(prev.v, last.v, opts)
  const streak = core.extremeStreak(series, opts)

  let msg = null
  if (ev) msg = extremeMessage(ev, last.v, streak, last)
  else if (core.isReminderDay(streak)) msg = extremeMessage(null, last.v, streak, last)
  if (!msg) return null

  const r = await push.push(cfg, msg.title, msg.body)
  if (!r.ok) {
    console.log('  ⚠️ 极值提醒推送失败：' + r.errors.join(' / '))
    return { pushed: false, errors: r.errors }
  }
  console.log('  🔔 已推送极值提醒（via ' + r.via + '）：' + msg.title)
  return { pushed: true, via: r.via, title: msg.title }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const backfill = process.argv.includes('--backfill')
  const dry = process.argv.includes('--dry')
  const onlyReport = process.argv.includes('--report')
  const noPush = process.argv.includes('--no-push')

  const prev = loadHist()

  if (onlyReport && prev.series.length) {
    const tail = prev.series.slice(-15)
    console.log('最近 ' + tail.length + ' 个交易日：')
    for (const s of tail) {
      const z = core.zone(s.v)
      console.log('  ' + s.d + '  ' + (s.v == null ? '—' : s.v.toFixed(1)) + '  ' + z.text)
    }
    console.log('快照两融日期：' + (prev.meta && prev.meta.margin ? prev.meta.margin.d : '无'))
    return
  }

  console.log('抓取中证全指日线 …')
  const days = await fetchKline()
  console.log('  得到 ' + days.length + ' 个交易日，' + days[0].d + ' ~ ' + days[days.length - 1].d)

  console.log('抓取两融历史 …')
  const margin = await fetchMargin()
  console.log('  得到 ' + margin.length + ' 条，' + margin[0].d + ' ~ ' + margin[margin.length - 1].d)

  console.log('计算恐贪指数 …')
  const built = core.buildSeries(days, margin, {})

  // 组装：已存档的日期保持原值（永久不变），只补新日期
  const frozen = {}
  if (!backfill) {
    for (let i = 0; i < prev.series.length; i++) {
      frozen[prev.series[i].d] = { v: prev.series[i].v, raw: prev.raws[i] }
    }
  }

  const byDate = {}
  for (let i = 0; i < built.series.length; i++) {
    const s = built.series[i]
    if (s.v == null) continue          // 窗口不足/数据缺失，不写入
    byDate[s.d] = { v: s.v, raw: built.raws[i] }
  }
  for (const d in frozen) {
    if (!byDate[d]) byDate[d] = frozen[d]   // 存档里有但本次没算出来的，保留
    else byDate[d] = frozen[d]              // 已有存档优先
  }

  const dates = Object.keys(byDate).sort()
  const keep = dates.length > KEEP ? dates.slice(dates.length - KEEP) : dates
  const series = [], raws = []
  for (const d of keep) {
    series.push({ d: d, v: byDate[d].v })
    raws.push(byDate[d].raw)
  }

  const newCount = backfill ? 0 : series.filter(s => !frozen[s.d]).length
  const last = series[series.length - 1]

  if (dry) {
    console.log('== dry 模式，不写文件 ==')
    console.log('  存档共 ' + series.length + ' 天，新增 ' + newCount + ' 天；最新 ' + last.d + ' = ' + last.v.toFixed(1) + '（' + core.zone(last.v).text + '）')
    const tail = series.slice(-8)
    for (const s of tail) console.log('    ' + s.d + '  ' + s.v.toFixed(1) + '  ' + core.zone(s.v).text)
    return
  }

  const out = buildFile(series, raws, margin)

  // 只有"数据真的变了"才写文件：否则 updated 时间戳会让文件每次运行都变，
  // 每天白产生两次提交（也会让 workflow 里的"存档无变化"分支永远走不到）。
  const prevDays = prev.meta && prev.meta.days ? JSON.stringify(prev.meta.days) : ''
  const prevMargin = prev.meta && prev.meta.margin ? JSON.stringify(prev.meta.margin) : ''
  if (JSON.stringify(out.days) === prevDays && JSON.stringify(out.margin) === prevMargin) {
    console.log('存档无变化：' + series.length + ' 天，' + keep[0] + ' ~ ' + keep[keep.length - 1] +
      '，最新 ' + last.d + ' = ' + last.v.toFixed(1) + '（' + core.zone(last.v).text + '）。不重写文件。')
    return
  }

  fs.writeFileSync(HIST_PATH, JSON.stringify(out), 'utf8')

  console.log('已写 fng-history.json：' + series.length + ' 天（新增 ' + newCount + '），' +
    keep[0] + ' ~ ' + keep[keep.length - 1] + '，文件 ' +
    Math.round(fs.statSync(HIST_PATH).size / 1024) + ' KB')
  console.log('  最新：' + last.d + ' = ' + last.v.toFixed(1) + '（' + core.zone(last.v).text + '）')
  console.log('  两融快照：' + out.margin.d + '  融资余额 ' + Math.round(out.margin.rzye / 1e8) + ' 亿')

  /* V1：情绪极值主动推送
   * 只有"确实新增了交易日"才推（同一天跑第二次只刷新两融，不该重复打扰）。
   * 推送失败不影响存档提交（存档是主任务），但会打醒目的 ⚠️ 并交给心跳任务兜底。 */
  if (!noPush && newCount > 0) {
    try {
      await maybeAlertExtreme(loadCfg(), series)
    } catch (e) {
      console.log('  ⚠️ 极值提醒异常（存档已正常写入）：' + (e && e.message ? e.message : e))
    }
  } else if (!noPush && newCount === 0 && backfill === false) {
    console.log('  本次无新增交易日，跳过极值提醒（避免重复打扰）')
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}

module.exports = {
  fetchKline: fetchKline,
  fetchMargin: fetchMargin,
  loadHist: loadHist,
  loadCfg: loadCfg,
  extremeOpts: extremeOpts,
  extremeMessage: extremeMessage,
  maybeAlertExtreme: maybeAlertExtreme,
  HIST_PATH: HIST_PATH,
  KEEP: KEEP
}
