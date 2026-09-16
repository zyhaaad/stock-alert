#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  每日备选池任务  screener.js
 * ============================================================
 *  每个交易日收盘后跑一次（signals.yml 里跟在 signals.js 后面）。
 *
 *  用户要求（2026-09-16）：
 *   · 基于整个 A 股的涨跌规律，每天给 1~2 只「往后看有胜算」的备选股
 *   · **不要推送**，只做记录列表（在控制台看），所以不发任何消息
 *   · 不碰 ST、不碰科创板（用户点名排除）
 *   · 每条推荐记录买入逻辑、建议卖出条件、推荐后累计涨跌幅
 *   · 胜负口径与持仓信号一致：10 个交易日后 ±2%
 *
 *  流程（两段式，控制 Actions 耗时）：
 *   段1 腾讯全 A 排行榜一次拉全（沪深主板+创业板，不含科创板/北交所，~4600 只，24 页）
 *       → 硬性过滤 → 按 60 日动量排序取前 250
 *   段2 对这 250 只拉 130 根日线 → 趋势/位置/量能/乖离/相对强度打分 → 取前 2 只（行业错开）
 *
 *  数据源说明：原本用东财 clist，本地 IP 被限流（socket hang up），换腾讯
 *  proxy.finance.qq.com getBoardRankList（实测稳定）。注意其字段口径：
 *   · code 带 sh/sz 前缀；turnover 是成交额（万元）；zdf_d60 是 60 日涨幅（百分比数）
 *   · state='S' 表示停牌；没有行业/上市日期字段 → 行业用东财 ulist 补齐（失败降级「未知」），
 *     次新股靠段 2「K 线不足 60 根自然淘汰」，不做上市日期过滤
 *
 *  ⚠️ 诚实声明：这是研究型筛选，不是投资建议。
 *     样本 <20 条前，胜率数字没有参考价值；参数调整走「规则体检 + 人工确认」，
 *     不做全自动调参（小样本自动调参必然过拟合）。
 *
 *  本地调试：
 *    node screener.js --dry        # 只算不写
 *    node screener.js --report     # 打印备选池的胜负统计
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const S = require('./signal-core.js')

const SRC = __dirname
const PICKS_PATH = path.join(SRC, 'picks-history.json')
const KEEP = 1000            // 最多保留多少条推荐记录

/* ---------------- 可调参数（集中在这一处；改这里要同步升 RULE_VERSION） ---------------- */
const P = {
  universeUrl: 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList',
  universeBoard: 'aStock',     // 腾讯口径：沪深主板+创业板，天然不含科创板/北交所
  universeSort: 'price',       // 实测只有 price/turnover/volume 是合法 sort_type（zdf/zdf_d60 等会报错）
  page: 200,                   // 实测单页上限 200（500/1000 报错），深翻页到 total 都正常
  minAmount: 5e7,          // 当日成交额 ≥ 5000 万（流动性底线）
  max60dGain: 0.80,        // 60 日涨幅 > 80% 的不追
  stage1Top: 250,          // 动量预选池大小
  minScore: 6,             // 打分低于这个的不入选
  pickCount: 2,            // 每天最多推荐几只
  max60dBars: 60
}

/* 用 https.get 而不是 fetch：实测腾讯/东财接口在部分运行时下
 * undici 会抛 UND_ERR_SOCKET（本地 Windows 复现），https.get 稳定。
 * 带 15s 超时与一次重试，接口抖动不至于让整批失败。 */
function getJson(url, tries) {
  const n = tries === undefined ? 2 : tries
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
        let b = ''
        res.setEncoding('utf8')
        res.on('data', d => (b += d))
        res.on('end', () => {
          try { resolve(JSON.parse(b)) }
          catch (e) {
            if (left > 0) return attempt(left - 1)
            reject(new Error('返回不是 JSON：' + b.slice(0, 80)))
          }
        })
      })
      req.on('error', e => {
        if (left > 0) return setTimeout(() => attempt(left - 1), 800)
        reject(new Error('请求失败: ' + (e && e.message ? e.message : e)))
      })
      req.on('timeout', () => {
        req.destroy()
        if (left > 0) return setTimeout(() => attempt(left - 1), 800)
        reject(new Error('请求超时'))
      })
    }
    attempt(n)
  })
}

function bjDate(d) {
  const t = d || new Date()
  return new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000).toISOString().slice(0, 10)
}

function loadPicks() {
  try {
    const j = JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8'))
    if (j && Array.isArray(j.picks)) return j
  } catch (e) { /* 首次运行 */ }
  return {
    _说明: '每日备选池（不推送，只在控制台展示）。每条记录推荐日价格与买入/卖出纪律，' +
      '10 个交易日后回填 ret10 与胜负（±2% 口径）。内容没变不重写文件。',
    ruleVersion: S.RULE_VERSION, picks: []
  }
}

