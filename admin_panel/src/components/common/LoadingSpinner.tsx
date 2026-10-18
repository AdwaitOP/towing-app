import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message = 'Loading operations console...',
  size = 'md',
}) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  }[size];

  return (
    <div className="flex flex-col items-center justify-center p-8 text-slate-400 space-y-3" role="status" aria-live="polite">
      <Loader2 className={`${sizeClasses} animate-spin text-orange-500`} />
      {message && <p className="text-sm font-medium">{message}</p>}
    </div>
  );
};
