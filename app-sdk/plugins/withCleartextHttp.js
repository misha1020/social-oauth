const { withAndroidManifest } = require("@expo/config-plugins");

function withCleartextHttp(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application[0];
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
}

module.exports = withCleartextHttp;
