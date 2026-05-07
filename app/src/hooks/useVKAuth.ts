import { useCallback, useRef, useState } from "react";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { VK_CLIENT_ID } from "../config";
import { exchangeVKCode } from "../services/api";
import { setDebugInfo } from "../debugStore";

const REDIRECT_BASE = `vk${VK_CLIENT_ID}://vk.ru/blank.html`;

// Module-level PKCE storage — survives component remounts when
// Expo Router navigates to +not-found on VK redirect deep link
let _storedPKCE: { codeVerifier: string; state: string } | null = null;
export function getStoredPKCE() {
  return _storedPKCE;
}
export function clearStoredPKCE() {
  _storedPKCE = null;
}

function base64urlEncode(array: Uint8Array): string {
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeVerifier(): Promise<string> {
  const array = new Uint8Array(32);
  Crypto.getRandomValues(array);
  return base64urlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseCallbackUrl(url: string) {
  const code = (url.match(/[?&]code=([^&]+)/) || [])[1];
  const state = (url.match(/[?&]state=([^&]+)/) || [])[1];
  const deviceId = (url.match(/[?&]device_id=([^&]+)/) || [])[1];
  return {
    code: code ? decodeURIComponent(code) : null,
    state: state ? decodeURIComponent(state) : null,
    deviceId: deviceId ? decodeURIComponent(deviceId) : null
  };
}

export interface VKAuthResult {
  token: string;
}

export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function useVKAuth(onSuccess: (result: VKAuthResult) => void) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pkceParams, setPkceParams] = useState<PKCEParams | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const preparePKCE = useCallback(async () => {
    setError(null);
    try {
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const stateArray = new Uint8Array(16);
      Crypto.getRandomValues(stateArray);
      const state = base64urlEncode(stateArray);

      _storedPKCE = { codeVerifier, state };
      setPkceParams({ codeVerifier, codeChallenge, state });
    } catch (err: any) {
      setError(err.message || "Failed to generate PKCE");
    }
  }, []);

  const continueAuth = useCallback(async () => {
    if (!pkceParams || !_storedPKCE) return;
    setIsLoading(true);
    setError(null);
    try {
      const { codeVerifier, codeChallenge, state } = pkceParams;

      const oauth2Params = btoa('scope="email"')
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const redirectUri = `${REDIRECT_BASE}?oauth2_params=${oauth2Params}`;

      const params = new URLSearchParams({
        client_id: VK_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        lang_id: "3"
      });

      const authUrl = `https://id.vk.ru/authorize?${params.toString()}`;
      const result = await WebBrowser.openAuthSessionAsync(
        authUrl,
        `vk${VK_CLIENT_ID}://`
      );

      if (result.type === "success" && result.url) {
        _storedPKCE = null;
        const {
          code,
          state: returnedState,
          deviceId
        } = parseCallbackUrl(result.url);

        if (!code || !deviceId) {
          setError("Missing code or device_id in VK response");
          return;
        }
        if (returnedState !== state) {
          setError("State mismatch — request may have been tampered with");
          return;
        }

        setDebugInfo({ code, codeVerifier, deviceId });
        const { token } = await exchangeVKCode({
          code,
          codeVerifier,
          deviceId
        });
        onSuccessRef.current({ token });
      } else {
        setIsLoading(false);
      }
    } catch (err: any) {
      _storedPKCE = null;
      setError(err.message || "Authentication failed");
      setIsLoading(false);
    }
  }, [pkceParams]);

  return { preparePKCE, continueAuth, pkceParams, isLoading, isReady: true, error };
}
