"""Authentication and callback behavior for the public bridge example."""

import importlib

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def test_bridge_rejects_unauthenticated_jobs_and_callbacks(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_TOKEN", "a-test-secret-with-enough-entropy")
    monkeypatch.setenv("BRIDGE_RESULTS", str(tmp_path))
    monkeypatch.setenv("BRIDGE_ALLOWED_ORIGINS", "https://target-app.example")
    bridge = importlib.import_module("bridge")
    bridge.jobs.clear()

    with TestClient(bridge.app) as client:
        try:
            with client.websocket_connect("/ws?token=wrong") as websocket:
                websocket.receive_json()
            assert False, "wrong WebSocket token was accepted"
        except WebSocketDisconnect as exc:
            assert exc.code == 4401

        with client.websocket_connect("/ws?token=a-test-secret-with-enough-entropy") as websocket:
            assert websocket.receive_json()["type"] == "hello"

        assert client.post("/job/submit", json={"step": "image"}).status_code == 401
        assert client.post(
            "/job/submit",
            json={"step": "image"},
            headers={"Authorization": "Bearer a-test-secret-with-enough-entropy"},
        ).status_code == 503  # No extension is connected.

        bridge.jobs["abc12345"] = {"status": "dispatched", "callback_token": "job-secret"}
        assert client.post("/result/abc12345", files={"file": ("result.txt", b"ok")}).status_code == 401
        assert client.post("/error/abc12345", json={"error": "failed"}).status_code == 401
        response = client.post(
            "/result/abc12345",
            files={"file": ("result.txt", b"ok")},
            headers={"X-Job-Token": "job-secret"},
        )
        assert response.status_code == 200
        assert (tmp_path / "abc12345_result.txt").read_bytes() == b"ok"

        assert client.get("/job/abc12345").status_code == 401
        response = client.get(
            "/job/abc12345",
            headers={"Authorization": "Bearer a-test-secret-with-enough-entropy"},
        )
        assert response.status_code == 200
        assert "callback_token" not in response.json()

        preflight = client.options(
            "/result/abc12345",
            headers={
                "Origin": "https://target-app.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-job-token",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "https://target-app.example"
