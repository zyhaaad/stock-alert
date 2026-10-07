#!/usr/bin/env node
/* 交易日判定（单一真源，2026-10-07）
 *
 * 为什么需要：cron 用的是「工作日」制（`* * 1-5`），不认 A 股节假日。假期里各任务照常触发：
 *   - 白烧 Actions 配额（flow-daily 曾在国庆假期每次都跑超时被 cancel，10-05 直接 failure）
 *   - 更糟：用上一交易日的数据算出「今天」的存档 → 控制台显示「更新于 10-06」，
 *     但数据其实是 09-30 的（chips-history.json 实测被这样覆盖过）→ 误导人
 *
 * 判定用双信号取「或」（避免任一接口滞后把**真实交易日**误判成非交易日——反向误判代价更大，
 * 会让整天的存档直接缺失；宁可多跑一次）：
 *   A. 腾讯中证全指( sh000985 )日 K 的最后一根日期 —— 当日 K 收盘后才出
 *   B. 腾讯实时行情里的行情时间戳字段 —— 假期时停在上一交易日
 * 两个都取不到 → isTrading = null，由调用方决定 fail-open 还是 fail-safe。
 *
 * 实测（2026-10-07 国庆假期；本机与 GitHub Actions 双侧一致）：A、B 都给出 2026-09-30。
 *
 * 用法：
 *   const TD = require('./trade-day.js')
 *   const g = await TD.gate()            // { t, dates, lastCal, qDate, isTrading }
 *   if (g.isTrading === false) return    // 非交易日 → 不写盘
 *   node trade-day.js                    // 诊断：打印今天的判定
 */
'use strict'

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/* 轻量重试 2 次（交易日判定是闸门，取不到会误判，值得多试一次但不该长退避拖时间） */
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

/* 信号 A：最近 n 个交易日（YYYY-MM-DD 数组，升序）；失败返回 null */
async function fetchTradingDates(n) {
  try {
    const j = await getJSONFast('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000985,day,,,' +
      (n + 10) + ',qfq')
    const key = j.data && Object.keys(j.data)[0]
    const raw = j.data && j.data[key] && (j.data[key].qfqday || j.data[key].day)
    if (!raw || !raw.length) return null
    return raw.map(r => String(r[0])).slice(-n)
  } catch (e) { return null }
}

/* 信号 B：实时行情时间戳 → YYYYMMDD；失败返回 null
 * 用 latin1 读原始字节（时间戳是 ASCII，不依赖 Node 的 gbk/ICU 支持）；
 * 字段形如 `~YYYYMMDDHHMMSS~`，实测该 14 位片段在响应中唯一 */
async function fetchQuoteDate() {
  try {
    const res = await fetch('https://qt.gtimg.cn/q=sh000985', { headers: UA })
    if (!res.ok) return null
    const txt = Buffer.from(await res.arrayBuffer()).toString('latin1')
    const m = txt.match(/~(\d{14})~/)
    return m ? m[1].slice(0, 8) : null
  } catch (e) { return null }
}

/* 综合判定。
 * 返回 { t, dates, lastCal, qDate, isTrading }
 *   t        判定目标日 YYYY-MM-DD（默认北京今天）
 *   dates    交易日历（flow-daily 还要用它做「当月覆盖」判定，所以一并返回）
 *   isTrading true=交易日 / false=非交易日 / null=两个信号都取不到 */
async function gate(day) {
  const t = day || bjToday()
  const dates = await fetchTradingDates(60)
  const qDate = await fetchQuoteDate()
  const lastCal = (dates && dates.length) ? dates[dates.length - 1] : null
  const isTrading = (!lastCal && !qDate) ? null : (lastCal === t || qDate === t.replace(/-/g, ''))
  return { t: t, dates: dates || [], lastCal: lastCal, qDate: qDate, isTrading: isTrading }
}

/* 给调用方用的一句话说明（日志口径统一） */
function describe(g) {
  return '交易日历最新 ' + (g.lastCal || '?') + '，行情时间戳 ' + (g.qDate || '?') + '，判定日 ' + g.t
}

module.exports = { gate, describe, bjToday, fetchTradingDates, fetchQuoteDate }

/* 直接运行 = 诊断 */
if (require.main === module) {
  gate().then(function (g) {
    console.log('北京今天 = ' + g.t)
    console.log(describe(g))
    console.log('isTrading = ' + g.isTrading + (g.isTrading === null ? '（两个信号都取不到）' : ''))
    console.log('最近 6 个交易日 = ' + g.dates.slice(-6).join(' '))
  }).catch(function (e) { console.error('trade-day 失败: ' + (e && e.message)) })
}
