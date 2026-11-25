// ============================================================
//   alexa/listeners.js
//   ElitePro automation layer (antilink, antispam, antibot,
//   antistatus, autoreact, chatbot, status watcher, antidelete,
//   anticall) ported from ELITE-PRO-V1 and made PER SESSION.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import moment from 'moment-timezone';
import { createRequire } from 'node:module';
import { extractMessageContent, downloadMediaMessage } from '@whiskeysockets/baileys';
import { getGroupAdmins, getBuffer, isUrl, reSize } from './lib/myfunc.js';
import './config.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = require('../helper/session.js');
const F = require('../helper/function.js');

// ── per-session paths / settings ─────────────────────────────
const sessWa  = () => S.currentWaNum();
const sessCfg = () => F.getWaSettings(sessWa());
const sessSet = (k, v) => F.setWaSetting(sessWa(), k, v);
const dbFile  = (name) => S.sessionFile(name, sessWa());
const readJson = (file, fallback = {}) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const getAntiDeleteStatus = () => sessCfg().antidelete === true;
const setAntiDeleteStatus = (v) => { sessSet('antidelete', !!v); return !!v; };
const ownerList = () => {
    const v = sessCfg().owners;
    return Array.isArray(v) ? v : [];
};
const flagOf = (file, key) => {
    const v = readJson(dbFile(file), {})[key];
    if (v === undefined || v === null) return false;
    return typeof v === 'object' ? v.enabled !== false : !!v;
};
const now = () => Date.now();

function normalizeJid(jid) {
    if (!jid) return ''
    return String(jid).trim().replace(/:\d+(?=@)/, '')
}

function normalizePnJid(jid) {
    const value = normalizeJid(jid)
    if (!value) return ''
    if (value.endsWith('@s.whatsapp.net') || value.endsWith('@hosted')) return value
    if (/^\d+$/.test(value)) return `${value}@s.whatsapp.net`
    return ''
}

function normalizeLidJid(jid) {
    const value = normalizeJid(jid)
    return value.endsWith('@lid') || value.endsWith('@hosted.lid') ? value : ''
}

function storeLidMapping(lid, pn) {
    const lidJid = normalizeLidJid(lid) || normalizeLidJid(pn)
    const pnJid = normalizePnJid(lid) || normalizePnJid(pn)
    if (lidJid && pnJid) lidToPnCache.set(lidJid, pnJid)
}

function getMappedPn(lid) {
    const lidJid = normalizeLidJid(lid)
    return lidJid ? lidToPnCache.get(lidJid) : undefined
}


async function resolveStatusTarget(EliteProTech, mek) {
    const key = mek?.key || {}
    const candidates = [
        key.participantPn,
        mek?.participantPn,
        key.participantAlt,
        key.remoteJidAlt,
        key.participant,
        mek?.participant,
        mek?.sender
    ].filter(Boolean).map(jid => EliteProTech.decodeJid?.(jid) || jid)

    for (const jid of candidates) {
        const phoneJid = normalizePnJid(jid)
        if (phoneJid) return phoneJid
    }

    for (const jid of candidates) {
        const lidJid = normalizeLidJid(jid)
        if (!lidJid) continue
        let phoneJid = getMappedPn(lidJid)
        if (!phoneJid) {
            try {
                phoneJid = await EliteProTech.signalRepository?.lidMapping?.getPNForLID?.(lidJid)
            } catch {}
        }
        phoneJid = normalizePnJid(phoneJid)
        if (phoneJid) {
            storeLidMapping(lidJid, phoneJid)
            return phoneJid
        }
    }

    return null
}

