import { NavLink } from 'react-router'
import { LayoutDashboard, MessageSquare, Settings } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { cn } from '@/lib/utils'

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="flex items-center justify-between h-14 px-6">
        <div className="flex items-center gap-4 sm:gap-8">
          <NavLink to="/" className="text-base font-semibold tracking-tight">
            CCSight
          </NavLink>
          <nav className="flex items-center gap-1">
            {links.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 px-2.5 py-2 sm:px-3 sm:py-1.5 rounded-md text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                  )
                }
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
        <ThemeToggle />
      </div>
    </header>
  )
}
