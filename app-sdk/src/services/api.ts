import { API_URL } from "../config";

interface MeResponse {
  user: {
    id: string;
    provider: string;
    providerId: string;
    firstName: string;
    lastName: string;
    email?: string;
    avatarId?: string;
  };
}

interface ExchangeVKCodeParams {
  code: string;
  codeVerifier: string;
  deviceId: string;
}

interface ExchangeVKCodeResponse {
  token: string;
}

export async function exchangeVKCode(
  params: ExchangeVKCodeParams
): Promise<ExchangeVKCodeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(`${API_URL}/auth/vk/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: params.code,
      code_verifier: params.codeVerifier,
      device_id: params.deviceId,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error || "Token exchange failed");
  }

  return res.json();
}

export async function exchangeYandexJwt(params: {
  jwt: string;
}): Promise<{ token: string; _debug?: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(`${API_URL}/auth/yandex/exchange-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt: params.jwt }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as any).message || (body as any).error || "Yandex JWT exchange failed"
    );
  }

  return res.json();
}

export async function getMe(token: string): Promise<MeResponse> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error("Invalid token");
  }

  return res.json();
}