async function handleStatusWatcher(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key || mek.key.fromMe) return
        if (mek.key.remoteJid !== 'status@broadcast') return
        if (!sessCfg().autoViewStatus && !sessCfg().autoLikeStatus) return

        const msg = mek.message

        if (msg?.reactionMessage) return
        if (msg?.protocolMessage) return

        const msgId = mek.key.id


        const participantJid = await resolveStatusTarget(EliteProTech, mek)
        if (!participantJid) return
        const ownPn = normalizePnJid(state.creds.me?.id || EliteProTech.user?.id)
        if (ownPn && participantJid === ownPn) return

        const statusKey = {
            ...mek.key,
            remoteJid: 'status@broadcast',
            id: msgId,
            fromMe: false,
            participant: mek.key.participant || participantJid
        }

        if (sessCfg().autoViewStatus) {
            try {
                await EliteProTech.readMessages([statusKey])
            } catch (err) {
                console.error('❌ Status view error:', err.message)
            }
        }

        if (!sessCfg().autoLikeStatus) return

        const emoji = (sessCfg().autolikeEmoji || '💚') || '💚'

        await EliteProTech.sendMessage(
            'status@broadcast',
            {
                react: {
                    text: emoji,
                    key: statusKey
                }
            },
            {
                statusJidList: [participantJid]
            }
        )

        console.log(`✅ Reacted to status from ${participantJid} with ${emoji}`)

    } catch (err) {
        console.error('❌ Status handler error:', err.message)
    }
}
//ANTISTATUS GROUP WATCHER//
async function handleAntiStatus(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key) return

        const from = mek.key.remoteJid
        if (!from || !from.endsWith('@g.us')) return

        const sender = mek.key.participant || from

        if (!mek.message?.groupStatusMentionMessage) return

        let data = {}
        try {
            data = JSON.parse(fs.readFileSync(dbFile('antistatus.json'), 'utf8'))
        } catch {}

        if (!data[from]?.enabled) return

        const metadata = await EliteProTech.groupMetadata(from)
        const admins = metadata.participants
            .filter(v => v.admin !== null)
            .map(v => v.id)

        if (mek.key.fromMe || admins.includes(sender)) return

        const mode = data[from].mode || 'warn'
        const limit = data[from].limit || 3

        if (!data[from].users) data[from].users = {}
        if (!data[from].users[sender]) data[from].users[sender] = 0

        data[from].users[sender] += 1

        await EliteProTech.sendMessage(from, { delete: mek.key })

        if (mode === 'delete') {
            await EliteProTech.sendMessage(from, {
                text: `⚠️ @${sender.split('@')[0]} status mention not allowed.`,
                mentions: [sender]
            }, { quoted: mek })
        }

        if (mode === 'warn') {
            const count = data[from].users[sender]

            await EliteProTech.sendMessage(from, {
                text: `⚠️ Warning ${count}/${limit} @${sender.split('@')[0]}`,
                mentions: [sender]
            }, { quoted: mek })
        }

        if (mode === 'warnkick') {
            const count = data[from].users[sender]

            if (count >= limit) {
                await EliteProTech.groupParticipantsUpdate(from, [sender], 'remove')

                await EliteProTech.sendMessage(from, {
                    text: `🚫 @${sender.split('@')[0]} removed (limit ${limit}).`,
                    mentions: [sender]
                }, { quoted: mek })

                data[from].users[sender] = 0
            } else {
                await EliteProTech.sendMessage(from, {
                    text: `⚠️ Warning ${count}/${limit}`,
                    mentions: [sender]
                }, { quoted: mek })
            }
        }

        if (mode === 'kick') {
            await EliteProTech.groupParticipantsUpdate(from, [sender], 'remove')

            await EliteProTech.sendMessage(from, {
                text: `🚫 @${sender.split('@')[0]} removed for status mention.`,
                mentions: [sender]
            }, { quoted: mek })
        }

        fs.writeFileSync(dbFile('antistatus.json'), JSON.stringify(data, null, 2))

    } catch (err) {
        console.error('AntiStatus Error:', err.message)
    }
}
// AUTOREACT MESSAGE
const emojiCache = new Map()   // waNum -> { mtime, list }
const reactedMessages = new Map()
const REACTION_DEDUPE_TTL = 30 * 60 * 1000

function hasReactedToMessage(key) {
    if (!key?.id) return false
    const id = `${key.remoteJid || ''}:${key.id}`
    const timestamp = reactedMessages.get(id)
    if (!timestamp) return false
    if (Date.now() - timestamp > REACTION_DEDUPE_TTL) {
        reactedMessages.delete(id)
        return false
    }
    return true
}

function markMessageReacted(key) {
    if (!key?.id) return
    reactedMessages.set(`${key.remoteJid || ''}:${key.id}`, Date.now())
}

function emojisForSession() {
    const wa = sessWa()
    const file = dbFile('autoreact.json')
    let mtime = 0
    try { mtime = fs.statSync(file).mtimeMs } catch { return [] }
    const hit = emojiCache.get(wa)
    if (hit && hit.mtime === mtime) return hit.list
    let list = []
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) list = parsed
    } catch (err) {
        console.error('Failed to load autoreact emojis:', err.message)
    }
    emojiCache.set(wa, { mtime, list })
    return list
}

