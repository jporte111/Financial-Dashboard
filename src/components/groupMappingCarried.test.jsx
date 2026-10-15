// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GroupMappingCard } from './admin/BvaCorrectionCards';

// The group card says where each watch-list group comes from. Fictional data.
afterEach(cleanup);
const validation = { reconciled: { detail: { categories: [
  { code: '9001', name: 'Test Gardening', group: 'fixed', groupConfirmed: true },
  { code: '9002', name: 'Test Nanny', group: 'variable', groupConfirmed: true },
  { code: '9003', name: 'Test Personal', group: 'unassigned', groupConfirmed: false },
] } } };
const carried = { map: { 9001: 'fixed', 9002: 'variable' }, from: 'September 2030' };

describe('GroupMappingCard with carried groups', () => {
  it('marks carried groups, hand-set differences, and new/renamed rows', () => {
    const corrections = [{ kind: 'group', target: '9002', value: 'fixed' }];
    render(<GroupMappingCard validation={validation} corrections={corrections} onSave={() => {}} onRemove={() => {}} by="a" carried={carried} />);
    expect(screen.getByTestId('group-status-9001').textContent).toBe('carried from September 2030');
    expect(screen.getByTestId('group-status-9002').textContent).toMatch(/differs from September 2030 \(Variable\) — needs a written reason/);
    expect(screen.getByTestId('group-status-9003').textContent).toBe('unassigned (new or renamed row)');
  });
});
