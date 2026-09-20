"""B01 raw SF3D feasibility wrapper. Heavy imports/downloads occur only in load."""

import hashlib
import os
from pathlib import Path
import platform
import sys
import threading
import time
import uuid

if __package__:
    from .transport import artifact_response, decode_request
    from .telemetry import Timings, profile_sf3d
else:
    # Truss 0.18.30 loads this file with an empty package from /app.
    from model.transport import artifact_response, decode_request
    from model.telemetry import Timings, profile_sf3d

SOURCE_REVISION = "ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2"
MODEL_REVISION = "f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778"
DINO_REVISION = "47b73eefe95e8d44ec3623f8890bd894b6ea2d6c"
CLIP_REVISION = "1a25a446712ba5ee05982a381eed697ef9b435cf"
SETTINGS = {"foreground_ratio": 0.85, "texture_resolution": 1024,
            "remesh": "none", "vertex_count": -1, "dtype": "cuda-bfloat16-autocast"}
REVISIONS = {"sf3d_source": SOURCE_REVISION, "sf3d_weights": MODEL_REVISION,
             "dinov2": DINO_REVISION, "open_clip": CLIP_REVISION,
             "rembg": "2.0.57", "u2net_md5": "60024c5c889badc19c04ad937298a77b"}


def validate_bake_resolution(value):
    if type(value) is not int or value not in (512, 1024):
        raise ValueError("Bake resolution must be 512 or 1024")
    return value


class CudaRuntime:
    def __init__(self, token):
        startup = Timings()
        started = time.perf_counter()
        import torch
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("This candidate requires a Linux CUDA GPU with bfloat16 support")
        if platform.system() != "Linux":
            raise RuntimeError("This candidate is Linux-only")
        from huggingface_hub import snapshot_download, hf_hub_download
        from omegaconf import OmegaConf
        from safetensors.torch import load_model
        import rembg

        # Explicit snapshots: no main-branch alias may choose secondary weights.
        with startup.stage("checkpoint_lookup_download"):
            primary = Path(snapshot_download("stabilityai/stable-fast-3d", revision=MODEL_REVISION,
                       allow_patterns=["config.yaml", "model.safetensors"], token=token))
            dino = snapshot_download("facebook/dinov2-large", revision=DINO_REVISION,
                                 allow_patterns=["config.json", "model.safetensors"], token=token)
            clip = hf_hub_download("laion/CLIP-ViT-B-32-laion2B-s34B-b79K",
                              "open_clip_pytorch_model.bin", revision=CLIP_REVISION, token=token)
        cfg = OmegaConf.load(primary / "config.yaml")
        OmegaConf.resolve(cfg)
        # Gated config was not available during B01: fail loudly on another architecture.
        if cfg.image_tokenizer_cls != "sf3d.models.tokenizers.image.DINOV2SingleImageTokenizer":
            raise RuntimeError("Unexpected SF3D image tokenizer; inspect the pinned config")
        if cfg.image_estimator_cls != "sf3d.models.image_estimator.clip_based_estimator.ClipBasedHeadEstimator":
            raise RuntimeError("Unexpected SF3D image estimator; inspect the pinned config")
        if cfg.image_estimator.get("model", "ViT-B-32") != "ViT-B-32":
            raise RuntimeError("Unexpected OpenCLIP architecture")
        cfg.image_tokenizer.pretrained_model_name_or_path = dino
        cfg.image_estimator.pretrain = clip
        sys.path.insert(0, "/opt/sf3d")
        from sf3d.system import SF3D
        from sf3d.utils import remove_background, resize_foreground
        self.torch = torch
        self.remove_background = remove_background
        self.resize_foreground = resize_foreground
        # Same construction/load_model sequence as upstream from_pretrained,
        # with only the secondary checkpoint paths replaced by pinned local files.
        with startup.stage("model_construction_including_secondary_checkpoints"):
            self.model = SF3D(cfg)
        with startup.stage("primary_checkpoint_deserialization"):
            load_model(self.model, str(primary / "model.safetensors"))
        with startup.stage("model_to_cuda_initialization"):
            self.model.to("cuda").eval()
            torch.cuda.synchronize()
        # CPU rembg is deliberate: predictable provider and no cuDNN search-path ambiguity.
        # SF3D remains on GPU. Keep one session loaded for every request.
        with startup.stage("rembg_u2net_session"):
            self.session = rembg.new_session("u2net", providers=["CPUExecutionProvider"])
        u2net_path = Path(os.environ.get("U2NET_HOME", str(Path.home() / ".u2net"))) / "u2net.onnx"
        if hashlib.md5(u2net_path.read_bytes()).hexdigest() != REVISIONS["u2net_md5"]:
            raise RuntimeError("Unexpected U2NET checkpoint checksum")
        self.info = {"python": platform.python_version(), "torch": torch.__version__,
                     "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
                     "onnx_providers": self.session.inner_session.get_providers(),
                     "cond_image_size": int(cfg.cond_image_size),
                     "u2net_sha256": hashlib.sha256(u2net_path.read_bytes()).hexdigest()}
        self.info["startup_stages"] = startup.stages
        self.info["runtime_init_ms"] = (time.perf_counter() - started) * 1000
        self.info["replica_id"] = uuid.uuid4().hex
        self.profile = True

    def generate(self, image, bake_resolution=1024):
        validate_bake_resolution(bake_resolution)
        from contextlib import nullcontext
        start = time.perf_counter()
        t = self.torch
        timers = Timings(t.cuda.synchronize)
        rembg_ran = not (image.mode == "RGBA" and image.getextrema()[3][0] < 255)
        helper = getattr(self.model, "isosurface_helper", None)
        cached = helper is not None and helper._all_edges is not None
        with timers.stage("background_alpha_decision"):
            image = self.remove_background(image, self.session)
        alpha = image.getchannel("A")
        box = alpha.point(lambda v: 255 if v > 127 else 0).getbbox()
        if box is None or min(box[2] - box[0], box[3] - box[1]) < 2:
            raise ValueError("Empty or degenerate foreground mask")
        with timers.stage("foreground_crop_pad"):
            image = self.resize_foreground(image, SETTINGS["foreground_ratio"])
        prep_end = time.perf_counter()
        t.cuda.synchronize()
        t.cuda.reset_peak_memory_stats()
        hooks = profile_sf3d(self.model, timers) if getattr(self, "profile", False) else nullcontext()
        with hooks, t.inference_mode(), t.autocast(device_type="cuda", dtype=t.bfloat16):
            mesh, _ = self.model.run_image(image, bake_resolution=bake_resolution,
                                          remesh="none", vertex_count=-1)
        t.cuda.synchronize()
        gen_end = time.perf_counter()
        if not len(mesh.vertices) or not len(mesh.faces):
            raise ValueError("SF3D returned an empty mesh")
        with timers.stage("glb_export"):
            raw = mesh.export(file_type="glb", include_normals=True)
        return raw, {"preprocess_ms": (prep_end - start) * 1000,
                     "generate_bake_ms": (gen_end - prep_end) * 1000,
                     "export_ms": (time.perf_counter() - gen_end) * 1000,
                     "peak_cuda_bytes": t.cuda.max_memory_allocated(),
                     "stages": timers.stages, "rembg_ran": rembg_ran,
                     "all_edges_cached_before": cached,
                     "vertices": len(mesh.vertices), "faces": len(mesh.faces), "glb_bytes": len(raw),
                     "timing_method": "coarse completed CUDA wall boundaries; nested totals inclusive",
                     "unseparated": ["normal-map inline tensor assembly (tangents separately timed)",
                                     "rasterizer native BVH setup included in rasterize",
                                     "scalar GPU transfers and inline mesh transforms"]}