/** 段1：腾讯全 A 排行榜（分页全拉）→ 返回原始行 */
async function fetchUniverse() {
  const out = []
  let offset = 0
  let total = Infinity
  while (offset < total && offset <= 6000) {
    const url = P.universeUrl + '?board_code=' + P.universeBoard +
      '&sort_type=' + P.universeSort + '&direct=down&offset=' + offset + '&count=' + P.page
    const j = await getJson(url)
    const d = j && j.data
    if (j.code !== 0 || !d || !Array.isArray(d.rank_list) || !d.rank_list.length) break
    if (isFinite(d.total)) total = d.total
    out.push.apply(out, d.rank_list)
    offset += d.rank_list.length
  }
  console.log('  榜单拿到 ' + out.length + ' 条（腾讯口径不含科创板/北交所）')
  return out
}

/** 行业补齐：腾讯榜单没有行业字段，用东财 ulist 按 secids 分批查
 *（本地 IP 被限流时降级「未知」，不阻塞主流程；GitHub Actions 上东财可达） */
async function enrichIndustry(rows) {
  const noInd = rows.filter(r => !r.industry)
  if (!noInd.length) return
  const map = {}
  const CHUNK = 50
  for (let i = 0; i < noInd.length; i += CHUNK) {
    const part = noInd.slice(i, i + CHUNK)
    const secids = part.map(r => (r.code[0] === '6' ? '1.' : '0.') + r.code).join(',')
    try {
      const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + secids +
        '&fields=f12,f100&fltt=2&invt=2&np=1'
      const j = await getJson(url, 1)
      const diff = j && j.data && j.data.diff
      if (Array.isArray(diff)) for (const d of diff) map[String(d.f12)] = String(d.f100 || '')
    } catch (e) { /* 单批失败跳过，继续下一批 */ }
  }
  let hit = 0
  for (const r of noInd) if (map[r.code]) { r.industry = map[r.code]; hit++ }
  console.log('  行业补齐 ' + hit + '/' + noInd.length + (hit ? '（东财 ulist）' : '（东财不可达，降级「未知」）'))
}

function hardFilter(rows) {
  const out = []
  let dropSt = 0, dropKcb = 0, dropSusp = 0, dropThin = 0, dropHot = 0
  for (const r of rows) {
    const code = String(r.code || '').replace(/^(sh|sz|bj)/, '')
    const name = String(r.name || '')
    // 用户点名：不要 ST、不要科创板（aStock 板块本身不含科创板，这里兜底）
    if (name.indexOf('ST') >= 0 || name.indexOf('退') >= 0) { dropSt++; continue }
    if (!/^(60|00|30)/.test(code)) { dropKcb++; continue }
    const price = Number(r.zxj)
    if (!isFinite(price) || price <= 0 || r.state === 'S') { dropSusp++; continue }  // 停牌/无价
    // 腾讯 turnover 单位是万元（实测茅台 33 亿 ≈ 330793 万）
    const amountWan = Number(r.turnover)
    if (!isFinite(amountWan) || amountWan * 1e4 < P.minAmount) { dropThin++; continue }
    const g60pct = Number(r.zdf_d60)           // 腾讯口径：60 日涨幅，百分比数
    if (isFinite(g60pct) && g60pct > P.max60dGain * 100) { dropHot++; continue }
    out.push({
      code: code, name: name, industry: '',
      price: price, amount: amountWan * 1e4,
      chg: Number(r.zdf), turnover: Number(r.hsl), volRatio: Number(r.lb),
      mktcap: Number(r.zsz) * 1e8,             // 腾讯 zsz 单位是亿，统一成元
      gain60: isFinite(g60pct) ? g60pct / 100 : NaN
    })
  }
  console.log('  过滤：ST/退 ' + dropSt + '、非沪深主板/创业板 ' + dropKcb + '、停牌 ' + dropSusp +
    '、成交额不足 ' + dropThin + '、60日涨幅超限 ' + dropHot + ' → 剩 ' + out.length)
  return out
}

