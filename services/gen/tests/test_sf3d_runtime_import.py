"""Exercise Truss 0.18.30's file-loader contract without CUDA or weights."""

from pathlib import Path
import shutil
import subprocess
import sys


PACKAGE = Path(__file__).resolve().parents[1] / "deploy" / "sf3d"


def test_model_imports_as_local_generation_package(tmp_path):
    result = subprocess.run(
        [sys.executable, "-B", "-c", """
import sys
sys.path.insert(0, sys.argv[1])
from deploy.sf3d.model import model, transport
from app.generation_io import SF3DProvider
assert model.decode_request is transport.decode_request
assert model.artifact_response is transport.artifact_response
assert model.Model(secrets={})._runtime is None
assert not any(name in sys.modules for name in ('torch', 'sf3d', 'huggingface_hub'))
""", str(PACKAGE.parents[1])],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_model_imports_with_truss_file_loader(tmp_path):
    # The server runs from /app, with the deployed model/ package beneath it.
    # A fresh interpreter avoids test_sf3d_config's cached model.* imports.
    shutil.copytree(PACKAGE / "model", tmp_path / "model")
    result = subprocess.run(
        [sys.executable, "-B", "-c", """
import importlib.util
from pathlib import Path
import sys

assert 'model' not in sys.modules
module_path = Path('model/model.py').resolve()
# Exact loading sequence in installed Truss 0.18.30 ModelWrapper._load_impl.
spec = importlib.util.spec_from_file_location(module_path.stem, module_path)
module = importlib.util.module_from_spec(spec)
assert module.__package__ == ''
spec.loader.exec_module(module)

from model import transport
assert Path(transport.__file__).resolve() == module_path.with_name('transport.py')
assert module.decode_request is transport.decode_request
assert module.artifact_response is transport.artifact_response
model = module.Model(secrets={})
assert model._runtime is None
assert callable(model.load) and callable(model.predict)
# Import and construction must not initialize the GPU/model-download runtime.
assert not any(name in sys.modules for name in ('torch', 'sf3d', 'huggingface_hub'))
print('Truss-style Model import and construction passed')
"""],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