async function handleAutoReact(EliteProTech, mek) {
    try {
        if (!mek?.key || mek.key.fromMe || !mek.key.remoteJid) return
        const emojis = emojisForSession()
        if (!sessCfg().autoreact || emojis.length < 1) return

        const jid = mek.key.remoteJid
        if (jid === 'status@broadcast') return
        if (hasReactedToMessage(mek.key)) return
        markMessageReacted(mek.key)

        const chatType = jid.endsWith('@g.us') ? 'Group' : 'DM'
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)]

        await EliteProTech.sendMessage(jid, {
            react: {
                text: randomEmoji,
                key: mek.key
            }
        })

        console.log(`✅ Auto-reacted in ${chatType} (${jid}) with ${randomEmoji}`)

    } catch (err) {
        console.error('❌ Auto-react error:', err.message)
    }
}
//CHATBOT CODES//
async function handleChatbot(EliteProTech,mek){
    try{
        if(!mek?.message||!mek?.key||mek.key.fromMe)return
        const from=mek.key.remoteJid
        if(!from||from==='status@broadcast')return
        let chatbotData={global:false,dm:false,group:false,chats:{}}
        try{
            const data=fs.readFileSync(dbFile('chatbot.json'),'utf8')
            chatbotData=JSON.parse(data)
        }catch{
            return
        }
        const isGroup=from.endsWith('@g.us')
        const isDM=from.endsWith('@s.whatsapp.net')
        const chatEnabled=chatbotData.chats?.[from]===true
        const typeEnabled=isGroup?chatbotData.group===true:chatbotData.dm===true
        if(!chatbotData.global&&!typeEnabled&&!chatEnabled)return
        const text=mek.message.conversation||mek.message.extendedTextMessage?.text||mek.message.imageMessage?.caption||mek.message.videoMessage?.caption||''
        if(!text.trim())return
        const prefix=(sessCfg().prefix || '.')||'.'
        if(text.trim().startsWith(prefix))return
        const sender=mek.key.participant||from
        EliteProTech.__userChats = EliteProTech.__userChats || {}
        EliteProTech.__userChatTs = EliteProTech.__userChatTs || {}
        EliteProTech.__userChats[sender]=EliteProTech.__userChats[sender]||[]
        EliteProTech.__userChatTs[sender]=Date.now()
        EliteProTech.__userChats[sender].push(`User: ${text}`)
        if(EliteProTech.__userChats[sender].length>15)EliteProTech.__userChats[sender].shift()
        const history=EliteProTech.__userChats[sender].join('\n').slice(-3000)
        const basePrompt=`
You're ElitePro, an intelligent assistant developed by Chinedu (cyrilix-xmd). Respond clearly and naturally. Do not ask, "How can I assist you?"

Owner: Chinedu-md
WhatsApp: https://wa.me/2347047504860
Telegram: https://t.me/eliteprotechs
Website: https://eliteprotech.zone.id/
YouTube: https://www.youtube.com/@eliteprotechs
GitHub: https://eliteproverified.vercel.app/

Services Guide:
- If someone requests a song, reply: ".play [song name]".
- If someone requests a video, reply: ".video [video name]".
- If someone requests an image, reply: ".img [image name]".
- If someone requests menu, reply: ".menu".
- If someone requests a song, reply: ".song [song name]".

Conversation History:
${history}
        `.trim()
        await EliteProTech.sendPresenceUpdate('composing',from)
        await new Promise(resolve=>setTimeout(resolve,1000))
        const apiUrl=`https://eliteprotech-apis.zone.id/ai/talkai?q=${encodeURIComponent(text)}`
        const response=await axios.get(apiUrl,{headers:{Accept:'*/*','User-Agent':'Mozilla/5.0'},timeout:30000})
        const botReply=response?.data?.success&&response?.data?.response?response.data.response:'I couldn’t generate a reply at this time. Please try again.'
        await EliteProTech.sendPresenceUpdate('paused',from)
        EliteProTech.__userChats[sender].push(`Bot: ${botReply}`)
        if(EliteProTech.__userChats[sender].length>15)EliteProTech.__userChats[sender].shift()
        await EliteProTech.sendMessage(from,{text:botReply},{quoted:mek})
    }catch(err){
        console.error('❌ Chatbot Error:',err.message)
        try{
            const from=mek?.key?.remoteJid
            if(from)await EliteProTech.sendMessage(from,{text:'❌ An error occurred while processing your message.'},{quoted:mek})
        }catch(fallbackErr){
            console.error('❌ Failed to send error message:',fallbackErr.message)
        }
    }
}
export function startChatCleanup(EliteProTech) {
    if (EliteProTech.__chatCleanup) return
    EliteProTech.__chatCleanup = setInterval(() => {
        if (!EliteProTech.__userChatTs || !EliteProTech.__userChats) return
        const now = Date.now()
        for (const user in EliteProTech.__userChatTs) {
            if (now - EliteProTech.__userChatTs[user] > 30 * 60 * 1000) {
                delete EliteProTech.__userChats[user]
                delete EliteProTech.__userChatTs[user]
            }
        }
    }, 10 * 60 * 1000)
    EliteProTech.__chatCleanup.unref?.()
}
//ANTILINK DETECT//
async function handleAntiLink(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key) return
        if (mek.message.protocolMessage) return
        const from = mek.key.remoteJid
        if (!from || !from.endsWith('@g.us')) return
        const sender = mek.key.participant || from
        const text =
            mek.message.conversation ||
            mek.message.extendedTextMessage?.text ||
            mek.message.imageMessage?.caption ||
            mek.message.videoMessage?.caption ||
            mek.message.documentMessage?.caption ||
            ''
        if (!isUrl(text)) return
        let antilinkData = {}
        try {
            antilinkData = JSON.parse(
                fs.readFileSync(dbFile('antilink.json'), 'utf8')
            )
        } catch (err) {
            console.error('Error loading antilink.json:', err.message)
            return
        }
        if (!antilinkData[from]?.enabled) return
        const actionType = antilinkData[from].action || 'warn'
        const warnings = antilinkData[from].warnings || {}
        const groupMetadata = await EliteProTech.groupMetadata(from)
        const admins = groupMetadata.participants
            .filter(v => v.admin !== null)
            .map(v => v.id)
        const botJid =
            EliteProTech.user.id.split(':')[0] + '@s.whatsapp.net'
        const botParticipant = groupMetadata.participants.find(
            p => p.jid === botJid
        )
        const isBotMessage = mek.key.fromMe
        const isAdmin = admins.includes(sender)
        const isOwner = ownerList().some(num =>
            sender === num || sender === num + '@s.whatsapp.net'
        )
        const isBotAdmin = botParticipant?.admin !== null
        if (isBotMessage || isAdmin || isOwner) return
        console.log(`🔗 Link detected from ${sender}: ${text}`)
        if (!isBotAdmin) return
        if (actionType === 'delete') {
            await EliteProTech.sendMessage(from, {
                delete: mek.key
            })
            await EliteProTech.sendMessage(
                from,
                {
                    text: `⚠️ @${sender.split('@')[0]} links are not allowed in this group.`,
                    mentions: [sender]
                },
                { quoted: mek }
            )
        }
        else if (actionType === 'kick') {
            await EliteProTech.sendMessage(from, {
                delete: mek.key
            })
            await EliteProTech.sendMessage(
                from,
                {
                    text: `🚫 @${sender.split('@')[0]} has been removed for sending links.`,
                    mentions: [sender]
                },
                { quoted: mek }
            )
            await EliteProTech.groupParticipantsUpdate(
                from,
                [sender],
                'remove'
            )
        }
        else if (actionType === 'warn') {
            warnings[sender] = (warnings[sender] || 0) + 1
            antilinkData[from].warnings = warnings
            fs.writeFileSync(
                dbFile('antilink.json'),
                JSON.stringify(antilinkData, null, 2)
            )
            const warnCount = warnings[sender]
            await EliteProTech.sendMessage(from, {
                delete: mek.key
            })
            await EliteProTech.sendMessage(
                from,
                {
                    text: `⚠️ @${sender.split('@')[0]} links are not allowed.\nWarning ${warnCount}/4`,
                    mentions: [sender]
                },
                { quoted: mek }
            )
            if (warnCount >= 4) {
                await EliteProTech.groupParticipantsUpdate(
                    from,
                    [sender],
                    'remove'
                )
                await EliteProTech.sendMessage(
                    from,
                    {
                        text: `🚫 @${sender.split('@')[0]} has been removed.\nLimit exceeded (4/4).`,
                        mentions: [sender]
                    },
                    { quoted: mek }
                )
                delete warnings[sender]
                antilinkData[from].warnings = warnings
                fs.writeFileSync(
                    dbFile('antilink.json'),
                    JSON.stringify(antilinkData, null, 2)
                )
            }
        }
    } catch (err) {
        console.error('❌ Error in anti-link detection:', err.message)
    }
}	
//ANTISPAM//
const spamTracker = new Map()
const spamSeen = new Set()
async function handleAntiSpam(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key || mek.key.fromMe) return
        const from = mek.key.remoteJid
        if (!from?.endsWith('@g.us')) return
        if (mek.message.protocolMessage || mek.message.reactionMessage) return

        if (spamSeen.has(mek.key.id)) return
        spamSeen.add(mek.key.id)
        setTimeout(() => spamSeen.delete(mek.key.id), 60000)

        let data = {}
        try { data = JSON.parse(fs.readFileSync(dbFile('antispam.json'), 'utf8')) } catch { return }
        const cfg = data[from]
        if (!cfg?.enabled) return
                const sender = mek.key.participant || mek.participant
        if (!sender) return

        const limit = cfg.limit || 5
        const windowMs = (cfg.seconds || 8) * 1000
        const now = Date.now()
        const trackKey = `${from}:${sender}`

        const list = (spamTracker.get(trackKey) || []).filter(e => now - e.ts < windowMs)
        list.push({ ts: now, key: mek.key })
        spamTracker.set(trackKey, list)
        if (list.length <= limit) return

        // Over the limit: only now do the (cached) metadata checks
        const metadata = await EliteProTech.groupMetadata(from)
        const participants = metadata.participants || []
        const matches = (p, id) => id && (p.id === id || p.lid === id || p.jid === id || p.phoneNumber === id)

        const senderP = participants.find(p => matches(p, sender))
        const botIds = [EliteProTech.user?.id, EliteProTech.user?.lid]
            .filter(Boolean).map(i => i.replace(/:\d+/, ''))
        const botP = participants.find(p => botIds.some(b => matches(p, b)))

        const senderNums = [sender, senderP?.jid, senderP?.phoneNumber, senderP?.pn]
            .filter(Boolean).map(x => x.split('@')[0])
        const isOwner = ownerList().some(n => senderNums.includes(String(n).replace(/[^0-9]/g, '')))

        if (senderP?.admin || isOwner || botIds.some(b => sender === b)) {
            spamTracker.delete(trackKey)
            return
        }
        if (!botP?.admin) return
        const keys = list.map(e => e.key)
        spamTracker.delete(trackKey) // reset so the next burst is judged fresh

        for (const k of keys) {
            await EliteProTech.sendMessage(from, { delete: k }).catch(() => {})
            await new Promise(r => setTimeout(r, 300))
        }

        const tag = `@${sender.split('@')[0]}`
        const removeId = senderP?.id || sender
        const mode = cfg.action || 'warn'

        if (mode === 'delete') {
            await EliteProTech.sendMessage(from, {
                text: `🚫 ${tag} stop spamming. Messages deleted.`,
                mentions: [sender]
            })
        } else if (mode === 'kick') {
            await EliteProTech.groupParticipantsUpdate(from, [removeId], 'remove')
            await EliteProTech.sendMessage(from, {
                text: `🚫 ${tag} was removed for spamming.`,
                mentions: [sender]
            })
        } else {
            cfg.warnings = cfg.warnings || {}
            cfg.warnings[sender] = (cfg.warnings[sender] || 0) + 1
            const count = cfg.warnings[sender]
            const max = cfg.maxWarn || 3

            if (count >= max) {
                await EliteProTech.groupParticipantsUpdate(from, [removeId], 'remove')
                await EliteProTech.sendMessage(from, {
                    text: `🚫 ${tag} was removed for spamming (${max}/${max} warnings).`,
                    mentions: [sender]
                })
                delete cfg.warnings[sender]
            } else {
                await EliteProTech.sendMessage(from, {
                    text: `⚠️ ${tag} stop spamming. Warning ${count}/${max}`,
                    mentions: [sender]
                })
            }
            fs.writeFileSync(dbFile('antispam.json'), JSON.stringify(data, null, 2))
        }
    } catch (err) {
        console.error('❌ AntiSpam error:', err.message)
    }
}
setInterval(() => {
    const now = Date.now()
    for (const [k, list] of spamTracker) {
        if (!list.length || now - list[list.length - 1].ts > 60000) spamTracker.delete(k)
    }
}, 5 * 60 * 1000)
////AntiSpam ends here///
	
