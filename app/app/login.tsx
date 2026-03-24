import { Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { useVKAuth } from '../src/hooks/useVKAuth';
import { useAuth } from '../src/hooks/useAuth';
import { router } from 'expo-router';

export default function LoginScreen() {
  const { login, isLoading, error } = useAuth();

  const { promptAsync, isReady, request, response } = useVKAuth(async (result) => {
    await login(result);
    router.replace('/home');
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>VK OAuth Demo</Text>

      {error && <Text style={styles.debug}>{error}</Text>}

      {request?.url && (
        <Text selectable style={styles.debug}>{request.url}</Text>
      )}

      {response && response.type !== 'success' && (
        <Text selectable style={styles.debug}>
          response: {JSON.stringify(response, null, 2)}
        </Text>
      )}

      <Pressable
        style={[styles.button, (!isReady || isLoading) && styles.buttonDisabled]}
        onPress={() => promptAsync()}
        disabled={!isReady || isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in with VK</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#4680C2',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  debug: {
    fontSize: 10,
    color: '#333',
    marginBottom: 16,
    padding: 8,
    backgroundColor: '#eee',
    borderRadius: 4,
  },
});
