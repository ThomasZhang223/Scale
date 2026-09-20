import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

// ceiling: no SSE provider wired here yet. The route tree in the plan (section
// 8) puts one at this level, but it lives in src/lib/sse.ts, which is Panel
// B's file and does not exist until Panel B's first commit. Wrap <Stack> with
// it once that lands.
//
// Headers: every pushed page gets the native stack header — glass on iOS 26,
// with the system back button and swipe-back. The three capture screens and
// the tab root opt out; they draw their own close buttons over the camera.
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerShown: true,
            headerBackButtonDisplayMode: "minimal",
            headerShadowVisible: false,
            headerStyle: { backgroundColor: "#e8edf4" },
            headerTintColor: "#1c1c1e",
            contentStyle: { backgroundColor: "#e8edf4" },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="room/[id]" options={{ title: "Room" }} />
          <Stack.Screen name="object/[id]" options={{ title: "Object" }} />
          <Stack.Screen name="ar/[objectId]" options={{ title: "View at 1:1" }} />
          <Stack.Screen name="capture/room" options={{ headerShown: false }} />
          <Stack.Screen name="capture/object" options={{ headerShown: false }} />
          <Stack.Screen name="capture/object3d" options={{ headerShown: false }} />
          <Stack.Screen name="capture/box" options={{ headerShown: false }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
