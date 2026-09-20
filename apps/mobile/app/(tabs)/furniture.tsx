// Furniture — the merchant catalog: Shopify listings Paul's ingest pulled (with the Browserbase
// page pass for stores whose products.json carries no dimensions), each already an Object v1
// with measured metres. Filter by merchant, search by name, tap through to generate 3D and view
// at 1:1.
import { useCallback, useMemo, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { withTabFade } from "../../src/ui/TabFade";

import { Glass } from "../../src/theme/Glass";
import { Card } from "../../src/ui/Card";
import { colors, radius, spacing } from "../../src/theme/tokens";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { ObjectCard } from "../../src/ui/ObjectCard";
import { formatPrice, listObjects, merchantsOf, UNLABELLED_MERCHANT } from "../../src/ui/objectsApi";
import { merchantName } from "../../src/ui/catalogImages";
import { PageHeading } from "../../src/ui/Logo";
import type { ObjectV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

function matches(o: ObjectV1, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    o.name.toLowerCase().includes(q) ||
    o.category.toLowerCase().includes(q) ||
    merchantName(o.merchant ?? UNLABELLED_MERCHANT).toLowerCase().includes(q) ||
    (o.caption ?? "").toLowerCase().includes(q)
  );
}

function FurnitureScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // One fetch of the whole catalog; merchant and text narrow it locally. A few hundred rows is
  // nothing, and it keeps the merchant menu stable while you switch between merchants.
  const [state, retry] = useFetchState(() => listObjects("catalog"), []);

  useFocusEffect(
    useCallback(() => {
      retry();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const objects = state.status === "ready" ? state.data : [];
  const merchants = useMemo(() => merchantsOf(objects), [objects]);
  const shown = useMemo(() => objects.filter((o) => matches(o, query)), [objects, query]);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      stickyHeaderIndices={[1]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={retry} />}
    >
      <PageHeading title="Furniture" />

      {/* Glass works here because the list scrolls under it. Merchant filtering
          is by text now: type a merchant's name and its rows match. */}
      {/* Sticky, so the listings slide underneath it — that motion is what
          makes Liquid Glass read as glass. A faint white tint and a bright
          hairline give it an edge even before anything scrolls. */}
      <View style={styles.searchWrap}>
        <Glass style={styles.searchPill} glassEffectStyle="clear" tintColor="rgba(255,255,255,0.18)" isInteractive>
          <SymbolView name="magnifyingglass" size={17} tintColor="rgba(60,60,67,0.55)" weight="semibold" />
          <TextInput
            placeholder="Search furniture"
            placeholderTextColor="rgba(60,60,67,0.45)"
            value={query}
            onChangeText={setQuery}
            style={styles.search}
            clearButtonMode="while-editing"
            autoCorrect={false}
          />
        </Glass>
      </View>

      {shown.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{objects.length === 0 ? "No listings yet" : "No matches"}</Text>
          <Text style={styles.emptyText}>
            {objects.length === 0
              ? "Run the merchant ingest and listings appear here with measured dimensions."
              : "Try a shorter search."}
          </Text>
        </View>
      ) : (
        <Card style={styles.card}>
          {shown.map((object, i) => (
            <View key={object.objectId} style={i > 0 && styles.divider}>
              <ObjectCard
                object={object}
                subtitle={`${merchantName(object.merchant ?? UNLABELLED_MERCHANT)} · ${object.category}`}
                trailing={formatPrice(object.price)}
                onPress={() => router.push({ pathname: "/object/[id]", params: { id: object.objectId } })}
              />
            </View>
          ))}
        </Card>
      )}
      <Text style={styles.footer}>
        {`${shown.length} listing${shown.length === 1 ? "" : "s"} · ${merchants.length} merchant${merchants.length === 1 ? "" : "s"}`}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  heading: { fontSize: 34, fontWeight: "700", color: "#1c1c1e", letterSpacing: 0.2, paddingHorizontal: 4, paddingTop: spacing.sm, marginBottom: 4 },
  card: {},
  searchWrap: { paddingVertical: 6, backgroundColor: "transparent", overflow: "visible" },
  searchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 999,
    overflow: "hidden",
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.95)",
    shadowColor: "#1c1c1e",
    shadowOpacity: 0.14,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
  },
  search: { flex: 1, fontSize: 17, color: "#1c1c1e", paddingVertical: 16 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(60,60,67,0.18)" },
  footer: { fontSize: 13, color: colors.textMuted, paddingHorizontal: 10, paddingTop: 4 },
  empty: { alignItems: "center", padding: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#1c1c1e" },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
});

export default withTabFade(FurnitureScreen);
