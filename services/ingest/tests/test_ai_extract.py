"""Tests for steps 2 and 3 — the OpenAI passes. No key and no network: the HTTP client is
injected, same as the Browserbase fetcher."""

import json, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.ai_extract import (
    OpenAIConfig, SCHEMA, extract_with_llm, extract_with_vlm, product_text, _to_hit,
)

CFG = OpenAIConfig(api_key="k", model="gpt-test")


class Fake:
    """Records the request and replays a canned choices[0].message.content."""
    def __init__(self, payload=None, status=200, refusal=None, body=None, text=""):
        self.payload, self.status, self.refusal, self.body = payload, status, refusal, body
        self.text = text
        self.seen = None

    def post(self, url, headers=None, json=None):
        self.seen = {"url": url, "headers": headers, "json": json}
        outer = self
        class R:
            status_code = outer.status
            text = outer.text
            def json(self):
                if outer.body is not None:
                    return outer.body
                msg = {"content": None, "refusal": outer.refusal} if outer.refusal else \
                      {"content": json_dumps(outer.payload)}
                return {"choices": [{"message": msg}]}
        return R()


def json_dumps(p):
    return json.dumps(p) if p is not None else None


def product(body="<p>Measures just under five feet across.</p>"):
    return {"title": "Oak Bench", "handle": "oak-bench", "product_type": "Benches",
            "body_html": body, "variants": [{"title": "Default Title"}], "options": []}


# --- the request we send -------------------------------------------------

