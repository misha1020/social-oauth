import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { router, useGlobalSearchParams } from 'expo-router';
import { useAuth } from '../src/hooks/useAuth';
import { exchangeVKCode } from '../src/services/api';
import { getStoredPKCE, clearStoredPKCE } from '../src/hooks/useVKAuth';
import { setDebugInfo } from '../src/debugStore';

export default function NotFoundScreen() {
  const params = useGlobalSearchParams<{ code?: string; state?: string; device_id?: string }>();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const code = params.code as string | undefined;
  const state = params.state as string | undefined;
  const deviceId = params.device_id as string | undefined;
  const isVKCallback = !!(code && deviceId);

  useEffect(() => {
    if (!isVKCallback) {
      router.replace('/');
      return;
    }

    const pkce = getStoredPKCE();
    if (!pkce) {
      setError('Auth session expired. Please try again.');
      return;
    }

    if (state !== pkce.state) {
      clearStoredPKCE();
      setError('State mismatch — please try again.');
      return;
    }

    clearStoredPKCE();
    setDebugInfo({ code: code!, codeVerifier: pkce.codeVerifier, deviceId: deviceId! });

    exchangeVKCode({ code: code!, codeVerifier: pkce.codeVerifier, deviceId: deviceId! })
      .then(async ({ token }) => {
        await login({ token });
        router.replace('/home');
      })
      .catch((err) => {
        setError(err.message || 'Authentication failed');
      });
  }, []);

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.error}>{error}</Text>
        <Pressable style={styles.button} onPress={() => router.replace('/login')}>
          <Text style={styles.buttonText}>Back to login</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#4680C2" />
      <Text style={styles.text}>Signing in...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
  error: {
    color: 'red',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#4680C2',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
  },
});
