import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'

const execFileAsync = promisify(execFile)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY env var')
  process.exit(1)
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

const inPath = process.env.IN_PATH || path.join(process.cwd(), 'public', 'videos.json')
const outPath = process.env.OUT_PATH || inPath

const maxVideos = Number(process.env.MAX_VIDEOS || '200')
// Defaults tuned for Anthropic TPM limits (safer out of the box)
const concurrency = Number(process.env.CONCURRENCY || '1')
const sleepMs = Number(process.env.SLEEP_MS || '1500')
const maxTranscriptChars = Number(process.env.MAX_TRANSCRIPT_CHARS || '6000')

const retry429Max = Number(process.env.RETRY_429_MAX || '3')
const retry429SleepMs = Number(process.env.RETRY_429_SLEEP_MS || '65000')

const ytDlpBin = process.env.YT_DLP_BIN || '/data/linuxbrew/.linuxbrew/bin/yt-dlp'
const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'

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

function truncate(s, n){
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function vttToText(vtt){
  const lines = vtt.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    if (s === 'WEBVTT') continue
    if (/^Kind:/.test(s)) continue
    if (/^Language:/.test(s)) continue
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(s)) continue
    if (/^NOTE\b/.test(s)) continue
    if (/^STYLE\b/.test(s)) continue
    if (/^REGION\b/.test(s)) continue
    out.push(s.replace(/<[^>]+>/g, ''))
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

async function getTranscriptText(videoId){
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-sub-'))
  const url = `https://www.youtube.com/watch?v=${videoId}`

  const args = [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-format', 'vtt',
    '--sub-lang', 'en,en-orig',
    '-o', path.join(tmp, '%(id)s.%(language)s.%(ext)s'),
    url
  ]

  try {
    await execFileAsync(ytDlpBin, args, { timeout: 120000 })
  } catch (_) {
    // continue
  }

  const files = await fs.readdir(tmp)
  const vttFiles = files.filter(f => f.includes(videoId) && f.endsWith('.vtt'))
  if (vttFiles.length === 0) throw new Error('Transcript unavailable (yt-dlp)')

  const preferred =
    vttFiles.find(f => f.includes('.en-orig.')) ||
    vttFiles.find(f => f.includes('.en.')) ||
    vttFiles[0]

  const vtt = await fs.readFile(path.join(tmp, preferred), 'utf8')
  const text = vttToText(vtt)
  if (!text || text.length < 200) throw new Error('Transcript empty/short (yt-dlp)')
  return text
}

function shouldEnrich(v){
  if (!v?.id) return false
  if (v.enrichError) return true
  if (!v.aiTitle) return true
  if (!v.summary) return true
  if (!Array.isArray(v.topics) || v.topics.length === 0) return true
  return false
}

function isRateLimit429(err){
  const msg = String(err?.message || err)
  return msg.includes('rate_limit_error') || msg.includes('429') || (err?.status === 429)
}

async function summarizeAndTag({ transcript, ytTitle, ytDescription }){
  const prompt = `You are helping build a webpage called "Islamic Studies at MCCT".\n\nGiven a YouTube lecture transcript (auto-generated, may be messy), produce:\n1) aiTitle: a short, clear, human-friendly title (max ~80 chars)\n2) topics: 1-3 tags chosen ONLY from this list: ${topicsAllowed.join(', ')}\n3) summary: 1-2 sentence summary.\n\nRules:\n- Use respectful, neutral wording.\n- Prefer specific series names when evident (e.g. Riyadh as-Salihin, Al-Wajeez).\n- If unsure, choose "Other".\n- Output STRICT JSON with keys: aiTitle, topics, summary.\n\nYouTube title: ${ytTitle || ''}\nYouTube description: ${truncate(ytDescription || '', 800)}\n\nTranscript:\n${truncate(transcript, maxTranscriptChars)}\n`

  let attempt = 0
  while (true) {
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 500,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      })

      return msg
    } catch (err) {
      attempt += 1
      if (attempt <= retry429Max && isRateLimit429(err)) {
        console.warn(`429 rate limit; sleeping ${retry429SleepMs}ms then retrying (attempt ${attempt}/${retry429Max})`)
        await sleep(retry429SleepMs)
        continue
      }
      throw err
    }
  }

  // unreachable
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON found in model output')
  const obj = JSON.parse(text.slice(start, end + 1))

  const aiTitle = (typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) ? obj.aiTitle.trim() : null
  const summary = (typeof obj.summary === 'string') ? obj.summary.trim() : ''
  const topics = Array.isArray(obj.topics) ? obj.topics.filter(t => topicsAllowed.includes(t)).slice(0,3) : []

  return {
    aiTitle: aiTitle || 'Untitled',
    summary,
    topics: topics.length ? topics : ['Other']
  }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

async function runPool(tasks, limit){
  const results = []
  let i = 0
  async function worker(){
    while (i < tasks.length) {
      const idx = i++
      results[idx] = await tasks[idx]()
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker)
  await Promise.all(workers)
  return results
}

async function main(){
  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'))
  const items = raw.items || []

  const targets = items
    .slice()
    .sort((a,b)=> new Date(b.timeBasis || b.publishedAt) - new Date(a.timeBasis || a.publishedAt))
    .filter(shouldEnrich)
    .slice(0, maxVideos)

  console.log(`Loaded ${items.length} videos. Enriching ${targets.length} with concurrency=${concurrency}…`)

  const tasks = targets.map(v => async () => {
    const id = v.id
    try {
      console.log(`Transcript ${id}…`)
      const transcript = await getTranscriptText(id)
      console.log(`Claude summarize ${id}…`)
      const msg = await summarizeAndTag({
        transcript,
        ytTitle: v.title,
        ytDescription: v.description || ''
      })

      const text = msg.content?.[0]?.text || ''
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start === -1 || end === -1) throw new Error('No JSON found in model output')
      const obj = JSON.parse(text.slice(start, end + 1))

      const aiTitle = (typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) ? obj.aiTitle.trim() : (v.title || 'Untitled')
      const summary = (typeof obj.summary === 'string') ? obj.summary.trim() : ''
      const topics = Array.isArray(obj.topics) ? obj.topics.filter(t => topicsAllowed.includes(t)).slice(0,3) : []

      v.aiTitle = aiTitle
      v.topics = topics.length ? topics : ['Other']
      v.summary = summary
      v.aiTitle = aiTitle
      v.topics = topics
      v.summary = summary
      delete v.enrichError
      v.enrichedAt = new Date().toISOString()
      await sleep(sleepMs)
      return { id, ok: true }
    } catch (err) {
      v.enrichError = String(err?.message || err)
      if (!v.aiTitle) v.aiTitle = v.title || 'Untitled'
      if (!Array.isArray(v.topics) || v.topics.length === 0) v.topics = ['Other']
      v.enrichedAt = new Date().toISOString()
      console.warn(`Failed ${id}: ${v.enrichError}`)
      await sleep(Math.min(400, sleepMs))
      return { id, ok: false, error: v.enrichError }
    }
  })

  await runPool(tasks, concurrency)

  raw.enrichedAt = new Date().toISOString()
  await fs.writeFile(outPath, JSON.stringify(raw, null, 2))
  console.log(`Wrote enriched data to ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
