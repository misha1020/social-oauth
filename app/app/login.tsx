import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView
} from "react-native";
import { useVKAuth } from "../src/hooks/useVKAuth";
import { useAuth } from "../src/hooks/useAuth";
import { router } from "expo-router";

export default function LoginScreen() {
  const { login, isLoading: authLoading, error: authError } = useAuth();
  const {
    preparePKCE,
    continueAuth,
    pkceParams,
    isLoading: vkLoading,
    isReady,
    error: vkError
  } = useVKAuth(async ({ token }) => {
    await login({ token });
    router.replace("/home");
  });

  const isLoading = authLoading || vkLoading;
  const error = vkError || authError;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>VK OAuth Demo 1</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!pkceParams && (
        <Pressable
          style={[
            styles.button,
            (!isReady || isLoading) && styles.buttonDisabled
          ]}
          onPress={() => preparePKCE()}
          disabled={!isReady || isLoading}
        >
          <Text style={styles.buttonText}>Sign in with VK</Text>
        </Pressable>
      )}

      {pkceParams && (
        <>
          <View style={styles.debugSection}>
            <Text style={styles.debugTitle}>Generated PKCE Params</Text>
            <Text style={styles.debugLabel}>code_verifier:</Text>
            <Text style={styles.debugValue} selectable>
              {pkceParams.codeVerifier}
            </Text>
            <Text style={styles.debugLabel}>code_challenge:</Text>
            <Text style={styles.debugValue} selectable>
              {pkceParams.codeChallenge}
            </Text>
            <Text style={styles.debugLabel}>state:</Text>
            <Text style={styles.debugValue} selectable>
              {pkceParams.state}
            </Text>
          </View>

          <Pressable
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={() => continueAuth()}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Continue to VK</Text>
            )}
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: "#f5f5f5"
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 40
  },
  button: {
    backgroundColor: "#4680C2",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: "center"
  },
  buttonDisabled: {
    opacity: 0.6
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600"
  },
  error: {
    color: "red",
    marginBottom: 16,
    textAlign: "center"
  },
  debugSection: {
    backgroundColor: "#e3f2fd",
    padding: 16,
    borderRadius: 12,
    width: "100%",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "#90caf9"
  },
  debugTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    color: "#1565c0"
  },
  debugLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#0d47a1",
    marginTop: 8
  },
  debugValue: {
    fontSize: 12,
    color: "#333",
    fontFamily: "monospace",
    marginBottom: 4
  }
});
