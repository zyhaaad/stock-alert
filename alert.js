#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  免费版 A 股价格监控  alert.js
 * ============================================================
 *  原理：定时任务（GitHub Actions 或 Windows 任务计划）每 5 分钟调用本脚本：
 *        1. 调东方财富公开接口拉取实时行情
 *        2. 逐只检查 config.json 里的价格条件
 *        3. 条件"从不满足变为满足"的那一刻，通过
 *           Server酱 / PushPlus / 企业微信机器人 推送到微信
 *        4. 把运行状态写进 state.json（含首次触发价），供手机控制台的
 *           「删除记录」计算"触发后至今涨跌幅"
 *
 *  用法：
 *    node alert.js             正常运行（由定时任务调用）
 *    node alert.js --dry       只打印行情和判断结果，不推送、不记状态
 *    node alert.js --simulate  模拟运行：忽略交易时段、不推送，但会更新状态
 *                              （用于部署后验证逻辑，不会打扰你）
 *
 *  推送通道在 config.json 的 channel 里选：
 *    serverchan  Server酱（微信扫码 sct.ftqq.com 拿 SendKey）
 *    pushplus    PushPlus（微信扫码 pushplus.plus 拿 token）
 *    wecombot    企业微信群机器人（填 webhook 地址）
 */

const fs = require('fs')
const path = require('path')

const DIR = __dirname
const CONFIG_PATH = path.join(DIR, 'config.json')
const STATE_PATH = path.join(DIR, 'state.json')

const QUOTE_HOSTS = [
  'push2delay.eastmoney.com',
  'push2.eastmoney.com',
  '82.push2.eastmoney.com'
]

const COND_LABEL = {
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  eq: '等于'
}

/* ---------------- 工具 ---------------- */

function checkCond(cond, price, target) {
  switch (cond) {
    case 'gt': return price > target
    case 'gte': return price >= target
    case 'lt': return price < target
    case 'lte': return price <= target
    case 'eq': return Math.abs(price - target) < 0.005
    default: return false
  }
}

/** 沪市(6开头)用 1.，其余用 0. */
function secidOf(stock) {
  if (stock.secid && /^\d\.\d{6}$/.test(stock.secid)) return stock.secid
  const code = String(stock.code || '')
  return (/^6/.test(code) ? '1.' : '0.') + code
}

function nowStr() {
  // 显式按北京时间输出（云端服务器多为 UTC，本地也可能时区不对）
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

/** 当前"北京时间"的 星期/时/分（不依赖运行机器的时区设置） */
function bjNow() {
  const offMin = new Date().getTimezoneOffset()
  const d = new Date(Date.now() + (8 * 60 + offMin) * 60000)
  return { day: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes() }
}

function inTradingHours() {
  const t = bjNow()
  if (t.day === 0 || t.day === 6) return false
  const m = t.h * 60 + t.m
  // A股开盘时段：9:30-11:30、13:00-15:00（午休不监控）
  return (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60)
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(function () { ac.abort() }, timeoutMs || 10000)
  try {
    const res = await fetch(url, Object.assign({ signal: ac.signal }, opts || {}))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 行情 ---------------- */

async function fetchQuotes(secids) {
  const groups = []
  for (let i = 0; i < secids.length; i += 40) {
    groups.push(secids.slice(i, i + 40))
  }
  const map = {}
  for (const g of groups) {
    const q = 'secids=' + g.join(',') +
      '&fields=f2,f3,f12,f13,f14&fltt=2&invt=2'
    let j = null
    let lastErr = null
    for (const host of QUOTE_HOSTS) {
      try {
        j = await fetchJson('https://' + host + '/api/qt/ulist.np/get?' + q)
        if (j && j.data) break
      } catch (e) {
        lastErr = e
      }
    }
    if (!j || !j.data) {
      if (lastErr) throw lastErr
      continue
    }
    let diff = j.data.diff || []
    if (!Array.isArray(diff)) diff = Object.values(diff)
    for (const d of diff) {
      if (d.f12 === undefined) continue
      // fltt=2 时价格已是真实小数；停牌等场景 f2 可能是 '-' 或字符串
      const price = typeof d.f2 === 'number' ? d.f2 : NaN
      map[(d.f13 === 1 ? '1.' : '0.') + d.f12] = {
        code: String(d.f12),
        name: d.f14 || '',
        price: price,
        changePct: typeof d.f3 === 'number' ? d.f3 : NaN
      }
    }
  }
  return map
}

/* ---------------- 推送 ---------------- */

async function pushMessage(cfg, title, content) {
  // 云端(GitHub Actions)运行时从仓库 Secrets 读 SENDKEY，本地运行用 config.json 里的 sendKey
  const key = process.env.SENDKEY || cfg.sendKey

  if (cfg.channel === 'serverchan') {
    if (!key) throw new Error('没有配置 sendKey（本地填 config.json，云端配仓库 Secret SENDKEY）')
    const res = await fetchJson(
      'https://sctapi.ftqq.com/' + key + '.send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: title, desp: content }).toString()
      }
    )
    if (res.code !== 0) throw new Error('Server酱返回异常: ' + JSON.stringify(res))
    return
  }

  if (cfg.channel === 'pushplus') {
    if (!key) throw new Error('没有配置 sendKey（本地填 config.json，云端配仓库 Secret SENDKEY）')
    const res = await fetchJson('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: key,
        title: title,
        content: content,
        template: 'txt'
      })
    })
    if (res.code !== 200) throw new Error('PushPlus返回异常: ' + JSON.stringify(res))
    return
  }

  if (cfg.channel === 'wecombot') {
    const res = await fetchJson(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: title + '\n' + content }
      })
    })
    if (res.errcode !== 0) throw new Error('企业微信机器人返回异常: ' + JSON.stringify(res))
    return
  }

  throw new Error('未知的推送通道 channel=' + cfg.channel)
}

