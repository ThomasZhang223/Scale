// A GLB preview built on expo-gl + raw three, via @react-three/fiber's
// native renderer — @react-three/fiber's own package.json has a
// "react-native" entry point that Metro follows automatically for a bare
// `@react-three/fiber` import, and that native build wires up an expo-gl
// GLView on its own. Not expo-three: it was last published in 2024 against
// three ^0.166, and three here is 0.186.
//
// ceiling: UNVERIFIED ON A DEVICE. This file exists to answer the
// hour-boxed spike in .claude/workstreams/thomas.md's cut list (item 1) —
// @react-three/fiber has an open blank-render issue on the New
// Architecture, pmndrs/react-three-fiber#3399 — but the session that wrote
// it had no way to run that spike: Xcode here is 16.4 (Expo SDK 57 needs
// 26.4 to even compile — CLAUDE.local.md), no simulator runtime is
// installed, and no device is attached. That failure mode is a genuinely
// blank Canvas, not a thrown error, so no amount of try/catch in this file
// can stand in for actually looking at a screen. Separately,
// fixtures/mesh-macbook.glb doesn't exist yet either (mesh-macbook.README.md
// — pending from Ani) and fixtures/object-macbook.json's glbUrl points at
// a non-resolving placeholder domain, so there is nothing real to load
// against yet regardless of the Xcode gap.
//
// Written to spec against the documented APIs and believed correct, but
// treat it as unverified until someone with a real device and a real GLB
// confirms it draws something. app/object/[id].tsx wires in
// StaticThumbnail.tsx instead, which needs no WebGL context at all —
// swap this in only after that confirmation, not on the strength of this
// comment.
import { Suspense, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type GlbPreviewProps = {
  glbUrl: string;
  bboxMeters: { w: number; h: number; d: number };
};

export function GlbPreview({ glbUrl, bboxMeters }: GlbPreviewProps) {
  const cameraPosition = useMemo(() => cameraPositionFor(bboxMeters), [bboxMeters]);

  return (
    <View style={styles.container}>
      <Canvas
        camera={{ position: cameraPosition, fov: 40 }}
        onCreated={({ gl }) => {
          // Plan section 5: NeutralToneMapping, not ACESFilmic — ACES
          // desaturates and warm-shifts midtones, which is exactly the
          // wrong thing when the pitch is "this colour matches the real
          // object".
          gl.toneMapping = THREE.NeutralToneMapping;
        }}
      >
        <SceneEnvironment />
        <ambientLight intensity={0.4} />
        <directionalLight position={[2, 4, 2]} intensity={1.2} />
        <ContactShadow bboxMeters={bboxMeters} />
        <MeasuredBoxWireframe bboxMeters={bboxMeters} />
        <Suspense fallback={null}>
          <GltfModel url={glbUrl} />
        </Suspense>
      </Canvas>
    </View>
  );
}

function cameraPositionFor({ w, h, d }: { w: number; h: number; d: number }): [number, number, number] {
  const diagonal = Math.sqrt(w * w + h * h + d * d) || 1;
  return [diagonal * 0.9, diagonal * 0.7 + h / 2, diagonal * 0.9];
}

function SceneEnvironment() {
  // Plan section 5, ranked #1 visual win: RoomEnvironment + PMREMGenerator,
  // about six lines, ships inside three, no HDR file to fetch over the
  // venue network. Wrapped defensively — PMREMGenerator leans on
  // render-target and mipmap support that may not be complete through
  // expo-gl's GL context, and a lighting setup failing should degrade to
  // flat ambient light, never blank the whole preview.
  const { gl, scene } = useThree();
  useEffect(() => {
    try {
      const pmrem = new THREE.PMREMGenerator(gl);
      const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTexture;
      return () => {
        pmrem.dispose();
        envTexture.dispose();
      };
    } catch {
      return undefined;
    }
  }, [gl, scene]);
  return null;
}

function MeasuredBoxWireframe({ bboxMeters }: { bboxMeters: { w: number; h: number; d: number } }) {
  // Plan section 5, item 3: "it IS the pitch — the visible claim that the
  // size is real." Origin at bottom-centre, matching the mesh
  // normalisation contract, so it sits exactly where the GLB lands once it
  // loads rather than floating relative to it.
  const geometry = useMemo(
    () => new THREE.BoxGeometry(bboxMeters.w, bboxMeters.h, bboxMeters.d),
    [bboxMeters.w, bboxMeters.h, bboxMeters.d]
  );
  return (
    <lineSegments position={[0, bboxMeters.h / 2, 0]}>
      <edgesGeometry args={[geometry]} />
      <lineBasicMaterial color="#3a86ff" />
    </lineSegments>
  );
}

function ContactShadow({ bboxMeters }: { bboxMeters: { w: number; h: number; d: number } }) {
  // Plan section 5, item 2: "without one the object visibly floats,
  // which destroys the true-scale illusion faster than any lighting
  // error." A flat translucent disc rather than real shadow-mapping
  // (renderer.shadowMap + castShadow/receiveShadow) — same visual cue,
  // with no dependency on the light/shadow pipeline actually working
  // through expo-gl.
  const radius = Math.max(bboxMeters.w, bboxMeters.d) * 0.7;
  return (
    <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[radius, 32]} />
      <meshBasicMaterial color="#000000" transparent opacity={0.18} />
    </mesh>
  );
}

function GltfModel({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url);

  useEffect(() => {
    // Plan section 5, "Tame the generated material on load": clamp
    // metalness near zero and roughness to at least 0.75. The glTF spec
    // default for an unset metallicFactor is 1.0, which renders nearly
    // black without an environment map — TRELLIS 1.x never writes it.
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
        child.material.metalness = Math.min(child.material.metalness, 0.05);
        child.material.roughness = Math.max(child.material.roughness, 0.75);
      }
    });
  }, [gltf]);

  return <primitive object={gltf.scene} />;
}

const styles = StyleSheet.create({
  container: {
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
});
