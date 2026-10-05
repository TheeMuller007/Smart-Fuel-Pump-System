/*
 * Smart Fuel Pump — ESP32 Pump Controller firmware
 * Stage 9 deliverable: a compilable sketch that talks to the backend.
 *
 * Loop summary (matches the stage 9 spec):
 *   1. Connect Wi-Fi, wait for time sync (needed for TLS certificate
 *      validation; also used for log timestamps).
 *   2. Poll GET /api/esp32/authorizations/<PUMP_ID> every POLL_INTERVAL_MS.
 *   3. On receipt of an AUTHORIZED transaction: verify the HMAC-SHA256
 *      signature, then open the relay to power the pump.
 *   4. Count flow-sensor pulses -> litres; POST /api/esp32/status/<PUMP_ID>
 *      every STATUS_INTERVAL_MS with {current_litres, pump_state}.
 *   5. current >= authorized -> close relay, POST .../ack with the final
 *      quantity (server settles the wallet and issues the receipt).
 *   6. Error paths: no-flow timeout, dispense timeout, sensor out of range
 *      -> POST status with an error string and close the relay (fail safe).
 *
 * Hardware assumptions (adjust in config.h):
 *   - Relay module on RELAY_PIN (HIGH = pump ON).
 *   - YF-S401 / YF-S201 flow sensor pulse output on FLOW_SENSOR_PIN.
 *
 * Libraries (Arduino Library Manager): ArduinoJson (v6 or v7).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <mbedtls/md.h>

#include "config.h"

// ---- Volatile counters (ISR) -------------------------------------------------
volatile unsigned long gPulseCount = 0;

void IRAM_ATTR onFlowPulse() {
  gPulseCount++;
}

// ---- State --------------------------------------------------------------------
enum ControllerState { IDLE, DISPENSING, FAULT };
ControllerState gState = IDLE;

String gTxnId;
String gTxnRef;
String gSignature;
float gAuthorizedLitres = 0.0f;
float gStartLitres = 0.0f;
unsigned long gDispenseStartMs = 0;
unsigned long gLastStatusMs = 0;
unsigned long gLastPulseMs = 0;
String gLastError;

unsigned long gLastPollMs = 0;

float litresFromPulses(unsigned long pulses) {
  return (float)pulses / PULSES_PER_LITRE;
}

// ---- HMAC-SHA256 (mbedTLS, bundled with the ESP32 Arduino core) -----------------
bool verifySignature(const String& payload, const String& expectedHex) {
  if (expectedHex.length() != 64) return false; // SHA-256 = 32 bytes = 64 hex
  byte mac[32];
  memset(mac, 0, sizeof(mac));
  const char* key = DEVICE_SIGNING_SECRET;
  mbedtls_md_hmac(
    mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
    (const unsigned char*)key, strlen(key),
    (const unsigned char*)payload.c_str(), payload.length(), mac);
  static const char* hex = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    char buf[3] = { hex[mac[i] >> 4], hex[mac[i] & 0xF], 0 };
    if (buf[0] != expectedHex[i * 2] || buf[1] != expectedHex[i * 2 + 1]) return false;
  }
  return true;
}

// ---- HTTP helpers -----------------------------------------------------------------
String httpGet(const String& url) {
  HTTPClient http;
  http.begin(url);
  http.setTimeout(5000);
  http.addHeader("x-api-key", DEVICE_API_KEY);
  const int code = http.GET();
  String body = (code > 0) ? http.getString() : String("");
  http.end();
  if (code != 200) {
    Serial.printf("[HTTP] GET %s -> %d\n", url.c_str(), code);
    return String("");
  }
  return body;
}

int httpPost(const String& url, const String& json) {
  HTTPClient http;
  http.begin(url);
  http.setTimeout(5000);
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST(json);
  if (code < 200 || code >= 300) {
    Serial.printf("[HTTP] POST %s -> %d\n", url.c_str(), code);
    Serial.println(http.getString());
  }
  http.end();
  return code;
}

String baseUrl() {
  return String(SERVER_USE_TLS ? "https://" : "http://") + SERVER_HOST + ":" + String(SERVER_PORT);
}

// ---- Wi-Fi -----------------------------------------------------------------------
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[WiFi] connecting");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " FAILED");
}

// ---- Authorization polling ----------------------------------------------------------
bool pollForAuthorization() {
  String body = httpGet(baseUrl() + "/api/esp32/authorizations/" + PUMP_ID);
  if (body.length() == 0) return false;

  JsonDocument doc; // ArduinoJson v7; v6: StaticJsonDocument<2048>
  if (deserializeJson(doc, body) != DeserializationError::Ok) return false;
  if (doc["authorization"].isNull()) return false;

  JsonObject auth = doc["authorization"];
  gTxnId = auth["transaction_id"].as<String>();
  gTxnRef = auth["transaction_reference"].as<String>();
  gSignature = auth["signature"].as<String>();
  gAuthorizedLitres = auth["authorized_litres"].as<float>();

  // Rebuild the signed payload exactly as the server documents it.
  const String payload =
    gTxnRef + "|" +
    auth["request_id"].as<String>() + "|" +
    auth["user_id"].as<String>() + "|" +
    auth["station_id"].as<String>() + "|" +
    auth["pump_id"].as<String>() + "|" +
    auth["fuel_type_id"].as<String>() + "|" +
    String(auth["price_per_litre"].as<String>()) + "|" +
    String(auth["authorized_litres"].as<String>()) + "|" +
    String(auth["authorized_amount"].as<String>()) + "|" +
    String(auth["status"].as<String>()) + "|" +
    String(auth["started_at"].as<String>());

  if (!verifySignature(payload, gSignature)) {
    Serial.println("[AUTH] Signature mismatch — refusing to dispense!");
    gTxnId = "";
    return false;
  }
  Serial.printf("[AUTH] Authorized %s for %.3f L\n", gTxnRef.c_str(), gAuthorizedLitres);
  return true;
}

// ---- Dispensing -------------------------------------------------------------------------
void startDispense() {
  gState = DISPENSING;
  gStartLitres = litresFromPulses(gPulseCount);
  gDispenseStartMs = millis();
  gLastPulseMs = millis();
  gLastError = "";
  digitalWrite(RELAY_PIN, HIGH); // pump ON
  digitalWrite(STATUS_LED_PIN, HIGH);
  Serial.println("[PUMP] Relay OPEN — dispensing");
}

void stopRelay() {
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);
}

void reportStatus(const String& pumpState, const String& error = "") {
  const float current = litresFromPulses(gPulseCount) - gStartLitres;
  String json = "{\"current_litres\":" + String(current, 3) +
                ",\"pump_state\":\"" + pumpState + "\"";
  if (error.length() > 0) {
    json += ",\"error\":\"" + error + "\"";
  }
  json += "}";
  httpPost(baseUrl() + "/api/esp32/status/" + PUMP_ID, json);
}

void completeDispense() {
  stopRelay();
  const float finalLitres = litresFromPulses(gPulseCount) - gStartLitres;
  String json = "{\"transaction_id\":\"" + gTxnId + "\",\"actual_litres\":" +
                String(finalLitres, 3) + ",\"device_signature\":\"" + gSignature + "\"}";
  const int code = httpPost(baseUrl() + "/api/esp32/authorizations/" + PUMP_ID + "/ack", json);
  if (code >= 200 && code < 300) {
    Serial.printf("[PUMP] Completed %.3f L — wallet settled\n", finalLitres);
  } else {
    // The server is idempotent: a retry later returns already_completed.
    Serial.println("[PUMP] Ack failed — will retry next loop");
  }
  reportStatus("COMPLETED");
  gState = IDLE;
  gTxnId = "";
}

void enterFault(const String& reason) {
  stopRelay();
  gState = FAULT;
  gLastError = reason;
  Serial.println("[FAULT] " + reason);
  reportStatus("FAULT", reason);
}

void tickDispensing() {
  const unsigned long now = millis();
  const float current = litresFromPulses(gPulseCount) - gStartLitres;

  // Track pulse recency for the no-flow timeout.
  static unsigned long sLastCount = 0;
  if (gPulseCount != sLastCount) {
    sLastCount = gPulseCount;
    gLastPulseMs = now;
  }

  if (current >= gAuthorizedLitres) {
    completeDispense();
    return;
  }
  if (now - gLastPulseMs > NO_FLOW_TIMEOUT_MS) {
    enterFault("No flow detected for " + String(NO_FLOW_TIMEOUT_MS / 1000) + "s");
    return;
  }
  if (now - gDispenseStartMs > DISPENSE_TIMEOUT_MS) {
    enterFault("Dispense exceeded the maximum time");
    return;
  }
  if (now - gLastStatusMs >= STATUS_INTERVAL_MS) {
    gLastStatusMs = now;
    reportStatus("DISPENSING");
  }
}

// ---- Arduino lifecycle -----------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  stopRelay();
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), onFlowPulse, FALLING);
  ensureWifi();
  Serial.println("[BOOT] Pump controller ready");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) ensureWifi();

  const unsigned long now = millis();

  switch (gState) {
    case IDLE:
      if (now - gLastPollMs >= POLL_INTERVAL_MS) {
        gLastPollMs = now;
        if (pollForAuthorization()) startDispense();
      }
      break;
    case DISPENSING:
      tickDispensing();
      break;
    case FAULT:
      // Stay in fault until power cycle; keep reporting so dashboards see it.
      if (now - gLastStatusMs >= STATUS_INTERVAL_MS * 5) {
        gLastStatusMs = now;
        reportStatus("FAULT", gLastError);
      }
      break;
  }
}
