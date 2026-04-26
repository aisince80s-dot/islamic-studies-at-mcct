import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import Anthropic from '@anthropic-ai/sdk'

const execFileAsync = promisify(execFile)

const CHANNEL_ID = process.env.YT_CHANNEL_ID || 'UCt-XeQTVRSETC9DceeC6nMw'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY env var')
  process.exit(1)
}

const inPath = process.env.IN_PATH || path.join(process.cwd(), 'public', 'videos.json')
const outPath = process.env.OUT_PATH || inPath
const maxVideos = Number(process.env.MAX_VIDEOS || '40')

const topicsAllowed = [
  'Quran',
  'Tafsir',
  'Hadith',
  'Riyadh as-Salihin',
  'Al-Wajeez',
  'Fiqh',
  'Aqeedah',
  'Seerah',
  'Other'
]

function classifyTopicsFallback(text){
  const t = (text || '').toLowerCase()
  const topics = new Set()

  if (/(qur\b|quran|surah|sura|tafsir)/.test(t)) { topics.add('Quran'); topics.add('Tafsir') }
  if (/(hadith|ḥadīth|حديث)/.test(t)) topics.add('Hadith')
  if (/(riyadh|riyaad|saliheen|salihin|صالحين)/.test(t)) { topics.add('Hadith'); topics.add('Riyadh as-Salihin') }
  if (/(al\s*wajeez|al\s*wajiz|wajeez|wajiz)/.test(t)) { topics.add('Fiqh'); topics.add('Al-Wajeez') }
  if (/(fiqh|فقه)/.test(t)) topics.add('Fiqh')
  if (/(aqeed|aqid|\bcreed\b|عقيدة)/.test(t)) topics.add('Aqeedah')
  if (/(seerah|sira|سيرة|prophet)/.test(t)) topics.add('Seerah')

  // keep only allowed
  const cleaned = [...topics].filter(x => topicsAllowed.includes(x))
  if (cleaned.length === 0) return ['Other']
  return cleaned.slice(0, 3)
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

function vttToText(vtt){
  // Minimal VTT-to-text: drop timestamps/cues, keep text lines.
  const lines = vtt.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    if (s === 'WEBVTT') continue
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(s)) continue
    if (/^NOTE\b/.test(s)) continue
    if (/^STYLE\b/.test(s)) continue
    if (/^REGION\b/.test(s)) continue
    // remove tags like <c> ... </c>
    out.push(s.replace(/<[^>]+>/g, ''))
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function getTranscriptText(videoId){
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-sub-'))
  const url = `https://www.youtube.com/watch?v=${videoId}`

  // Try English first, then any auto subs.
  const args = [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-format', 'vtt',
    '--sub-lang', 'en,en-orig',
    '-o', path.join(tmp, '%(id)s.%(ext)s'),
    url
  ]

  try {
    await execFileAsync('yt-dlp', args, { timeout: 120000 })
  } catch (e) {
    // yt-dlp sometimes returns non-zero even when it writes files; continue to scan dir
  }

  const files = await fs.readdir(tmp)
  const vttFiles = files.filter(f => f.startsWith(videoId) && f.endsWith('.vtt'))
  if (vttFiles.length === 0) {
    throw new Error('Transcript unavailable (yt-dlp)')
  }

  // Prefer English if present
  const preferred =
    vttFiles.find(f => f.includes('.en-orig.')) ||
    vttFiles.find(f => f.includes('.en.')) ||
    vttFiles[0]
  const vtt = await fs.readFile(path.join(tmp, preferred), 'utf8')
  const text = vttToText(vtt)
  if (!text) throw new Error('Transcript empty (yt-dlp)')
  return text
}

function truncate(s, n){
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

async function summarizeAndTag({ transcript, ytTitle, ytDescription }){
  const prompt = `You are helping build a webpage called "Islamic Studies at MCCT".

Given a YouTube lecture transcript (auto-generated, may be messy), produce:
1) aiTitle: a short, clear, human-friendly title (max ~80 chars)
2) topics: 1-3 tags chosen ONLY from this list: ${topicsAllowed.join(', ')}
3) summary: 1-2 sentence summary.

Rules:
- Use respectful, neutral wording.
- Prefer specific series names when evident (e.g. Riyadh as-Salihin, Al-Wajeez).
- If unsure, choose "Other".
- Output STRICT JSON with keys: aiTitle, topics, summary.

YouTube title: ${ytTitle || ''}
YouTube description: ${truncate(ytDescription || '', 800)}

Transcript:
${truncate(transcript, 12000)}
`

  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
    max_tokens: 500,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }]
  })

  const text = msg.content?.[0]?.text || ''
  // Extract JSON (Claude usually returns exact JSON, but be safe)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON found in model output')
  const jsonText = text.slice(start, end + 1)
  const obj = JSON.parse(jsonText)

  // validate
  if (!obj.aiTitle || typeof obj.aiTitle !== 'string') throw new Error('Invalid aiTitle')
  if (!Array.isArray(obj.topics)) throw new Error('Invalid topics')
  obj.topics = obj.topics.filter(t => topicsAllowed.includes(t))
  if (obj.topics.length === 0) obj.topics = ['Other']
  if (obj.topics.length > 3) obj.topics = obj.topics.slice(0,3)
  if (!obj.summary || typeof obj.summary !== 'string') obj.summary = ''
  return obj
}

async function main(){
  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'))
  const items = raw.items || []

  // Enrich newest first, only those missing aiTitle/topics.
  const targets = items
    .filter(v => v?.id)
    .sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt))
    .filter(v => !(v.aiTitle && Array.isArray(v.topics) && v.topics.length))
    .slice(0, maxVideos)

  console.log(`Loaded ${items.length} videos. Enriching ${targets.length}…`)

  for (const v of targets) {
    const id = v.id
    try {
      console.log(`Transcript ${id}…`)
      const transcript = await getTranscriptText(id)
      if (!transcript || transcript.length < 200) throw new Error('Transcript too short/unavailable')

      console.log(`Claude summarize ${id}…`)
      const { aiTitle, topics, summary } = await summarizeAndTag({
        transcript,
        ytTitle: v.title,
        ytDescription: v.description || ''
      })

      v.aiTitle = aiTitle
      v.topics = topics
      v.summary = summary
      delete v.enrichError
      v.enrichedAt = new Date().toISOString()
      v.channelId = CHANNEL_ID

      // Gentle pacing to avoid rate limits
      await sleep(Number(process.env.SLEEP_MS || '800'))
    } catch (err) {
      v.enrichError = String(err?.message || err)
      // Fallback: if transcript is unavailable, keep YouTube title and tag from title/description keywords.
      if (!v.aiTitle) v.aiTitle = v.title || 'Untitled'
      if (!Array.isArray(v.topics) || v.topics.length === 0) {
        v.topics = classifyTopicsFallback(`${v.title || ''}\n${v.description || ''}`)
      }
      v.enrichedAt = new Date().toISOString()
      console.warn(`Failed ${id}: ${v.enrichError}`)
      await sleep(400)
    }
  }

  raw.channelId = raw.channelId || CHANNEL_ID
  raw.enrichedAt = new Date().toISOString()

  await fs.writeFile(outPath, JSON.stringify(raw, null, 2))
  console.log(`Wrote enriched data to ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
