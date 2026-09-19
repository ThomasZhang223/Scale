const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// ceiling: only the two binary formats this app actually bundles or fetches
// as assets — GLB for the three.js preview, USDZ for the QuickLook AR
// fallback box. Add a format here only when a real consumer needs it.
config.resolver.assetExts.push("glb", "usdz");

module.exports = config;
