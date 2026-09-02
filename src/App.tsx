import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { InstallPrompt } from './components/InstallPrompt'
import { NavBar } from './components/NavBar'
import { Home } from './routes/Home'
import { SessionDetail } from './routes/SessionDetail'
import { Sessions } from './routes/Sessions'

function App() {
  return (
    <BrowserRouter>
      <div className="flex h-full flex-col bg-slate-950">
        <InstallPrompt />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:sessionId" element={<SessionDetail />} />
        </Routes>
        <NavBar />
      </div>
    </BrowserRouter>
  )
}

export default App
