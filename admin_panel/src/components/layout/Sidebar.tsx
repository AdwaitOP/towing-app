import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  UserCheck,
  Radio,
  Users,
  Sliders,
  PhoneCall,
  Clock,
} from 'lucide-react';

interface SidebarProps {
  onItemClick?: () => void;
}

export const navItems = [
  {
    name: 'Console Overview',
    to: '/',
    icon: LayoutDashboard,
    implementedInM1: true,
  },
  {
    name: 'Verification Queue',
    to: '/verification',
    icon: UserCheck,
    implementedInM1: false,
    badge: 'M2',
  },
  {
    name: 'Live Jobs',
    to: '/jobs',
    icon: Radio,
    implementedInM1: false,
    badge: 'M2',
  },
  {
    name: 'Driver Management',
    to: '/drivers',
    icon: Users,
    implementedInM1: false,
    badge: 'M3',
  },
  {
    name: 'Config Editor',
    to: '/config',
    icon: Sliders,
    implementedInM1: false,
    badge: 'M3',
  },
  {
    name: 'Phone Booking',
    to: '/phone-booking',
    icon: PhoneCall,
    implementedInM1: false,
    badge: 'M4',
  },
];

export const Sidebar: React.FC<SidebarProps> = ({ onItemClick }) => {
  return (
    <aside className="w-64 border-r border-slate-800 bg-slate-900/60 flex flex-col h-[calc(100vh-4rem)] p-4 flex-shrink-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-3 mb-2">
        Operations Modules
      </div>

      <nav className="space-y-1 flex-1" aria-label="Main Navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onItemClick}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition ${
                isActive
                  ? 'bg-orange-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`
            }
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <item.icon className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{item.name}</span>
            </div>

            {!item.implementedInM1 && (
              <span className="ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded uppercase tracking-wider bg-slate-800 text-slate-400 border border-slate-700">
                {item.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* M1 Scope Notice */}
      <div className="mt-auto p-3 rounded-lg bg-slate-950/80 border border-slate-800 text-[11px] text-slate-400 space-y-1">
        <div className="flex items-center gap-1.5 text-orange-400 font-semibold">
          <Clock className="h-3.5 w-3.5" />
          <span>Milestone 1 Scope</span>
        </div>
        <p className="text-[10px] text-slate-400 leading-relaxed">
          Foundation & authentication only. Future modules unlock in M2–M5 per roadmap.
        </p>
      </div>
    </aside>
  );
};
