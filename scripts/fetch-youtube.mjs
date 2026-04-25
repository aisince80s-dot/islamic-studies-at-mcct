import fs from 'node:fs/promises'
import path from 'node:path'

const API_KEY = process.env.YT_API_KEY
const CHANNEL_ID = process.env.YT_CHANNEL_ID || 'UCt-XeQTVRSETC9DceeC6nMw'

if (!API_KEY) {
  console.error('Missing YT_API_KEY env var')
  process.exit(1)
}

const outPath = process.env.OUT_PATH || path.join(process.cwd(), 'public', 'videos.json')
const months = Number(process.env.MONTHS || '6')

const now = new Date()
const after = new Date(now)
after.setMonth(after.getMonth() - months)

function iso(d){ return d.toISOString() }

async function yt(url){
  const res = await fetch(url)
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function listUploadsPlaylistId(){
  const url = new URL('https://www.googleapis.com/youtube/v3/channels')
  url.searchParams.set('part','contentDetails')
  url.searchParams.set('id', CHANNEL_ID)
  url.searchParams.set('key', API_KEY)
  const j = await yt(url)
  const pl = j?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!pl) throw new Error('Could not resolve uploads playlist for channel')
  return pl
}

async function listPlaylistItems(playlistId){
  let pageToken = undefined
  const items = []

  while (true) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    url.searchParams.set('part','snippet,contentDetails')
    url.searchParams.set('maxResults','50')
    url.searchParams.set('playlistId', playlistId)
    url.searchParams.set('key', API_KEY)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const j = await yt(url)
    for (const it of (j.items || [])) {
      const videoId = it?.contentDetails?.videoId
      const publishedAt = it?.contentDetails?.videoPublishedAt || it?.snippet?.publishedAt
      if (!videoId || !publishedAt) continue
      items.push({ videoId, publishedAt })
    }

    pageToken = j.nextPageToken
    if (!pageToken) break

    // Stop if the last item is older than our cutoff
    const last = items[items.length - 1]
    if (last && new Date(last.publishedAt) < after) break
  }

  return items
}

async function getVideoDetails(ids){
  const chunks = []
  for (let i=0;i<ids.length;i+=50) chunks.push(ids.slice(i,i+50))

  const all = []
  for (const chunk of chunks) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part','snippet,contentDetails')
    url.searchParams.set('id', chunk.join(','))
    url.searchParams.set('key', API_KEY)
    const j = await yt(url)
    all.push(...(j.items || []))
  }

  return all
}

function timeOfDayBucket(publishedAt){
  const h = new Date(publishedAt).getUTCHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

function classifyTopics(text){
  const t = (text || '').toLowerCase()
  const topics = new Set()

  // High-level
  if (/(qur\b|quran|surah|sura|tafsir)/.test(t)) topics.add('Quran')
  if (/(hadith|ḥadīth|حديث)/.test(t)) topics.add('Hadith')
  if (/(fiqh|فقه|wajeez|wajiz|al\s*wajeez|al\s*wajiz)/.test(t)) topics.add('Fiqh')
  if (/(aqeed|aqid|\bcreed\b|عقيدة)/.test(t)) topics.add('Aqeedah')
  if (/(seerah|sira|سيرة|prophet)/.test(t)) topics.add('Seerah')

  // Series / books
  if (/(riyadh|riyaad|saliheen|salihin|صالحين)/.test(t)) topics.add('Riyadh as-Salihin')
  if (/(al\s*wajeez|al\s*wajiz|wajeez|wajiz)/.test(t)) topics.add('Al-Wajeez')

  if (topics.size === 0) topics.add('Other')
  return [...topics]
}

function aiTitleFallback(snippet){
  // Until we add transcript summarization, produce a nicer title from snippet title.
  const raw = snippet?.title || 'Untitled'
  return raw
    .replace(/\s*\|\s*mcct.*$/i,'')
    .replace(/\s*\(mcct.*\)$/i,'')
    .replace(/\s*-\s*mcct.*$/i,'')
    .trim()
}

async function main(){
  const uploads = await listUploadsPlaylistId()
  const playlistItems = await listPlaylistItems(uploads)

  const filteredIds = playlistItems
    .filter(x => new Date(x.publishedAt) >= after)
    .map(x => x.videoId)

  const uniqIds = [...new Set(filteredIds)]
  const details = await getVideoDetails(uniqIds)

  const items = details
    .map(v => {
      const sn = v.snippet || {}
      const publishedAt = sn.publishedAt
      const url = `https://www.youtube.com/watch?v=${v.id}`
      const textForTopics = `${sn.title || ''}\n${sn.description || ''}`
      return {
        id: v.id,
        url,
        publishedAt,
        timeOfDay: timeOfDayBucket(publishedAt),
        title: sn.title || '',
        description: sn.description || '',
        // aiTitle/topics will be overwritten by the transcript+Claude enrichment step.
        aiTitle: null,
        topics: []
      }
    })
    .filter(v => v.publishedAt)
    .sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt))

  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify({
    channelId: CHANNEL_ID,
    generatedAt: new Date().toISOString(),
    cutoffAfter: iso(after),
    items
  }, null, 2))

  console.log(`Wrote ${items.length} videos to ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
