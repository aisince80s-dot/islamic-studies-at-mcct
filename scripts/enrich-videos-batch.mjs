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
const statePath = process.env.STATE_PATH || path.join(process.cwd(), 'public', 'enrich-state.json')

const maxVideos = Number(process.env.MAX_VIDEOS || '200')
const maxTranscriptChars = Number(process.env.MAX_TRANSCRIPT_CHARS || '12000')
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

async function loadState(){
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'))
  } catch {
    return { batches: [], lastRunAt: null }
  }
}

async function saveState(state){
  await fs.writeFile(statePath, JSON.stringify(state, null, 2))
}

async function main(){
  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'))
  const items = raw.items || []

  const state = await loadState()

  const targets = items
    .slice()
    .sort((a,b)=> new Date(b.timeBasis || b.publishedAt) - new Date(a.timeBasis || a.publishedAt))
    .filter(shouldEnrich)
    .slice(0, maxVideos)

  console.log(`Loaded ${items.length} videos. Targeting ${targets.length} for batch.`)

  if (targets.length === 0) {
    state.lastRunAt = new Date().toISOString()
    await saveState(state)
    console.log('Nothing to enrich.')
    return
  }

  // Fetch transcripts first (outside the batch)
  const requests = []
  for (const v of targets) {
    try {
      console.log(`Transcript ${v.id}…`)
      const transcript = await getTranscriptText(v.id)

      const prompt = `You are helping build a webpage called "Islamic Studies at MCCT".\n\nGiven a YouTube lecture transcript (auto-generated, may be messy), produce:\n1) aiTitle: a short, clear, human-friendly title (max ~80 chars)\n2) topics: 1-3 tags chosen ONLY from this list: ${topicsAllowed.join(', ')}\n3) summary: 1-2 sentence summary.\n\nRules:\n- Use respectful, neutral wording.\n- Prefer specific series names when evident (e.g. Riyadh as-Salihin, Al-Wajeez).\n- If unsure, choose "Other".\n- Output STRICT JSON with keys: aiTitle, topics, summary.\n\nYouTube title: ${v.title || ''}\nYouTube description: ${truncate(v.description || '', 800)}\n\nTranscript:\n${truncate(transcript, maxTranscriptChars)}\n`

      requests.push({
        custom_id: v.id,
        params: {
          model,
          max_tokens: 500,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }]
        }
      })

      delete v.enrichError
    } catch (err) {
      v.enrichError = String(err?.message || err)
      v.aiTitle = v.aiTitle || v.title || 'Untitled'
      v.topics = (Array.isArray(v.topics) && v.topics.length) ? v.topics : ['Other']
      v.enrichedAt = new Date().toISOString()
      console.warn(`Skip ${v.id}: ${v.enrichError}`)
    }
  }

  if (requests.length === 0) {
    raw.enrichedAt = new Date().toISOString()
    await fs.writeFile(outPath, JSON.stringify(raw, null, 2))
    state.lastRunAt = new Date().toISOString()
    await saveState(state)
    console.log('No batch requests created (no transcripts).')
    return
  }

  console.log(`Submitting batch with ${requests.length} requests…`)

  const batch = await client.batches.create({
    requests
  })

  state.batches.push({ id: batch.id, createdAt: new Date().toISOString(), count: requests.length })
  await saveState(state)

  console.log(`Batch submitted: ${batch.id}`)

  // Poll
  const deadline = Date.now() + Number(process.env.BATCH_TIMEOUT_MS || String(30 * 60 * 1000))
  let current = batch
  while (true) {
    current = await client.batches.retrieve(batch.id)
    if (current.processing_status === 'ended') break
    if (Date.now() > deadline) throw new Error('Batch timed out waiting for completion')
    await new Promise(r => setTimeout(r, Number(process.env.POLL_MS || '5000')))
  }

  console.log(`Batch ended with status=${current.processing_status}`)

  // Download results
  const results = await client.batches.results(batch.id)

  const byId = new Map(items.map(v => [v.id, v]))

  for await (const r of results) {
    const id = r.custom_id
    const v = byId.get(id)
    if (!v) continue

    if (r.result?.type !== 'succeeded') {
      v.enrichError = `Anthropic batch failed: ${r.result?.type || 'unknown'}`
      v.enrichedAt = new Date().toISOString()
      continue
    }

    const text = r.result.message?.content?.[0]?.text || ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) {
      v.enrichError = 'No JSON in model output'
      v.enrichedAt = new Date().toISOString()
      continue
    }

    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      v.aiTitle = obj.aiTitle || v.title
      v.summary = obj.summary || ''
      const topics = Array.isArray(obj.topics) ? obj.topics : []
      v.topics = topics.filter(t => topicsAllowed.includes(t)).slice(0,3)
      if (!v.topics.length) v.topics = ['Other']
      delete v.enrichError
      v.enrichedAt = new Date().toISOString()
    } catch (e) {
      v.enrichError = `JSON parse failed: ${String(e?.message || e)}`
      v.enrichedAt = new Date().toISOString()
    }
  }

  raw.enrichedAt = new Date().toISOString()
  await fs.writeFile(outPath, JSON.stringify(raw, null, 2))
  state.lastRunAt = new Date().toISOString()
  await saveState(state)

  console.log(`Wrote enriched data to ${outPath} and state to ${statePath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
