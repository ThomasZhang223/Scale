"""Versioned baseline shared by acquisition, inference, tests and fingerprints."""

MODEL_ID = "google/siglip2-base-patch16-224"
REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
DIMENSION = 768
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_SIDE = 8192
MAX_TEXT_BYTES = 4096
MAX_BATCH = 8
MAX_BODY_BYTES = 14 * 1024 * 1024
FILES = ["config.json", "preprocessor_config.json", "tokenizer.json",
         "tokenizer_config.json", "special_tokens_map.json", "tokenizer.model",
         "model.safetensors"]
RUNTIME_PINS = {
    "torch": "2.6.0+cpu", "transformers": "4.51.3", "tokenizers": "0.21.1",
    "huggingface-hub": "0.30.2", "safetensors": "0.5.3",
    "sentencepiece": "0.2.0", "numpy": "1.26.4", "Pillow": "11.1.0",
}
POLICY = {
    "version": "ani-siglip-embedding-v1", "image": "exif-transpose;alpha-over-white;RGB;full-frame",
    "resize": [224, 224], "resample": "bilinear", "rescale": 1 / 255,
    "mean": [0.5, 0.5, 0.5], "std": [0.5, 0.5, 0.5],
    "text": "strip;lower;utf8", "text_max_length": 64, "padding": "max_length-right",
    "truncation": True, "add_bos_token": False, "add_eos_token": True,
    "dtype": "float32", "device": "cpu", "normalization": "l2-float32-v1",
    "image_features": "get_image_features", "text_features": "get_text_features",
}
