#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  持仓/监控信号任务  signals.js
 * ============================================================
 *  每个交易日收盘后跑一次（signals.yml）：
 *   1. 把「我的持仓 holdings[]」和「监控清单 stocks[]」里的代码合并去重
 *   2. 逐只拉 130 根日线（腾讯），用 signal-core.js 跑规则
 *      · 其中 MA5_STREAK_EXIT（连续 ≥2 天开收盘都站上 5 日线 → 提醒卖出）**只对持仓股发**，
 *        与持仓页那个「连续 N 天站上 5 日线」标识同一套天数口径（SignalCore.ma5Streak）
 *   3. 新信号写进 signals-history.json（**幂等**：内容没变就不写文件）
 *   4. 顺手把存档里已满 10 个交易日的旧信号判出胜负（回填，供胜率统计）
 *   5. 有新信号才推送一条（没有就不推，避免打扰）
 *
 *  推送口径：所有信号合并成**一条**消息（Server酱 免费版一天只有几条额度）。
 *  备选池（每日优选）不在这里推 —— 用户明确要求：备选不推送，只做记录列表。
 *
 *  本地调试：
 *    node signals.js --dry          # 只算不写不推
 *    node signals.js --report       # 打印存档里各规则的胜负统计
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const push = require('./push.js')
const S = require('./signal-core.js')

const SRC = __dirname
const HIST_PATH = path.join(SRC, 'signals-history.json')
const CFG_PATH = path.join(SRC, 'config.json')
const KEEP = 2000          // 存档最多保留多少条信号（防止无限膨胀）

/* ---------------- 基础工具 ---------------- */

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function bjDate(d) {
  const t = d || new Date()
  return new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000).toISOString().slice(0, 10)
}

function loadCfg() {
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
}

function loadHist() {
  try {
    const j = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'))
    if (j && Array.isArray(j.signals)) return j
  } catch (e) { /* 首次运行没有存档 */ }
  return { _说明: '信号存档：每条信号事后按「10 个交易日后 ±2%」判胜负（用户 2026-09-16 指定口径）。' +
    'rule/side/title/detail/price/at 是信号本体；verdict 是回填的胜负。' +
    '只增不删（超出 KEEP 上限才裁最旧的），内容没变不重写文件。', ruleVersion: S.RULE_VERSION, signals: [] }
}

/** 腾讯日线：code 6 开头 → 沪市，否则深市。失败/无数据返回 null（单只失败不拖垮整批） */
async function fetchBars(code) {
  const c = String(code)
  if (!/^(60|00|30)/.test(c)) return null            // 只认沪深 A（688 属 60 开头，包含在内）
  const secid = (c[0] === '6' ? 'sh' : 'sz') + c
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + secid + ',day,,,130,qfq'
  const j = await fetchJson(url)
  const key = j && j.data && Object.keys(j.data)[0]
  const raw = j && j.data && j.data[key] && (j.data[key].qfqday || j.data[key].day)
  return raw ? S.normBars(raw) : null
}

/** 简单并发池：并发 n 跑 tasks（每个是 () => Promise），保序返回结果 */
async function pool(n, tasks) {
  const out = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      try { out[i] = await tasks[i]() } catch (e) { out[i] = { err: e && e.message ? e.message : String(e) } }
    }
  }
  await Promise.all(new Array(Math.min(n, tasks.length)).fill(0).map(worker))
  return out
}

/** 同一 (code, rule) 在 cooldownDays 个交易日内不重复发：用 K 线位置算交易日距离 */
function onCooldown(bars, hist, code, rule, todayIdx) {
  const list = hist.signals || []
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i]
    if (s.code !== code || s.rule !== rule) continue
    const prevIdx = bars.findIndex(b => b.d === s.at)
    if (prevIdx < 0) continue
    if (todayIdx - prevIdx < S.P.cooldownDays) return true
  }
  return false
}

/* ---------------- 推送文案 ---------------- */

/**
 * 把当天的新信号拼成**一条**推送消息（分「卖出/离场提醒」与「企稳/介入观察」两栏）。
 *
 * 为什么拆成独立函数：推送文案是用户唯一直接看到的东西，不能靠"跑一次肉眼看一眼"就算验过。
 * 拆出来之后单测可以拿合成 K 线走完「算信号 → 过滤 → 拼文案」整条链路（见 _tests/signals-push-test.js）。
 *
 * @param list  当天新信号数组（每项含 name/code/list/side/title/detail）
 * @param today 北京日期 YYYY-MM-DD（标题里只取 MM-DD）
 * @returns { title, content }
 */
