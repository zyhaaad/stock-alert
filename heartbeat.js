#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  任务心跳与失败告警  heartbeat.js
 * ============================================================
 *  为什么需要它：
 *    整套系统跑在 GitHub 免费云端 + Server酱 上，是个**单点**。
 *    Actions 因额度/权限静默失败、仓库被停用、推送欠费——这些情况下
 *    你会**完全不知道**：以为"今天没到价"，其实是"早就没人盯了"。
 *
 *  它做什么（每交易日收盘后跑一次）：
 *    1. 判断今天是不是 A 股交易日（用中证全指日线的最新日期，比节假日表简单可靠）
 *    2. 检查恐贪存档是否已更新到今日
 *    3. 检查 monitor / fng 两个 workflow 今天是否有成功运行记录
 *    4. 有问题 → 立即推送告警（带排查步骤）
 *       没问题 → 静默；每周五额外推一条"一切正常"，用来证明推送通道还活着
 *
 *  用法：
 *    node heartbeat.js            正常自检
 *    node heartbeat.js --force    无视"是否交易日"，强制自检（本地调试用）
 *    node heartbeat.js --weekly   强制输出周报（本地调试用）
 *    node heartbeat.js --dry      只打印，不推送
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const push = require('./push.js')

const DIR = __dirname
const HIST_PATH = path.join(DIR, 'fng-history.json')
const CONFIG_PATH = path.join(DIR, 'config.json')

const REPO = process.env.GITHUB_REPOSITORY || 'zyhaaad/stock-alert'
const TOKEN = process.env.GITHUB_TOKEN || ''
const API = 'https://api.github.com/repos/' + REPO
const TENCENT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'

const args = process.argv
const FORCE = args.includes('--force')
const DRY = args.includes('--dry')
const WEEKLY = args.includes('--weekly')

/* ---------------- 基础 ---------------- */

