#!/usr/bin/env node
/* 板块资金流日更存档（2026-09-29）
 * 作用：每交易日收盘后跑一次，把「行业板块全量 + 概念板块前 80」的当日主力净流入
 *       增量写入 flow-history.json（保留最近 60 个交易日）。
 * 页面（资金流向监控）在东财接口被限流/不可达时，直读这份存档兜底：
 *   https://raw.githubusercontent.com/zyhaaad/stock-alert/main/flow-history.json
 *
 * 用法：node flow-daily.js [--dry]
 *
 * 设计要点：
 *   - 每天只发 2 个 clist 请求（行业/概念各一），GitHub Actions 的 IP 干净且频率极低，
 *     不会像浏览器端高频请求那样触发东财风控
 *   - f62 取万元整数、f3 存涨跌幅 bp，控制存档体积（60 天约 100+KB）
 *   - 幂等：同一天重复跑只覆盖当天，不产生重复日期
 */
'use strict'
const fs = require('fs')
const path = require('path')

const DIR = __dirname
const HIST_PATH = path.join(DIR, 'flow-history.json')
const DRY = process.argv.includes('--dry')
const KEEP = 60
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' }

function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function getJSON(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 80))
  return res.json()
}

/* type: 2=行业板块 3=概念板块；返回 { bk: [名称, f62万元, chgBp] } */
async function fetchBoards(type, pz) {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + pz +
    '&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:' + type + '&fields=f12,f14,f2,f3,f62'
  const j = await getJSON(url)
  const diff = (j && j.data && j.data.diff) || []
  if (!Array.isArray(diff) || !diff.length) throw new Error('clist 返回空（t=' + type + '）')
  const out = {}
  for (const d of diff) {
    if (!d.f12) continue
    out[String(d.f12)] = [
      String(d.f14 || '').trim(),
      Math.round((Number(d.f62) || 0) / 1e4),
      Math.round((Number(d.f3) || 0) * 100)
    ]
  }
  return out
}

async function main() {
  const t = bjToday()
  const ind = await fetchBoards(2, 100)
  const con = await fetchBoards(3, 80)
  const nInd = Object.keys(ind).length
  const nCon = Object.keys(con).length
  if (nInd < 50) throw new Error('行业板块数量异常：' + nInd)

  let hist = { names: {}, days: [] }
  if (fs.existsSync(HIST_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'))
      if (prev && prev.days) hist = { names: prev.names || {}, days: prev.days }
    } catch (e) { console.log('⚠️ 旧存档解析失败，重建：' + e.message) }
  }

  /* names 只增不改（板块名基本不变），days 里当天覆盖（幂等） */
  for (const bk of Object.keys(ind)) hist.names[bk] = [ind[bk][0], 2]
  for (const bk of Object.keys(con)) if (!hist.names[bk]) hist.names[bk] = [con[bk][0], 3]
  const todayEntry = { d: t, ind: ind, con: con }
  const idx = hist.days.findIndex(x => x.d === t)
  if (idx >= 0) hist.days[idx] = todayEntry
  else hist.days.push(todayEntry)
  if (hist.days.length > KEEP) hist.days = hist.days.slice(-KEEP)
  hist.updated = t

  const body = JSON.stringify(hist)
  const summary = t + '  行业 ' + nInd + ' + 概念 ' + nCon + '  存档 ' + hist.days.length +
    ' 天  ' + Math.round(body.length / 1024) + 'KB'
  if (DRY) {
    console.log('[dry] ' + summary)
    return
  }
  fs.writeFileSync(HIST_PATH, body)
  console.log('已写 flow-history.json：' + summary)
}

main().catch(function (e) {
  console.error('flow-daily 失败: ' + (e && e.message ? e.message : e))
  process.exit(1)
})
