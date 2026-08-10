import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
// Side-effect import: attaches the beforeinstallprompt listener at boot so it's never missed
// (see lib/installPrompt.js) — InstallPrompt.jsx may not mount until minutes later.
import './lib/installPrompt.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registered on every load (not just prod) — the service worker's own fetch handler already
// leaves navigations/API calls network-first, so it's safe in dev too and means installability
// works from a local build as well.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}
