import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

// ceiling: no SSE provider wired here yet. The route tree in the plan (section
// 8) puts one at this level, but it lives in src/lib/sse.ts, which is Panel
// B's file and does not exist until Panel B's first commit. Wrap <Stack> with
// it once that lands.
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