def test_it_calls_chat_completions_with_a_strict_schema():
    f = Fake({"found": True, "width": 150, "height": 45, "depth": 40, "unit": "cm", "quote": "x"})
    extract_with_llm(product(), CFG, client=f)
    assert f.seen["url"] == "https://api.openai.com/v1/chat/completions"
    assert f.seen["headers"]["authorization"] == "Bearer k"
    rf = f.seen["json"]["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
    assert f.seen["json"]["temperature"] == 0


def test_the_cloudflare_gateway_is_used_when_configured():
    cfg = OpenAIConfig(api_key="k", model="m",
                       gateway_url="https://gateway.ai.cloudflare.com/v1/acct/gw/openai/",
                       gateway_token="gt")
    f = Fake({"found": False, "width": None, "height": None, "depth": None,
              "unit": None, "quote": None})
    extract_with_llm(product(), cfg, client=f)
    assert f.seen["url"].startswith("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat")
    assert f.seen["headers"]["cf-aig-authorization"] == "Bearer gt"


def test_an_unconfigured_key_skips_rather_than_calls():
    f = Fake({"found": True})
    assert extract_with_llm(product(), OpenAIConfig(api_key=None, model=None), client=f) is None
    assert f.seen is None, "must not have called anything"


# --- what we accept back -------------------------------------------------

def test_a_complete_answer_converts_to_metres():
    f = Fake({"found": True, "width": 150, "height": 45, "depth": 40, "unit": "cm",
              "quote": "150 x 40 x 45 cm"})
    hit = extract_with_llm(product(), CFG, client=f)
    assert hit.as_bbox() == {"w": 1.5, "h": 0.45, "d": 0.4}
    assert hit.method == "llm"


def test_found_false_is_respected():
    f = Fake({"found": False, "width": 150, "height": 45, "depth": 40, "unit": "cm", "quote": None})
    assert extract_with_llm(product(), CFG, client=f) is None


def test_an_answer_with_no_unit_is_refused():
    """A bare 60 x 30 could be inches or centimetres and the difference is a metre."""
    f = Fake({"found": True, "width": 60, "height": 30, "depth": 20, "unit": None, "quote": "60 x 30"})
    assert extract_with_llm(product(), CFG, client=f) is None


def test_an_absurd_value_is_refused_at_the_source():
    f = Fake({"found": True, "width": 900, "height": 45, "depth": 40, "unit": "m", "quote": "?"})
    assert extract_with_llm(product(), CFG, client=f) is None


def test_a_partial_answer_is_kept_as_a_partial():
    f = Fake({"found": True, "width": 150, "height": None, "depth": 40, "unit": "cm", "quote": "?"})
    hit = extract_with_llm(product(), CFG, client=f)
    assert hit is not None and hit.as_bbox() is None
    assert hit.w == 1.5 and hit.h is None


def test_confidence_ranks_below_a_labelled_regex_hit():
    """A model reads prose a regex cannot, and is likelier to be confidently wrong."""
    f = Fake({"found": True, "width": 150, "height": 45, "depth": 40, "unit": "cm", "quote": "?"})
    assert extract_with_llm(product(), CFG, client=f).confidence < 0.75


# --- failures degrade, never propagate -----------------------------------

def test_an_http_error_returns_none():
    assert extract_with_llm(product(), CFG, client=Fake(status=500)) is None


def test_a_refusal_returns_none():
    assert extract_with_llm(product(), CFG, client=Fake(refusal="no")) is None


def test_a_malformed_body_returns_none():
    assert extract_with_llm(product(), CFG, client=Fake(body={"unexpected": True})) is None


# --- a failure has to be distinguishable from "found nothing" -------------

def test_an_http_error_is_recorded_with_the_api_s_own_explanation():
    """Step 3 reported `recovered 0` across seven merchants and nobody could tell whether the
    model found no diagrams or every call was being rejected. The body carries the reason."""
    errors = []
    fake = Fake(status=400, text='{"error":{"code":"invalid_image_format"}}')
    assert extract_with_llm(product(), CFG, client=fake, errors=errors) is None
    assert len(errors) == 1, errors
    assert errors[0].startswith("http_400"), errors[0]
    assert "invalid_image_format" in errors[0], errors[0]


def test_a_refusal_is_recorded_separately_from_an_http_error():
    errors = []
    assert extract_with_llm(product(), CFG, client=Fake(refusal="no"), errors=errors) is None
    assert errors and errors[0].startswith("refusal"), errors


def test_a_successful_call_that_finds_nothing_records_no_error():
    """The case that must stay quiet: the model answered, and the answer was 'not found'.
    If this ever appends an error, the signal becomes noise and stops being read."""
    errors = []
    hit = extract_with_llm(product(), CFG, errors=errors,
                           client=Fake(payload={"found": False}))
    assert hit is None
    assert errors == [], errors


def test_the_vlm_records_its_failures_too():
    errors = []
    fake = Fake(status=401, text='{"error":{"message":"Incorrect API key"}}')
    assert extract_with_vlm(b"\x89PNG", "image/png", CFG, client=fake, errors=errors) is None
    assert errors and "http_401" in errors[0] and "Incorrect API key" in errors[0], errors


# --- step 3 --------------------------------------------------------------

def test_the_vlm_sends_a_data_uri_image():
    f = Fake({"found": True, "width": 60, "height": 29, "depth": 30, "unit": "in", "quote": "d"})
    hit = extract_with_vlm(b"\x89PNG-bytes", "image/png", CFG, client=f)
    content = f.seen["json"]["messages"][1]["content"]
    img = next(c for c in content if c["type"] == "image_url")
    assert img["image_url"]["url"].startswith("data:image/png;base64,")
    assert hit.method == "vlm" and abs(hit.w - 1.524) < 1e-3


def test_the_vlm_can_use_a_stronger_model_than_the_llm():
    """Reading callouts off a dimension diagram is the hardest read here and the lowest volume,
    so it should be pointable at a better model without paying for one on every step-2 call."""
    cfg = OpenAIConfig(api_key="k", model="cheap", vlm_model="strong")
    f = Fake({"found": True, "width": 60, "height": 29, "depth": 30, "unit": "in", "quote": "d"})
    extract_with_vlm(b"img", "image/png", cfg, client=f)
    assert f.seen["json"]["model"] == "strong"
    extract_with_llm(product(), cfg, client=f)
    assert f.seen["json"]["model"] == "cheap"


def test_the_vlm_model_defaults_to_the_main_one():
    cfg = OpenAIConfig(api_key="k", model="only-one")
    assert cfg.vlm_model == "only-one"


def test_no_image_means_no_call():
    f = Fake({"found": True})
    assert extract_with_vlm(b"", "image/png", CFG, client=f) is None
    assert f.seen is None


# --- the text step 2 reads ----------------------------------------------

def test_product_text_flattens_the_same_fields_step_1_searched():
    t = product_text({"title": "Oak Bench", "body_html": "<p>Solid <b>oak</b>.</p>",
                      "variants": [{"title": '60" wide'}], "options": [{"values": ["Walnut"]}]})
    assert "Oak Bench" in t and '60" wide' in t and "Walnut" in t and "Solid oak" in t
    assert "<b>" not in t


def test_the_schema_is_strict_and_closed():
    """Strict mode is what makes an injected instruction in product copy inert: there is no
    field in this schema it could express itself through."""
    body = SCHEMA["schema"]
    assert SCHEMA["strict"] is True
    assert body["additionalProperties"] is False
    assert set(body["required"]) == set(body["properties"])


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {type(e).__name__}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
