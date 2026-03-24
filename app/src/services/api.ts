import { API_URL } from '../config';

interface AuthResponse {
  token: string;
  user: {
    id: string;
    vkId: number;
    firstName: string;
    lastName: string;
  };
}

interface MeResponse {
  user: {
    id: string;
    vkId: number;
    firstName: string;
    lastName: string;
  };
}

export async function loginWithVK(params: {
  code: string;
  redirectUri: string;
}): Promise<AuthResponse> {
  const res = await fetch(`${API_URL}/auth/vk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.message || 'Login failed');
  }

  return res.json();
}

export async function getMe(token: string): Promise<MeResponse> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error('Invalid token');
  }

  return res.json();
}
