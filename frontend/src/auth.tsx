import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  type CurrentUser,
  getCurrentUser,
  loginRequest,
  logoutRequest,
} from './api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

type AuthContextValue = {
  user: CurrentUser | null;
  status: AuthStatus;
  error: string | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
      setStatus('authenticated');
    } catch (requestError) {
      setUser(null);
      if (requestError instanceof ApiError && requestError.status === 401) {
        setStatus('unauthenticated');
        return;
      }
      setStatus('error');
      setError(requestError instanceof Error ? requestError.message : 'Unable to verify your session.');
    }
  }, []);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    await loginRequest(username, password);
    const currentUser = await getCurrentUser();
    setUser(currentUser);
    setError(null);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo(
    () => ({ user, status, error, refresh, login, logout }),
    [user, status, error, refresh, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const auth = useContext(AuthContext);
  if (!auth) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return auth;
}
