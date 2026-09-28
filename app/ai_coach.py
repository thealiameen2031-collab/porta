"""Optional generative learning-plan coach using an OpenAI-compatible API."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class CoachUnavailableError(Exception):
    """Raised when no generative AI provider has been configured."""


class CoachProviderError(Exception):
    """Raised when a configured AI provider cannot return a usable response."""


def is_configured() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def _validated_endpoint() -> str:
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise CoachProviderError("The AI provider URL must use HTTPS.")
    if not parsed.netloc:
        raise CoachProviderError("The AI provider URL is invalid.")
    return f"{base_url}/chat/completions"


def create_learning_plan(goal: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise CoachUnavailableError("The generative learning coach is not configured.")

    body = json.dumps(
        {
            "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are Porta's practical learning coach. Give a friendly, "
                        "beginner-accessible learning plan in four short steps. "
                        "Encourage learning with another person; do not claim to be "
                        "a human tutor, promise results, or give high-stakes advice. "
                        "Do not request personal details."
                    ),
                },
                {"role": "user", "content": f"Suggest a learning plan for this goal: {goal}"},
            ],
            "temperature": 0.5,
            "max_tokens": 300,
        }
    ).encode("utf-8")
    request = Request(
        _validated_endpoint(),
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read())
    except HTTPError as error:
        raise CoachProviderError(f"The AI provider returned HTTP {error.code}.") from error
    except (URLError, TimeoutError) as error:
        raise CoachProviderError("Could not connect to the configured AI provider.") from error
    except json.JSONDecodeError as error:
        raise CoachProviderError("The AI provider returned an unreadable response.") from error

    try:
        plan = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise CoachProviderError("The AI provider response did not contain a learning plan.") from error
    if not isinstance(plan, str) or not plan.strip():
        raise CoachProviderError("The AI provider returned an empty learning plan.")
    return plan.strip()
