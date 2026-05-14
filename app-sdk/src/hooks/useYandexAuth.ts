import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
import { exchangeYandexJwt } from "../services/api";

export interface YandexAuthResult {
  token: string;
}

// Same call the native SDK's getJwt() makes internally:
// GET login.yandex.ru/info?format=jwt&oauth_token=<token>  -> response body IS the JWT string.
async function fetchYandexJwt(accessToken: string): Promise<string> {
  const res = await fetch(
    `https://login.yandex.ru/info?format=jwt&oauth_token=${encodeURIComponent(accessToken)}`
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`yandex /info?format=jwt failed: ${res.status} ${body}`);
  }
  return body.trim();
}

export function useYandexAuth(onSuccess: (result: YandexAuthResult) => void) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const authorize = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await yandexAuthorize();
      if ("cancelled" in result && result.cancelled) {
        setIsLoading(false);
        return;
      }

      // 1. exchange the access token for a Yandex-signed JWT
      const yandexJwt = await fetchYandexJwt(result.accessToken);
      console.log("[yandex] JWT:", yandexJwt); // copy from logs to verify offline if needed

      // 2. send the JWT to our backend, which verifies the HS256 signature with client_secret
      const { token } = await exchangeYandexJwt({ jwt: yandexJwt });
      onSuccessRef.current({ token });
    } catch (err: any) {
      setError(err.message || "Yandex authentication failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authorize, isLoading, error };
}
