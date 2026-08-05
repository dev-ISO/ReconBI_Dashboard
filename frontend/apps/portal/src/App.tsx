import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import {
  BarChart3,
  Database,
  FlaskConical,
  LayoutDashboard,
  Moon,
  Network,
  Sun,
  UserRound,
} from 'lucide-react';
import { DashboardsProvider } from '@recon/dashboards-ui';
import { useTheme } from './theme/useTheme';
import { DEMO_USERS, loginAs, portalFetcher, useCurrentUser } from './auth/demoAuth';
import { DashboardListPage } from './pages/DashboardListPage';
import { DashboardPage } from './pages/DashboardPage';
import { ModelListPage } from './pages/ModelListPage';
import { ModelEditorPage } from './pages/ModelEditorPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { SpikePage } from './pages/SpikePage';

const navGroups = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Dashboards', icon: LayoutDashboard, end: true },
      { to: '/models', label: 'Models', icon: Network, end: false },
      { to: '/connections', label: 'Connections', icon: Database, end: false },
    ],
  },
  {
    label: 'Developer',
    items: [{ to: '/spike', label: 'Spike', icon: FlaskConical, end: false }],
  },
];

/** Product mark: accent square + wordmark, reused in the sidebar and splash. */
function ProductMark({ large = false }: { large?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white shadow-sm ${
          large ? 'h-10 w-10' : 'h-7 w-7'
        }`}
      >
        <BarChart3 size={large ? 22 : 16} />
      </span>
      <span className={`font-semibold leading-tight tracking-[-0.01em] ${large ? 'text-lg' : 'text-[15px]'}`}>
        Recon Dashboards
      </span>
    </div>
  );
}

export function App() {
  const { theme, toggle } = useTheme();
  const currentUser = useCurrentUser();
  // Gate routed content until the auto-login settles so first fetches never
  // fire tokenless 401s. 'idle' also gates (covers the pre-effect first paint).
  const [autoLogin, setAutoLogin] = useState<'idle' | 'pending' | 'done'>('idle');

  // Default to carol so the portal works immediately after `docker compose up`.
  useEffect(() => {
    if (currentUser) return;
    setAutoLogin('pending');
    loginAs('carol')
      .catch(() => {
        // demo API not up yet; the pages show their own error states
      })
      .finally(() => setAutoLogin('done'));
  }, [currentUser]);

  const signingIn = !currentUser && autoLogin !== 'done';

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/10 bg-[var(--color-surface)] dark:border-white/10">
        <div className="px-4 pb-4 pt-5">
          <ProductMark />
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider opacity-50">
                {group.label}
              </p>
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] font-medium text-[var(--color-accent)]'
                        : 'opacity-80 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10'
                    }`
                  }
                >
                  <Icon size={16} />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* User picker + theme toggle, pinned to the sidebar foot. */}
        <div className="flex items-center gap-2 border-t border-black/10 px-3 py-3 dark:border-white/10">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
          >
            <UserRound size={15} className="opacity-70" />
          </span>
          <select
            aria-label="Switch demo user"
            className="h-8 min-w-0 flex-1 rounded-md border border-black/15 bg-[var(--color-surface)] px-2 text-sm outline-none transition-colors focus:border-[var(--color-accent)] dark:border-white/15"
            value={currentUser ?? ''}
            onChange={(event) => void loginAs(event.target.value)}
          >
            {!currentUser && <option value="">signed out</option>}
            {DEMO_USERS.map((user) => (
              <option key={user.username} value={user.username}>
                {user.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="shrink-0 rounded-md p-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={portalFetcher}>
          {signingIn ? (
            // Sign-in splash: centered card with the product mark.
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-[10px] border border-black/10 bg-[var(--color-surface)] px-8 py-10 shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_18px_rgba(0,0,0,0.08)] dark:border-white/10">
                <ProductMark large />
                <p className="text-center text-sm opacity-60">
                  Build models, compose dashboards, and explore your data.
                </p>
                <div className="flex items-center gap-2 text-sm opacity-70" role="status">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-[var(--color-accent)] dark:border-white/20" />
                  Signing in…
                </div>
              </div>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<DashboardListPage />} />
              <Route path="/dashboards/:id" element={<DashboardPage />} />
              <Route path="/models" element={<ModelListPage />} />
              <Route path="/models/:id" element={<ModelEditorPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/spike" element={<SpikePage />} />
            </Routes>
          )}
        </DashboardsProvider>
      </main>
    </div>
  );
}
