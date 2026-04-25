import './style.css'
import { renderApp } from './ui'

renderApp(document.querySelector('#app')).catch(err => {
  document.querySelector('#app').innerHTML = `<div style="padding:24px; color:#e2e8f0">Failed to load videos.json: ${String(err)}</div>`
})
