// The wait between a screen mounting and its fetch resolving: the mark assembling on the
// app's backdrop. Shared by every screen that fetches.
import { StyleSheet, View } from "react-native";

import { LogoAnimated } from "./LogoAnimated";

export function LoadingView() {
  return (
    <View style={styles.screen}>
      <LogoAnimated size={140} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4", alignItems: "center", justifyContent: "center" },
});
