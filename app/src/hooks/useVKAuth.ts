import { useEffect, useRef, useMemo } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri, useAuthRequest } from 'expo-auth-session';
import { VK_CLIENT_ID } from '../config';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://id.vk.com/authorize',
  tokenEndpoint: 'https://id.vk.com/oauth2/auth',
};

function generateDeviceId(): string {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export interface VKAuthResult {
  code: string;
  codeVerifier: string;
  deviceId: string;
  redirectUri: string;
}

export function useVKAuth(onSuccess: (result: VKAuthResult) => void) {
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const deviceId = useMemo(() => generateDeviceId(), []);

  const redirectUri = makeRedirectUri({
    scheme: 'vkoauth',
    path: 'auth/vk',
  });

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: VK_CLIENT_ID,
      scopes: ['email', 'profile'],
      redirectUri,
      usePKCE: true,
      responseType: 'code',
      extraParams: {
        device_id: deviceId,
        app_id: VK_CLIENT_ID,
      },
    },
    discovery
  );

  useEffect(() => {
    if (response?.type === 'success' && request?.codeVerifier) {
      const { code, device_id } = response.params;
      onSuccessRef.current({
        code,
        codeVerifier: request.codeVerifier,
        deviceId: device_id || deviceId,
        redirectUri,
      });
    }
  }, [response, request, redirectUri, deviceId]);

  return {
    promptAsync,
    isReady: !!request,
  };
}
