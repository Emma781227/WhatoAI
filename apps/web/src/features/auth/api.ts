import { apiRequest } from '@/lib/api/client';

export type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface AuthSessionResponse {
  user: AuthUser;
  accessToken: string;
}

export interface MessageResponse {
  message: string;
  /** Lien de vérification/reset — présent uniquement en dev (AUTH_EXPOSE_TEST_TOKENS). */
  devLink?: string;
}

export const authApi = {
  register(input: { email: string; password: string; firstName: string; lastName: string }) {
    return apiRequest<MessageResponse>('/auth/register', {
      method: 'POST',
      body: input,
      skipAuthRetry: true,
    });
  },
  login(input: { email: string; password: string }) {
    return apiRequest<AuthSessionResponse>('/auth/login', {
      method: 'POST',
      body: input,
      skipAuthRetry: true,
    });
  },
  refresh() {
    return apiRequest<AuthSessionResponse>('/auth/refresh', {
      method: 'POST',
      skipAuthRetry: true,
    });
  },
  logout() {
    return apiRequest<void>('/auth/logout', { method: 'POST', skipAuthRetry: true });
  },
  me() {
    return apiRequest<AuthUser>('/auth/me');
  },
  verifyEmail(token: string) {
    return apiRequest<AuthUser>('/auth/verify-email', {
      method: 'POST',
      body: { token },
      skipAuthRetry: true,
    });
  },
  resendVerification() {
    return apiRequest<MessageResponse>('/auth/resend-verification', { method: 'POST' });
  },
  forgotPassword(email: string) {
    return apiRequest<MessageResponse>('/auth/forgot-password', {
      method: 'POST',
      body: { email },
      skipAuthRetry: true,
    });
  },
  resetPassword(input: { token: string; newPassword: string }) {
    return apiRequest<MessageResponse>('/auth/reset-password', {
      method: 'POST',
      body: input,
      skipAuthRetry: true,
    });
  },
  changePassword(input: { currentPassword: string; newPassword: string }) {
    return apiRequest<AuthSessionResponse>('/auth/change-password', {
      method: 'POST',
      body: input,
    });
  },
};
