import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import * as SecureStore from "expo-secure-store";
import { getMe } from "../services/api";
import { TOKEN_KEY } from "../config";

interface User {
  id: string;
  provider: string;
  providerId: string;
  firstName: string;
  lastName: string;
  email?: string;
  avatarId?: string;
}

interface AuthState {
  isLoading: boolean;
  isLoggedIn: boolean;
  user: User | null;
  error: string | null;
  login: (params: { token: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useAuthProvider() {
  const [state, setState] = useState<Omit<AuthState, "login" | "logout">>({
    isLoading: true,
    isLoggedIn: false,
    user: null,
    error: null,
  });

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (!token) {
        setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
        return;
      }
      const { user } = await getMe(token);
      setState({ isLoading: false, isLoggedIn: true, user, error: null });
    } catch {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
    }
  }

  const login = useCallback(async ({ token }: { token: string }) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      const { user } = await getMe(token);
      setState({ isLoading: false, isLoggedIn: true, user, error: null });
    } catch (err: any) {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err.message || "Login failed",
      }));
    }
  }, []);

  const logout = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setState({ isLoading: false, isLoggedIn: false, user: null, error: null });
  }, []);

  return { ...state, login, logout };
}

export { AuthContext };