/** 段2：单只打分。返回 { score, reasons[], metrics } 或 null（数据不足） */
function scoreStock(bars, cand, idxBars) {
  const ind = S.indicatorsAt(bars, idxBars)
  if (!ind || !isFinite(ind.ma60)) return null
  const c = bars[idxBars].c
  const ret20 = idxBars >= 20 ? c / bars[idxBars - 20].c - 1 : NaN
  const ret60 = idxBars >= P.max60dBars ? c / bars[idxBars - P.max60dBars].c - 1 : NaN
  if (!isFinite(ret20) || !isFinite(ret60)) return null

  let score = 0
  const reasons = []

  // 1) 趋势（0-3）：多头排列最理想
  if (c > ind.ma20 && ind.ma20 > ind.ma60) { score += 3; reasons.push('多头排列（价>20日线>60日线）') }
  else if (c > ind.ma20) { score += 2; reasons.push('站上 20 日线') }
  else if (c > ind.ma60) { score += 1; reasons.push('仍在 60 日线上') }
  else return null                                   // 两根均线都在下面：下跌趋势，直接不要

  // 2) 位置（0-2）：不追山顶，也不接飞刀
  const dd = ind.drawdown
  if (dd <= -0.03 && dd >= -0.18) { score += 2; reasons.push('距 60 日高点回撤 ' + Math.round(-dd * 100) + '%（不追高）') }
  else if (dd <= -0.18 && dd >= -0.25) { score += 1; reasons.push('回撤 ' + Math.round(-dd * 100) + '%（偏深，注意企稳确认）') }

  // 3) 动量（0-2）：20 日温和上涨
  if (ret20 > 0 && ret20 <= 0.20) { score += 2; reasons.push('20 日涨 ' + Math.round(ret20 * 100) + '%（温和）') }
  else if (ret20 > 0 && ret20 <= 0.30) { score += 1; reasons.push('20 日涨 ' + Math.round(ret20 * 100) + '%（偏快）') }

  // 4) 量能（0-2）：温和放量
  const vr = isFinite(ind.vol5) && ind.vol20 > 0 ? ind.vol5 / ind.vol20 : NaN
  if (isFinite(vr)) {
    if (vr >= 1.1) { score += 2; reasons.push('5 日均量是 20 日的 ' + vr.toFixed(2) + ' 倍（放量）') }
    else if (vr >= 0.9) { score += 1; reasons.push('量能持平') }
  }

  // 5) 乖离（0-1）：不追偏离均线太远的
  if (isFinite(ind.bias5) && Math.abs(ind.bias5) <= 0.04) { score += 1; reasons.push('5 日乖离 ' + Math.round(ind.bias5 * 100) + '%（贴近均线）') }

  // 6) 相对强度（0-1）：跑赢大盘
  if (isFinite(cand.gain60) && isFinite(cand.idxGain60) && cand.gain60 - cand.idxGain60 >= 0.10) {
    score += 1; reasons.push('60 日跑赢大盘 ' + Math.round((cand.gain60 - cand.idxGain60) * 100) + ' 个点')
  }

  return { score: score, reasons: reasons, ret20: ret20, ret60: ret60, dd: dd, volRatio: vr, bias5: ind.bias5, ma20: ind.ma20 }
}

/** 简单并发池 */
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

/** 指数（中证全指）60 日涨幅，供相对强度用 */
async function fetchIndexGain60() {
  try {
    const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000985,day,,,70,qfq')
    const key = j.data && Object.keys(j.data)[0]
    const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
    const bars = S.normBars(raw)
    if (bars.length < P.max60dBars) return NaN
    return bars[bars.length - 1].c / bars[bars.length - 1 - P.max60dBars].c - 1
  } catch (e) { return NaN }
}

