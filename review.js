#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  规则体检任务  review.js（每周五跑一次）
 * ============================================================
 *  这是「自我优化」的实现方式 —— 用户 2026-09-16 要求：
 *   「根据推荐的涨跌幅度，自我优化升级推荐规则，提高胜率」。
 *
 *  为什么不做成全自动调参：样本只有几十条就自动改参数，**必然过拟合**，
 *  改完看起来胜率变高、实际是背对了最近几笔。所以这里只做两件事：
 *   1. 用数据说话：每条规则的样本数 / 胜率 / 平均涨跌，和上一版对比
 *   2. 给出**建议**（继续用 / 收紧 / 暂停），改动需要人确认后改 signal-core.js
 *      的参数并升 RULE_VERSION —— 胜率按版本分开统计，新旧不混
 *
 *  用户已选定胜负口径：10 个交易日后 ±2%（signal-core.js 里的 P.winDays/winBand）。
 *
 *  本地调试：node review.js            （非周五会提示跳过；--force 可强制跑）
 * ============================================================
 */

const fs = require('fs')
const path = require('path')
const push = require('./push.js')
const S = require('./signal-core.js')

const SRC = __dirname
const SIG_PATH = path.join(SRC, 'signals-history.json')
const PICKS_PATH = path.join(SRC, 'picks-history.json')

const RULE_NAME = {
  MA5_STREAK_EXIT: '连续站上5日线（减仓提示）',
  HOT_MA5_BIAS: '短线过热（站上5日线+乖离大）',
  NEAR_PREV_HIGH: '触及前高压力位',
  TREND_BREAK: '跌破20日线',
  GRIND_DOWN: '持续阴跌',
  BOTTOM_RECLAIM: '超跌企稳',
  PICK: '每日备选池'
}

/** 非周五直接跳过（北京时区），避免每天都发一份没人看的报告 */
function isFriday(d) {
  const t = d || new Date()
  return new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000).getDay() === 5
}

function readSignals() {
  try {
    const j = JSON.parse(fs.readFileSync(SIG_PATH, 'utf8'))
    return Array.isArray(j.signals) ? j.signals : []
  } catch (e) { return [] }
}
function readPicks() {
  try {
    const j = JSON.parse(fs.readFileSync(PICKS_PATH, 'utf8'))
    return Array.isArray(j.picks) ? j.picks : []
  } catch (e) { return [] }
}

/** 依数据给建议：样本够多才谈得上"建议"，太少就明说看不出来 */
function adviceOf(s) {
  if (s.done < 10) return '样本太少，先攒数据'
  if (s.winRate >= 0.55) return '表现达标，保持'
  if (s.winRate >= 0.40) return '中性，继续观察'
  if (s.winRate < 0.35) return '建议收紧或暂停该规则'
  return '继续观察'
}

function fmtPct(v) {
  return isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%' : '—'
}

async function main() {
  const force = process.argv.includes('--force')
  if (!force && !isFriday()) {
    console.log('今天不是周五，规则体检每周五跑一次（--force 可强制）')
    return
  }

  const sigs = readSignals()
  const picks = readPicks()
  if (!sigs.length && !picks.length) {
    console.log('信号存档和备选池都是空的，没东西可体检')
    return
  }

  /* 备选池的记录转成 winrateStats 认识的形状 */
  const pickRows = picks.map(p => ({ rule: 'PICK', verdict: p.verdict || { state: 'pending', ret: NaN } }))
  const stats = S.winrateStats(sigs.concat(pickRows))

  const bj = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000)
  const today = bj.toISOString().slice(0, 10)
  const pending = stats.reduce((a, s) => a + s.pending, 0)

  let content = '胜负口径：10 个交易日后 ±2%。规则版本 ' + S.RULE_VERSION +
    '。共 ' + stats.length + ' 条规则，待判定 ' + pending + ' 条。\n\n'

  for (const s of stats) {
    content += '· ' + (RULE_NAME[s.rule] || s.rule) +
      '\n   样本 ' + s.n + '（已判 ' + s.done + '）' +
      '  胜率 ' + (isFinite(s.winRate) ? Math.round(s.winRate * 100) + '%' : '—') +
      '  平均涨跌 ' + fmtPct(s.avgRet) +
      '\n   建议：' + adviceOf(s) + '\n\n'
  }

  const totalDone = stats.reduce((a, s) => a + s.done, 0)
  content += totalDone < 20
    ? '⚠️ 已判定样本仅 ' + totalDone + ' 条，胜率数字仅供参考，别拿来当决策依据。\n'
    : '已判定样本 ' + totalDone + ' 条。要调整规则参数请说一声，改参数会升版本号、新旧胜率分开统计。\n'
  content += '\n非投资建议。'

  console.log('==== 规则体检 ' + today + ' ====')
  console.log(content)

  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.json'), 'utf8'))
  try {
    const r = await push.pushOrThrow(cfg, '规则体检 ' + today.slice(5), content)
    console.log('已推送（' + r.via + '）')
  } catch (e) {
    console.log('⚠️ 推送失败：' + (e && e.message ? e.message : e))
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('出错: ' + (e && e.message ? e.message : e))
    process.exit(1)
  })
}
