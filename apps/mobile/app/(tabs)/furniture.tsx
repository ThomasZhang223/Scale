// Furniture — the merchant catalog: Shopify listings Paul's ingest pulled (with the Browserbase
// page pass for stores whose products.json carries no dimensions), each already an Object v1
// with measured metres. Filter by merchant, search by name, tap through to generate 3D and view
// at 1:1.
import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { List, Picker, Text, TextField } from "@expo/ui/swift-ui";
import { font, foregroundStyle, pickerStyle, refreshable, tag } from "@expo/ui/swift-ui/modifiers";

import { GlassHost, GlassSection, glassList } from "../../src/ui/glass";

import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { ObjectRow } from "../../src/ui/ObjectRow";
import { formatPrice, listObjects, merchantsOf, UNLABELLED_MERCHANT } from "../../src/ui/objectsApi";
import type { ObjectV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

const ALL = "__all__";

function matches(o: ObjectV1, merchant: string, query: string): boolean {
  if (merchant !== ALL && (o.merchant ?? UNLABELLED_MERCHANT) !== merchant) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return o.name.toLowerCase().includes(q) || o.category.toLowerCase().includes(q) || (o.caption ?? "").toLowerCase().includes(q);
}

export default function FurnitureScreen() {
  const router = useRouter();
  const [merchant, setMerchant] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  // One fetch of the whole catalog; merchant and text narrow it locally. A few hundred rows is
  // nothing, and it keeps the merchant menu stable while you switch between merchants.
  const [state, retry] = useFetchState(() => listObjects("catalog"), []);

  const objects = state.status === "ready" ? state.data : [];
  const merchants = useMemo(() => merchantsOf(objects), [objects]);
  const shown = useMemo(() => objects.filter((o) => matches(o, merchant, query)), [objects, merchant, query]);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

  return (
    <GlassHost>
      <List modifiers={[...glassList, refreshable(async () => retry())]}>
        <GlassSection>
          <TextField placeholder="Search furniture" onTextChange={setQuery} />
          <Picker
            label="Merchant"
            selection={merchant}
            onSelectionChange={(v) => setMerchant(v)}
            modifiers={[pickerStyle("menu")]}
          >
            <Text modifiers={[tag(ALL)]}>All merchants</Text>
            {merchants.map((m) => (
              <Text key={m} modifiers={[tag(m)]}>
                {m}
              </Text>
            ))}
          </Picker>
        </GlassSection>

        {shown.length === 0 ? (
          <GlassSection divided={false}>
            <EmptyState
              title={objects.length === 0 ? "No listings yet" : "No matches"}
              systemImage="sofa"
              description={
                objects.length === 0
                  ? "Run the merchant ingest and listings appear here with measured dimensions."
                  : "Try another merchant or a shorter search."
              }
            />
          </GlassSection>
        ) : (
          <GlassSection
            title={merchant === ALL ? "All merchants" : merchant}
            footer={
              <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>
                {`${shown.length} listing${shown.length === 1 ? "" : "s"} · ${merchants.length} merchant${merchants.length === 1 ? "" : "s"}`}
              </Text>
            }
          >
            {shown.map((object) => (
              <ObjectRow
                key={object.objectId}
                object={object}
                subtitle={`${object.merchant ?? UNLABELLED_MERCHANT} · ${object.category}`}
                trailing={formatPrice(object.price)}
                onPress={() => router.push({ pathname: "/object/[id]", params: { id: object.objectId } })}
              />
            ))}
          </GlassSection>
        )}
      </List>
    </GlassHost>
  );
}
