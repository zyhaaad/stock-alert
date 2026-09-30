#!/usr/bin/env node
/* 一次性诊断（2026-09-30）：
 * 1) 电池/电网等板块的 9 月全月主力净流入累计（daykline 35 天）——验证「当月累计口径下它们该不该在榜」
 * 2) 各板块个股 TOP5（页面同款请求）——验证用户报告的「不同板块点开个股很多一样」 */
'use strict'
const BKS = [
  ['BK1648', '电池技术'], ['BK0457', '电网设备'], ['BK1647', '电网概念'],
  ['BK1033', '电池(行业)'], ['BK0113', '半导体'], ['BK0493', '电力行业'], ['BK0475', '银行']
]
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' }

async function getJSON(url) {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  let lastErr
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: UA })
      if (res.ok) return res.json()
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500 && res.status !== 429) throw lastErr
    } catch (e) { if (/HTTP 4/.test(String(e.message)) && !/429/.test(e.message)) throw e; lastErr = e }
    if (i < 3) await wait([3000, 6000, 10000][i])
  }
  throw lastErr
}

async function monthCum(bk) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=35&klt=101&secid=90.' + bk +
    '&fields1=f1,f2,f3,f7&fields2=f51,f52'
  const j = await getJSON(url)
  const kl = (j && j.data && j.data.klines) || []
  let sep = 0, n = 0, streak = 0, lastD = ''
  for (const line of kl) {
    const p = String(line).split(',')
    if (p.length < 2) continue
    if (p[0] >= '2026-09') { sep += parseFloat(p[1]); n++; lastD = p[0] }
  }
  for (let i = kl.length - 1; i >= 0; i--) {
    const p = String(kl[i]).split(',')
    if (p[0] < '2026-09') break
    const f = parseFloat(p[1])
    if (streak === 0) { if (f > 0) streak = 1; else if (f < 0) streak = -1; else break }
    else if (streak > 0) { if (f > 0) streak++; else break }
    else { if (f < 0) streak--; else break }
  }
  return { sep, n, streak, lastD }
}

async function topStocks(bk) {
  const url = 'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62' +
    '&fs=b:' + bk + '+f:!50&fields=f12,f14,f2,f3,f62&ut=b2884a393a59ad64002292a3e90d46a5'
  const j = await getJSON(url)
  const diff = (j && j.data && j.data.diff) || []
  return (Array.isArray(diff) ? diff : []).slice(0, 5).map(d => d.f14 + '(' + d.f12 + ')')
}

async function main() {
  const all = {}
  for (const [bk, name] of BKS) {
    try {
      const m = await monthCum(bk)
      console.log('[月累计] ' + name + '(' + bk + ') 9月=' + (m.sep / 1e8).toFixed(1) + '亿 天数=' + m.n + ' 连续=' + m.streak + ' 末日=' + m.lastD)
      all[bk] = name
    } catch (e) { console.log('[月累计] ' + name + '(' + bk + ') 失败: ' + e.message) }
  }
  const sets = {}
  for (const [bk, name] of BKS) {
    try {
      const st = await topStocks(bk)
      sets[bk] = st
      console.log('[个股TOP5] ' + name + '(' + bk + '): ' + st.join(' | '))
    } catch (e) { console.log('[个股TOP5] ' + name + '(' + bk + ') 失败: ' + e.message) }
  }
  /* 重复性：两两比较交集 */
  const keys = Object.keys(sets)
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = new Set(sets[keys[i]]), inter = sets[keys[j]].filter(x => a.has(x))
      if (inter.length) console.log('[重复] ' + all[keys[i]] + ' ∩ ' + all[keys[j]] + ' = ' + inter.length + ' 只: ' + inter.join(','))
    }
  }
  console.log('probe done')
}
main().catch(e => { console.error('probe 失败: ' + e.message); process.exit(1) })
