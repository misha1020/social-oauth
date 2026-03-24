import { useEffect, useRef } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri, useAuthRequest } from 'expo-auth-session';
import { VK_CLIENT_ID } from '../config';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://oauth.vk.com/authorize',
  tokenEndpoint: 'https://oauth.vk.com/access_token',
};

export interface VKAuthResult {
  code: string;
  redirectUri: string;
}

export function useVKAuth(onSuccess: (result: VKAuthResult) => void) {
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const redirectUri = makeRedirectUri({
    scheme: 'vkoauth',
    path: 'auth/vk',
  });

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: VK_CLIENT_ID,
      scopes: ['email'],
      redirectUri,
      usePKCE: false,
      responseType: 'code',
      extraParams: {
        display: 'mobile',
        v: '5.131',
      },
    },
    discovery
  );

  useEffect(() => {
    if (response?.type === 'success') {
      const { code } = response.params;
      onSuccessRef.current({ code, redirectUri });
    }
  }, [response, redirectUri]);

  return {
    promptAsync,
    isReady: !!request,
    request,
    response,
  };
}
