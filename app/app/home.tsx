import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useAuth } from '../src/hooks/useAuth';
import { getDebugInfo } from '../src/debugStore';
import { router } from 'expo-router';

export default function HomeScreen() {
  const { user, logout } = useAuth();
  const debug = getDebugInfo();

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Welcome!</Text>

      {user && (
        <View style={styles.profile}>
          <Text style={styles.name}>{user.firstName} {user.lastName}</Text>
          <Text style={styles.info}>VK ID: {user.vkId}</Text>
          <Text style={styles.info}>User ID: {user.id}</Text>
        </View>
      )}

      {debug && (
        <View style={styles.debugSection}>
          <Text style={styles.debugTitle}>Auth Debug Info</Text>
          <Text style={styles.debugLabel}>device_id:</Text>
          <Text style={styles.debugValue} selectable>{debug.deviceId}</Text>
          <Text style={styles.debugLabel}>code:</Text>
          <Text style={styles.debugValue} selectable>{debug.code}</Text>
          <Text style={styles.debugLabel}>code_verifier:</Text>
          <Text style={styles.debugValue} selectable>{debug.codeVerifier}</Text>
        </View>
      )}

      <Pressable style={styles.button} onPress={handleLogout}>
        <Text style={styles.buttonText}>Logout</Text>
      </Pressable>
    </ScrollView>
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  profile: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    width: '100%',
    marginBottom: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  name: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  info: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  debugSection: {
    backgroundColor: '#fff3e0',
    padding: 16,
    borderRadius: 12,
    width: '100%',
    marginBottom: 30,
    borderWidth: 1,
    borderColor: '#ffcc80',
  },
  debugTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    color: '#e65100',
  },
  debugLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#bf360c',
    marginTop: 8,
  },
  debugValue: {
    fontSize: 12,
    color: '#333',
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  button: {
    backgroundColor: '#e53935',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
