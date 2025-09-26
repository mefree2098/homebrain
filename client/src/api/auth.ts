import api from './api';

// Description: Login user functionality
// Endpoint: POST /api/auth/login
// Request: { email: string, password: string }
// Response: { accessToken: string, refreshToken: string, user: User }
export const login = async (email: string, password: string) => {
  try {
    const response = await api.post('/api/auth/login', { email, password });
    return response.data;
  } catch (error) {
    console.error('Login error:', error);
    throw new Error(error?.response?.data?.message || error.message);
  }
};

// Description: Logout
// Endpoint: POST /api/auth/logout
// Request: { refreshToken?: string }
// Response: { success: boolean, message: string }
export const logout = async (refreshToken?: string) => {
  try {
    return await api.post('/api/auth/logout', { refreshToken });
  } catch (error) {
    throw new Error(error?.response?.data?.message || error.message);
  }
};
