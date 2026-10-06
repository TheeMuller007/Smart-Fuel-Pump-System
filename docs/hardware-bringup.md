# Hardware Bring-Up Guide — ESP32 Pump Controller

Everything needed to go from a bag of parts to a controller that dispenses
fuel against the running backend. Follow the sections in order; each one ends
with a checkpoint you can verify before moving on.

## 1. Bill of materials

| Part | Qty | Notes |
|---|---|---|
| ESP32 dev board | 1 | Any WROOM-32 board (DevKit v1, NodeMCU-32S, …) |
| Flow sensor | 1 | YF-S201 / YF-S401 hall-effect turbine, 3-wire |
| Relay module | 1 | 1-channel 5 V, **opto-isolated, active-HIGH** |
| Buck converter | 1 | 12 V → 5 V (≥ 2 A) — powers ESP32 **and** relay coil |
| Fuel pump | 1 | 12 V DC pump sized for the relay's contact rating |
| 12 V PSU | 1 | Separate from the 5 V rail; sized for the pump's inrush |
| Dupont wires, breadboard | — | For bring-up; solder + enclosure for fuel-area use |

> **Safety:** the prototype runs water/air first (see calibration). Real fuel
> requires explosion-rated hardware, proper bonding/earthing and ventilation —
> this guide gets the *electronics* proven, not the fuel certification.

## 2. Wiring

### Power tree

```
12 V PSU ──► pump motor (+) ──► relay COM/NO contact ──► back to PSU (−)
        └─► buck converter IN ──► 5 V ──┬─► ESP32 VIN (or 5V pin)
                                        └─► relay module VCC
12 V PSU (−) ──► common GND with ESP32 GND and relay GND
```

**The pump's 12 V circuit and the 5 V logic share a ground but nothing else.**
The pump current flows only through the relay contacts.

### Signal connections (ESP32 → modules)

| ESP32 pin | Goes to | Direction | Notes |
|---|---|---|---|
| `GPIO 26` | Relay `IN` | OUT | HIGH = relay closed = pump ON |
| `GPIO 27` | Flow sensor signal (yellow) | IN (pullup) | Interrupt on FALLING edge |
| `3V3` | Flow sensor VCC (red) | — | Hall sensor runs on 3.3–5 V |
| `GND` | Flow sensor GND (black) | — | Common ground |
| `GPIO 2` | Onboard LED | OUT | DISPENSING indicator (free, no wiring) |
| `VIN` / `5V` | Buck 5 V out | IN | Power the board here, not over USB, once the relay is attached |

Checkpoint: with the firmware un-flashed, apply power — the relay must **not**
click at boot. If it does, your module is active-LOW; either use an
active-HIGH module or invert the logic in `startDispense()` / `stopRelay()`.

## 3. Firmware setup

1. **Arduino IDE** (or CLI): install the *esp32 by Espressif* board package,
   then in Library Manager install **ArduinoJson** (v6 or v7).
2. Copy `esp32-mock/firmware/config.h.example` to
   `esp32-mock/firmware/esp32_pump_controller/config.h` and fill it in
   (details in §4). `config.h` is git-ignored — never commit it.
3. Select your board (`Tools → Board → ESP32 Dev Module`), pick the COM port,
   and upload `esp32-mock/firmware/esp32_pump_controller.ino`.
4. Open the Serial Monitor at **115200 baud**.

Checkpoint: the boot log prints `[BOOT] Pump controller ready` after Wi-Fi
connects. Every HTTP call is logged with its status code.

## 4. config.h, field by field

```cpp
// Wi-Fi of the LAN where the backend runs (2.4 GHz — ESP32 has no 5 GHz radio)
const char* WIFI_SSID     = "your-wifi-ssid";
const char* WIFI_PASSWORD = "your-wifi-password";

// Where the backend lives — the PC's LAN IP, NOT localhost (§6)
const char* SERVER_HOST   = "192.168.1.50";
const uint16_t SERVER_PORT = 4000;
const bool SERVER_USE_TLS  = false;   // http on the LAN; TLS is a deployment step

// Device credentials — must match the server's .env exactly
const char* DEVICE_API_KEY        = "…ESP32_API_KEY from server .env…";
const char* DEVICE_SIGNING_SECRET = "…DEVICE_SIGNING_SECRET from server .env…";
const char* PUMP_ID               = "uuid of the pump row this controller drives";
```

`PUMP_ID` is the UUID of a pump created in the admin portal
(Stations → pumps). One controller drives exactly one pump; run two
controllers with two `config.h` files to drive two pumps.

Hardware pins — leave them unless your layout demands otherwise:

```cpp
const int RELAY_PIN        = 26;
const int FLOW_SENSOR_PIN  = 27;
const int STATUS_LED_PIN   = 2;
```

Calibration and timing constants are covered in §5.

**Getting the credentials:** in the project root, copy the values from
`.env` (`ESP32_API_KEY`, `DEVICE_SIGNING_SECRET`) into `config.h`. If the
server was started with different values, the device gets `403` on every
call — the serial log shows the exact code.

## 5. Pulses-per-litre calibration

The firmware converts pulses to litres as `litres = pulses / PULSES_PER_LITRE`,
so one wrong constant means a wrong *bill*. Calibrate on the bench with
**water** before any fuel:

1. Set a placeholder `PULSES_PER_LITRE = 450.0f` (YF-S201/S401 datasheet
   nominal) and flash.
2. Run a dispense through the UI into a **graduated container** with a known
   target, e.g. request 1.000 L.
3. Record the *measured* volume `M` (graduations) and the *reported* volume
   `R` (receipt shows `actual_litres`).
