import { useCallback, useRef, useState } from "react";
import { authorize as yandexAuthorize } from "../../modules/expo-yandex-sdk";
import { exchangeYandexJwt } from "../services/api";

export interface YandexAuthResult {
  token: string;
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

      // The native module already fetched the Yandex-signed JWT via the SDK's getJwt()
      // (Approach A) — the raw access token never enters JS.
      console.log("[yandex] JWT:", result.jwt); // copy from logs to verify offline if needed

      // Send the JWT to our backend, which verifies the HS256 signature with client_secret.
      const { token } = await exchangeYandexJwt({ jwt: result.jwt });
      onSuccessRef.current({ token });
    } catch (err: any) {
      setError(err.message || "Yandex authentication failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authorize, isLoading, error };
}
