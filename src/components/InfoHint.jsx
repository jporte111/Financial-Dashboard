import React from 'react';
import { Info } from 'lucide-react';

// Lightweight hover/focus hint. Uses the native title attribute so it needs no
// TooltipProvider at the app root and works identically on touch (long-press).
export default function InfoHint({ text, className = '' }) {
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      tabIndex={0}
      className={`inline-flex cursor-help text-stone-400 hover:text-stone-600 focus:outline-none focus-visible:text-stone-700 ${className}`}
    >
      <Info className="h-3.5 w-3.5" />
    </span>
  );
}
