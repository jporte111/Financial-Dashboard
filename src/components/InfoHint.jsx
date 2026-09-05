import React from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Click the "i" to open a short explanation. The text is also exposed via
// aria-label / title for hover and assistive tech. Clicking the icon never
// triggers a surrounding clickable row/card.
export default function InfoHint({ text, className = '' }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={text}
          title={text}
          onClick={(e) => e.stopPropagation()}
          className={`inline-flex items-center text-stone-400 transition hover:text-stone-600 focus:outline-none focus-visible:text-stone-700 ${className}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 text-xs font-normal normal-case leading-relaxed tracking-normal text-stone-600"
        onClick={(e) => e.stopPropagation()}
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
