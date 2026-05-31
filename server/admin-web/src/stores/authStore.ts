import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthUser {
  id: string;
  email: string;
  role: string;
  tenant_id: string;
  permissions?: string[];
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  dark: boolean;
  setTokens: (a: string, r: string) => void;
  setUser: (u: AuthUser | null) => void;
  toggleDark: () => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    set => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      dark: true,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: user => set({ user }),
      toggleDark: () => set(s => ({ dark: !s.dark })),
      logout: () => set({ accessToken: null, refreshToken: null, user: null })
    }),
    { name: 'mdm-auth' }
  )
);
