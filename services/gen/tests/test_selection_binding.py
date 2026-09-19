"""Selected product B must never inherit query A's dimensions/image."""
import pytest
from test_mesh_contract import fixture, IDENTITY
from app.binding import GeneratedAsset, SelectedProduct, bind_selected, BindingError


def test_query_a_selected_b_dimension_isolation():
    query_a = {"objectId": "query-A", "bboxMeters": {"w": 9, "h": 8, "d": 7}, "image_sha256": "a"*64}
    selected_b = SelectedProduct("product-B-variant-2", "b"*64, {"w": 0.61, "h": 1.07, "d": 0.49})
    generated_b = GeneratedAsset(fixture(), selected_b.image_sha256)
    output = bind_selected(generated_b, selected_b, IDENTITY, scope="session-one")
    assert output.report["target_meters"] == [0.61, 1.07, 0.49]
    assert output.report["measured_meters"] == pytest.approx([0.61, 1.07, 0.49], abs=0.001)
    assert output.report["selected_object_id"] == selected_b.object_id
    assert output.report["selected_image_sha256"] == selected_b.image_sha256
    query_a["bboxMeters"] = {"w": 1, "h": 2, "d": 3}
    assert bind_selected(generated_b, selected_b, IDENTITY, scope="session-one").glb == output.glb
    with pytest.raises(BindingError, match="not selected product image"):
        bind_selected(GeneratedAsset(fixture(), query_a["image_sha256"]), selected_b, IDENTITY, scope="session-one")
