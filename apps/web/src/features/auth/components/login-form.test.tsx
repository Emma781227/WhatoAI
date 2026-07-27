import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import { LoginForm } from './login-form';

const { loginMock, replaceMock, searchParamsRef } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({ login: loginMock, status: 'unauthenticated', user: null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
}));

beforeEach(() => {
  loginMock.mockReset();
  replaceMock.mockReset();
  searchParamsRef.current = new URLSearchParams();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'aicha@boutique.cm');
  await user.type(screen.getByLabelText('Mot de passe'), 'password-123');
  await user.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('LoginForm', () => {
  it('soumet et redirige vers la destination interne `next`', async () => {
    searchParamsRef.current = new URLSearchParams('next=%2Fshops');
    loginMock.mockResolvedValue({ id: 'user-1' });
    const user = userEvent.setup();
    render(<LoginForm />);

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith({ email: 'aicha@boutique.cm', password: 'password-123' }),
    );
    expect(replaceMock).toHaveBeenCalledWith('/shops');
  });

  it('refuse une redirection `next` externe (open redirect)', async () => {
    searchParamsRef.current = new URLSearchParams('next=https%3A%2F%2Fevil.example');
    loginMock.mockResolvedValue({ id: 'user-1' });
    const user = userEvent.setup();
    render(<LoginForm />);

    await fillAndSubmit(user);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('affiche le message métier du backend en cas d’identifiants invalides', async () => {
    loginMock.mockRejectedValue(
      new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await fillAndSubmit(user);

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('empêche la double soumission pendant l’appel en cours', async () => {
    let resolveLogin: (value: unknown) => void = () => undefined;
    loginMock.mockImplementation(() => new Promise((resolve) => (resolveLogin = resolve)));
    const user = userEvent.setup();
    render(<LoginForm />);

    await fillAndSubmit(user);
    const button = screen.getByRole('button', { name: 'Se connecter' });
    expect(button).toBeDisabled();
    await user.click(button); // clic ignoré

    resolveLogin({ id: 'user-1' });
    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
  });

  it('validation locale : email invalide bloqué sans appel réseau', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email'), 'pas-un-email');
    await user.type(screen.getByLabelText('Mot de passe'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByText('Adresse email invalide')).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });
});
