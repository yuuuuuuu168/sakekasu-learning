import { GraduationCap, LogOut } from 'lucide-react';
import { Link, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthGate';

export function Layout() {
  const { email, signOut } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <GraduationCap className="size-5" />
            </span>
            sakekasu learning
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-slate-500 sm:block">{email}</span>
            <button
              onClick={() => void signOut()}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">ログアウト</span>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