//ANTIBOT//
const botSeen = new Set()
const botWarnCooldown = new Set()
const BOT_PREFIX_CHARS = ',*@/?!>.&√#$%+~_=|\\:;^-'
const PREFIX_CMD_REGEX = new RegExp(`^[${BOT_PREFIX_CHARS.replace(/[\]\\^-]/g, '\\$&')}]+[a-zA-Z]{2,}`)

const looksLikeBotId = (key) => {
    const id = key?.id || ''
    const sender = key?.participant || ''
    return /^BAE5.{12}$/.test(id) ||
           /^3EB0[0-9A-F]{36}$/i.test(id) ||
           sender.endsWith('@bot')
}

const getPlainText = (message) => {
    const c = extractMessageContent(message) || message || {}
    return (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption ||
            c.videoMessage?.caption || c.documentMessage?.caption || '').trim()
}

const looksLikePrefixCommand = (text) => {
    if (!text) return false
    const own = (sessCfg().prefix || '.')
    if (own && text.startsWith(own)) return false          // never touch our own bot's commands
    if (!PREFIX_CMD_REGEX.test(text)) return false
    if (text.startsWith('*') && text.indexOf('*', 1) > 0) return false   // *bold text*
    return true
}

async function handleAntiBot(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key || mek.key.fromMe) return
        const from = mek.key.remoteJid
        if (!from?.endsWith('@g.us')) return
        if (mek.message.protocolMessage || mek.message.reactionMessage) return

        const byId = looksLikeBotId(mek.key)
        const text = getPlainText(mek.message)
        const byPrefix = looksLikePrefixCommand(text)
        if (!byId && !byPrefix) return

        if (botSeen.has(mek.key.id)) return
        botSeen.add(mek.key.id)
        setTimeout(() => botSeen.delete(mek.key.id), 60000)

        let data = {}
        try { data = JSON.parse(fs.readFileSync(dbFile('antibot.json'), 'utf8')) } catch { return }
        const cfg = data[from]
        if (!cfg?.enabled) return
        if (!byId && !cfg.prefix) return   // prefix rule is off

        const sender = mek.key.participant || mek.participant
        if (!sender) return
        const metadata = await EliteProTech.groupMetadata(from)
        const participants = metadata.participants || []
        const matches = (p, id) => id && (p.id === id || p.lid === id || p.jid === id || p.phoneNumber === id)

        const senderP = participants.find(p => matches(p, sender))
        const botIds = [EliteProTech.user?.id, EliteProTech.user?.lid]
            .filter(Boolean).map(i => i.replace(/:\d+/, ''))
        const botP = participants.find(p => botIds.some(b => matches(p, b)))

        const senderNums = [sender, senderP?.jid, senderP?.phoneNumber, senderP?.pn]
            .filter(Boolean).map(x => x.split('@')[0])
        const isOwner = ownerList().some(n => senderNums.includes(String(n).replace(/[^0-9]/g, '')))

        if (senderP?.admin || isOwner || botIds.some(b => sender === b)) return
        if (!botP?.admin) return

        await EliteProTech.sendMessage(from, { delete: mek.key })
            .then(() => console.log('[antibot] deleted message'))
            .catch(e => console.log('[antibot] delete failed:', e.message))

        const tag = `@${sender.split('@')[0]}`
        const removeId = senderP?.id || sender
        let mode = cfg.action || 'delete'
        if (!byId && mode === 'kick') mode = 'warn'   // never kick a human just for typing a prefix

        if (mode === 'delete') return

        if (mode === 'kick') {
            await EliteProTech.groupParticipantsUpdate(from, [removeId], 'remove')
            await EliteProTech.sendMessage(from, {
                text: `🤖 ${tag} was removed. Bots are not allowed in this group.`,
                mentions: [sender]
            })
            return
        }

        const cdKey = `${from}:${sender}`
        if (botWarnCooldown.has(cdKey)) return
        botWarnCooldown.add(cdKey)
        setTimeout(() => botWarnCooldown.delete(cdKey), 10000)

        cfg.warnings = cfg.warnings || {}
        cfg.warnings[sender] = (cfg.warnings[sender] || 0) + 1
        const count = cfg.warnings[sender]
        const max = cfg.maxWarn || 3
        const reason = byId ? 'bots are not allowed in this group' : 'other bot commands are not allowed in this group'

        if (count >= max) {
            await EliteProTech.groupParticipantsUpdate(from, [removeId], 'remove')
            await EliteProTech.sendMessage(from, {
                text: `🚫 ${tag} was removed (${max}/${max} warnings).`,
                mentions: [sender]
            })
            delete cfg.warnings[sender]
        } else {
            await EliteProTech.sendMessage(from, {
                text: `⚠️ ${tag} ${reason}. Warning ${count}/${max}`,
                mentions: [sender]
            })
        }
        fs.writeFileSync(dbFile('antibot.json'), JSON.stringify(data, null, 2))
    } catch (err) {
        console.error('❌ AntiBot error:', err.message)
    }
}
///Antibot ends here////
	
