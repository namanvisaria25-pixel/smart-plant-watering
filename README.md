# IoT Smart Plant Watering System

Complete mini-project using:

- ESP32 firmware (Arduino)
- Node.js + Express backend
- Web dashboard (HTML/CSS/JS + Chart.js)

Watering is based on a **Water Requirement Score** (weighted formula), not only a single threshold.

## Supported Plants (Only 5)

1. Aloe Vera
2. Money Plant
3. Holy Basil (Tulsi)
4. Rosemary
5. Snake Plant

## Folder Structure

```text
.
├── backend
│   ├── data/db.json
│   ├── package.json
│   └── src
│       ├── config/plants.js
│       ├── storage/db.js
│       └── server.js
├── dashboard
│   ├── app.js
│   ├── config.js
│   ├── index.html
│   └── styles.css
├── firmware
│   └── esp32_smart_plant/esp32_smart_plant.ino
└── render.yaml
```

## Architecture

### ESP32 firmware

- Reads soil moisture, temperature, humidity, and light
- Pulls plant config from cloud (`GET /config`)
- Computes Water Requirement Score
- Turns pump on when score exceeds selected-plant threshold
- Enforces cooldown to prevent overwatering
- Sends logs and sensor data to cloud
- Uses local fallback logic when internet is unavailable

### Cloud backend

- Stores sensor data, selected plant, pump status, and watering logs
- Exposes required APIs:
  - `POST /sensor-data`
  - `GET /config`
  - `POST /watering-log`
- Also exposes dashboard APIs:
  - `POST /config`
  - `POST /manual-watering`
  - `GET /dashboard-state`
  - `GET /plant-profiles`

### Web dashboard

- Plant selection UI (the 5 supported plants)
- Live sensor display
- Pump status and last watered time
- Historical graphs via Chart.js
- Manual watering request button

## Water Requirement Score

All sensor values are normalized to `0-100` first.

```text
Score =
  (soilDrynessWeight * SoilDryness)
  + (temperatureWeight * TemperatureNormalized)
  - (humidityWeight * HumidityNormalized)
  + (lightWeight * LightNormalized)
```

## Deploy with GitHub + Render

This project is ready for your selected stack:

- GitHub: source code + optionally dashboard hosting
- Render: backend API hosting

### Step 1: Push project to GitHub

```powershell
git init
git add .
git commit -m "Initial smart plant watering system"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### Step 2: Deploy backend on Render

1. Open Render Dashboard.
2. Click **New +** -> **Web Service**.
3. Connect your GitHub repo.
4. Render auto-detects `render.yaml` in this repo.
5. Deploy.
6. After deploy, copy your backend URL, for example:
   - `https://smart-plant-watering.onrender.com`

### Step 3A: Host dashboard from same Render service (simplest)

No extra setup needed.

- Open backend URL in browser.
- The server already serves `dashboard/index.html`.

### Step 3B: Host dashboard on GitHub Pages (optional)

If you prefer GitHub Pages for frontend:

1. Put dashboard files in your Pages branch/folder (`index.html`, `styles.css`, `app.js`, `config.js`).
2. In `dashboard/config.js`, set:

```js
window.APP_CONFIG = {
  API_BASE_URL: "https://smart-plant-watering.onrender.com"
};
```

3. Enable GitHub Pages in repo settings.
4. Open your Pages URL.

## ESP32 Setup for Render Backend

In `firmware/esp32_smart_plant/esp32_smart_plant.ino`, set:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL` to your Render URL:

```cpp
const char* API_BASE_URL = "https://smart-plant-watering.onrender.com";
```

Then upload firmware.

## Hardware Pins (ESP32)

- Soil moisture sensor -> `GPIO 34` (analog)
- LDR divider -> `GPIO 35` (analog)
- DHT11 -> `GPIO 4`
- Relay -> `GPIO 26`
- Pump -> relay output

## Important Data Storage Note for Render

By default, JSON file storage on Render can reset on redeploy/restart.

- Local dev file: `backend/data/db.json`
- Backend supports custom data path via:
  - `DATA_DIR` env var
  - `DB_PATH` env var

For better persistence in production, use one of these:

1. Render persistent disk + `DATA_DIR=/var/data`
2. External database (MongoDB/Postgres/Firebase)

## Local Run (Optional)

```powershell
cd backend
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Constraints Satisfied

- No camera or image processing
- Exactly 5 supported plants
- User selects one plant and logic adapts
- Score-based watering + cooldown + offline fallback
