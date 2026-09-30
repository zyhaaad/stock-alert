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
  /* 实验A：个股 TOP5 请求形态对比（查「不同板块点开个股一样」）
   * 页面现款 = push2 + fs=b:BK+f:!50 无 ut。变体：去 f:!50 / 带 ut / delay 域。 */
  const variants = [
    ['A现款 push2 f:!50', 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK1648+f:!50&fields=f12,f14,f62'],
    ['B无f:!50 push2',    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK1648&fields=f12,f14,f62'],
    ['C现款+ut push2',    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK1648+f:!50&fields=f12,f14,f62&ut=b2884a393a59ad64002292a3e90d46a5'],
    ['D delay+ut f:!50',  'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK1648+f:!50&fields=f12,f14,f62&ut=b2884a393a59ad64002292a3e90d46a5'],
    ['E delay+ut 无f:!50','https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK1648&fields=f12,f14,f62&ut=b2884a393a59ad64002292a3e90d46a5'],
    ['F对照 电网BK0457',  'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:BK0457&fields=f12,f14,f62&ut=b2884a393a59ad64002292a3e90d46a5']
  ]
  for (const [tag, url] of variants) {
    try {
      const j = await getJSON(url)
      const diff = (j && j.data && j.data.diff) || []
      const total = j && j.data && j.data.total
      console.log('[个股实验] ' + tag + ' → total=' + total + ' ' + (Array.isArray(diff) ? diff.slice(0, 5).map(d => d.f14).join(' | ') : 'diff异常'))
    } catch (e) { console.log('[个股实验] ' + tag + ' → 失败: ' + e.message) }
    await new Promise(r => setTimeout(r, 1200))
  }
  console.log('probe done')
}
main().catch(e => { console.error('probe 失败: ' + e.message); process.exit(1) })
