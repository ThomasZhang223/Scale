import { GLView } from "expo-gl";
import { useLocalSearchParams } from "expo-router";
import ExpoQuickLook from "@magrinj/expo-quick-look";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import * as THREE from "three";

import { getJSON } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme/tokens";

interface ObjectSummary {
  objectId: string;
  bboxMeters: { w: number; h: number; d: number };
  palette: string[];
  usdzUrl: string | null;
}

// True AR placement when a generated USDZ exists (@magrinj/expo-quick-look
// over the real mesh, with RealityKit's own environment lighting and
// grounding shadow — see plan section 5, "phone AR gets its lighting for
// free"). Falls back to a plain 3D preview, sized and coloured, while the
// mesh is still generating.
export default function ArObjectScreen() {
  const { objectId } = useLocalSearchParams<{ objectId: string }>();
  const [object, setObject] = useState<ObjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!objectId) return;
    getJSON<ObjectSummary>(`/objects/${objectId}`)
      .then(setObject)
      .catch((e: Error) => setError(e.message));
  }, [objectId]);

  useEffect(() => {
    if (!object?.usdzUrl) return;
    ExpoQuickLook.previewFile({ uri: object.usdzUrl }).catch((e: Error) => setError(e.message));
  }, [object?.usdzUrl]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!object) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (object.usdzUrl) {
    // QuickLook owns its own full-screen presentation; nothing to render
    // underneath it once previewFile() has been called.
    return <View style={styles.center} />;
  }

  return <BoxPreview bboxMeters={object.bboxMeters} palette={object.palette} />;
}

// ceiling: not real AR — no camera passthrough, no true-scale placement.
// Building solid-box AR placement would mean extending
// modules/object-measure's native view with a tap-to-place, filled-material
// mode (it already has the ARSession + box-rendering plumbing for the
// wireframe). That is real work, scoped out of this pass since it is only
// the fallback for an object whose mesh has not generated yet. This is a
// true-to-scale 3D preview instead, using the expo-gl + raw three.js
// pairing the plan calls for (expo-three is skipped as unmaintained).
// Untested on a real device or simulator.
function BoxPreview({ bboxMeters, palette }: { bboxMeters: ObjectSummary["bboxMeters"]; palette: string[] }) {
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <View style={StyleSheet.absoluteFill}>
      <GLView
        style={StyleSheet.absoluteFill}
        onContextCreate={(gl) => {
          const renderer = new THREE.WebGLRenderer({
            context: gl as unknown as WebGLRenderingContext,
            alpha: true,
          });
          renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
          renderer.setPixelRatio(1);

          const scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera(
            50,
            gl.drawingBufferWidth / gl.drawingBufferHeight,
            0.01,
            10
          );
          const maxDim = Math.max(bboxMeters.w, bboxMeters.h, bboxMeters.d);
          camera.position.set(maxDim * 1.4, maxDim * 1.1, maxDim * 1.4);
          camera.lookAt(0, 0, 0);

          scene.add(new THREE.AmbientLight(0xffffff, 0.6));
          const key = new THREE.DirectionalLight(0xffffff, 0.8);
          key.position.set(2, 3, 2);
          scene.add(key);

          const color = palette[0] ?? "#8e8e93";
          const geometry = new THREE.BoxGeometry(bboxMeters.w, bboxMeters.h, bboxMeters.d);
          // Untreated PBR defaults render nearly black with no environment
          // map (plan section 5) — this box uses a plain Lambert material
          // instead, which needs no environment map to look reasonable.
          const material = new THREE.MeshLambertMaterial({ color });
          const box = new THREE.Mesh(geometry, material);
          box.position.y = bboxMeters.h / 2; // origin at bottom-centre, per the mesh normalisation contract
          scene.add(box);

          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.4, transparent: true })
          );
          edges.position.copy(box.position);
          scene.add(edges);

          const render = () => {
            frameRef.current = requestAnimationFrame(render);
            box.rotation.y += 0.006;
            edges.rotation.y = box.rotation.y;
            renderer.render(scene, camera);
            gl.endFrameEXP();
          };
          render();
        }}
      />
      <View style={styles.fallbackBadge}>
        <Text style={styles.fallbackBadgeText}>
          Preview only — mesh still generating ({(bboxMeters.w * 100).toFixed(0)}×
          {(bboxMeters.h * 100).toFixed(0)}×{(bboxMeters.d * 100).toFixed(0)} cm)
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "black" },
  errorText: { color: colors.danger, padding: spacing.lg, textAlign: "center" },
  fallbackBadge: {
    position: "absolute",
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    alignItems: "center",
  },
  fallbackBadgeText: { color: "white", fontSize: 12, opacity: 0.8, textAlign: "center" },
});