//CHANNEL AUTOREACT//
const CHANNEL_ID = "120363287352245413@newsletter"
async function handleChannelReact(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key) return

        const from = mek.key.remoteJid
        const serverId = mek.key.server_id

        if (from !== CHANNEL_ID) return
        if (!serverId) return

        const emojis = [
            "❤️", "💛", "👍", "💜", "😮", "🤍", "💙", "🔥", "💯", "⚡"
        ]

        const emoji = emojis[Math.floor(Math.random() * emojis.length)]

        await EliteProTech.newsletterReactMessage(
            from,
            serverId.toString(),
            emoji
        )

    } catch (err) {
        console.log("Channel React Error:", err.message)
    }
}
//ANTIDELETE CODES//
const settingsFile = path.join(__dirname, 'database', 'settings.json')

function getRestorableText(content) {
    const candidates = [
        content?.conversation,
        content?.extendedTextMessage?.text,
        content?.imageMessage?.caption,
        content?.videoMessage?.caption,
        content?.ptvMessage?.caption,
        content?.documentMessage?.caption,
        content?.audioMessage?.caption,
        content?.buttonsResponseMessage?.selectedDisplayText,
        content?.buttonsResponseMessage?.selectedButtonId,
        content?.listResponseMessage?.singleSelectReply?.selectedRowId,
        content?.templateButtonReplyMessage?.selectedDisplayText,
        content?.templateButtonReplyMessage?.selectedId,
        content?.interactiveResponseMessage?.body?.text,
        content?.messageContextInfo?.selectedButtonId,
        content?.messageContextInfo?.selectedRowId
    ]
    const text = candidates.find(value => typeof value === 'string' && value.trim())
    if (text) return text

    // Some Baileys wrappers (or cached legacy messages) nest the payload more deeply.
    const seen = new WeakSet()
    const findNestedText = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || depth > 5 || seen.has(value)) return ''
        seen.add(value)
        for (const key of ['conversation', 'text', 'caption', 'contentText', 'selectedDisplayText', 'selectedButtonId', 'selectedId']) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key]
        }
        for (const child of Object.values(value)) {
            const nested = findNestedText(child, depth + 1)
            if (nested) return nested
        }
        return ''
    }
    return findNestedText(content)
}