/** 腾讯日线（与 signals.js 同一份逻辑，这里独立一份小实现避免跨文件耦合） */
async function fetchBars(code) {
  const secid = (String(code)[0] === '6' ? 'sh' : 'sz') + code
  const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + secid + ',day,,,130,qfq')
  const key = j.data && Object.keys(j.data)[0]
  const raw = j.data[key] && (j.data[key].qfqday || j.data[key].day)
  return raw ? S.normBars(raw) : null
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const dry = process.argv.includes('--dry')
  const report = process.argv.includes('--report')
  const picks = loadPicks()

  if (report) {
    const st = S.winrateStats((picks.picks || []).map(p => ({
      rule: 'PICK', verdict: p.verdict || { state: 'pending' }
    })))
    const done = (picks.picks || []).filter(p => p.verdict && p.verdict.state !== 'pending')
    const wins = done.filter(p => p.verdict.state === 'win').length
    console.log('备选池体检：共 ' + (picks.picks || []).length + ' 条，已判定 ' + done.length +
      '，胜 ' + wins + '，胜率 ' + (done.length ? Math.round(wins / done.length * 100) + '%' : '—') +
      '（口径：10 个交易日 ±2%）')
    for (const p of done.slice(-10)) {
      console.log('  ' + p.date + ' ' + p.name + ' ' + p.code + '  ' +
        (p.verdict.ret >= 0 ? '+' : '') + (p.verdict.ret * 100).toFixed(2) + '%  ' + p.verdict.state)
    }
    return
  }

  console.log('== 段0：回填历史推荐胜负（介入信号口径：10 个交易日后涨幅 ≥+2% → win） ==')
  let backfilled = 0
  const todo = (picks.picks || []).filter(p =>
    (!p.verdict || p.verdict.state === 'pending') && p.date !== bjDate())
  for (const p of todo) {
    try {
      const bars = await fetchBars(p.code)
      if (!bars) { p.verdict = { state: 'nodata', ret: NaN, resolveDate: null }; backfilled++; continue }
      const v = S.judgeOutcome({ side: 'buy', at: p.date, price: p.price }, bars)
      if (v.state !== 'pending') { p.verdict = v; backfilled++ }
    } catch (e) { /* 单只失败不影响整体 */ }
  }
  if (todo.length) console.log('  待回填 ' + todo.length + ' 条，本次判定 ' + backfilled + ' 条')

  console.log('== 段1：全 A 榜单 ==')
  const rows = hardFilter(await fetchUniverse())
  if (!rows.length) { console.log('过滤后为空，退出'); return }
  rows.sort((a, b) => (b.gain60 || -9) - (a.gain60 || -9))
  const stage1 = rows.slice(0, P.stage1Top)
  console.log('  动量预选前 ' + stage1.length + ' 只')
  await enrichIndustry(stage1)

  console.log('== 段2：逐只拉 K 线打分 ==')
  const idxGain60 = await fetchIndexGain60()
  console.log('  大盘 60 日涨幅 ' + (isFinite(idxGain60) ? (idxGain60 * 100).toFixed(1) + '%' : '取不到（相对强度项跳过）'))

  const tasks = stage1.map(cand => async () => {
    try {
      const bars = await fetchBars(cand.code)
      if (!bars || bars.length < S.P.trendMa) return { cand, sc: null }
      const idx = bars.length - 1
      const todayBar = bars[idx].d === bjDate()
      cand.idxGain60 = idxGain60
      const sc = scoreStock(bars, cand, idx)
      return { cand, sc: sc, price: bars[idx].c, date: bars[idx].d, isToday: todayBar }
    } catch (e) {
      return { cand, sc: null, err: e && e.message ? e.message : String(e) }
    }
  })
  const rs = await pool(5, tasks)
  const scored = rs.filter(r => r.sc && r.sc.score >= P.minScore)
  console.log('  打分达标（≥' + P.minScore + '）' + scored.length + ' / ' + rs.length)

  /* 排序：分数优先，同分看流动性（成交额） */
  scored.sort((a, b) => (b.sc.score - a.sc.score) || (b.cand.amount - a.cand.amount))

  /* 行业错开：前 2 只不重复同一个行业 */
  const chosen = []
  const usedInd = {}
  for (const r of scored) {
    const ind = r.cand.industry || '未知'
    if (usedInd[ind]) continue
    usedInd[ind] = true
    chosen.push(r)
    if (chosen.length >= P.pickCount) break
  }
  if (!chosen.length) { console.log('今天没有达到入选标准的股票，不硬凑。'); return }

  const today = bjDate()
  const fresh = chosen.map(r => ({
    id: r.cand.code + '|' + r.date,
    date: r.date,
    code: r.cand.code,
    name: r.cand.name,
    industry: r.cand.industry || '',
    price: r.price,
    score: r.sc.score,
    reasons: r.sc.reasons,
    plan: {
      buy: '分批介入，首仓不超过计划仓位的 1/3；介入后收盘跌破 20 日线（当前约 ' +
        r.sc.ma20.toFixed(2) + '）或较介入价回撤 8% 即离场',
      sell: '涨到 60 日高点附近（压力位）或 20 日乖离超过 +8% 时分批止盈'
    },
    ruleVersion: S.RULE_VERSION,
    verdict: null
  }))
  console.log('今日备选 ' + fresh.length + ' 只：' + fresh.map(f => f.name + '(' + f.score + '分)').join('、'))

  /* 写存档（幂等：内容没变就不写） */
  const ids = new Set((picks.picks || []).map(p => p.id))
  let added = 0
  for (const f of fresh) if (!ids.has(f.id)) { picks.picks.push(f); added++ }
  if (picks.picks.length > KEEP) picks.picks = picks.picks.slice(picks.picks.length - KEEP)
  picks.ruleVersion = S.RULE_VERSION

  if (!dry) {
    const prevText = fs.existsSync(PICKS_PATH) ? fs.readFileSync(PICKS_PATH, 'utf8') : ''
    const nextText = JSON.stringify(picks)
    if (nextText === prevText) {
      console.log('备选池无变化，不重写文件')
    } else {
      fs.writeFileSync(PICKS_PATH, nextText, 'utf8')
      console.log('已写 picks-history.json：共 ' + picks.picks.length + ' 条（新增 ' + added + '）')
    }
  }
  console.log('（按用户要求：备选池不推送，只在控制台展示）')
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
