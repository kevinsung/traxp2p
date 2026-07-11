import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its double-mounting in dev would join/leave the P2P room
// twice in quick succession, confusing the signaling relays.
createRoot(document.getElementById('root')!).render(<App />)