async function restoreMessage(EliteProTech, from, note, msg, quoted, mentions) {
    try {
        const rawContent = msg?.message && typeof msg.message === 'object' ? msg.message : msg
        const contentMessage = extractMessageContent(rawContent) || rawContent
        const sendNote = async () =>
            EliteProTech.sendMessage(from, { text: note, mentions }, { quoted })

        const mediaTypes = [
            ['imageMessage', 'image'],
            ['videoMessage', 'video'],
            ['ptvMessage', 'video'],
            ['audioMessage', 'audio'],
            ['stickerMessage', 'sticker'],
            ['documentMessage', 'document']
        ]
        const mediaEntry = mediaTypes.find(([messageType]) => contentMessage[messageType])
        if (mediaEntry) {
            const [messageType, contentType] = mediaEntry
            const mediaDetails = contentMessage[messageType]
            const downloadableMessage = { ...quoted, message: contentMessage }
            const downloadOptions = {
                reuploadRequest: EliteProTech.updateMediaMessage.bind(EliteProTech),
                logger: mediaDownloadLogger
            }
            let media
            try {
                media = await downloadMediaMessage(downloadableMessage, 'buffer', {}, downloadOptions)
            } catch (error) {
                const status = Number(error?.status ?? error?.statusCode ?? error?.output?.statusCode)
                if (![404, 410].includes(status)) throw error
                const refreshedMessage = await EliteProTech.updateMediaMessage(downloadableMessage)
                media = await downloadMediaMessage(refreshedMessage, 'buffer', {}, downloadOptions)
            }
            const content = { [contentType]: media }
            if (contentType === 'image' || contentType === 'video') {
                if (mediaDetails.caption) content.caption = mediaDetails.caption
                if (mediaDetails.mimetype) content.mimetype = mediaDetails.mimetype
                if (mediaDetails.gifPlayback) content.gifPlayback = true
            }
            if (messageType === 'audioMessage') {
                content.ptt = mediaDetails.ptt
                content.mimetype = mediaDetails.mimetype || 'audio/mpeg'
            } else if (messageType === 'documentMessage') {
                content.fileName = mediaDetails.fileName || 'restored.file'
                content.mimetype = mediaDetails.mimetype || 'application/octet-stream'
                if (mediaDetails.caption) content.caption = mediaDetails.caption
            }
            await EliteProTech.sendMessage(from, content, { quoted })
            return sendNote()
        }

        const text = getRestorableText(contentMessage)
        if (text) {
            return EliteProTech.sendMessage(
                from,
                { text: `${note}\n♻️ *Message:* \`\`\`${text}\`\`\``, mentions },
                { quoted }
            )
        }

        return EliteProTech.sendMessage(
            from,
            {
                text: `${note}\n❌ *Cannot restore this message type.*`,
                mentions
            },
            { quoted }
        )
    } catch (err) {
        console.error('❌ Restore error:', err.message)
    }
}

