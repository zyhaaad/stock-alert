#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  筹码透视任务  chips.js
 * ============================================================
 *  每个交易日收盘后跑一次（挂在 signals.yml 的最后一步）：
 *   1. 取「持仓 holdings[] + 监控 stocks[] + 最新推荐」的代码并去重
 *   2. 逐只拉：腾讯前复权日线（500 根）+ 东财资金流日线（120 天）+ 股本
 *   3. 用 chip-core.js 算筹码分布与「主力/散户」行为，写 chips-history.json
 *   4. **幂等**：内容没变不重写文件（否则每天产生只有时间戳变化的噪音提交）
 *
 *  为什么透视放云端算，而不是手机上算？
 *   · 手机浏览器打开时逐只实时拉资金流，接口跨域不保证、还慢（每只 3 个请求）
 *   · 500 根 K 线 × 120 桶的筹码分布算一次就够，所有设备共享同一份结果
 *   · 资金流本来就是**日频**数据，T+1 完全够用
 *   手机端只负责一件小事：用腾讯日线（支持跨域）本地算「5 日线连续站上天数」。
 *
 *  数据源与降级（本机网络实测结论，见 _recon/chip-probe*.js）：
 *   日线    腾讯 web.ifzq.gtimg.cn        仅此一家（CORS 开放，手机也能取）
 *   资金流  东财 push2his/fflow/kline  →  新浪 MoneyFlow.ssl_qsfx_zjlrqs
 *            · 东财口径明确：日期,主力,小单,中单,大单,超大单（已做字段闭合校验）
 *            · 新浪只有「主力净额 netamount」与「超大单净额 r0_net」，
 *              拿不到中/小单的细分，故标记 src='sina'，仅供方向性判断
 *   股本    东财 push2delay/stock/get 的 f84/f85（国内可达、免鉴权）
 *
 *  本地调试：
 *    node chips.js --dry       # 只算不写文件
 *    node chips.js --show 600519   # 打印单只的完整结果
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const C = require('./chip-core.js')
const S = require('./signal-core.js')

const SRC = __dirname
const OUT_PATH = path.join(SRC, 'chips-history.json')
const CFG_PATH = path.join(SRC, 'config.json')
const PICKS_PATH = path.join(SRC, 'picks-history.json')

const BARS_N = 500           // 日线根数：两年足够让筹码分布收敛（低换手股尤其需要长历史）
const FLOW_N = 120           // 资金流天数：半年，够看一波完整的建仓/派发
const CHIP_KEEP = 200        // 存档最多保留多少只（防止无限膨胀）

/* ---------------- 基础工具 ---------------- */

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    })
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

function round2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : null }
function round6(v) { return isFinite(v) ? Math.round(v * 1e6) / 1e6 : null }

function loadCfg() {
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
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

/* ---------------- 数据获取 ---------------- */

/** 腾讯前复权日线（K 线唯一来源）。失败返回 null，不拖垮整批 */
async function fetchBars(code) {
  const c = String(code)
  if (!/^(60|00|30)/.test(c)) return null
  const sym = (c[0] === '6' ? 'sh' : 'sz') + c
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,' + BARS_N + ',qfq'
  const j = await fetchJson(url, 20000)
  const key = j && j.data && Object.keys(j.data)[0]
  const raw = j && j.data && j.data[key] && (j.data[key].qfqday || j.data[key].day)
  return raw ? S.normBars(raw) : null
}

/**
 * 资金流日线。返回 { src, flows }
 *   主源 东财：{d, main, small, mid, big, huge}（元）
 *   备源 新浪：{d, main, huge}（mid/small/big 拿不到，置 0；src='sina' 供降级标注）
 */
async function fetchFlows(code) {
  const c = String(code)
  const secid = (c[0] === '6' ? '1.' : '0.') + c
  /* ---- 主源：东财 ---- */
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=' + FLOW_N +
      '&klt=101&secid=' + secid + '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56'
    const j = await fetchJson(url, 15000)
    const kl = (j && j.data && j.data.klines) || []
    if (kl.length >= 5) return { src: 'eastmoney', flows: C.normFlows(kl) }
  } catch (e) { /* 落到备源 */ }

  /* ---- 备源：新浪（老牌接口，国内稳定；但只有超大单与总净额） ---- */
  try {
    const sym = (c[0] === '6' ? 'sh' : 'sz') + c
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
      'MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=' + FLOW_N + '&sort=opendate&asc=0&daima=' + sym
    const j = await fetchJson(url, 15000)
    const arr = Array.isArray(j) ? j : []
    if (!arr.length) return { src: null, flows: [] }
    const rows = arr.slice().reverse().map(function (d) {
      return {
        d: String(d.opendate).slice(0, 10),
        main: Number(d.netamount) || 0,      // 新浪口径的「主力净额」（大单+超大单）
        huge: Number(d.r0_net) || 0,         // 超大单净额
        big: 0, mid: 0, small: 0             // 细分拿不到，如实置 0，不编
      }
    })
    return { src: 'sina', flows: rows }
  } catch (e) { /* 两家都不通 */ }
  return { src: null, flows: [] }
}