/* ---------------- 状态 ---------------- */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch (e) {
    return {}
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const dry = process.argv.includes('--dry')
  const simulate = process.argv.includes('--simulate')
  const isTest = cfg.test === true

  const stocks = (cfg.stocks || []).filter(function (s) { return s.enabled !== false })
  if (!stocks.length) {
    console.log(nowStr() + ' 没有启用任何股票，退出')
    return
  }

  const secidList = stocks.map(secidOf)
  const quotes = await fetchQuotes(secidList)

  /* --dry：只打印，不推送、不记状态 */
  if (dry) {
    console.log('== dry 模式（' + nowStr() + '）==')
    for (const s of stocks) {
      const q = quotes[secidOf(s)]
      if (!q || typeof q.price !== 'number') {
        console.log('  ' + (s.name || s.code) + '  没取到价格（停牌或代码有误）')
        continue
      }
      const met = checkCond(s.condition, q.price, Number(s.target))
      console.log('  ' + (s.name || s.code) + '(' + s.code + ')  现价 ' +
        q.price.toFixed(2) + ' 元  条件[' + COND_LABEL[s.condition] + ' ' +
        s.target + '] → ' + (met ? '满足(会推送)' : '未满足'))
    }
    return
  }

  /* 正式运行：非交易时段静默退出（test / simulate 模式除外） */
  if (!isTest && !simulate && !inTradingHours()) return

  const state = loadState()
  const cooldownMs = (cfg.cooldownMinutes === undefined ? 30 : cfg.cooldownMinutes) * 60000
  const now = Date.now()
  const fired = []

  for (const s of stocks) {
    const q = quotes[secidOf(s)]
    if (!q || typeof q.price !== 'number') continue

    const target = Number(s.target)
    const met = checkCond(s.condition, q.price, target)
    const st = state[secidOf(s)] || { met: false, lastSent: 0 }

    let shouldSend = false
    if (simulate) {
      shouldSend = false // 模拟运行只判断、只记状态，绝不打扰
    } else if (isTest) {
      shouldSend = true
    } else if (met && !st.met && now - st.lastSent > cooldownMs) {
      // 边沿触发：从不满足变为满足的那一刻才发，防止反复刷屏
      shouldSend = true
    }

    if (shouldSend) {
      fired.push({
        name: q.name || s.name || s.code,
        code: s.code,
        price: q.price,
        changePct: q.changePct,
        cond: s.condition,
        target: target
      })
      st.lastSent = now
      st.fireCount = (st.fireCount || 0) + 1 // 真实推送次数
    }

    /* 触发点价格存档：首次满足价是"触发后至今涨跌幅"的基准，只记一次 */
    if (met) {
      if (!st.firstFire) st.firstFire = { price: q.price, at: now }
      st.lastFire = { price: q.price, at: now }
    }
    st.met = met
    state[secidOf(s)] = st
  }

  if (fired.length) {
    const names = fired.map(function (f) { return f.name }).join('、')
    const title = (isTest ? '[测试] ' : '') + '股价提醒：' + names
    const lines = fired.map(function (f) {
      return f.name + '(' + f.code + ')' +
        '\n当前价：' + f.price.toFixed(2) + ' 元' +
        (isNaN(f.changePct) ? '' : '（' + (f.changePct > 0 ? '+' : '') + f.changePct.toFixed(2) + '%）') +
        '\n触发条件：价格' + COND_LABEL[f.cond] + ' ' + f.target.toFixed(2) + ' 元' +
        '\n时间：' + nowStr()
    })
    await pushMessage(cfg, title, lines.join('\n\n' + '-'.repeat(20) + '\n\n'))
    console.log(nowStr() + ' 已推送 ' + fired.length + ' 条：' + names)
  } else {
    console.log(nowStr() + (simulate ? ' 模拟运行，检查 ' : ' 检查 ') + stocks.length + ' 只，无触发')
  }

  if (isTest) {
    // 测试推送不落状态，避免污染"首次触发价"存档
    console.log(nowStr() + ' 测试模式：本次不写状态')
    return
  }

  saveState(state)
}

main().catch(function (err) {
  console.error(nowStr() + ' 出错: ' + (err && err.message ? err.message : err))
  process.exit(1)
})
