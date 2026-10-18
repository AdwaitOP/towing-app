import React from 'react';
import { Link } from 'react-router-dom';
import { Lock, Clock, ArrowLeft, Shield } from 'lucide-react';

interface PlaceholderModulePageProps {
  title: string;
  milestone: string;
  description: string;
  plannedFeatures: string[];
}

export const PlaceholderModulePage: React.FC<PlaceholderModulePageProps> = ({
  title,
  milestone,
  description,
  plannedFeatures,
}) => {
  return (
    <div className="space-y-6">
      {/* Back button */}
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Operations Overview</span>
        </Link>
      </div>

      {/* Main Placeholder Container */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-6 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2.5 mb-2">
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{title}</h1>
              <span className="px-2.5 py-0.5 text-xs font-bold rounded uppercase tracking-wider bg-orange-950/90 text-orange-400 border border-orange-800/80">
                {milestone}
              </span>
            </div>
            <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">{description}</p>
          </div>

          <div className="flex-shrink-0">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-300 text-xs font-semibold">
              <Lock className="h-3.5 w-3.5" />
              <span>Not Implemented in M1</span>
            </span>
          </div>
        </div>

        {/* Milestone Boundary Notice */}
        <div className="my-6 p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-300 space-y-2">
          <div className="flex items-center gap-2 text-orange-400 font-semibold uppercase tracking-wider">
            <Clock className="h-4 w-4" />
            <span>Milestone Scope Boundary</span>
          </div>
          <p className="leading-relaxed">
            Per the authoritative Phase 6 implementation contract, business operational functions, live job streams, KYC inspection, and configuration writers are deferred to <strong>{milestone}</strong>. Milestone 1 strictly implements the web foundation, responsive desktop shell, and server-authoritative authentication proof.
          </p>
        </div>

        {/* Planned Features List */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
            <Shield className="h-4 w-4 text-orange-400" />
            <span>Planned {milestone} Capabilities</span>
          </h2>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {plannedFeatures.map((feat, idx) => (
              <li
                key={idx}
                className="p-3 rounded-lg bg-slate-950/50 border border-slate-800/70 text-xs text-slate-300 flex items-start gap-2.5"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500 mt-1.5 flex-shrink-0" />
                <span>{feat}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
