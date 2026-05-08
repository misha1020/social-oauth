import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useVKSDKAuth } from "../src/hooks/useVKSDKAuth";
import { useYandexAuth } from "../src/hooks/useYandexAuth";
import { useAuth } from "../src/hooks/useAuth";
import { router } from "expo-router";
import buildVersion from "../build-version.json";

export default function LoginScreen() {
  const { login, isLoading: authLoading, error: authError } = useAuth();
  const {
    promptAsync,
    isLoading: vkLoading,
    isReady,
    error: vkError,
  } = useVKSDKAuth(async ({ token }) => {
    await login({ token });
    router.replace("/home");
  });
  const {
    authorize: yandexAuthorize,
    isLoading: yandexLoading,
    error: yandexError,
  } = useYandexAuth(async ({ token }) => {
    await login({ token });
    router.replace("/home");
  });

  const isLoading = authLoading || vkLoading || yandexLoading;
  const error = vkError || yandexError || authError;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>VK OAuth SDK Demo v{buildVersion.build}</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.button, (!isReady || isLoading) && styles.buttonDisabled]}
        onPress={() => promptAsync()}
        disabled={!isReady || isLoading}
      >
        {vkLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in with VK</Text>
        )}
      </Pressable>

      <Pressable
        style={[styles.yandexButton, isLoading && styles.buttonDisabled]}
        onPress={() => yandexAuthorize()}
        disabled={isLoading}
      >
        {yandexLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in with Yandex</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: "#f5f5f5",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 40,
  },
  button: {
    backgroundColor: "#4680C2",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: "center",
  },
  yandexButton: {
    backgroundColor: "#FC3F1D",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: "center",
    marginTop: 12,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  error: {
    color: "red",
    marginBottom: 16,
    textAlign: "center",
  },
});