class Model:
    def __init__(self, **kwargs):
        self._secrets = kwargs.get("secrets", {})
        self._runtime = None
        self._lock = threading.Lock()
        self._ordinal = 0
        self._allow_profile_override = os.environ.get("SF3D_PROFILE_ALLOW_BAKE_OVERRIDE") == "1"

    def load(self):
        with self._lock:
            if self._runtime is None:
                token = self._secrets.get("hf_access_token")
                if not token:
                    raise RuntimeError("Configure the hf_access_token runtime secret after access approval")
                started = time.perf_counter()
                self._runtime = CudaRuntime(token)
                self._runtime.info["model_load_ms"] = (time.perf_counter() - started) * 1000
                print("SF3D load complete", self._runtime.info["model_load_ms"], "ms", flush=True)

    def predict(self, model_input):
        if self._runtime is None:
            raise RuntimeError("SF3D is not loaded")
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("SF3D is busy; one request at a time")
        try:
            start = time.perf_counter()
            requested_bake = SETTINGS["texture_resolution"]
            if self._allow_profile_override and isinstance(model_input, dict) and "_profile_bake_resolution" in model_input:
                model_input = dict(model_input)
                requested_bake = validate_bake_resolution(model_input.pop("_profile_bake_resolution"))
            diagnostics = {}
            image, input_hash = decode_request(model_input, diagnostics=diagnostics)
            decode_ms = (time.perf_counter() - start) * 1000
            self._ordinal += 1
            raw, timings = (self._runtime.generate(image) if requested_bake == 1024 else
                            self._runtime.generate(image, bake_resolution=requested_bake))
            settings = {**SETTINGS, "texture_resolution": requested_bake}
            diagnostics.update(requested_bake_resolution=requested_bake, effective_bake_resolution=requested_bake)
            response_started = time.perf_counter()
            response = artifact_response(raw, input_hash, revisions=REVISIONS, settings=settings,
                                     runtime=self._runtime.info,
                                     timings={"decode_ms": decode_ms, **timings, **diagnostics,
                                              "request_ordinal": self._ordinal})
            response["timings"]["response_base64_validation_serialization_ms"] = (time.perf_counter() - response_started) * 1000
            response["timings"]["server_total_ms"] = (time.perf_counter() - start) * 1000
            return response
        finally:
            self._lock.release()
