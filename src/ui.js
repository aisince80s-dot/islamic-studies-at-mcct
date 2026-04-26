import dayjs from 'dayjs'

async function loadData(){
  const res = await fetch('./videos.json', { cache: 'no-store' })
  if (!res.ok) {
    // fallback for local dev first run
    const sample = await import('./videos.sample.json')
    return sample.default || sample
  }
  return res.json()
}

function timeOfDayFromItem(v){
  // Prefer server-provided classification (already AZ + livestream-aware)
  const t = (v && typeof v.timeOfDay === 'string') ? v.timeOfDay : ''
  if (t === 'morning') return 'fajr'
  if (t === 'afternoon') return 'jumaa'
  if (t === 'evening') return 'isha'
  if (t === 'fajr' || t === 'jumaa' || t === 'isha') return t

  // Fallback (should be rare): compute from timeBasis/publishedAt in local browser time
  const d = v?.timeBasis || v?.publishedAt
  const h = dayjs(d).hour()
  if (h < 12) return 'fajr'
  if (h < 17) return 'jumaa'
  return 'isha'
}

function unique(arr){
  return [...new Set(arr)].filter(Boolean).sort((a,b)=>a.localeCompare(b))
}

export async function renderApp(root){
  const data = await loadData()

  const state = {
    timeOfDay: 'all',
    topic: 'all',
    from: '',
    to: ''
  }

  const topics = unique((data.items || []).flatMap(v => v.topics || []))

  root.innerHTML = `
    <div class="container">
      <header>
        <div>
          <h1>Islamic Studies at MCCT</h1>
          <div class="sub">MCCT Tucson YouTube channel • filter by date, time-of-day, and topic</div>
        </div>
      </header>

      <div class="panel" style="margin-top:14px">
        <div class="filters">
          <label>
            Time
            <select id="timeOfDay">
              <option value="all">All</option>
              <option value="fajr">Fajr</option>
              <option value="jumaa">Jumaa</option>
              <option value="isha">Isha</option>
            </select>
          </label>

          <label>
            Topic
            <select id="topic">
              <option value="all">All</option>
              ${topics.map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
          </label>

          <label>
            From
            <input id="from" type="date" />
          </label>

          <label>
            To
            <input id="to" type="date" />
          </label>

          <button id="apply">Apply</button>
          <button class="secondary" id="reset">Reset</button>
        </div>
      </div>

      <div id="results" class="grid"></div>

      <div class="footer">Data shown is sample data. Next step: wire this to a generated <code>videos.json</code> from the YouTube Data API.</div>
    </div>
  `

  const els = {
    timeOfDay: root.querySelector('#timeOfDay'),
    topic: root.querySelector('#topic'),
    from: root.querySelector('#from'),
    to: root.querySelector('#to'),
    apply: root.querySelector('#apply'),
    reset: root.querySelector('#reset'),
    results: root.querySelector('#results'),
  }

  function readState(){
    state.timeOfDay = els.timeOfDay.value
    state.topic = els.topic.value
    state.from = els.from.value
    state.to = els.to.value
  }

  function passesFilters(v){
    const published = dayjs(v.publishedAt)

    if (state.timeOfDay !== 'all') {
      if (timeOfDayFromItem(v) !== state.timeOfDay) return false
    }

    if (state.topic !== 'all') {
      const topics = v.topics || []
      if (!topics.includes(state.topic)) return false
    }

    if (state.from) {
      if (published.isBefore(dayjs(state.from), 'day')) return false
    }

    if (state.to) {
      if (published.isAfter(dayjs(state.to), 'day')) return false
    }

    return true
  }

  function render(){
    const items = data.items
      .slice()
      .sort((a,b)=> dayjs(b.publishedAt).valueOf() - dayjs(a.publishedAt).valueOf())
      .filter(passesFilters)

    els.results.innerHTML = items.map(v => {
      const published = dayjs(v.publishedAt)
      const tod = timeOfDayFromItem(v)
      const topics = (v.topics || []).map(t => `<span class="chip">${t}</span>`).join('')
      const title = v.aiTitle || v.title

      return `
        <div class="card">
          <h3>${escapeHtml(title)}</h3>
          <div class="meta">
            <span class="chip">${published.format('YYYY-MM-DD')}</span>
            <span class="chip">${published.format('h:mm A')}</span>
            <span class="chip">${tod}</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px">${topics}</div>
          <a href="${v.url}" target="_blank" rel="noreferrer">Watch on YouTube</a>
        </div>
      `
    }).join('')
  }

  els.apply.addEventListener('click', () => { readState(); render() })
  els.reset.addEventListener('click', () => {
    els.timeOfDay.value = 'all'
    els.topic.value = 'all'
    els.from.value = ''
    els.to.value = ''
    readState();
    render()
  })

  render()
}

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;')
}
