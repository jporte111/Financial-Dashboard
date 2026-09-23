// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';

let mockAuth;
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => mockAuth }));

import ProtectedRoute from './ProtectedRoute';

afterEach(cleanup);

const auth = (over) => ({ isAuthenticated: true, isLoadingAuth: false, authChecked: true, authError: null, checkUserAuth: () => {}, user: null, ...over });

function renderAdminArea() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/client" element={<div>CLIENT VIEW</div>} />
        <Route element={<ProtectedRoute requireAdmin unauthenticatedElement={<Navigate to="/client" replace />} />}>
          <Route path="/" element={<div>ADMIN SIDE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute requireAdmin (admin side reads entities directly)', () => {
  it('lets an admin in', () => {
    mockAuth = auth({ user: { role: 'admin' } });
    renderAdminArea();
    expect(screen.getByText('ADMIN SIDE')).toBeTruthy();
  });

  it.each([
    ['a signed-in non-admin', { user: { role: 'user' } }],
    ['a signed-in user with no role', { user: {} }],
    ['an anonymous visitor', { isAuthenticated: false }],
  ])('sends %s to the public client view', (_, over) => {
    mockAuth = auth(over);
    renderAdminArea();
    expect(screen.getByText('CLIENT VIEW')).toBeTruthy();
    expect(screen.queryByText('ADMIN SIDE')).toBeNull();
  });
});
