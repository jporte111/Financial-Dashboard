import React from 'react';

export default function SectionHeading({ title, subtitle, right }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-xl tracking-tight">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}