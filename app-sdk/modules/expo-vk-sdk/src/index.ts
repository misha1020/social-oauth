import type { AuthCodeResult } from "./ExpoVKSDK.types";

let ExpoVKSDK: any = null;
try {
  ExpoVKSDK = require("expo-modules-core").requireNativeModule("ExpoVKSDK");
} catch {
  // Native module not available (Expo Go) — authorize will throw
}

export async function authorize(
  codeChallenge: string,
  state: string
): Promise<AuthCodeResult> {
  if (!ExpoVKSDK) {
    throw new Error(
      "VK SDK is not available in Expo Go. Use a development build or release APK."
    );
  }
  return ExpoVKSDK.authorize(codeChallenge, state);
}
