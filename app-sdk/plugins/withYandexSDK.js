const {
  withAppBuildGradle,
  withInfoPlist,
} = require("@expo/config-plugins");

function withYandexSDK(config, { clientId }) {
  if (!clientId) throw new Error("withYandexSDK: clientId is required");

  // Android: the Yandex SDK's bundled AndroidManifest declares
  //   <meta-data android:name="com.yandex.auth.CLIENT_ID" android:value="${YANDEX_CLIENT_ID}"/>
  // (and deep-link entries that interpolate the same placeholder). We supply the placeholder
  // value via manifestPlaceholders in the host app's build.gradle.
  config = withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('manifestPlaceholders["YANDEX_CLIENT_ID"]')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /(defaultConfig\s*\{)/,
        `$1\n        manifestPlaceholders["YANDEX_CLIENT_ID"] = "${clientId}"`
      );
    }
    return cfg;
  });

  // iOS: register yx<clientId> URL scheme + Info.plist YandexClientID key.
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.YandexClientID = clientId;
    const scheme = `yx${clientId}`;
    cfg.modResults.CFBundleURLTypes = cfg.modResults.CFBundleURLTypes || [];
    const exists = cfg.modResults.CFBundleURLTypes.some((t) =>
      (t.CFBundleURLSchemes || []).includes(scheme)
    );
    if (!exists) {
      cfg.modResults.CFBundleURLTypes.push({
        CFBundleURLSchemes: [scheme],
      });
    }
    return cfg;
  });

  return config;
}

module.exports = withYandexSDK;
