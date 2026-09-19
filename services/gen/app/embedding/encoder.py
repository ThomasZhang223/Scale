"""One pinned CPU encoder. No network downloads during normal service loading."""

import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import threading
import time

from .config import MODEL_ID, REVISION, DIMENSION, MAX_BATCH, POLICY, RUNTIME_PINS
from .preprocess import decode_image, normalize_text, content_hash, InputError


class EncoderBusy(RuntimeError):
    pass


class EncoderInvariantError(RuntimeError):
    pass


def canonical_json(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def normalize_features(features, count):
    import torch
    if not isinstance(features, torch.Tensor) or tuple(features.shape) != (count, DIMENSION):
        raise EncoderInvariantError("Unexpected feature type or shape")
    values = features.detach().to(device="cpu", dtype=torch.float32)
    norms = torch.linalg.vector_norm(values, ord=2, dim=-1, keepdim=True)
    if not torch.isfinite(values).all() or not torch.isfinite(norms).all() or (norms <= 1e-12).any():
        raise EncoderInvariantError("Nonfinite or zero embedding")
    values = values / norms
    if not torch.isfinite(values).all() or not torch.allclose(
        torch.linalg.vector_norm(values, dim=-1), torch.ones(count), atol=1e-5, rtol=0
    ):
        raise EncoderInvariantError("Embedding normalization failed")
    return values.numpy().copy()


class SiglipEncoder:
    def __init__(self, cache_dir):
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModel, AutoTokenizer, SiglipImageProcessor, SiglipProcessor

        started = time.perf_counter()
        versions = {name: importlib.metadata.version(name) for name in RUNTIME_PINS}
        if versions != RUNTIME_PINS or platform.python_version() != "3.11.9":
            raise EncoderInvariantError("Runtime differs from the pinned B03 environment")
        self.snapshot = Path(snapshot_download(MODEL_ID, revision=REVISION, cache_dir=cache_dir,
                                              local_files_only=True, token=False))
        if self.snapshot.name != REVISION:
            raise EncoderInvariantError("Unexpected checkpoint revision")
        self.image_processor = SiglipImageProcessor.from_pretrained(self.snapshot, local_files_only=True)
        self.tokenizer = AutoTokenizer.from_pretrained(self.snapshot, use_fast=True,
                                                       trust_remote_code=False, local_files_only=True)
        self._validate_processors()
        self.processor = SiglipProcessor(image_processor=self.image_processor, tokenizer=self.tokenizer)
        torch.set_num_threads(4)
        self.model = AutoModel.from_pretrained(self.snapshot, trust_remote_code=False,
                                               use_safetensors=True, local_files_only=True,
                                               torch_dtype=torch.float32, attn_implementation="eager")
        self.model.to("cpu").eval()
        if type(self.model).__name__ != "SiglipModel" or self.model.config.model_type != "siglip":
            raise EncoderInvariantError("Checkpoint did not resolve to SiglipModel")
        cfg = self.model.config
        if (cfg.text_config.hidden_size != DIMENSION or cfg.vision_config.hidden_size != DIMENSION
                or cfg.text_config.max_position_embeddings != 64
                or cfg.text_config.vocab_size != 256000
                or cfg.vision_config.image_size != 224 or cfg.vision_config.patch_size != 16):
            raise EncoderInvariantError("Checkpoint architecture does not match the baseline")
        assets = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in sorted(self.snapshot.iterdir())
                  if p.suffix == ".json" or p.name == "tokenizer.model"}
        self.provenance = {
            "checkpoint": MODEL_ID, "revision": REVISION,
            "processor_revision": REVISION, "tokenizer_revision": REVISION,
            "model_class": type(self.model).__name__,
            "vision_class": type(self.model.vision_model).__name__,
            "text_class": type(self.model.text_model).__name__,
            "processor_class": type(self.processor).__name__,
            "image_processor_class": type(self.image_processor).__name__,
            "tokenizer_class": type(self.tokenizer).__name__,
            "tokenizer_eos_id": self.tokenizer.eos_token_id,
            "tokenizer_pad_id": self.tokenizer.pad_token_id,
            "assets_sha256": assets, "versions": versions,
            "python": platform.python_version(), "platform": platform.system(),
            "machine": platform.machine(), "torch_threads": torch.get_num_threads(),
            "attention_implementation": "eager", "text_attention_mask": "not-passed",
            "policy": POLICY,
        }
        self.fingerprint = hashlib.sha256(canonical_json(self.provenance)).hexdigest()
        self.load_seconds = time.perf_counter() - started
        self._lock = threading.Lock()

    def _validate_processors(self):
        p, t = self.image_processor, self.tokenizer
        if (type(p).__name__ != "SiglipImageProcessor" or p.size != {"height": 224, "width": 224}
                or int(p.resample) != 2 or not p.do_resize or not p.do_rescale or not p.do_normalize
                or abs(p.rescale_factor - 1 / 255) > 1e-12
                or p.image_mean != [0.5] * 3 or p.image_std != [0.5] * 3):
            raise EncoderInvariantError("Unexpected image preprocessing configuration")
        if (type(t).__name__ != "GemmaTokenizerFast" or not t.is_fast or t.add_bos_token
                or not t.add_eos_token or t.padding_side != "right"
                or t.eos_token_id is None or t.pad_token_id is None):
            raise EncoderInvariantError("Unexpected tokenizer configuration")

    @staticmethod
    def _check_batch(items):
        if not isinstance(items, (list, tuple)) or not 1 <= len(items) <= MAX_BATCH:
            raise InputError("Batch must contain 1 to 8 inputs")

    def _features(self, inputs, modality, count):
        import torch
        if not self._lock.acquire(blocking=False):
            raise EncoderBusy("Encoder busy")
        try:
            with torch.inference_mode():
                if modality == "image":
                    features = self.model.get_image_features(pixel_values=inputs["pixel_values"].to("cpu", torch.float32))
                else:
                    # Checkpoint reference uses padded input_ids without a padding mask.
                    features = self.model.get_text_features(input_ids=inputs["input_ids"].to("cpu"))
                return normalize_features(features, count)
        finally:
            self._lock.release()

    def embed_images(self, images):
        self._check_batch(images)
        decoded = [decode_image(raw) for raw in images]
        inputs = self.image_processor(images=decoded, return_tensors="pt")
        return self._features(inputs, "image", len(images))

    def tokenize(self, texts):
        self._check_batch(texts)
        return self.tokenizer([normalize_text(t) for t in texts], padding="max_length",
                              max_length=64, truncation=True, return_tensors="pt")

    def embed_texts(self, texts):
        return self._features(self.tokenize(texts), "text", len(texts))

    def response(self, *, image=None, text=None):
        if (image is None) == (text is None):
            raise InputError("Supply exactly one image or text")
        if image is not None:
            values = self.embed_images([image])[0]
            digest, modality = content_hash(image), "image"
        else:
            canonical = normalize_text(text)
            values = self.embed_texts([canonical])[0]
            digest, modality = content_hash(canonical.encode("utf-8")), "text"
        return {"values": values.tolist(), "dimension": DIMENSION,
                "fingerprint": self.fingerprint, "inputHash": digest, "modality": modality}
