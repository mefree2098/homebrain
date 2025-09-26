import { createContext, useContext, useState, ReactNode } from "react";
import { login as apiLogin, logout as apiLogout } from "../api/auth";
import { User } from "../../../shared/types/user";

type AuthContextType = {
  isAuthenticated: boolean;
  currentUser: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

const loadStoredUser = (): User | null => {
  const stored = localStorage.getItem("userData");
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored);
    if (parsed?.email) {
      return parsed;
    }
    if (parsed?.user?.email) {
      return parsed.user;
    }
  } catch (error) {
    console.warn("Failed to parse stored user data:", error);
  }
  return null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return Boolean(localStorage.getItem("accessToken"));
  });
  const [currentUser, setCurrentUser] = useState<User | null>(() => loadStoredUser());

  const login = async (email: string, password: string) => {
    try {
      const response = await apiLogin(email, password);
      const { accessToken, refreshToken, user } = response;
      setAuthData(accessToken, refreshToken, user);
    } catch (error) {
      resetAuth();
      throw new Error(error?.message || "Login failed");
    }
  };

  const logout = async () => {
    const refreshToken = localStorage.getItem("refreshToken") || undefined;
    resetAuth();
    try {
      await apiLogout(refreshToken);
    } catch (error) {
      console.warn("Logout error:", error?.message || error);
    } finally {
      window.location.reload();
    }
  };

  const resetAuth = () => {
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userData");
    setCurrentUser(null);
    setIsAuthenticated(false);
  };

  const setAuthData = (accessToken: string, refreshToken: string, user: User) => {
    if (!accessToken || !refreshToken || !user) {
      throw new Error("Missing authentication tokens or user profile.");
    }

    localStorage.setItem("refreshToken", refreshToken);
    localStorage.setItem("accessToken", accessToken);
    localStorage.setItem("userData", JSON.stringify(user));
    setCurrentUser(user);
    setIsAuthenticated(true);
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        isAuthenticated,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
