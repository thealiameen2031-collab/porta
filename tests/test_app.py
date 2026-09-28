import asyncio
import smtplib
import sqlite3
import ssl
import json

import pytest
from authlib.integrations.base_client.errors import OAuthError
from fastapi.testclient import TestClient

import app.main as porta_app
from app.main import app
from app.recommender import recommend_paths

REAL_WHATSAPP_SENDER = porta_app.send_whatsapp_verification_code

PROFILE = {
    "full_name": "  Noor   Ahmed ",
    "first_name": "Noor",
    "last_name": "Ahmed",
    "username": "noor.ahmed",
    "phone_number": "+974 5555 1234",
    "email": " Noor@example.com ",
    "password": "a-correct-horse-battery",
    "password_confirmation": "a-correct-horse-battery",
    "role": "both",
    "interests": ["Coding", "Languages"],
    "skills_to_share": ["Arabic", "Arabic", "Drawing"],
    "learning_goal": "Build a website",
    "learning_goals": ["Build a website", "Python"],
    "learning_style": "one_to_one",
    "location": " Doha, Qatar ",
    "language": "English",
    "languages": ["English", "Arabic"],
    "bio": "  Curious   learner. ",
    "policies_accepted": True,
}


@pytest.fixture(autouse=True)
def clear_local_smtp_configuration(monkeypatch):
    for setting in (
        "PORTA_SMTP_HOST",
        "PORTA_SMTP_PORT",
        "PORTA_SMTP_FROM",
        "PORTA_SMTP_USERNAME",
        "PORTA_SMTP_PASSWORD",
        "PORTA_PUBLIC_URL",
        "PORTA_WHATSAPP_PHONE_NUMBER_ID",
        "PORTA_WHATSAPP_ACCESS_TOKEN",
        "PORTA_WHATSAPP_TEMPLATE_NAME",
    ):
        monkeypatch.delenv(setting, raising=False)
    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "porta@example.test")
    monkeypatch.setenv("PORTA_WHATSAPP_PHONE_NUMBER_ID", "123456789")
    monkeypatch.setenv("PORTA_WHATSAPP_ACCESS_TOKEN", "test-access-token")
    monkeypatch.setenv("PORTA_WHATSAPP_TEMPLATE_NAME", "porta_verification_code")
    TEST_VERIFICATION_CODES["phone"].clear()
    TEST_VERIFICATION_CODES["email"].clear()
    monkeypatch.setattr(
        porta_app,
        "send_whatsapp_verification_code",
        lambda recipient, code: TEST_VERIFICATION_CODES["phone"].append((recipient, code)),
    )
    monkeypatch.setattr(
        porta_app,
        "send_email_verification_code",
        lambda recipient, code: TEST_VERIFICATION_CODES["email"].append((recipient, code)),
    )


def make_client(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    return TestClient(app)


def test_postgres_connection_translates_sqlite_placeholders():
    class FakeConnection:
        def execute(self, query, parameters):
            self.query = query
            self.parameters = parameters
            return self

    connection = FakeConnection()
    cursor = porta_app.PostgresConnection(connection).execute(
        "SELECT id FROM accounts WHERE email = ? AND username = ?",
        ("member@example.com", "member"),
    )

    assert cursor is connection
    assert connection.query == "SELECT id FROM accounts WHERE email = %s AND username = %s"
    assert connection.parameters == ("member@example.com", "member")


def test_vercel_startup_requires_persistent_database_and_session_secret(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("PORTA_SESSION_SECRET", raising=False)

    async def start_app():
        async with app.router.lifespan_context(app):
            pass

    with pytest.raises(RuntimeError, match="DATABASE_URL, PORTA_SESSION_SECRET"):
        asyncio.run(start_app())


def create_account(client, payload=None):
    started = client.post("/api/auth/register", json=payload or PROFILE)
    if started.status_code != 202:
        return started
    verification_id = started.json()["verification_id"]
    phone_verified = client.post(
        "/api/auth/register/verify-phone",
        json={
            "verification_id": verification_id,
            "code": TEST_VERIFICATION_CODES["phone"][-1][1],
        },
    )
    if phone_verified.status_code != 200:
        return phone_verified
    return client.post(
        "/api/auth/register/verify-email",
        json={
            "verification_id": verification_id,
            "code": TEST_VERIFICATION_CODES["email"][-1][1],
        },
    )


TEST_VERIFICATION_CODES = {"phone": [], "email": []}


def test_initialize_database_adds_new_profile_fields_to_existing_accounts(tmp_path, monkeypatch):
    db_path = tmp_path / "existing-porta.sqlite3"
    monkeypatch.setenv("PORTA_DB_PATH", str(db_path))
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                interests TEXT NOT NULL,
                skills_to_share TEXT NOT NULL,
                learning_goal TEXT NOT NULL,
                learning_style TEXT NOT NULL,
                location TEXT NOT NULL,
                language TEXT NOT NULL,
                bio TEXT NOT NULL,
                policies_accepted_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )

    porta_app.initialize_database()
    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(accounts)")}
        username_index = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'accounts_username_unique'"
        ).fetchone()

    assert {"first_name", "last_name", "username", "phone_number", "learning_goals", "phone_verified"} <= columns
    assert username_index == ("accounts_username_unique",)


