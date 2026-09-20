"""Scoped, reversible timers for the pinned upstream API; no model/source fork.

Only coarse function boundaries synchronize CUDA. Inclusive and exclusive wall
times represent completed work, not kernel launch time. Nested times MUST NOT
be summed with their parents. No hooks survive a request, including failures.
"""

from contextlib import contextmanager
from functools import wraps
import time


class Timings:
    def __init__(self, synchronize=None, clock=time.perf_counter):
        self.synchronize = synchronize
        self.clock = clock
        self.stages = {}
        self.stack = []

    @contextmanager
    def stage(self, name, gpu=False):
        if gpu and self.synchronize:
            self.synchronize()
        start = self.clock()
        frame = [0.0]
        self.stack.append(frame)
        try:
            yield
        finally:
            if gpu and self.synchronize:
                self.synchronize()
            elapsed = (self.clock() - start) * 1000
            self.stack.pop()
            record = self.stages.setdefault(name, {"wall_ms": 0.0, "exclusive_ms": 0.0, "calls": 0})
            record["wall_ms"] += elapsed
            record["exclusive_ms"] += elapsed - frame[0]
            record["calls"] += 1
            if self.stack:
                self.stack[-1][0] += elapsed


class Hooks:
    def __init__(self, timers):
        self.timers = timers
        self.restore = []

    def wrap(self, owner, attribute, name, gpu=False):
        original = getattr(owner, attribute)
        own = attribute in vars(owner)

        @wraps(original)
        def timed(*args, **kwargs):
            label = name(*args, **kwargs) if callable(name) else name
            with self.timers.stage(label, gpu):
                return original(*args, **kwargs)

        setattr(owner, attribute, timed)
        self.restore.append(lambda: setattr(owner, attribute, original) if own else delattr(owner, attribute))

    def property(self, owner, attribute, name):
        original = getattr(owner, attribute)

        @wraps(original.fget)
        def timed(instance):
            # Cache hits stay visible, without treating them as construction.
            label = name if instance._all_edges is None else "all_edges_cache_hit"
            with self.timers.stage(label, gpu=True):
                return original.fget(instance)

        setattr(owner, attribute, property(timed, original.fset, original.fdel, original.__doc__))
        self.restore.append(lambda: setattr(owner, attribute, original))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        for restore in reversed(self.restore):
            restore()


@contextmanager
def profile_sf3d(model, timers):
    from sf3d import system
    from sf3d.models.mesh import Mesh
    from uv_unwrapper import Unwrapper

    with Hooks(timers) as hooks:
        for attribute, label in (("prepare_image", "conditioning_prepare"),
                                 ("get_scene_codes", "scene_codes_total"),
                                 ("triplane_to_meshes", "geometry_total")):
            hooks.wrap(model, attribute, label, gpu=True)
        for attribute, label in (("image_tokenizer", "dino_features"),
                                 ("backbone", "transformer"),
                                 ("post_processor", "triplane_postprocess"),
                                 ("image_estimator", "material_estimator")):
            module = getattr(model, attribute)
            if module is not None:
                hooks.wrap(module, "forward", label, gpu=True)
        hooks.wrap(model.image_processor, "convert_and_resize", "conditioning_resize", gpu=True)
        hooks.wrap(model, "query_triplane", "field_sampling", gpu=True)
        hooks.wrap(model.decoder, "forward",
                   lambda *a, **k: "geometry_field" if "include" in k else "texture_material_field", gpu=True)
        hooks.wrap(model.isosurface_helper, "forward", "marching_tetrahedra_total", gpu=True)
        hooks.property(type(model.isosurface_helper), "all_edges", "lazy_all_edges")
        hooks.wrap(Mesh, "unwrap_uv", "uv_unwrap_total", gpu=True)
        hooks.wrap(Unwrapper, "_assign_faces_uv_to_atlas_index", "cpu_atlas_overlap", gpu=True)
        hooks.wrap(model.baker, "rasterize", "texture_rasterizer_bvh", gpu=True)
        hooks.wrap(model.baker, "interpolate", "texture_interpolation", gpu=True)
        hooks.wrap(Mesh, "_compute_vertex_normal", "vertex_normals", gpu=True)
        hooks.wrap(Mesh, "_compute_vertex_tangent", "normal_map_tangents", gpu=True)
        hooks.wrap(system, "dilate_fill", "texture_padding", gpu=True)
        hooks.wrap(system, "convert_data", "gpu_cpu_transfer", gpu=True)
        hooks.wrap(system, "float32_to_uint8_np", "texture_quantization")
        hooks.wrap(system.trimesh.visual.material.PBRMaterial, "__init__", "pbr_construction")
        hooks.wrap(system.trimesh.Trimesh, "__init__", "trimesh_construction")
        yield
