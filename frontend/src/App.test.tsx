import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { CurrentUser } from './api';

const signedInUser: CurrentUser = {
  id: 'user-1',
  username: 'test.user',
  full_name: 'Test User',
  permissions: {
    'org-one': ['users:read', 'audit:read'],
  },
  scopes: [
    { organization_id: 'org-one', branch_id: 'branch-1', warehouse_id: null, factory_id: null },
  ],
};

let authenticated = false;
let currentUser = signedInUser;
let loginStatus = 200;
let loginPayload: unknown = { csrf_token: 'csrf-value' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  authenticated = false;
  currentUser = signedInUser;
  loginStatus = 200;
  loginPayload = { csrf_token: 'csrf-value' };
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/auth/me')) {
      return authenticated
        ? jsonResponse(currentUser)
        : jsonResponse({ error: { code: 'authentication_required', message: 'Authentication is required.' } }, 401);
    }
    if (url.endsWith('/auth/login')) {
      authenticated = loginStatus === 200;
      return jsonResponse(loginPayload, loginStatus);
    }
    if (url.endsWith('/auth/logout')) {
      authenticated = false;
      return new Response(null, { status: 204 });
    }
    return jsonResponse([]);
  }));
});

describe('ERP application routes and navigation', () => {
  it('redirects protected pages to the sign-in form', async () => {
    window.history.replaceState({}, '', '/modules/finance');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sign in to ERP' })).toBeInTheDocument();
  });

  it('shows only authorized modules after authentication', async () => {
    authenticated = true;
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Welcome back, Test' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: /Administration/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Finance/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Manufacturing/ })).not.toBeInTheDocument();
  });

  it('denies a direct route to a module without permission', async () => {
    authenticated = true;
    window.history.replaceState({}, '', '/modules/finance');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Access not granted' })).toBeInTheDocument();
  });

  it('shows authorized Finance pages and loads the account workspace', async () => {
    authenticated = true;
    currentUser = { ...signedInUser, permissions: { 'org-one': ['finance:read'] } };
    window.history.replaceState({}, '', '/modules/finance/overview');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Finance Overview' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Posted journal entries' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Finance Chart of accounts' })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Overview')).toHaveAttribute('aria-current', 'page');
  });

  it('opens the inventory workspace and creates an item through the API', async () => {
    authenticated = true;
    currentUser = {
      ...signedInUser,
      permissions: {
        'org-one': ['inventory:read', 'inventory:manage', 'inventory:transact'],
      },
    };
    window.history.replaceState({}, '', '/modules/inventory/items');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Create item' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'RM-001' } });
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Raw material' } });
    fireEvent.change(screen.getByLabelText('Unit of measure'), { target: { value: 'kg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Item created.');
    expect(fetch).toHaveBeenCalledWith('/api/inventory/items', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        organization_id: 'org-one',
        sku: 'RM-001',
        name: 'Raw material',
        unit: 'kg',
      }),
    }));
  });

  it('opens the procurement purchase-order workspace with authorized pages', async () => {
    authenticated = true;
    currentUser = {
      ...signedInUser,
      permissions: {
        'org-one': ['procurement:read', 'procurement:manage', 'procurement:order', 'procurement:receive', 'inventory:read'],
      },
    };
    window.history.replaceState({}, '', '/modules/procurement/orders');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Issue purchase order' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Procurement Suppliers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Procurement Purchase orders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue purchase order' })).toBeDisabled();
  });

  it('opens the Sales order workspace for users with Sales access', async () => {
    authenticated = true;
    currentUser = {
      ...signedInUser,
      permissions: {
        'org-one': ['sales:read', 'sales:customer_manage', 'sales:order', 'sales:fulfill', 'inventory:read', 'inventory:transact'],
      },
    };
    window.history.replaceState({}, '', '/modules/sales/orders');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Create sales order' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sales Customers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sales Sales orders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create sales order' })).toBeDisabled();
  });

  it('opens the HR department workflow and creates a department through the API', async () => {
    authenticated = true;
    currentUser = {
      ...signedInUser,
      permissions: { 'org-one': ['hr:read', 'hr:manage'] },
    };
    window.history.replaceState({}, '', '/modules/hr/departments');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Create department' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Department code'), { target: { value: 'OPS' } });
    fireEvent.change(screen.getByLabelText('Department name'), { target: { value: 'Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create department' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Department created.');
    expect(fetch).toHaveBeenCalledWith('/api/hr/departments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        organization_id: 'org-one',
        code: 'OPS',
        name: 'Operations',
        parent_id: undefined,
      }),
    }));
  });

  it('balances journal lines exactly and posts the journal payload', async () => {
    authenticated = true;
    currentUser = {
      ...signedInUser,
      permissions: {
        'org-one': ['finance:read', 'finance:accounts_manage', 'finance:post'],
      },
    };
    vi.mocked(fetch).mockImplementation(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) {
        return jsonResponse(currentUser);
      }
      if (url.includes('/finance/accounts?')) {
        return jsonResponse([
          { id: 'cash', organization_id: 'org-one', code: '1000', name: 'Cash', account_type: 'asset', is_active: true },
          { id: 'revenue', organization_id: 'org-one', code: '4000', name: 'Revenue', account_type: 'revenue', is_active: true },
        ]);
      }
      if (url.endsWith('/finance/journal-entries') && init?.method === 'POST') {
        return jsonResponse({ id: 'entry-1' });
      }
      return jsonResponse([]);
    });
    window.history.replaceState({}, '', '/modules/finance/journals');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Post journal entry' })).toBeInTheDocument();
    const accountSelects = screen.getAllByLabelText('Account');
    fireEvent.change(accountSelects[0], { target: { value: 'cash' } });
    fireEvent.change(accountSelects[1], { target: { value: 'revenue' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Manual sale' } });
    fireEvent.change(screen.getAllByLabelText('Debit')[0], { target: { value: '100.0000' } });
    fireEvent.change(screen.getAllByLabelText('Credit')[1], { target: { value: '100.0000' } });
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post journal entry' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/finance/journal-entries', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"description":"Manual sale"'),
    })));
  });

  it('shows not-found state for an unknown page in a permitted module', async () => {
    authenticated = true;
    currentUser = { ...signedInUser, permissions: { 'org-one': ['finance:read'] } };
    window.history.replaceState({}, '', '/modules/finance/unknown-page');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('toggles mobile navigation accessibly', async () => {
    authenticated = true;
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Welcome back, Test' });

    const menuButton = screen.getByRole('button', { name: 'Open navigation menu' });
    fireEvent.click(menuButton);

    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(container.querySelector('.app-layout')).toHaveClass('mobile-nav-open'));
  });

  it('closes the mobile drawer with Escape and restores focus to its trigger', async () => {
    authenticated = true;
    render(<App />);
    await screen.findByRole('heading', { name: 'Welcome back, Test' });

    const menuButton = screen.getByRole('button', { name: 'Open navigation menu' });
    fireEvent.click(menuButton);
    await waitFor(() => expect(screen.getByRole('link', { name: 'ERP home' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: /Administration/ })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it('submits accessible credentials and opens the protected dashboard', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to ERP' });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'test.user' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Welcome back, Test' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: JSON.stringify({ username: 'test.user', password: 'password-value' }),
    }));
  });

  it('shows the backend username validation reason for invalid usernames', async () => {
    loginStatus = 422;
    loginPayload = {
      detail: [{
        loc: ['body', 'username'],
        msg: 'String should match pattern.',
      }],
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to ERP' });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'person@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('username: String should match pattern.');
  });
});