def test_recommender_ranks_relevant_topics_and_reports_relative_scores():
    results = recommend_paths(["JavaScript"], "I want to build my first website")

    assert results
    assert results[0]["id"] == "coding"
    assert 0 < results[0]["relevance"] <= 1


def test_recommender_returns_no_match_for_unknown_vocabulary():
    assert recommend_paths([], "xyzzy quux") == []
    assert recommend_paths([], "") == []


def test_people_search_returns_only_public_fields_for_other_members(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        owner = create_account(client)
        other_profile = {
            **PROFILE,
            "first_name": "Maya",
            "last_name": "Khan",
            "full_name": "Maya Khan",
            "username": "maya.makes",
            "email": "maya@example.com",
            "phone_number": "+974 5555 4321",
        }
        other = create_account(client, other_profile)
        response = client.get(
            "/api/people",
            params={"q": "maya"},
            headers={"Authorization": f"Bearer {owner.json()['access_token']}"},
        )

    assert response.status_code == 200
    assert response.json()["people"] == [{
        "id": other.json()["user"]["id"],
        "full_name": "Maya Khan",
        "username": "maya.makes",
        "location": "Doha, Qatar",
        "languages": ["English", "Arabic"],
        "role": "both",
        "interests": ["Coding", "Languages"],
        "skills_to_share": ["Arabic", "Drawing"],
        "bio": "Curious learner.",
    }]
    assert "email" not in response.json()["people"][0]
    assert "phone_number" not in response.json()["people"][0]


def test_people_search_requires_auth_and_valid_query(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)

    with client:
        assert client.get("/api/people", params={"q": "ma"}).status_code == 401
        owner = create_account(client)
        headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
        assert client.get("/api/people", params={"q": " "}, headers=headers).status_code == 422


def test_register_creates_profile_and_session_and_persists_hashed_password(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        response = create_account(client)
        token = response.json()["access_token"]
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            row = connection.execute(
                "SELECT full_name, email, password_salt, password_hash, interests, skills_to_share, bio, policies_accepted_at, first_name, last_name, username, phone_number FROM accounts"
            ).fetchone()

    assert response.status_code == 201
    assert response.json()["user"]["full_name"] == "Noor Ahmed"
    assert response.json()["user"]["interests"] == ["Coding", "Languages"]
    assert response.json()["user"]["skills_to_share"] == ["Arabic", "Drawing"]
    assert me.status_code == 200
    assert me.json()["user"]["bio"] == "Curious learner."
    assert me.json()["user"]["languages"] == ["English", "Arabic"]
    assert me.json()["user"]["learning_goals"] == ["Build a website", "Python"]
    assert row[0:2] == ("Noor Ahmed", "noor@example.com")
    assert row[2] != PROFILE["password"]
    assert row[3] != PROFILE["password"]
    assert row[4] == '["Coding", "Languages"]'
    assert row[5] == '["Arabic", "Drawing"]'
    assert row[6] == "Curious learner."
    assert row[7]
    assert row[8:] == ("Noor", "Ahmed", "noor.ahmed", "+97455551234")


def test_register_rejects_duplicate_usernames_and_more_than_three_languages(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        assert create_account(client).status_code == 201
        duplicate_username = create_account(
            client,
            {**PROFILE, "email": "another@example.com"},
        )
        too_many_languages = create_account(
            client,
            {**PROFILE, "email": "languages@example.com", "username": "language.user", "languages": ["English", "Arabic", "French", "Hindi"]},
        )
    assert duplicate_username.status_code == 409
    assert "username" in duplicate_username.json()["detail"].lower()
    assert too_many_languages.status_code == 422


def test_registration_verifies_whatsapp_before_email_and_creates_account_after_both_codes(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path, monkeypatch)
    with client:
        started = client.post("/api/auth/register", json=PROFILE)
        verification_id = started.json()["verification_id"]
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            initial_counts = (
                connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
                connection.execute("SELECT stage FROM pending_registrations").fetchone()[0],
            )
        phone_verified = client.post(
            "/api/auth/register/verify-phone",
            json={
                "verification_id": verification_id,
                "code": TEST_VERIFICATION_CODES["phone"][-1][1],
            },
        )
        email_code = TEST_VERIFICATION_CODES["email"][-1][1]
        wrong_code = f"{(int(email_code) + 1) % 1_000_000:06d}"
        wrong_email_response = client.post(
            "/api/auth/register/verify-email",
            json={"verification_id": verification_id, "code": wrong_code},
        )
        completed = client.post(
            "/api/auth/register/verify-email",
            json={
                "verification_id": verification_id,
                "code": TEST_VERIFICATION_CODES["email"][-1][1],
            },
        )
        reused_code = client.post(
            "/api/auth/register/verify-email",
            json={
                "verification_id": verification_id,
                "code": TEST_VERIFICATION_CODES["email"][-1][1],
            },
        )
        phone_destination = TEST_VERIFICATION_CODES["phone"][-1][0]
        email_destination = TEST_VERIFICATION_CODES["email"][-1][0]

    assert started.status_code == 202
    assert initial_counts == (0, "phone")
    assert phone_destination == "+97455551234"
    assert phone_verified.status_code == 200
    assert phone_verified.json()["stage"] == "email"
    assert email_destination == PROFILE["email"].strip().lower()
    assert wrong_email_response.status_code == 400
    assert completed.status_code == 201
    assert completed.json()["user"]["profile_complete"] is True
    assert reused_code.status_code == 404


def test_registration_rejects_mismatched_passwords_and_returns_global_dialing_codes(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path, monkeypatch)
    with client:
        mismatch = client.post(
            "/api/auth/register",
            json={**PROFILE, "password_confirmation": "a-different-password"},
        )
        phone_codes = client.get("/api/phone-codes")
    regions = {item["region"]: item["calling_code"] for item in phone_codes.json()["regions"]}

    assert mismatch.status_code == 422
    assert "passwords do not match" in mismatch.json()["detail"][0]["msg"].lower()
    assert regions["QA"] == "974"
    assert regions["US"] == "1"
    assert len(regions) >= 240


def test_registration_resend_is_rate_limited_and_replaces_previous_code(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        started = client.post("/api/auth/register", json=PROFILE)
        verification_id = started.json()["verification_id"]
        throttled = client.post(
            "/api/auth/register/resend",
            json={"verification_id": verification_id},
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            connection.execute(
                "UPDATE pending_registrations SET last_sent_at = ?",
                ("2000-01-01T00:00:00+00:00",),
            )
        resent = client.post(
            "/api/auth/register/resend",
            json={"verification_id": verification_id},
        )
        old_code = client.post(
            "/api/auth/register/verify-phone",
            json={
                "verification_id": verification_id,
                "code": TEST_VERIFICATION_CODES["phone"][0][1],
            },
        )
        new_code = client.post(
            "/api/auth/register/verify-phone",
            json={
                "verification_id": verification_id,
                "code": TEST_VERIFICATION_CODES["phone"][-1][1],
            },
        )

    assert started.status_code == 202
    assert throttled.status_code == 429
    assert resent.status_code == 200
    assert old_code.status_code == 400
    assert new_code.status_code == 200


def test_registration_explains_missing_whatsapp_setup_before_accepting_account(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("PORTA_WHATSAPP_PHONE_NUMBER_ID", raising=False)
    monkeypatch.delenv("PORTA_WHATSAPP_ACCESS_TOKEN", raising=False)
    client = make_client(tmp_path, monkeypatch)
    with client:
        response = client.post("/api/auth/register", json=PROFILE)
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            pending_count = connection.execute(
                "SELECT COUNT(*) FROM pending_registrations"
            ).fetchone()[0]

    assert response.status_code == 503
    assert "Meta WhatsApp Cloud API" in response.json()["detail"]
    assert pending_count == 0


def test_whatsapp_verification_uses_meta_template_api(monkeypatch):
    sent = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"messages":[{"id":"wamid.test"}]}'

    def fake_urlopen(request, timeout):
        sent.append((request, timeout))
        return FakeResponse()

    monkeypatch.setattr(porta_app, "send_whatsapp_verification_code", REAL_WHATSAPP_SENDER)
    monkeypatch.setattr(porta_app.urllib.request, "urlopen", fake_urlopen)
    porta_app.send_whatsapp_verification_code("+97455551234", "004219")
    request, timeout = sent[0]
    payload = json.loads(request.data)

    assert request.full_url.endswith("/123456789/messages")
    assert request.get_header("Authorization") == "Bearer test-access-token"
    assert payload["to"] == "97455551234"
    assert payload["template"]["name"] == "porta_verification_code"
    assert payload["template"]["components"][0]["parameters"][0]["text"] == "004219"
    assert timeout == 15


def test_duplicate_email_is_rejected_without_leaking_password(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        assert create_account(client).status_code == 201
        response = create_account(client, {**PROFILE, "email": "NOOR@example.com"})
    assert response.status_code == 409


def test_login_issues_a_session_and_logout_invalidates_it(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        create_account(client)
        response = client.post(
            "/api/auth/login",
            json={"email": " NOOR@example.com ", "password": PROFILE["password"]},
        )
        token = response.json()["access_token"]
        auth_headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/auth/me", headers=auth_headers).status_code == 200
        assert client.post("/api/auth/logout", headers=auth_headers).status_code == 200
        assert client.get("/api/auth/me", headers=auth_headers).status_code == 401
    assert response.status_code == 200


def test_login_error_does_not_disclose_whether_email_exists(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        create_account(client)
        unknown = client.post(
            "/api/auth/login",
            json={"email": "unknown@example.com", "password": "incorrect password"},
        )
        wrong_password = client.post(
            "/api/auth/login",
            json={"email": PROFILE["email"], "password": "incorrect password"},
        )
    assert unknown.status_code == wrong_password.status_code == 401
    assert unknown.json() == wrong_password.json()


def test_profile_update_saves_changes_and_requires_teaching_skill(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        result = create_account(client).json()
        headers = {"Authorization": f"Bearer {result['access_token']}"}
        updated = client.put(
            "/api/auth/me",
            headers=headers,
            json={
                "profile": {
                    "role": "learner",
                    "interests": ["AI"],
                    "learning_goal": "Understand language models",
                    "learning_style": "small_group",
                    "location": "Lusail, Qatar",
                    "language": "English",
                    "bio": "Ready to learn",
                },
            },
        )
        invalid = client.put(
            "/api/auth/me",
            headers=headers,
            json={
                "profile": {
                    "role": "peer_tutor",
                    "interests": ["AI"],
                    "skills_to_share": [],
                },
            },
        )
    assert updated.status_code == 200
    assert updated.json()["user"]["interests"] == ["AI"]
    assert updated.json()["user"]["learning_style"] == "small_group"
    assert invalid.status_code == 422


def test_recommendation_requires_login_and_returns_matches_for_member(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        denied = client.post("/api/recommend", json={"interests": [], "goal": "Python"})
        result = create_account(client).json()
        response = client.post(
            "/api/recommend",
            headers={"Authorization": f"Bearer {result['access_token']}"},
            json={"interests": ["Coding"], "goal": "Build a website"},
        )
    assert denied.status_code == 401
    assert response.status_code == 200
    assert response.json()["matches"][0]["id"] == "coding"


def test_coach_requires_login_and_explains_when_ai_provider_not_configured(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = make_client(tmp_path, monkeypatch)
    with client:
        denied = client.post("/api/coach", json={"goal": "Learn enough Python to build a game"})
        result = create_account(client).json()
        response = client.post(
            "/api/coach",
            headers={"Authorization": f"Bearer {result['access_token']}"},
            json={"goal": "Learn enough Python to build a game"},
        )
    assert denied.status_code == 401
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_registration_validates_password_interests_and_sharing_skill(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    with client:
        weak_password = create_account(client, {**PROFILE, "password": "short"})
        no_interests = create_account(client, {**PROFILE, "email": "empty@example.com", "interests": []})
        no_sharing_skill = create_account(
            client,
            {**PROFILE, "email": "share@example.com", "role": "peer_tutor", "skills_to_share": []},
        )
        missing_consent = create_account(
            client,
            {**PROFILE, "email": "consent@example.com", "policies_accepted": False},
        )
    assert (
        weak_password.status_code
        == no_interests.status_code
        == no_sharing_skill.status_code
        == missing_consent.status_code
        == 422
    )


def test_password_reset_email_link_updates_password_and_revokes_old_sessions(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "Porta <hello@example.test>")
    monkeypatch.setenv("PORTA_PUBLIC_URL", "https://porta.example.test")
    sent = []
    monkeypatch.setattr(
        porta_app,
        "send_password_reset_email",
        lambda recipient, token: sent.append((recipient, token)),
    )
    client = make_client(tmp_path, monkeypatch)
    with client:
        account = create_account(client).json()
        original_token = account["access_token"]
        requested = client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        new_password = "a-new-secure-password"
        reset = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": sent[0][1], "new_password": new_password},
        )
        old_session = client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {original_token}"},
        )
        old_password = client.post(
            "/api/auth/login",
            json={"email": PROFILE["email"], "password": PROFILE["password"]},
        )
        new_login = client.post(
            "/api/auth/login",
            json={"email": PROFILE["email"], "password": new_password},
        )
        reused_link = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": sent[0][1], "new_password": "another-secure-password"},
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            saved_token = connection.execute(
                "SELECT token_hash FROM password_reset_tokens"
            ).fetchone()

    assert requested.status_code == 200
    assert sent[0][0] == "noor@example.com"
    assert reset.status_code == 200
    assert old_session.status_code == 401
    assert old_password.status_code == 401
    assert new_login.status_code == 200
    assert reused_link.status_code == 400
    assert saved_token is None


def test_password_reset_does_not_disclose_unknown_emails_or_repeat_sends(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "hello@example.test")
    sent = []
    monkeypatch.setattr(
        porta_app,
        "send_password_reset_email",
        lambda recipient, token: sent.append((recipient, token)),
    )
    client = make_client(tmp_path, monkeypatch)
    with client:
        create_account(client)
        existing = client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        throttled = client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        unknown = client.post(
            "/api/auth/password-reset/request",
            json={"email": "unknown@example.com"},
        )
        missing = client.post(
            "/api/auth/password-reset/request",
            json={"email": "missing@example.com"},
        )

    assert existing.status_code == throttled.status_code == unknown.status_code == missing.status_code == 200
    assert existing.json() == unknown.json() == missing.json()
    assert throttled.json() == existing.json()
    assert len(sent) == 1


def test_password_reset_requires_smtp_configuration_and_valid_token(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("PORTA_SMTP_HOST", raising=False)
    monkeypatch.delenv("PORTA_SMTP_FROM", raising=False)
    client = make_client(tmp_path, monkeypatch)
    with client:
        status = client.get("/api/status")
        unavailable = client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        invalid = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": "x" * 32, "new_password": "a-new-secure-password"},
        )

    assert status.json()["password_reset_available"] is False
    assert unavailable.status_code == 503
    assert "SMTP" in unavailable.json()["detail"]
    assert invalid.status_code == 400


def test_expired_reset_token_cannot_change_password(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "hello@example.test")
    sent = []
    monkeypatch.setattr(
        porta_app,
        "send_password_reset_email",
        lambda recipient, token: sent.append((recipient, token)),
    )
    client = make_client(tmp_path, monkeypatch)
    with client:
        create_account(client)
        client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            connection.execute(
                "UPDATE password_reset_tokens SET expires_at = ?",
                ("2000-01-01T00:00:00+00:00",),
            )
        response = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": sent[0][1], "new_password": "a-new-secure-password"},
        )

    assert response.status_code == 400
    assert "expired" in response.json()["detail"]


def test_failed_reset_email_does_not_leave_a_usable_token(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "hello@example.test")

    def fail_delivery(recipient, token):
        raise smtplib.SMTPException("test SMTP failure")

    monkeypatch.setattr(porta_app, "send_password_reset_email", fail_delivery)
    client = make_client(tmp_path, monkeypatch)
    with client:
        create_account(client)
        response = client.post(
            "/api/auth/password-reset/request",
            json={"email": PROFILE["email"]},
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            tokens = connection.execute("SELECT COUNT(*) FROM password_reset_tokens").fetchone()[0]
            throttles = connection.execute("SELECT COUNT(*) FROM password_reset_requests").fetchone()[0]

    assert response.status_code == 502
    assert "SMTP settings" in response.json()["detail"]
    assert tokens == 0
    assert throttles == 0


def test_reset_email_uses_tls_and_never_places_token_in_the_subject(
    monkeypatch,
):
    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs
            self.sent_message = None
            self.authenticated = False

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def login(self, username, password):
            self.authenticated = (username, password) == ("porta-user", "mail-secret")

        def send_message(self, message):
            self.sent_message = message

    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "hello@example.test")
    monkeypatch.setenv("PORTA_SMTP_PORT", "465")
    monkeypatch.setenv("PORTA_SMTP_USERNAME", "porta-user")
    monkeypatch.setenv("PORTA_SMTP_PASSWORD", "mail-secret")
    monkeypatch.setenv("PORTA_PUBLIC_URL", "https://porta.example.test")
    smtp_instances = []

    def fake_smtp_ssl(*args, **kwargs):
        smtp = FakeSMTP(*args, **kwargs)
        smtp_instances.append(smtp)
        return smtp

    monkeypatch.setattr(porta_app.smtplib, "SMTP_SSL", fake_smtp_ssl)
    token = "a-secret-one-time-reset-token"
    porta_app.send_password_reset_email("noor@example.test", token)

    smtp = smtp_instances[0]
    assert smtp.args == ("smtp.example.test", 465)
    assert isinstance(smtp.kwargs["context"], ssl.SSLContext)
    assert smtp.authenticated
    assert smtp.sent_message["To"] == "noor@example.test"
    assert token in smtp.sent_message.get_content()
    assert token not in smtp.sent_message["Subject"]


def test_reset_email_supports_starttls_configuration(monkeypatch):
    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs
            self.tls_context = None
            self.sent_message = None

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def ehlo(self):
            return None

        def starttls(self, *, context):
            self.tls_context = context

        def send_message(self, message):
            self.sent_message = message

    monkeypatch.setenv("PORTA_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("PORTA_SMTP_FROM", "hello@example.test")
    monkeypatch.setenv("PORTA_SMTP_PORT", "587")
    monkeypatch.setenv("PORTA_PUBLIC_URL", "https://porta.example.test")
    smtp_instances = []

    def fake_smtp(*args, **kwargs):
        smtp = FakeSMTP(*args, **kwargs)
        smtp_instances.append(smtp)
        return smtp

    monkeypatch.setattr(porta_app.smtplib, "SMTP", fake_smtp)
    porta_app.send_password_reset_email("noor@example.test", "another-secret-reset-token")

    smtp = smtp_instances[0]
    assert smtp.args == ("smtp.example.test", 587)
    assert isinstance(smtp.tls_context, ssl.SSLContext)
    assert smtp.sent_message["To"] == "noor@example.test"


def test_oauth_requires_a_verified_email_claim():
    assert porta_app.oauth_identity(
        {"sub": "google-user-1", "email": "person@example.com", "email_verified": True}
    ) == ("google-user-1", "person@example.com", "")
    assert (
        porta_app.oauth_identity(
            {"sub": "google-user-1", "email": "person@example.com", "email_verified": False}
        )
        is None
    )
    assert porta_app.oauth_identity(
        {"sub": "google-user-1", "email": "not-an-email", "email_verified": True}
    ) is None


def test_oauth_provider_endpoints_explain_missing_provider_configuration(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    monkeypatch.setattr(porta_app, "GOOGLE_CLIENT_ID", "")
    monkeypatch.setattr(porta_app, "GOOGLE_CLIENT_SECRET", "")
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_ID", "")
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_SECRET", "")
    with TestClient(app) as client:
        status = client.get("/api/status")
        google = client.get("/api/auth/google", follow_redirects=False)
        linkedin = client.get("/api/auth/linkedin", follow_redirects=False)

    assert status.json()["google_login_available"] is False
    assert status.json()["linkedin_login_available"] is False
    assert google.status_code == linkedin.status_code == 303
    assert google.headers["location"] == "/?auth_error=google_not_configured"
    assert linkedin.headers["location"] == "/?auth_error=linkedin_not_configured"


def test_loopback_alias_redirects_to_configured_oauth_origin(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    monkeypatch.setenv("PORTA_PUBLIC_URL", "http://localhost:8000")
    with TestClient(app) as client:
        home = client.get(
            "/",
            headers={"host": "127.0.0.1:8000"},
            follow_redirects=False,
        )
        login = client.get(
            "/api/auth/google",
            headers={"host": "127.0.0.1:8000"},
            follow_redirects=False,
        )
        callback = client.get(
            "/api/auth/linkedin/callback?code=test&state=test",
            headers={"host": "127.0.0.1:8000"},
            follow_redirects=False,
        )

    assert home.status_code == login.status_code == callback.status_code == 307
    assert home.headers["location"] == "http://localhost:8000/"
    assert login.headers["location"] == "http://localhost:8000/api/auth/google"
    assert callback.headers["location"] == (
        "http://localhost:8000/api/auth/linkedin/callback?code=test&state=test"
    )


def test_verified_provider_callback_creates_only_a_short_lived_exchange_code(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_ID", "client-id")
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_SECRET", "client-secret")

    class FakeOpenIDClient:
        async def authorize_access_token(self, _request):
            return {
                "userinfo": {
                    "sub": "linkedin-subject-42",
                    "email": "new-person@example.com",
                    "email_verified": True,
                    "name": "New Person",
                },
            }

    monkeypatch.setattr(porta_app.oauth, "create_client", lambda _provider: FakeOpenIDClient())
    client = make_client(tmp_path, monkeypatch)
    with client:
        callback = client.get(
            "/api/auth/linkedin/callback?code=fake-code&state=fake-state",
            follow_redirects=False,
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            account = connection.execute(
                "SELECT email, full_name, interests FROM accounts"
            ).fetchone()
            reset_code_count = connection.execute(
                "SELECT COUNT(*) FROM oauth_exchange_codes"
            ).fetchone()[0]
            bearer_session_count = connection.execute(
                "SELECT COUNT(*) FROM sessions"
            ).fetchone()[0]
        fragment = callback.headers["location"].split("#", 1)[1]
        exchange_code = fragment.removeprefix("oauth_code=")
        exchanged = client.post("/api/auth/exchange", json={"code": exchange_code})

    assert callback.status_code == 303
    assert fragment.startswith("oauth_code=")
    assert len(exchange_code) >= 32
    assert account == ("new-person@example.com", "New Person", "[]")
    assert reset_code_count == 1
    assert bearer_session_count == 0
    assert exchanged.status_code == 200
    assert exchanged.json()["user"]["profile_complete"] is False


def test_linkedin_oauth_callback_explains_provider_rejection(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_ID", "client-id")
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_SECRET", "client-secret")

    class RejectedOpenIDClient:
        async def authorize_access_token(self, _request):
            raise OAuthError(
                "invalid_client",
                description="The client authentication failed.",
            )

    monkeypatch.setattr(
        porta_app.oauth,
        "create_client",
        lambda _provider: RejectedOpenIDClient(),
    )
    with TestClient(app) as client:
        callback = client.get(
            "/api/auth/linkedin/callback?code=provider-code&state=provider-state",
            follow_redirects=False,
        )

    assert callback.status_code == 303
    assert callback.headers["location"] == "/?auth_error=linkedin_app_credentials_invalid"
    assert "linkedin sign-in callback rejected" in caplog.text.lower()
    assert "invalid_client" in caplog.text


def test_linkedin_oauth_callback_surfaces_only_safe_unknown_error_code(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("PORTA_DB_PATH", str(tmp_path / "porta-test.sqlite3"))
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_ID", "client-id")
    monkeypatch.setattr(porta_app, "LINKEDIN_CLIENT_SECRET", "client-secret")

    class RejectedOpenIDClient:
        async def authorize_access_token(self, _request):
            raise OAuthError(
                "unsupported_response_type",
                description="This text must not be exposed.",
            )

    monkeypatch.setattr(
        porta_app.oauth,
        "create_client",
        lambda _provider: RejectedOpenIDClient(),
    )
    with TestClient(app) as client:
        callback = client.get(
            "/api/auth/linkedin/callback?code=provider-code&state=provider-state",
            follow_redirects=False,
        )

    assert callback.headers["location"] == (
        "/?auth_error=linkedin_oauth_error&oauth_error_code=unsupported_response_type"
    )
    assert "This text must not be exposed" not in callback.headers["location"]


def test_oauth_exchange_requires_profile_completion_and_can_only_be_used_once(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path, monkeypatch)
    with client:
        account_id, created = porta_app.complete_oauth_account(
            "google", "google-subject-1", "social@example.com", "Social Learner"
        )
        assert created is True
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            code = porta_app.create_oauth_exchange(connection, account_id)

        exchange = client.post("/api/auth/exchange", json={"code": code})
        token = exchange.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        user = client.get("/api/auth/me", headers=headers)
        protected_matches = client.post(
            "/api/recommend",
            headers=headers,
            json={"goal": "Python"},
        )
        incomplete_profile = client.put(
            "/api/auth/me",
            headers=headers,
            json={
                "profile": {
                    "role": "learner",
                    "interests": ["Coding"],
                    "location": "Doha, Qatar",
                    "language": "English",
                },
            },
        )
        complete_profile = {
            "role": "learner",
            "first_name": "Social",
            "last_name": "Learner",
            "username": "social.learner",
            "phone_number": "+97455551234",
            "interests": ["Coding"],
            "learning_goal": "Build a website",
            "learning_goals": ["Build a website"],
            "learning_style": "flexible",
            "location": "Qatar",
            "language": "English",
            "languages": ["English", "Arabic"],
            "bio": "",
        }
        direct_profile_update = client.put(
            "/api/auth/me",
            headers=headers,
            json={
                "profile": complete_profile,
                "policies_accepted": True,
            },
        )
        started_phone_verification = client.post(
            "/api/auth/me/phone-verification",
            headers=headers,
            json={"profile": complete_profile, "policies_accepted": True},
        )
        completed_profile = client.post(
            "/api/auth/me/phone-verification/confirm",
            headers=headers,
            json={
                "verification_id": started_phone_verification.json()["verification_id"],
                "code": TEST_VERIFICATION_CODES["phone"][-1][1],
            },
        )
        reused_code = client.post("/api/auth/exchange", json={"code": code})

    assert exchange.status_code == 200
    assert user.json()["user"]["profile_complete"] is False
    assert protected_matches.status_code == 403
    assert incomplete_profile.status_code == 422
    assert direct_profile_update.status_code == 403
    assert started_phone_verification.status_code == 200
    assert completed_profile.status_code == 200
    assert completed_profile.json()["user"]["profile_complete"] is True
    assert reused_code.status_code == 400


def test_verified_social_email_links_existing_account_without_creating_another(
    tmp_path, monkeypatch
):
    client = make_client(tmp_path, monkeypatch)
    with client:
        existing = create_account(client).json()
        account_id, created = porta_app.complete_oauth_account(
            "linkedin", "linkedin-subject-1", PROFILE["email"], "Noor Ahmed"
        )
        same_identity_id, same_identity_created = porta_app.complete_oauth_account(
            "linkedin", "linkedin-subject-1", PROFILE["email"], "Changed Name"
        )
        other_provider_id, other_provider_created = porta_app.complete_oauth_account(
            "google", "google-subject-2", PROFILE["email"], "Noor Ahmed"
        )
        with sqlite3.connect(tmp_path / "porta-test.sqlite3") as connection:
            account_count = connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
            identity_count = connection.execute("SELECT COUNT(*) FROM oauth_identities").fetchone()[0]

    assert account_id == existing["user"]["id"]
    assert created is False
    assert same_identity_id == account_id
    assert same_identity_created is False
    assert other_provider_id == account_id
    assert other_provider_created is False
    assert account_count == 1
    assert identity_count == 2