async function getChatName(EliteProTech, jid, fallback = jid) {
    try {
        if (jid.endsWith('@g.us')) {
            const meta = await EliteProTech.groupMetadata(jid)
            return meta.subject || fallback
        }

        let phoneJid = getMappedPn(jid)
        if (!phoneJid && normalizeLidJid(jid)) {
            try {
                phoneJid = await EliteProTech.signalRepository?.lidMapping?.getPNForLID?.(jid) || ''
                if (phoneJid) storeLidMapping(jid, phoneJid)
            } catch {}
        }
        const contact = EliteProTech.contacts?.[phoneJid] || EliteProTech.contacts?.[jid] || {}
        return contact.name || contact.verifiedName || contact.notify || phoneJid?.split('@')[0] || fallback
    } catch {
        return fallback
    }
}

const handledDeletes = new Map()
const HANDLED_DELETE_TTL = 10 * 60 * 1000
const HANDLED_DELETE_LIMIT = 5000

async function handleAntiDeleteEvent(EliteProTech, targetKey, actorKey = {}) {
    if (!getAntiDeleteStatus()) return
    const remoteJid = targetKey?.remoteJid
    const msgId = targetKey?.id
    if (!remoteJid || !msgId) return

    // A single revoke can be reported with different LID/PN chat perspectives.
    // Baileys message IDs are unique, so dedupe by target ID across those events.
    const deleteKey = msgId
    const now = Date.now()
    const handledAt = handledDeletes.get(deleteKey)
    if (handledAt && now - handledAt < HANDLED_DELETE_TTL) return
    handledDeletes.set(deleteKey, now)
    while (handledDeletes.size > HANDLED_DELETE_LIMIT) {
        handledDeletes.delete(handledDeletes.keys().next().value)
    }

    const old = null
    if (!old?.message) {
        return
    }
    if (old.key?.fromMe) return

    const deletedByRaw = actorKey.participantPn || actorKey.participantAlt || actorKey.participant ||
        actorKey.senderPn || actorKey.senderLid || actorKey.remoteJid
    const sentByRaw = old.key?.participantPn || old.key?.participantAlt || old.key?.participant ||
        old.key?.senderPn || old.key?.senderLid || old.key?.remoteJid
    const resolveIdentity = async jid => {
        if (!jid) return ''
        const cached = getMappedPn(jid)
        if (cached) return cached
        if (normalizeLidJid(jid)) {
            try {
                const pn = await EliteProTech.signalRepository?.lidMapping?.getPNForLID?.(jid)
                if (pn) {
                    storeLidMapping(jid, pn)
                    return pn
                }
            } catch {}
        }
        return jid
    }
    const [deletedBy, sentBy] = await Promise.all([
        resolveIdentity(deletedByRaw),
        resolveIdentity(sentByRaw)
    ])
    const whoDeleted = `@${String(deletedBy || '').split('@')[0].split(':')[0]}`
    const whoSent = `@${String(sentBy || '').split('@')[0].split(':')[0]}`
    const from = EliteProTech.decodeJid(EliteProTech.user?.id || '')
    if (!from) return
    const originalChat = old.key?.remoteJid || remoteJid
    const chatName = await getChatName(EliteProTech, originalChat)
    const note = `╭━━[ *× ANTI DELETE MESSAGES ×* ]━┉
┣━ *Deleted:* ${whoDeleted}
┣━
┣━ *Sender:* ${whoSent}
┣━
┣━ *Chat:* ${chatName}
╰━━━━━━━━━━━━━━━━━━━━┉`

    await restoreMessage(
        EliteProTech,
        from,
        note,
        old.message,
        { key: old.key, message: old.message },
        [deletedBy, sentBy].filter(jid => jid?.includes('@'))
    )
}




