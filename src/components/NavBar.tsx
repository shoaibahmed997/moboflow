import { NavLink } from 'react-router-dom'
import { useRecorder } from '../lib/recorder/RecorderContext'

const links = [
  { to: '/', label: 'Record', end: true },
  { to: '/sessions', label: 'Sessions', end: false },
]

export function NavBar() {
  const { state } = useRecorder()

  return (
    <nav className="sticky bottom-0 z-10 flex border-t border-slate-800 bg-slate-950/95 backdrop-blur">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) =>
            `flex flex-1 items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors ${
              isActive ? 'text-sky-400' : 'text-slate-500'
            }`
          }
        >
          {link.to === '/' && (state === 'recording' || state === 'paused') && (
            <span
              aria-label={state === 'recording' ? 'Recording' : 'Paused'}
              className={`h-2 w-2 rounded-full ${state === 'recording' ? 'animate-pulse bg-red-500' : 'bg-amber-400'}`}
            />
          )}
          {link.label}
        </NavLink>
      ))}
    </nav>
  )
}