function buildMessage(list, today) {
  const listName = { holdings: '持仓', monitor: '监控', both: '持仓+监控' }
  const bySide = { sell: [], buy: [] }
  for (const s of list) {
    const line = '· ' + s.name + ' ' + s.code + '（' + (listName[s.list] || s.list) + '）' + s.title +
      '\n   ' + s.detail
    if (!bySide[s.side]) bySide[s.side] = []
    bySide[s.side].push(line)
  }
  let content = ''
  if (bySide.sell.length) content += '【卖出/离场提醒】\n' + bySide.sell.join('\n') + '\n\n'
  if (bySide.buy.length) content += '【企稳/介入观察】\n' + bySide.buy.join('\n') + '\n\n'
  content += '信号按「10个交易日后±2%」记录胜负，胜率见控制台-我的持仓。\n非投资建议。'
  return { title: '持仓信号 ' + String(today).slice(5) + ' · ' + list.length + ' 条', content: content }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const dry = process.argv.includes('--dry')
  const noPush = process.argv.includes('--no-push')
  const report = process.argv.includes('--report')

  const cfg = loadCfg()
  const hist = loadHist()

  /* --report：只打印规则胜负统计，不抓数据不写文件 */
  if (report) {
    const all = hist.signals || []
    // ★ 只统计当前版本：口径变了就不该和旧版本的胜负混在一个胜率里
    const st = S.winrateStats(all, { onlyVersion: S.RULE_VERSION })
    const counted = st.reduce((a, s) => a + s.n, 0)
    const skippedOld = all.length - counted
    console.log('规则体检（口径：10 个交易日 ±2%；只统计 ruleVersion ' + S.RULE_VERSION +
      (skippedOld ? '；另有 ' + skippedOld + ' 条更早版本已排除' : '') + '）')
    if (!st.length) { console.log('  当前版本还没有信号（存档里共 ' + all.length + ' 条，均非 ' + S.RULE_VERSION + '）'); return }
    for (const s of st) {
      console.log('  ' + s.rule.padEnd(16) +
        ' 样本 ' + String(s.n).padStart(3) +
        '（已判 ' + String(s.done).padStart(3) + '，待判 ' + String(s.pending).padStart(3) + '）' +
        '  胜率 ' + (isFinite(s.winRate) ? Math.round(s.winRate * 100) + '%' : '—') +
        '  平均涨跌 ' + (isFinite(s.avgRet) ? (s.avgRet >= 0 ? '+' : '') + (s.avgRet * 100).toFixed(2) + '%' : '—'))
    }
    console.log('  （样本 <20 条前，胜率数字仅供参考）')
    return
  }

  /* 合并两份清单：同一代码可能同时在持仓和监控里 */
  const holdings = cfg.holdings || []
  const stocks = cfg.stocks || []
  const nameOf = {}
  const listOf = {}
  for (const h of holdings) { nameOf[h.code] = h.name || h.code; listOf[h.code] = listOf[h.code] === 'monitor' ? 'both' : 'holdings' }
  for (const s of stocks) {
    nameOf[s.code] = s.name || s.code
    listOf[s.code] = listOf[s.code] ? 'both' : 'monitor'
  }
  const codes = Object.keys(nameOf)
  if (!codes.length) { console.log('配置里没有持仓也没有监控股票，无事可做'); return }
  console.log('待算股票 ' + codes.length + ' 只（持仓 ' + holdings.length + ' / 监控 ' + stocks.length + '）')

  /* 逐只拉 K 线并评估最后一根 */
  const tasks = codes.map(code => async () => {
    try {
      const bars = await fetchBars(code)
      if (!bars || bars.length < S.P.trendMa) return { code, bars: null, signals: [], err: 'K线不足' }
      const r = S.evaluate(bars)
      /* 按清单类型过滤（口径在 signal-core 的 signalsForList，单一真源）：
         「连续站上 5 日线 → 提醒卖出」只对持仓股发 —— 用户 2026-09-17 的需求原文是
         「**持仓股**……连续 2 天及以上都高于 5 日线就提醒卖出」，对没买的票喊卖出没意义。 */
      const sigs = S.signalsForList((r && r.signals) || [], listOf[code])
      return { code, bars, signals: sigs, err: null }
    } catch (e) {
      return { code, bars: null, signals: [], err: e && e.message ? e.message : String(e) }
    }
  })
  const results = await pool(4, tasks)
  const byCode = {}
  for (const r of results) byCode[r.code] = r
  const failed = results.filter(r => r.err)
  if (failed.length) console.log('  ⚠️ ' + failed.length + ' 只取K线失败（跳过，不影响其它）: ' + failed.map(f => f.code).join(','))

  /* 1) 回填旧信号的胜负（满 10 个交易日的） */
  let resolved = 0
  for (const s of hist.signals || []) {
    if (s.verdict && s.verdict.state !== 'pending') continue
    const r = byCode[s.code]
    if (!r || !r.bars) continue
    const v = S.judgeOutcome(s, r.bars)
    if (v.state !== 'pending') { s.verdict = v; resolved++ }
  }
  if (resolved) console.log('  回填胜负 ' + resolved + ' 条')

  /* 2) 生成今天的新信号（去重 + 冷却） */
  const today = bjDate()
  const fresh = []
  for (const r of results) {
    if (!r.bars || !r.signals.length) continue
    const idx = r.bars.length - 1
    if (r.bars[idx].d !== today) {
      // 今天不是这根K线（时区/停牌）：仍然按最后一根处理，at 用K线自己的日期
      console.log('  ℹ️ ' + r.code + ' 最新K线是 ' + r.bars[idx].d + '（非今天）')
    }
    for (const sig of r.signals) {
      if (onCooldown(r.bars, hist, r.code, sig.rule, idx)) continue
      fresh.push({
        id: r.code + '|' + sig.rule + '|' + sig.at,
        code: r.code,
        name: nameOf[r.code] || r.code,
        list: listOf[r.code] || 'monitor',
        rule: sig.rule,
        side: sig.side,
        title: sig.title,
        detail: sig.detail,
        price: sig.price,
        at: sig.at,
        ruleVersion: S.RULE_VERSION,
        verdict: null
      })
    }
  }
  /* 同一天同一规则只留一条（跨代码不去重） */
  const seen = {}
  const uniq = fresh.filter(s => (seen[s.id] ? false : (seen[s.id] = true)))

  console.log('新信号 ' + uniq.length + ' 条' + (uniq.length ? '：' + uniq.map(s => s.code + ' ' + s.title).join('；') : ''))

  /* 3) 写存档（内容没变就不写 —— 幂等） */
  if (uniq.length) {
    const ids = new Set((hist.signals || []).map(s => s.id))
    for (const s of uniq) if (!ids.has(s.id)) hist.signals.push(s)
    if (hist.signals.length > KEEP) hist.signals = hist.signals.slice(hist.signals.length - KEEP)
    hist.ruleVersion = S.RULE_VERSION
  }

  if (!dry) {
    const prevText = fs.existsSync(HIST_PATH) ? fs.readFileSync(HIST_PATH, 'utf8') : ''
    const nextText = JSON.stringify(hist)
    if (nextText === prevText) {
      console.log('存档无变化，不重写文件')
    } else {
      fs.writeFileSync(HIST_PATH, nextText, 'utf8')
      console.log('已写 signals-history.json：共 ' + hist.signals.length + ' 条（新增 ' + uniq.length + '），' +
        Math.round(nextText.length / 1024) + ' KB')
    }
  }

  /* 4) 推送（有新信号才推；全部合并成一条） */
  if (dry || noPush) { console.log('（--dry/--no-push：不推送）'); return }
  if (!uniq.length) { console.log('没有新信号，不推送'); return }

  const msg = buildMessage(uniq, today)
  const title = msg.title, content = msg.content
  try {
    const r = await push.pushOrThrow(cfg, title, content)
    console.log('已推送（' + r.via + '）')
  } catch (e) {
    console.log('⚠️ 推送失败（存档已写入，不影响数据）：' + (e && e.message ? e.message : e))
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}

module.exports = { main: main, buildMessage: buildMessage }
