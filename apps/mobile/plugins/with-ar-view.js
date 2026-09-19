// Config plugin placeholder for the RealityKit ARView (+ USDZ/QuickLook fallback) native module.
// ceiling: identity no-op until the Swift module lands; reserves the app.json slot
// so nobody has to edit app.json again to add it.
module.exports = function withArView(config) {
  return config;
};
