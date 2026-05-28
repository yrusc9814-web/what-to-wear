import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


SYSTEM_PROMPT = """你是衣物图片标签分析器。
你的任务是识别单张图片中的主要服装，并且只输出 JSON。

输出要求：
1. 只输出一个 JSON 对象，不要输出解释文字。
2. 如果图片不是单件服装，或无法判断，请尽量返回低置信度，并让 category 为空字符串。
3. 字段必须存在，缺失时使用空字符串、空数组或 0。

字段定义：
- category: top / bottom / shoes / hat / ""
- subCategory: 例如 tshirt, shirt, skirt, jeans, sneakers, loafers, cap
- color: 主要颜色，使用英文小写
- seasonTags: 从 spring, summer, autumn, winter 中选择 0 到 4 个
- styleTags: 例如 casual, minimal, sporty, elegant, sweet, commute
- fitTags: 例如 slim, regular, loose
- confidence: 0 到 1 之间的小数
"""


USER_TEXT = """请分析这张图片里的主要服装，并严格按约定输出 JSON。不要输出 markdown，不要输出代码块。"""


def image_to_data_url(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    if not mime:
        mime = "image/jpeg"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def build_payload(model: str, image_path: Path) -> dict:
    return {
        "model": model,
        "thinking": {"type": "disabled"},
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_TEXT},
                    {"type": "image_url", "image_url": {"url": image_to_data_url(image_path)}},
                ],
            },
        ],
    }


def call_api(api_key: str, base_url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_result(api_response: dict) -> dict:
    choice = api_response["choices"][0]["message"]
    content = choice.get("content") or ""
    parsed = json.loads(content)
    usage = api_response.get("usage", {})
    parsed["_usage"] = usage
    parsed["_model"] = api_response.get("model", "")
    return parsed


def run_one(api_key: str, base_url: str, model: str, image_path: Path) -> dict:
    started = time.perf_counter()
    payload = build_payload(model, image_path)
    try:
        raw = call_api(api_key, base_url, payload)
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        parsed = parse_result(raw)
        return {
            "image": str(image_path),
            "ok": True,
            "latency_ms": latency_ms,
            "result": parsed,
            "raw_error": "",
        }
    except urllib.error.HTTPError as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        detail = exc.read().decode("utf-8", errors="replace")
        return {
            "image": str(image_path),
            "ok": False,
            "latency_ms": latency_ms,
            "result": None,
            "raw_error": f"HTTP {exc.code}: {detail}",
        }
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "image": str(image_path),
            "ok": False,
            "latency_ms": latency_ms,
            "result": None,
            "raw_error": repr(exc),
        }


def print_summary(items: list[dict]) -> None:
    total = len(items)
    ok_count = sum(1 for item in items if item["ok"])
    print(f"total={total}")
    print(f"ok={ok_count}")
    print(f"failed={total - ok_count}")
    for item in items:
        print("-" * 80)
        print(f"image: {item['image']}")
        print(f"ok: {item['ok']}")
        print(f"latency_ms: {item['latency_ms']}")
        if item["ok"]:
            print(json.dumps(item["result"], ensure_ascii=False, indent=2))
        else:
            print(item["raw_error"])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate whether DeepSeek V4 can handle clothing-image structured output."
    )
    parser.add_argument("images", nargs="+", help="One or more local image paths.")
    parser.add_argument("--model", default="deepseek-v4-flash", help="Model name.")
    parser.add_argument("--base-url", default="https://api.deepseek.com", help="API base URL.")
    parser.add_argument("--output", default="", help="Optional output json file path.")
    args = parser.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("Missing DEEPSEEK_API_KEY environment variable.", file=sys.stderr)
        return 2

    image_paths = [Path(p).expanduser().resolve() for p in args.images]
    missing = [str(p) for p in image_paths if not p.exists()]
    if missing:
        print("Missing image files:", file=sys.stderr)
        for item in missing:
            print(item, file=sys.stderr)
        return 2

    results = [run_one(api_key, args.base_url, args.model, image_path) for image_path in image_paths]
    print_summary(results)

    if args.output:
        out = Path(args.output).expanduser().resolve()
        out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print("-" * 80)
        print(f"saved: {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
