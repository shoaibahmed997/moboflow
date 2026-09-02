import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Record', end: true },
  { to: '/sessions', label: 'Sessions', end: false },
]

export function NavBar() {
  return (
    <nav className="sticky bottom-0 z-10 flex border-t border-slate-800 bg-slate-950/95 backdrop-blur">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) =>
            `flex-1 py-3 text-center text-sm font-medium transition-colors ${
              isActive ? 'text-sky-400' : 'text-slate-500'
            }`
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  )
}
