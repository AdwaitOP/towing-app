import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Truck,
  RefreshCw,
  LogOut,
  ShieldCheck,
  Menu,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { EMULATOR_CONFIG } from '@/config/firebase';

interface NavbarProps {
  onMobileMenuToggle?: () => void;
  mobileMenuOpenerRef?: React.RefObject<HTMLButtonElement>;
}

export const Navbar: React.FC<NavbarProps> = ({ onMobileMenuToggle, mobileMenuOpenerRef }) => {
  const { user, refreshAuthorization, signOutUser, isRefreshing, serverProofVerified } = useAuth();

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/95 backdrop-blur px-4 sm:px-6 flex items-center justify-between sticky top-0 z-20">
      {/* Left: Mobile Toggle & Brand */}
      <div className="flex items-center gap-3">
        <button
          ref={mobileMenuOpenerRef}
          onClick={onMobileMenuToggle}
          className="md:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500"
          aria-label="Open mobile navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-gradient-to-br from-orange-500 to-orange-700 rounded-lg text-white shadow-md shadow-orange-950/40">
            <Truck className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-base tracking-tight text-white">TowMitra</span>
              <span className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase rounded bg-orange-950/80 text-orange-400 border border-orange-800/60">
                Admin Console
              </span>
            </div>
            <p className="text-[10px] text-slate-400 hidden sm:block">Navi Mumbai Dispatch Operations</p>
          </div>
        </div>
      </div>

      {/* Right: Emulator Badge, Server Proof Status, Admin Menu */}
      <div className="flex items-center gap-3">
        {/* Emulator Badge */}
        <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-950/50 border border-emerald-800/60 text-emerald-300 text-xs font-mono">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span>Emulator: {EMULATOR_CONFIG.projectId}</span>
        </div>

        {/* Server Proof Verified Status */}
        {serverProofVerified && (
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/80 border border-slate-700 text-slate-300 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span className="font-mono text-[11px]">dispatch_config/main verified</span>
          </div>
        )}

        {/* Refresh Auth Button */}
        <button
          onClick={() => refreshAuthorization()}
          disabled={isRefreshing}
          className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg border border-transparent hover:border-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-50 transition"
          title="Refresh ID token claims and re-verify server proof"
          aria-label="Refresh authorization"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-orange-400' : ''}`} />
        </button>

        {/* User Dropdown (Radix DropdownMenu) */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-slate-800 border border-slate-800 hover:border-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-500 transition"
              aria-label="Admin account menu"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-slate-700 to-slate-600 flex items-center justify-center font-bold text-xs text-white border border-slate-600 shadow">
                {user?.email?.charAt(0).toUpperCase() || 'A'}
              </div>
              <div className="hidden md:block text-left text-xs leading-tight">
                <p className="font-medium text-slate-200 max-w-[140px] truncate">{user?.email}</p>
                <p className="text-[10px] text-emerald-400 font-mono">admin: true</p>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400 hidden sm:block" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 min-w-[220px] rounded-xl border border-slate-800 bg-slate-900 p-1.5 text-slate-200 shadow-xl animate-in fade-in-80 zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
              sideOffset={8}
              align="end"
            >
              <div className="px-3 py-2 text-xs border-b border-slate-800 mb-1">
                <p className="font-semibold text-slate-100 truncate">{user?.email}</p>
                <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">UID: {user?.uid}</p>
              </div>

              <DropdownMenu.Item
                onSelect={() => refreshAuthorization()}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer outline-none transition"
              >
                <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
                <span>Re-verify Token & Claims</span>
              </DropdownMenu.Item>

              <DropdownMenu.Separator className="h-px bg-slate-800 my-1" />

              <DropdownMenu.Item
                onSelect={() => {
                  Promise.resolve(signOutUser()).catch(() => {
                    // Handled at context and route boundary
                  });
                }}
                data-testid="navbar-sign-out"
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-red-400 hover:bg-red-950/50 hover:text-red-300 cursor-pointer outline-none transition"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign Out</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
};