function bjNow() {
  const offMin = new Date().getTimezoneOffset()
  const d = new Date(Date.now() + (8 * 60 + offMin) * 60000)
  return d
}
function bjDate() {
  return bjNow().toISOString().slice(0, 10)
}
function bjDay() {
  return bjNow().getUTCDay()   // 0=周日 … 5=周五
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || 20000)
  try {
    const res = await fetch(url, Object.assign({ signal: ac.signal }, opts || {}))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

/* ---------------- 检查项 ---------------- */

/** 今天是不是 A 股交易日：看中证全指日线里有没有"今天"这根 K */
async function isTradingDay(today) {
  const url = TENCENT + '?param=sh000985,day,,,5,qfq&_=' + Date.now()
  const j = await fetchJson(url)
  const node = j && j.data && j.data.sh000985
  const rows = node && (node.day || node.qfqday || node.qfq_day)
  if (!Array.isArray(rows) || !rows.length) throw new Error('取不到中证全指日线，无法判断交易日')
  const lastD = String(rows[rows.length - 1][0]).slice(0, 10)
  return { trading: lastD === today, lastD: lastD }
}

/** 恐贪存档是否已更新到指定日期 */
function checkArchive(today, histPath) {
  const h = loadJson(histPath || HIST_PATH)
  if (!h || !Array.isArray(h.days) || !h.days.length) {
    return { ok: false, detail: '读不到 fng-history.json 或文件为空' }
  }
  const last = h.days[h.days.length - 1]
  const d = String(last[0]).slice(0, 10)
  return {
    ok: d === today,
    detail: '存档最新日期 ' + d + '（应为本日 ' + today + '）',
    last: d, value: last[1]
  }
}

/** 某 workflow 今天有没有成功运行 */
async function checkWorkflow(file, today, token) {
  const tk = token === undefined ? TOKEN : token
  if (!tk) return { ok: null, detail: '没有 GITHUB_TOKEN，跳过运行记录检查' }
  const url = API + '/actions/workflows/' + file + '/runs?per_page=20'
  let j
  try {
    j = await fetchJson(url, {
      headers: {
        'Authorization': 'Bearer ' + tk,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'stock-alert-heartbeat'
      }
    })
  } catch (e) {
    return { ok: null, detail: '查询 ' + file + ' 运行记录失败：' + (e && e.message) }
  }
  const runs = (j && j.workflow_runs) || []
  const todays = runs.filter(r => String(r.created_at).slice(0, 10) === today)
  if (!todays.length) {
    return { ok: false, detail: file + ' 今天没有任何运行记录（定时任务可能没被触发）' }
  }
  const okRun = todays.find(r => r.conclusion === 'success')
  if (!okRun) {
    const bad = todays[0]
    return {
      ok: false,
      detail: file + ' 今天运行了 ' + todays.length + ' 次，但没有一次成功（最近一次：' +
        bad.status + '/' + (bad.conclusion || '-') + '）',
      url: bad.html_url
    }
  }
  return { ok: true, detail: file + ' 今天成功运行 ' + todays.length + ' 次' }
}

/* ---------------- 周报 ---------------- */

function weeklyBody(cfg, arch, checks) {
  const stocks = (cfg && cfg.stocks) || []
  const lines = []
  lines.push('本周系统自检通过，一切正常。')
  lines.push('')
  if (arch && arch.last) {
    lines.push('恐贪指数：' + arch.value + '（' + arch.last + '）')
  }
  lines.push('监控股票：' + stocks.length + ' 只')
  const st = loadJson(path.join(DIR, 'state.json')) || {}
  const fired = Object.keys(st).filter(k => (st[k].fireCount || 0) > 0).length
  lines.push('历史触发过的股票：' + fired + ' 只')
  lines.push('')
  lines.push('任务运行：')
  checks.forEach(c => { if (c.detail) lines.push('· ' + c.detail) })
  lines.push('')
  lines.push('这条消息同时也是"推送通道还活着"的证明。')
  return lines.join('\n')
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const today = bjDate()
  const cfg = loadJson(CONFIG_PATH) || {}

  console.log('== 心跳自检 ' + today + '（周' + bjDay() + '）==')

  let td
  try {
    td = await isTradingDay(today)
  } catch (e) {
    // 连行情都取不到 → 这本身就是要告警的事
    const msg = '取不到行情数据，无法判断今天是否交易日：' + (e && e.message)
    console.log('  ⚠️ ' + msg)
    await alert(cfg, ['行情接口不可用 —— 监控与恐贪任务大概率也取不到数据', msg], [])
    return
  }
  console.log('  中证全指最新交易日：' + td.lastD + ' → 今天' + (td.trading ? '是' : '不是') + '交易日')

  if (!td.trading && !FORCE) {
    console.log('  非交易日（周末/节假日），无需自检。结束。')
    return
  }

  const problems = []
  const checks = []

  const arch = checkArchive(today)
  checks.push(arch)
  console.log('  ' + (arch.ok ? '✅' : '❌') + ' 恐贪存档：' + arch.detail)
  if (!arch.ok) problems.push('恐贪存档没有更新到本日 —— ' + arch.detail)

  const wfMonitor = await checkWorkflow('monitor.yml', today)
  checks.push(wfMonitor)
  console.log('  ' + (wfMonitor.ok === false ? '❌' : wfMonitor.ok === null ? '➖' : '✅') + ' 价格监控：' + wfMonitor.detail)
  if (wfMonitor.ok === false) problems.push(wfMonitor.detail)

  const wfFng = await checkWorkflow('fng.yml', today)
  checks.push(wfFng)
  console.log('  ' + (wfFng.ok === false ? '❌' : wfFng.ok === null ? '➖' : '✅') + ' 恐贪任务：' + wfFng.detail)
  if (wfFng.ok === false) problems.push(wfFng.detail)

  if (problems.length) {
    console.log('')
    console.log('  ⚠️ 发现 ' + problems.length + ' 个问题')
    await alert(cfg, problems, checks)
    return
  }

  // 一切正常：周五（或 --weekly）发一条确认，证明通道活着
  if (bjDay() === 5 || WEEKLY) {
    console.log('  一切正常，输出周报')
    if (DRY) { console.log(weeklyBody(cfg, arch, checks)); return }
    const r = await push.push(cfg, '✅ 监控周报：本周一切正常', weeklyBody(cfg, arch, checks))
    if (!r.ok) {
      console.error('  周报推送失败：' + r.errors.join(' / '))
      process.exit(1)
    }
    console.log('  周报已推送（via ' + r.via + '）')
  } else {
    console.log('  一切正常，静默（周五会发一条确认消息）')
  }
}

/** 告警：带上"你自己能怎么排查" */
async function alert(cfg, problems, checks) {
  const body = []
  body.push('自动检查发现以下问题：')
  body.push('')
  problems.forEach(p => body.push('· ' + p))
  body.push('')
  body.push('可能的原因与处理：')
  body.push('1) 打开 github.com/' + REPO + '/actions 看有没有红色运行，点进去看日志')
  body.push('2) Actions 免费额度用完了 → 到 Settings → Billing 查看；额度会在月初重置')
  body.push('3) 仓库长时间无活动被暂停定时任务 → 到 Actions 页面点一次 Enable / 手动 Run')
  body.push('4) 推送通道欠费或密钥失效 → 检查 Server酱 余额与 SendKey')
  body.push('')
  body.push('注意：如果连这条告警你都收不到，说明推送通道本身也断了。')
  if (DRY) { console.log(body.join('\n')); return }
  const r = await push.push(cfg, '⚠️ 监控自检异常（' + problems.length + ' 项）', body.join('\n'))
  if (!r.ok) {
    console.error('  告警推送失败：' + r.errors.join(' / '))
    process.exit(1)
  }
  console.log('  告警已推送（via ' + r.via + '）')
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('心跳自检出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}

module.exports = { isTradingDay, checkArchive, checkWorkflow, bjDate, bjDay, weeklyBody }