/** 股本（总股本/流通股本）。东财 push2delay（国内可达）。失败返回 null */
async function fetchShares(code) {
  const c = String(code)
  const secid = (c[0] === '6' ? '1.' : '0.') + c
  const url = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=' + secid +
    '&fields=f43,f57,f58,f84,f85,f116,f168'
  const j = await fetchJson(url, 12000)
  const d = (j && j.data) || null
  if (!d || !isFinite(Number(d.f84))) return null
  return {
    name: d.f58 || '',
    totalShares: Number(d.f84) || NaN,
    floatShares: Number(d.f85) || Number(d.f84) || NaN,
    turnover: Number(d.f168) / 100 || NaN
  }
}

/* ---------------- 存档 ---------------- */

function loadHist() {
  try {
    const j = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'))
    if (j && j.stocks && typeof j.stocks === 'object') return j
  } catch (e) { /* 首次运行 */ }
  return {
    _说明: '筹码透视存档：每个交易日收盘后由 chips.js 生成。' +
      'chips=筹码分布（主力成本/散户成本/获利盘/支撑压力），' +
      'flows=资金流（主力=大单+超大单，散户=中单+小单），' +
      'mainBehavior/retailBehavior=主力与散户的行为判定，stance=站队结论。' +
      '口径见 chip-core.js，ruleVersion 变了说明算法改过，别跨版本比。',
    ruleVersion: C.RULE_VERSION,
    chipVersion: C.VERSION,
    updatedAt: '',
    stocks: {}
  }
}