// ════════════════════════════════════════════════════════════
//   ANTI-CALL  (per session: database/sessions/<num>/anticall.json)
// ════════════════════════════════════════════════════════════
export async function handleCall(EliteProTech, callEvents) {
    let anticallData = { enabled: false, mode: 'decline' };
    try { anticallData = JSON.parse(fs.readFileSync(dbFile('anticall.json'), 'utf8')); } catch {}
    if (!anticallData || anticallData.enabled !== true) return;
    if (!Array.isArray(callEvents)) callEvents = [callEvents];

    for (const call of callEvents) {
        try {
            if (call.status !== 'offer') continue;
            const callerId = call.from;
            await EliteProTech.rejectCall(call.id, callerId);
            if (anticallData.mode === 'block') {
                await EliteProTech.sendMessage(callerId, {
                    text: '⛔ Calls are strictly forbidden.\nYou have been *blocked* for calling the bot.',
                });
                await EliteProTech.updateBlockStatus(callerId, 'block').catch(() => {});
            } else {
                await EliteProTech.sendMessage(callerId, {
                    text: '🚫 Calls are not allowed.\nYour call was auto-declined.',
                });
            }
        } catch (err) {
            console.error('[ANTICALL]', err.message);
        }
    }
}

export {
    handleStatusWatcher,
    handleAntiStatus,
    handleAntiLink,
    handleAntiSpam,
    handleAntiBot,
    handleAutoReact,
    handleChatbot,
    handleChannelReact,
    handleAntiDeleteEvent,
    getAntiDeleteStatus,
    setAntiDeleteStatus,
};
