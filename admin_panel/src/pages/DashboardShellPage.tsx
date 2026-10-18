import React from 'react';
import { Link } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ShieldCheck,
  Server,
  UserCheck,
  Radio,
  Users,
  Sliders,
  PhoneCall,
  Clock,
  ArrowUpRight,
  Database,
  Lock,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { EMULATOR_CONFIG } from '@/config/firebase';

export const DashboardShellPage: React.FC = () => {
  const { user, tokenResult, serverProofVerified } = useAuth();

  const modules = [
    {
      title: 'Driver Verification Queue',
      desc: 'Review pending driver KYC applications, cross-check ID/RC/selfie photos, and issue audited approvals or rejections.',
      to: '/verification',
      icon: UserCheck,
      milestone: 'M2',
      status: 'Planned for Milestone 2',
    },
    {
      title: 'Live Jobs Monitoring',
      desc: 'Real-time Firestore snapshot monitor tracking active tows, dispatch runs, offer cascades, and lifecycle events.',
      to: '/jobs',
      icon: Radio,
      milestone: 'M2',
      status: 'Planned for Milestone 2',
    },
    {
      title: 'Driver Management',
      desc: 'Driver profiles, duty telemetry, wallet balance inspection, ledger history, and audited cancellation forgiveness.',
      to: '/drivers',
      icon: Users,
      milestone: 'M3',
      status: 'Planned for Milestone 3',
    },
    {
      title: 'Config Editor',
      desc: 'Strongly typed editor for booking tiers, fare formulas, and driver cancellation forfeiture policies with strict server validation.',
      to: '/config',
      icon: Sliders,
      milestone: 'M3',
      status: 'Planned for Milestone 3',
    },
    {
      title: 'Phone Booking Pipeline',
      desc: 'Inbound telephone booking dispatch using shared pricing and job creation with authenticated admin attribution.',
      to: '/phone-booking',
      icon: PhoneCall,
      milestone: 'M4',
      status: 'Planned for Milestone 4',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Operations Console Shell</h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-orange-950/80 text-orange-400 border border-orange-800/60">
                Phase 6 M1
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-400">
              TowMitra Central Dispatch & Management System • Navi Mumbai Operations
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs font-mono">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span>Session Authenticated as Admin</span>
            </div>
          </div>
        </div>
      </div>

      {/* Security & System Info Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Auth & Claim Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3 min-w-0">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Auth & Claims</span>
            <Lock className="h-4 w-4 text-orange-400 flex-shrink-0" />
          </div>
          <div className="space-y-1 font-mono text-xs">
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Account:</span>
              <span className="text-slate-200 truncate max-w-[200px] break-all">{user?.email}</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Custom Claim:</span>
              <span className="text-emerald-400 font-bold truncate">admin: true</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Token Auth Time:</span>
              <span className="text-slate-300 truncate">
                {tokenResult?.authTime ? new Date(tokenResult.authTime).toLocaleTimeString() : 'N/A'}
              </span>
            </div>
          </div>
        </div>

        {/* Server Proof Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3 min-w-0">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Server Proof (M1-M)</span>
            <Server className="h-4 w-4 text-emerald-400 flex-shrink-0" />
          </div>
          <div className="space-y-1 font-mono text-xs">
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Document:</span>
              <span className="text-slate-200 truncate break-all">dispatch_config/main</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Read Authority:</span>
              <span className="text-emerald-400 truncate">Rules isAdmin() PASS</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Status:</span>
              <span className="text-emerald-300 truncate">{serverProofVerified ? 'Verified Server Read' : 'Pending'}</span>
            </div>
          </div>
        </div>

        {/* Emulator Configuration Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3 min-w-0">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Emulator Topology</span>
            <Database className="h-4 w-4 text-blue-400 flex-shrink-0" />
          </div>
          <div className="space-y-1 font-mono text-xs">
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Project ID:</span>
              <span className="text-blue-300 truncate">{EMULATOR_CONFIG.projectId}</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Region:</span>
              <span className="text-slate-300 truncate">{EMULATOR_CONFIG.region}</span>
            </div>
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-slate-500 flex-shrink-0">Ports:</span>
              <span className="text-slate-300 truncate">
                A:{EMULATOR_CONFIG.ports.auth} F:{EMULATOR_CONFIG.ports.firestore}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Tabs (Radix Tabs) */}
      <Tabs.Root defaultValue="modules" className="space-y-4">
        <Tabs.List className="flex border-b border-slate-800 space-x-4">
          <Tabs.Trigger
            value="modules"
            className="pb-2 text-xs font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent data-[state=active]:border-orange-500 data-[state=active]:text-orange-400 transition"
          >
            Phase 6 Modules
          </Tabs.Trigger>
          <Tabs.Trigger
            value="boundaries"
            className="pb-2 text-xs font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent data-[state=active]:border-orange-500 data-[state=active]:text-orange-400 transition"
          >
            Milestone 1 Contract Boundaries
          </Tabs.Trigger>
        </Tabs.List>

        {/* Tab 1: Module Cards */}
        <Tabs.Content value="modules" className="outline-none space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
              Operations Modules Roadmap
            </h2>
            <span className="text-xs text-slate-500 font-mono">5 Modules • Locked in M1</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {modules.map((m) => (
              <div
                key={m.to}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between hover:border-slate-700 transition"
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="p-2.5 bg-slate-800 rounded-lg text-orange-400 border border-slate-700">
                      <m.icon className="h-5 w-5" />
                    </div>
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded uppercase tracking-wider bg-slate-800 text-slate-400 border border-slate-700">
                      {m.milestone}
                    </span>
                  </div>

                  <h3 className="font-semibold text-slate-100 text-sm">{m.title}</h3>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">{m.desc}</p>
                </div>

                <div className="mt-5 pt-4 border-t border-slate-800/80 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-400/90 font-medium">
                    <Clock className="h-3 w-3" />
                    <span>{m.status}</span>
                  </div>

                  <Link
                    to={m.to}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-orange-400 hover:text-orange-300 transition"
                  >
                    <span>View Shell</span>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </Tabs.Content>

        {/* Tab 2: Milestone 1 Contract Invariants */}
        <Tabs.Content value="boundaries" className="outline-none space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 space-y-4 text-xs text-slate-300">
            <h3 className="font-bold text-sm text-slate-100 uppercase tracking-wider">
              Enforced M1 Security & Architectural Invariants
            </h3>
            <div className="space-y-3 font-mono">
              <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800">
                <p className="text-orange-400 font-bold mb-1">M1-F: Strict Boolean Claim Semantics</p>
                <p className="text-slate-400">
                  Access granted ONLY when (claims.admin === true). Fails closed on missing, null, false, &quot;true&quot;, or 1.
                </p>
              </div>

              <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800">
                <p className="text-orange-400 font-bold mb-1">M1-M: Server-Authoritative Authorization Proof</p>
                <p className="text-slate-400">
                  Client claim reflection alone is insufficient. Successful server-side read of dispatch_config/main via firestore.rules is required.
                </p>
              </div>

              <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800">
                <p className="text-orange-400 font-bold mb-1">M1-J: Generation Fencing & Race Safety</p>
                <p className="text-slate-400">
                  Async authorization verification is generation-bound. Late or in-flight responses after logout or user change cannot restore access.
                </p>
              </div>

              <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800">
                <p className="text-orange-400 font-bold mb-1">M1-C: Disposable Project & Loopback Isolation</p>
                <p className="text-slate-400">
                  Strictly restricted to demo-towmitra-admin on 127.0.0.1. Zero access to production credentials or external networks.
                </p>
              </div>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
};