/** 把 analyze 的结果压成存档用的紧凑结构（只留界面要用的字段，控制文件体积） */
function compact(code, name, r, flowSrc) {
  const c = r.chips, f = r.flows, v = r.vol
  return {
    code: code,
    name: name || r.name || code,
    date: r.date,
    price: round2(r.price),
    flowSrc: flowSrc || '',
    chips: c ? {
      avgCost: round2(c.avgCost),
      profitRatio: round6(c.profitRatio),
      concentration: round6(c.concentration),   // 现价 ±10% 内的筹码占比（越大越集中）
      spread: round6(c.spread),                 // 90% 筹码带宽 / 均价（越小越集中）
      mainCost: round2(c.mainCost),
      mainMass: round6(c.mainMass),
      retailCost: round2(c.retailCost),
      retailMass: round6(c.retailMass),
      support: round2(c.support),
      pressure: round2(c.pressure),
      band90: [round2(c.band90[0]), round2(c.band90[1])]
    } : null,
    flows: {
      main5: round2(f.main5), main20: round2(f.main20),
      dom5: round6(f.dom5), dom20: round6(f.dom20),
      huge5: round2(f.huge5), big5: round2(f.big5),
      days: f.days
    },
    vol: {
      volRatio: round6(v.volRatio), volRatio60: round6(v.volRatio60),
      turnover5: round6(v.turnover5), turnoverRank: round6(v.turnoverRank),
      ret5: round6(v.ret5), ret20: round6(v.ret20), ret60: round6(v.ret60)
    },
    main: r.mainBehavior,
    retail: r.retailBehavior,
    stance: r.stance,
    ma5: (function () {
      const st = S.ma5Streak(r.barsObj || [])
      return { days: st.days, sig: st.sig, ma5: round2(st.ma5) }
    })(),
    notes: r.notes || []
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const dry = process.argv.includes('--dry')
  const showIdx = process.argv.indexOf('--show')
  const showCode = showIdx > -1 ? process.argv[showIdx + 1] : ''

  const cfg = loadCfg()
  const hist = loadHist()

  /* 三份来源合并去重：持仓 + 监控 + 最新推荐 */
  const nameOf = {}
  const srcOf = {}
  for (const h of (cfg.holdings || [])) { nameOf[h.code] = h.name || h.code; srcOf[h.code] = 'holdings' }
  for (const s of (cfg.stocks || [])) {
    nameOf[s.code] = s.name || nameOf[s.code] || s.code
    srcOf[s.code] = srcOf[s.code] ? 'both' : 'monitor'
  }
  try {
    const pj = JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8'))
    const picks = (pj && pj.picks) || []
    /* 只取最新一天的推荐，避免把历史几百只全算一遍 */
    let latest = ''
    for (const p of picks) if (p.date && p.date > latest) latest = p.date
    for (const p of picks) {
      if (p.date !== latest) continue
      nameOf[p.code] = p.name || nameOf[p.code] || p.code
      if (!srcOf[p.code]) srcOf[p.code] = 'picks'
    }
  } catch (e) { /* 没有推荐存档 */ }

  const codes = Object.keys(nameOf).filter(c => /^(60|00|30)/.test(c))
  if (!codes.length) { console.log('配置里没有可分析的股票，无事可做'); return }
  console.log('待透视 ' + codes.length + ' 只（持仓 ' + (cfg.holdings || []).length +
    ' / 监控 ' + (cfg.stocks || []).length + ' / 来源见下）')

  /* ---- 逐只：日线 + 资金流 + 股本 → 分析 ---- */
  const tasks = codes.map(code => async () => {
    const bars = await fetchBars(code)
    if (!bars || bars.length < 21) return { code, err: 'K线不足(' + (bars ? bars.length : 0) + ')' }
    const ff = await fetchFlows(code)
    const sh = await fetchShares(code)
    const floatShares = sh && isFinite(sh.floatShares) ? sh.floatShares : NaN
    const r = C.analyze({
      code: code,
      name: nameOf[code],
      bars: bars,
      flows: ff.flows,
      floatShares: floatShares
      /* price 不传 → chip-core 用最后一根收盘价，避免行情快照与日线打架 */
    })
    if (!r.ok) return { code, err: r.msg }
    r.barsObj = bars                     // compact 里要算 5 日线，临时挂上（不进存档）
    return { code, r: r, flowSrc: ff.src, bars: bars.length, flowDays: ff.flows.length, src: srcOf[code] }
  })
  const results = await pool(3, tasks)

  const ok = results.filter(x => x && x.r)
  const bad = results.filter(x => x && x.err)
  if (bad.length) console.log('  ⚠️ ' + bad.length + ' 只失败（跳过，不影响其它）：' +
    bad.map(b => b.code + '(' + b.err + ')').join(' '))

  /* ---- --show：打印单只的完整结果 ---- */
  if (showCode) {
    const one = ok.find(x => x.code === showCode)
    if (!one) { console.log('没有算出 ' + showCode); return }
    const r = one.r
    console.log('\n=== ' + (r.name || '') + ' ' + showCode + ' @ ' + r.price.toFixed(2) + ' (' + r.date + ') ===')
    console.log('数据源：日线 ' + one.bars + ' 根 / 资金流 ' + one.flowDays + ' 天（' + one.flowSrc + '）')
    if (r.chips) {
      const c = r.chips
      console.log('筹码：平均成本 ' + c.avgCost.toFixed(2) + ' | 获利盘 ' + (c.profitRatio * 100).toFixed(1) + '%' +
        ' | 密集度 ' + (c.concentration * 100).toFixed(1) + '% | 90%区间 ' +
        c.band90[0].toFixed(2) + '~' + c.band90[1].toFixed(2))
      console.log('      主力成本 ' + (isFinite(c.mainCost) ? c.mainCost.toFixed(2) : '—') +
        ' | 散户成本 ' + (isFinite(c.retailCost) ? c.retailCost.toFixed(2) : '—') +
        ' | 支撑 ' + (isFinite(c.support) ? c.support.toFixed(2) : '—') +
        ' | 压力 ' + (isFinite(c.pressure) ? c.pressure.toFixed(2) : '—'))
    }
    console.log('资金：主力5日 ' + C.yi(r.flows.main5) + ' / 20日 ' + C.yi(r.flows.main20) +
      ' | dom5 ' + (isFinite(r.flows.dom5) ? (r.flows.dom5 * 100).toFixed(2) + '%' : '—') +
      ' | dom20 ' + (isFinite(r.flows.dom20) ? (r.flows.dom20 * 100).toFixed(2) + '%' : '—'))
    console.log('量能：5/20量比 ' + (isFinite(r.vol.volRatio) ? r.vol.volRatio.toFixed(2) : '—') +
      ' | 5/60量比 ' + (isFinite(r.vol.volRatio60) ? r.vol.volRatio60.toFixed(2) : '—') +
      ' | ret5 ' + (isFinite(r.vol.ret5) ? (r.vol.ret5 * 100).toFixed(2) + '%' : '—') +
      ' | ret20 ' + (isFinite(r.vol.ret20) ? (r.vol.ret20 * 100).toFixed(2) + '%' : '—'))
    console.log('★ 主力：' + r.mainBehavior.tag + ' — ' + r.mainBehavior.desc)
    console.log('★ 散户：' + r.retailBehavior.tag + ' — ' + r.retailBehavior.desc)
    console.log('★ 结论：[' + r.stance.tag + '] ' + r.stance.actionText + ' — ' + r.stance.desc)
    if (r.notes.length) console.log('注：' + r.notes.join(' / '))
    return
  }

  /* ---- 汇总写存档 ---- */
  const stocks = {}
  /* 先保留存档里已有的（本轮没算到的股票不清空，避免临时失败丢数据） */
  for (const k of Object.keys(hist.stocks || {})) stocks[k] = hist.stocks[k]
  for (const x of ok) {
    try { stocks[x.code] = compact(x.code, nameOf[x.code], x.r, x.flowSrc) }
    catch (e) { console.log('  ⚠️ ' + x.code + ' 压缩失败：' + e.message) }
  }
  /* 裁剪：只留最近 CHIP_KEEP 只（按日期新的优先） */
  const keys = Object.keys(stocks)
  if (keys.length > CHIP_KEEP) {
    keys.sort((a, b) => String(stocks[b].date || '').localeCompare(String(stocks[a].date || '')))
    const keep = {}
    for (const k of keys.slice(0, CHIP_KEEP)) keep[k] = stocks[k]
    hist.stocks = keep
  } else {
    hist.stocks = stocks
  }
  hist.ruleVersion = C.RULE_VERSION
  hist.chipVersion = C.VERSION
  hist.updatedAt = bjDate()

  console.log('算出 ' + ok.length + ' 只；' +
    ok.map(x => x.code + '[' + x.src + '/' + x.r.stance.tag + ']').join(' '))

  if (dry) { console.log('（--dry：不写文件）'); return }

  const prevText = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : ''
  /* ⚠️ 幂等的前提是序列化稳定：JSON.stringify 的键序由插入顺序决定，
     stocks 的插入顺序是「旧存档 → 本轮结果」，只要股票集合不变就是稳定的。
     所以先比内容、再写文件，避免每天产生只有 updatedAt 变化的噪音提交。 */
  let nextText = JSON.stringify(hist)
  if (nextText === prevText) {
    console.log('存档无变化，不重写文件')
  } else {
    /* updatedAt 变了但其实没新数据 → 仍写（日期会变），这是可接受的：
       因为收盘后 daily 数据本身就更新了。若内容完全一致则上面的分支已拦住。 */
    fs.writeFileSync(OUT_PATH, nextText, 'utf8')
    console.log('已写 chips-history.json：' + Object.keys(hist.stocks).length + ' 只，' +
      Math.round(nextText.length / 1024) + ' KB')
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
