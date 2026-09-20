import { router } from "expo-router";
import ExpoQuickLook from "@magrinj/expo-quick-look";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ObjectCaptureModule, ObjectCaptureView } from "../../modules/object-capture";
import type { ObjectCaptureState, ReconstructionResult } from "../../modules/object-capture";
import { ApiError, postJSON, putUpload } from "../../src/lib/api";
import { CameraGlass, GlassButton, GlassCloseButton } from "../../src/theme/Glass";
import { colors, spacing } from "../../src/theme/tokens";
import { BuildProgress } from "../../src/ui/BuildProgress";
import { saveObjectPhoto, saveObjectUsdz } from "../../src/ui/objectFiles";
import { Logo } from "../../src/ui/Logo";
import { Readout, ReadoutHint } from "../../src/ui/Readout";

type Phase = ObjectCaptureState | "reconstructing" | "done" | "saving";

// Apple's Object Capture orbit, hosted in modules/object-capture. Apple draws
// the camera, the detection box and the capture dial; this screen owns the
// state machine's buttons, the reconstruction progress, and handing the
// finished GLB to the Worker as an Object v1 that is ready on arrival.
export default function CaptureObject3DScreen() {
  const [phase, setPhase] = useState<Phase>("initializing");
  const [feedback, setFeedback] = useState<string[]>([]);
  const [shots, setShots] = useState({ taken: 0, max: 0 });
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ReconstructionResult | null>(null);
  const startedRef = useRef(false);
  const phaseRef = useRef<Phase>("initializing");
  phaseRef.current = phase;

  useEffect(() => {
    const subs = [
      ObjectCaptureModule.addListener("onState", ({ state }) => {
        // Once reconstruction has begun, the session's own state no longer
        // drives the screen.
        const p = phaseRef.current;
        if (p === "reconstructing" || p === "done" || p === "saving") return;
        setPhase(state);
      }),
      ObjectCaptureModule.addListener("onFeedback", ({ feedback }) => setFeedback(feedback)),
      ObjectCaptureModule.addListener("onShots", setShots),
      ObjectCaptureModule.addListener("onReconstructionProgress", ({ fraction }) => setProgress(fraction)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    ObjectCaptureModule.isSupported()
      .then((supported) => {
        if (!supported) {
          Alert.alert("Not supported", "Object Capture needs an iPhone 12 Pro or later on iOS 17.", [
            { text: "OK", onPress: () => router.back() },
          ]);
          return;
        }
        return ObjectCaptureModule.startSession();
      })
      .catch((error: Error) => {
        Alert.alert("Could not start", error.message, [{ text: "OK", onPress: () => router.back() }]);
      });
    return () => {
      ObjectCaptureModule.cancelSession().catch(() => {});
    };
  }, []);

  const fail = (title: string, error: unknown) =>
    Alert.alert(title, error instanceof Error ? error.message : String(error));

  const onContinue = useCallback(async () => {
    try {
      await ObjectCaptureModule.startDetecting();
    } catch (e) {
      fail("Could not find the object", e);
    }
  }, []);

  const onStartCapture = useCallback(async () => {
    try {
      await ObjectCaptureModule.startCapturing();
    } catch (e) {
      fail("Could not start capturing", e);
    }
  }, []);

  const onFinish = useCallback(async () => {
    try {
      await ObjectCaptureModule.finishCapture();
      setPhase("reconstructing");
      setProgress(0);
      const r = await ObjectCaptureModule.reconstruct("reduced");
      setResult(r);
      setPhase("done");
    } catch (e) {
      fail("Could not build the model", e);
      setPhase("failed");
    }
  }, []);

  const onRestart = useCallback(async () => {
    setResult(null);
    setShots({ taken: 0, max: 0 });
    try {
      await ObjectCaptureModule.startSession();
    } catch (e) {
      fail("Could not restart", e);
    }
  }, []);

  const onPreview = useCallback(() => {
    if (!result) return;
    ExpoQuickLook.previewFile({ uri: `file://${result.usdzPath}` }).catch((e: Error) => fail("Preview failed", e));
  }, [result]);

  const onSave = useCallback(async () => {
    if (!result) return;
    setPhase("saving");
    try {
      // The object row first (state measured, size from the mesh), then the
      // mesh under its key, then the flip to ready. Three calls, no guessing.
      const object = await postJSON<{ objectId: string }>("/objects", {
        source: "scan",
        name: "Captured object",
        category: "unknown",
        bboxMeters: result.bboxMeters,
        // ceiling: confidence 1 is exact, not estimated — bboxMeters IS this mesh's AABB
        // (ObjectCaptureController.reconstruct, from GLBExporter.export). If a future path estimates instead, this must stop being 1.
        measure: { method: "declared", confidence: 1 },
      });
      // The phone keeps the USDZ for its own preview and AR; the server gets the GLB.
      try {
        saveObjectUsdz(object.objectId, result.usdzPath);
        if (result.photoPath) saveObjectPhoto(object.objectId, result.photoPath);
      } catch {
        // Preview and AR fall back to the measured box for this object.
      }
      const { key, putUrl } = await postJSON<{ key: string; putUrl: string }>("/uploads", {
        kind: "scanMesh",
        objectId: object.objectId,
      });
      await putUpload(result.glbPath, putUrl, "model/gltf-binary");
      // ceiling: no roomId on this screen, so POST /mesh cannot emit the SSE `object` event
      // (postObjectMesh in workers/src/routes/index.ts) and the headset is not told. Upgrade path: carry the
      // active roomId into the capture route and pass it here. Never guess one.
      try {
        await postJSON(`/objects/${object.objectId}/mesh`, { key });
      } catch (e) {
        // ceiling: POST /objects/{id}/mesh ships in workers/ with this screen but the deployed
        // Worker may predate it. The row and the mesh are both stored by now; only the flip to
        // ready is missing. Land on the object page anyway — it shows Measured, and the flip
        // happens once `cd workers && npx wrangler deploy` runs. Only a 404 takes this path.
        if (!(e instanceof ApiError) || !/HTTP 404/.test(e.message)) throw e;
        Alert.alert(
          "Saved, 3D flag pending",
          "The model is uploaded. Marking it ready needs the latest Worker deploy; it will show as Measured until then."
        );
      }
      router.replace(`/object/${object.objectId}`);
    } catch (e) {
      fail("Save failed", e);
      setPhase("done");
    }
  }, [result]);

  const hint = hintFor(phase, feedback);
  // Once the camera session is finished it renders black; from here on the
  // screen is ours: a light build/progress state, then the result.
  const cameraDone = phase === "reconstructing" || phase === "done" || phase === "saving";
  const light = cameraDone;

  return (
    <View style={[styles.screen, light && styles.screenLight]}>
      {cameraDone ? null : <ObjectCaptureView style={StyleSheet.absoluteFill} />}
      {phase === "reconstructing" ? (
        <BuildProgress
          fraction={progress}
          title="Building the model"
          detail="Photogrammetry is running on this phone. A minute or two, depending on how many photos you took."
        />
      ) : null}
      {phase === "saving" ? (
        <BuildProgress fraction={1} title="Saving to your library" detail="Uploading the model to the room server." />
      ) : null}

      <SafeAreaView style={styles.chrome} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          <GlassCloseButton dark={light} onPress={() => router.back()} />
          <Logo size={26} mono={!light} style={styles.mark} />
          {phase === "capturing" && shots.max > 0 ? (
            <CameraGlass style={styles.shotsPill}>
              <Text style={styles.shotsText}>
                {shots.taken}
                <Text style={styles.shotsMax}> / {shots.max} photos</Text>
              </Text>
            </CameraGlass>
          ) : null}
        </View>

        <View style={styles.footer} pointerEvents="box-none">
          {phase === "reconstructing" || phase === "saving" ? null : result && phase === "done" ? (
            <Readout bboxMeters={result.bboxMeters} confidence={1} />
          ) : hint ? (
            <ReadoutHint text={hint} />
          ) : null}

          <View style={styles.actions}>
            {phase === "ready" && <GlassButton label="Continue" icon="viewfinder" prominent onPress={onContinue} />}
            {phase === "detecting" && (
              <>
                <GlassButton label="Reset" icon="arrow.counterclockwise" onPress={onRestart} />
                <GlassButton label="Start capture" icon="camera.fill" prominent onPress={onStartCapture} />
              </>
            )}
            {phase === "capturing" && (
              <GlassButton label="Finish" icon="checkmark" prominent disabled={shots.taken < 10} onPress={onFinish} />
            )}
            {phase === "failed" && <GlassButton label="Try again" icon="arrow.counterclockwise" prominent onPress={onRestart} />}
            {phase === "done" && (
              <>
                <GlassButton label="Preview in AR" icon="arkit" onPress={onPreview} />
                <GlassButton label="Save to library" icon="square.and.arrow.down" prominent onPress={onSave} />
              </>
            )}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

// One line of direction at a time. Apple's feedback wins over the phase
// text while capturing, because it names the reason a shot was refused.
function hintFor(phase: Phase, feedback: string[]): string | null {
  const fb = feedback[0];
  if (phase === "capturing" && fb && FEEDBACK_TEXT[fb]) return FEEDBACK_TEXT[fb];
  switch (phase) {
    case "initializing":
      return "Starting the camera…";
    case "ready":
      return "Put the object on a table and point the camera at it";
    case "detecting":
      return fb && FEEDBACK_TEXT[fb] ? FEEDBACK_TEXT[fb] : "Fit the box around the object, then start";
    case "capturing":
      return "Walk slowly around the object. Keep it in the frame.";
    case "finishing":
      return "Saving photos…";
    case "completed":
      return "Photos saved";
    case "failed":
      return "The capture did not finish";
    default:
      return null;
  }
}

const FEEDBACK_TEXT: Record<string, string> = {
  objectTooClose: "Move back a little",
  objectTooFar: "Move closer",
  movingTooFast: "Slow down",
  environmentLowLight: "Add more light",
  environmentTooDark: "Too dark to capture",
  outOfFieldOfView: "Keep the object in the frame",
  objectNotDetected: "Point at the object",
  overCapturing: "This angle is covered. Move on.",
  objectNotFlippable: "This object can't be flipped",
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "black" },
  screenLight: { backgroundColor: "#f6f8fb" },
  chrome: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" },
  mark: { position: "absolute", left: 0, right: 0, top: spacing.sm + 7, alignSelf: "center", marginHorizontal: "auto" },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  shotsPill: { paddingHorizontal: spacing.md, paddingVertical: 10 },
  shotsText: { color: "white", fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  shotsMax: { color: "rgba(255,255,255,0.6)", fontWeight: "500" },
  footer: {
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  actions: { flexDirection: "row", gap: spacing.sm, justifyContent: "center", flexWrap: "wrap" },
});
