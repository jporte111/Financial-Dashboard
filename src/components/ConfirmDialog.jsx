import React from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';

// Phase 9a: a confirmation for consequential actions (publishing to the client
// page). Built on Radix AlertDialog: focus moves into the dialog (to Cancel),
// stays there, Escape cancels, and focus returns to the button that opened it.
/**
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void, title: React.ReactNode,
 *   children?: React.ReactNode, confirmLabel: React.ReactNode, onConfirm: () => void,
 *   tone?: 'default' | 'danger', testId?: string }} props
 */
export default function ConfirmDialog({ open, onOpenChange, title, children = null, confirmLabel, onConfirm, tone = 'default', testId = 'confirm-dialog' }) {
  const confirmClass = tone === 'danger' ? 'bg-rose-700 hover:bg-rose-800 focus-visible:ring-rose-500' : 'bg-stone-900 hover:bg-stone-800 focus-visible:ring-stone-500';
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <AlertDialog.Content
          data-testid={testId}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-stone-200 bg-white p-6 shadow-xl focus:outline-none"
        >
          <AlertDialog.Title className="font-display text-xl leading-snug text-stone-900">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 space-y-3 text-sm text-stone-700">{children}</div>
          </AlertDialog.Description>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel
              autoFocus
              className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              data-testid={`${testId}-confirm`}
              className={`rounded-full px-4 py-2 text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${confirmClass}`}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