4. New constant: `PULSES_PER_LITRE = 450.0 × R / M`.
   * Reported 1.05 L but measured 1.00 L → the sensor over-counts →
     `450 × 1.05 / 1.00 = 472.5`.
5. Repeat the dispense; iterate until `R` and `M` agree within ±1 %.

Notes that save hours:

* **Flow rate matters.** These sensors are non-linear below ~1 L/min; calibrate
  at the flow rate the real pump produces (measure it — don't assume).
* **Temperature changes the constant** slightly; re-check when moving from
  water to fuel, and for real money-critical use, calibrate against a
  certified reference measure.
* If pulses arrive at all when the relay is OFF, you have electrical noise on
  GPIO 27 — add a 100 nF cap from signal to GND and keep the sensor wire away
  from the pump's 12 V cable.

Checkpoint: request 2.000 L, dispense, and the receipt's `actual_litres` is
within ±20 mL of the graduated cylinder.

## 6. LAN setup — letting the ESP32 reach your PC

The firmware calls `SERVER_HOST`, which must be the **PC's LAN IP**, because
from the ESP32's point of view `localhost` is *itself*, not your computer.

**Find the PC's IP** (the machine running `npm run dev`):

```
ipconfig          # Windows  — look for IPv4 Address under your Wi-Fi/Ethernet adapter
ip addr           # Linux
ifconfig | grep "inet "   # macOS
```

Put that address (e.g. `192.168.1.50`) in `config.h`.

**Checkpoint from the ESP32's network position:** before blaming the firmware,
verify the server is reachable *from another device on the same LAN*:

```
# from any phone/PC on the same Wi-Fi
curl http://192.168.1.50:4000/api/health     # → {"status":"ok"}
```

If that fails, the Windows **firewall** is the usual culprit:

```powershell
# One-time, admin PowerShell: allow inbound :4000 on private networks
New-NetFirewallRule -DisplayName "Smart Fuel API" -Direction Inbound `
  -LocalPort 4000 -Protocol TCP -Action Allow -Profile Private,Domain
```

**Binding check:** `src/index.js` listens on `0.0.0.0` by default, so the
server accepts LAN traffic. If you ever start it behind a dev proxy that binds
to `127.0.0.1`, LAN devices will get connection-refused while localhost works.

**Same-subnet rule:** the ESP32, the PC and the curl-test device must all be on
the *same* network (same SSID / same switch). Guest Wi-Fi and IoT-isolation
features on routers will silently block device→PC traffic; put the controller
on the same SSID as the PC or disable *client isolation* for that SSID.

**USB fallback:** while bench-testing with the board plugged into the PC, you
can also watch the serial log: `[HTTP] GET http://…/api/esp32/authorizations/…`
repeated every 3 s means Wi-Fi + routing are fine even before any request is
authorized.

## 7. End-to-end smoke test (water)

With the backend running (`npm run db:start` then `npm run dev`) and the
controller flashed and powered:

1. Log into the **customer** portal, create a 1.000 L request at your station.
2. Log into the **staff** portal, pick the pump tied to your `PUMP_ID`,
   **Assign** it, then **Authorize**.
3. Watch the controller: serial prints
   `[AUTH] Authorized FUEL-… for 1.000 L`, the relay clicks, water flows.
4. The **staff dashboard** shows live litres every 2 s (`DISPENSING`
   telemetry); the customer's portal shows the same progress.
5. At the authorized volume the relay clicks off, the transaction shows
   `COMPLETED`, the wallet moves `reserved → paid`, and the receipt PDF is
   downloadable.

Checkpoint: the receipt's litres match the graduated container within ±1 %.

## 8. Failure-mode drills (worth rehearsing)

These are exactly the behaviours the software was hardened for — test them:

| Drill | Expected behaviour |
|---|---|
| Pull the controller's power mid-dispense, wait, re-power | Serial shows `Recovering transaction … — completing without re-dispensing`; it re-acks and settles for the litres actually metered. Pump must never re-start. |
| Kill the backend (Ctrl+C) mid-dispense, keep the controller running | Controller keeps the relay in its last state and retries; after `STUCK_DISPENSE_TIMEOUT_MIN` (default 10 min) the server (once restarted) reaps the transaction: `CANCELLED`, pump freed, request back to `RESERVED`, **no charge**. |
| Stop the water source with the relay open | After `NO_FLOW_TIMEOUT_MS` with zero pulses the controller faults: relay off, `FAULT` telemetry, no charge until staff resolve. |
| Let a dispense run past `DISPENSE_TIMEOUT_MS` | Hard cap fires: relay off, `FAULT`, same as above. |

## 9. Troubleshooting quick reference

| Symptom | Likely cause → fix |
|---|---|
| Serial loops `WiFi … FAILED` | Wrong SSID/password, or a 5 GHz-only network — use 2.4 GHz. |
| `GET … -> 403` | `DEVICE_API_KEY` doesn't match the server's `.env`. |
| `GET … -> -1` (connection refused) | Wrong `SERVER_HOST` (localhost instead of LAN IP) or Windows firewall (§6). |
| `[AUTH] Signature mismatch` | `DEVICE_SIGNING_SECRET` differs from the server, or a *new* server field was added without bumping the firmware's payload builder — compare the 11-field list in `pollForAuthorization()` against the API docs. |
| Relay clicks but no litres counted | Sensor signal wire on the wrong pin, or sensor needs 5 V on VCC — check the wiring table in §2. |
| Litres counted with relay off | Electrical noise → 100 nF cap on GPIO 27, reroute the cable (§5). |
| Receipt litres drift ±3–5 % | Recalibrate `PULSES_PER_LITRE` at the real flow rate (§5). |
