#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 *  推送通道（单一真源）  push.js
 * ============================================================
 *  alert.js / fng.js / heartbeat.js 共用这一份推送实现，避免三个脚本各写一套
 *  （各写一套的结果必然是某个通道只在某个脚本里生效，出问题时极难排查）。
 *
 *  通道优先级：config.json 里配的主通道 → 备用通道（云端 Secrets）
 *  主通道失败自动降级到备用通道；全部失败则返回 ok:false，由调用方决定
 *  （脚本一般直接抛错，让 GitHub Actions 亮红，比静默失败好得多）。
 *
 *  云端从仓库 Secrets 读（本地运行回落到 config.json）：
 *    SENDKEY         Server酱 或 PushPlus 的 key（主通道用）
 *    PUSHPLUS_TOKEN  PushPlus token（可选，作备用通道）
 *    WECOM_WEBHOOK   企业微信群机器人 webhook（可选，作备用通道）
 *
 *  config.json 里可配：
 *    channel     'serverchan' | 'pushplus' | 'wecombot'
 *    sendKey     本地调试用（云端留空，走 Secret）
 *    webhook     企业微信机器人地址（channel=wecombot 时用）
 */

const CHANNEL_NAME = {
  serverchan: 'Server酱',
  pushplus: 'PushPlus',
  wecombot: '企业微信机器人'
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000)
  try {
    const res = await fetch(url, Object.assign({ signal: ac.signal }, opts || {}))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 组装可用通道（有序）。去重：同一个 key/webhook 不重复出现。
 * @returns {Array<{kind, key?, webhook?, label}>}
 */
function channelsOf(cfg, env) {
  cfg = cfg || {}
  env = env || process.env
  const list = []
  const push = (c) => {
    if (!c.key && !c.webhook) return
    const sig = c.kind + '|' + (c.key || c.webhook)
    if (list.some(x => x.kind + '|' + (x.key || x.webhook) === sig)) return
    list.push(c)
  }

  const primary = cfg.channel || 'serverchan'
  const key = env.SENDKEY || cfg.sendKey || ''
  const wecom = env.WECOM_WEBHOOK || cfg.webhook || ''

  if (primary === 'wecombot') push({ kind: 'wecombot', webhook: wecom })
  else push({ kind: primary, key: key })

  // 备用通道
  push({ kind: 'pushplus', key: env.PUSHPLUS_TOKEN || '' })
  push({ kind: 'wecombot', webhook: env.WECOM_WEBHOOK || '' })

  return list.map(c => Object.assign({ label: CHANNEL_NAME[c.kind] || c.kind }, c))
}

async function sendVia(ch, title, content) {
  if (ch.kind === 'serverchan') {
    const res = await fetchJson('https://sctapi.ftqq.com/' + ch.key + '.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: title, desp: content }).toString()
    })
    if (res.code !== 0) throw new Error('Server酱返回异常: ' + JSON.stringify(res))
    return
  }

  if (ch.kind === 'pushplus') {
    const res = await fetchJson('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ch.key, title: title, content: content, template: 'txt' })
    })
    if (res.code !== 200) throw new Error('PushPlus返回异常: ' + JSON.stringify(res))
    return
  }

  if (ch.kind === 'wecombot') {
    const res = await fetchJson(ch.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: title + '\n' + content } })
    })
    if (res.errcode !== 0) throw new Error('企业微信机器人返回异常: ' + JSON.stringify(res))
    return
  }

  throw new Error('未知的推送通道 kind=' + ch.kind)
}

/**
 * 推送：依次尝试每个通道，成功即止。
 * @returns {Promise<{ok:boolean, via?:string, errors:string[], tried:number}>}
 */
async function push(cfg, title, content, env) {
  const list = channelsOf(cfg, env)
  const errors = []
  if (!list.length) {
    return { ok: false, via: null, errors: ['没有配置任何推送通道（本地填 config.json 的 sendKey；云端配仓库 Secret SENDKEY）'], tried: 0 }
  }
  for (const ch of list) {
    try {
      await sendVia(ch, title, content)
      return { ok: true, via: ch.label, errors: errors, tried: list.length }
    } catch (e) {
      errors.push(ch.label + ' 失败：' + (e && e.message ? e.message : e))
    }
  }
  return { ok: false, via: null, errors: errors, tried: list.length }
}

/** 推送，失败即抛错（让 Actions 亮红，避免静默失败） */
async function pushOrThrow(cfg, title, content, env) {
  const r = await push(cfg, title, content, env)
  if (!r.ok) throw new Error('推送失败（已尝试 ' + r.tried + ' 个通道）：' + r.errors.join(' / '))
  return r
}

module.exports = { push, pushOrThrow, channelsOf, CHANNEL_NAME }
