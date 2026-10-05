#!/usr/bin/env python3
"""
Smart Fuel Pump — ESP32 pump controller MOCK (stage 9 early-integration tool).

Simulates a pump controller against a running backend so the full
request -> authorize -> dispense -> settle -> receipt loop can be tested
before any electronics are wired up.

What it does (mirrors the Arduino firmware):
  1. Polls GET /api/esp32/authorizations/<PUMP_ID> every --poll-interval s.
  2. Verifies the HMAC-SHA256 signature of the authorization (real crypto,
     so a server-side signing bug is caught here, not in the field).
  3. "Dispenses" at a configurable litres/sec rate, posting
     POST /api/esp32/status/<PUMP_ID> telemetry.
  4. On reaching the authorized quantity, POSTs
     /api/esp32/authorizations/<PUMP_ID>/ack with the final amount.

Usage:
  python pump_mock.py \
    --base-url http://localhost:4000 \
    --api-key "$ESP32_API_KEY" \
    --signing-secret "$DEVICE_SIGNING_SECRET" \
    --pump-id <pump uuid> \
    --rate 1.5 --poll-interval 2

Exit codes: 0 clean run (Ctrl+C), 1 configuration error, 2 unrecoverable.
"""

import argparse
import hashlib
import hmac
import json
import sys
import time
import uuid

import requests


class PumpMock:
    def __init__(self, base_url, api_key, signing_secret, pump_id, rate, poll_interval, status_interval, verify):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.signing_secret = signing_secret.encode()
        self.pump_id = pump_id
        self.rate = rate          # litres per second the "pump" delivers
        self.poll_interval = poll_interval
        self.status_interval = status_interval
        self.verify = verify      # TLS verification flag
        self.session = requests.Session()
        self.session.headers["x-api-key"] = api_key

        self.txn = None           # authorization currently being dispensed
        self.dispensed = 0.0

    # ---- HTTP ------------------------------------------------------------------
    def _url(self, path):
        return f"{self.base_url}/api/esp32{path}"

    def get_authorization(self):
        try:
            r = self.session.get(
                self._url(f"/authorizations/{self.pump_id}"),
                timeout=5,
                verify=self.verify,
            )
        except requests.RequestException as exc:
            print(f"[poll] connection error: {exc}")
            return None
        if r.status_code != 200:
            print(f"[poll] HTTP {r.status_code}: {r.text[:120]}")
            return None
        return r.json().get("authorization")

    def post_status(self, pump_state, error=None):
        body = {"current_litres": round(self.dispensed, 3), "pump_state": pump_state}
        if error:
            body["error"] = error
        try:
            self.session.post(self._url(f"/status/{self.pump_id}"), json=body, timeout=5, verify=self.verify)
        except requests.RequestException as exc:
            print(f"[status] connection error: {exc}")

    def post_ack(self):
        body = {
            "transaction_id": self.txn["transaction_id"],
            "actual_litres": round(self.dispensed, 3),
            "device_signature": self.txn["signature"],
        }
        try:
            r = self.session.post(
                self._url(f"/authorizations/{self.pump_id}/ack"),
                json=body,
                timeout=8,
                verify=self.verify,
            )
        except requests.RequestException as exc:
            print(f"[ack] connection error (will retry): {exc}")
            return False
        if r.status_code == 200:
            data = r.json()
            print(
                f"[ack] settled {data.get('transaction_reference')}: "
                f"final {data.get('final_amount')}, refund {data.get('refund_amount')}"
            )
            return True
        print(f"[ack] HTTP {r.status_code}: {r.text[:160]}")
        # 4xx (other than transient 5xx) means the server rejected this ack
        # permanently — drop the txn so we don't loop forever.
        return 500 <= r.status_code < 600

    # ---- Signature verification ----------------------------------------------------
    def verify_signature(self, auth):
        fields = [
            "transaction_reference", "request_id", "user_id", "station_id", "pump_id",
            "fuel_type_id", "price_per_litre", "authorized_litres", "authorized_amount",
            "status", "started_at",
        ]
        payload = "|".join(str(auth.get(f, "")) for f in fields)
        expected = auth.get("signature", "")
        actual = hmac.new(self.signing_secret, payload.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(actual, expected)

    # ---- Main loop -----------------------------------------------------------------
    def run(self):
        print(f"[mock] pump {self.pump_id} @ {self.base_url} (rate {self.rate} L/s)")
        last_poll = 0.0
        last_status = 0.0
        while True:
            now = time.monotonic()

            if self.txn is None:
                if now - last_poll >= self.poll_interval:
                    last_poll = now
                    auth = self.get_authorization()
                    if auth:
                        if not self.verify_signature(auth):
                            print("[SECURITY] signature mismatch — refusing to dispense!")
                        else:
                            self.txn = auth
                            self.dispensed = 0.0
                            litres = float(auth["authorized_litres"])
                            print(f"[pump] START {auth['transaction_reference']} for {litres} L")
                            self.post_status("DISPENSING")
            else:
                self.dispensed = min(self.dispensed + self.rate * (now - last_status if last_status else self.rate), float(self.txn["authorized_litres"]))
                if now - last_status >= self.status_interval or self.dispensed >= float(self.txn["authorized_litres"]):
                    last_status = now
                    done = self.dispensed >= float(self.txn["authorized_litres"])
                    self.post_status("DISPENSING" if not done else "COMPLETING")
                    if done:
                        if self.post_ack():
                            self.txn = None
                            self.dispensed = 0.0

            time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description="ESP32 pump controller mock for the Smart Fuel Pump backend")
    ap.add_argument("--base-url", default="http://localhost:4000")
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--signing-secret", required=True)
    ap.add_argument("--pump-id", required=True)
    ap.add_argument("--rate", type=float, default=1.5, help="litres per second")
    ap.add_argument("--poll-interval", type=float, default=2.0, help="seconds between authorization polls")
    ap.add_argument("--status-interval", type=float, default=1.0, help="seconds between telemetry posts")
    ap.add_argument("--no-verify-tls", action="store_true", help="disable TLS cert verification (dev only)")
    args = ap.parse_args()

    if not args.pump_id or args.pump_id.startswith("paste-"):
        ap.error("--pump-id must be the UUID of a pump created in the system")
    try:
        uuid.UUID(args.pump_id)
    except ValueError:
        ap.error("--pump-id must be a valid UUID")

    mock = PumpMock(
        base_url=args.base_url,
        api_key=args.api_key,
        signing_secret=args.signing_secret,
        pump_id=args.pump_id,
        rate=args.rate,
        poll_interval=args.poll_interval,
        status_interval=args.status_interval,
        verify=not args.no_verify_tls,
    )
    try:
        mock.run()
    except KeyboardInterrupt:
        print("\n[mock] stopped")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
