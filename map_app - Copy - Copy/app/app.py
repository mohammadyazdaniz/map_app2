from flask import Flask, jsonify, render_template, request, send_from_directory
from pathlib import Path
import math
import os
import requests as http_requests

from data_loader import load_city_data, CITIES, LAYER_META, build_layers_response

BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__, template_folder=str(BASE_DIR / "templates") if (BASE_DIR / "templates" / "index.html").is_file() else str(BASE_DIR))


# Keep Flask's normal static route, with a fallback for the supplied flat files.
@app.errorhandler(404)
def missing_file(error):
    if request.path in {"/static/app.js", "/static/style.css"}:
        return send_from_directory(BASE_DIR, request.path.rsplit("/", 1)[-1])
    return jsonify({"error": "Not found"}), 404

ETA_URL = (
    "https://application2.irantracking.com/"
    "modsapi/api/PublicTransport/"
    "BusStopETA"
)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/cities")
def api_cities():
    return jsonify(list(CITIES.keys()))


@app.route("/api/layers/<city>")
def api_layers(city):
    if city not in CITIES:
        return jsonify({"error": f"Unknown city: {city}"}), 400

    return jsonify(build_layers_response(city))


@app.route("/api/features/<city>")
def api_features(city):
    if city not in CITIES:
        return jsonify({"error": f"Unknown city: {city}"}), 400

    bbox_str = request.args.get("bbox", "")
    layers_str = request.args.get("layers", "")

    if not bbox_str:
        return jsonify({"error": "Missing bbox parameter"}), 400

    try:
        west, south, east, north = map(float, bbox_str.split(","))
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid bbox format"}), 400

    if not all(math.isfinite(v) for v in (west, south, east, north)) or south > north or south < -90 or north > 90:
        return jsonify({"error": "Invalid bbox coordinates"}), 400

    requested_layers = [l.strip() for l in layers_str.split(",") if l.strip()] if layers_str else []

    if any(key not in LAYER_META for key in requested_layers):
        return jsonify({"error": "Unknown layer"}), 400
    # Leaflet can return longitudes outside [-180, 180] after panning.
    full_world = abs(east - west) >= 360
    west, east = (west + 180) % 360 - 180, (east + 180) % 360 - 180
    all_layers = load_city_data(city)
    result = {}

    for layer_key, features in all_layers.items():
        if requested_layers and layer_key not in requested_layers:
            continue

        visible = []
        for f in features:
            lon = f["lon"]
            lat = f["lat"]
            in_longitude = full_world or (west <= lon <= east if west <= east else lon >= west or lon <= east)
            if in_longitude and south <= lat <= north:
                visible.append(f)

        meta = LAYER_META.get(layer_key, {"label": layer_key, "group": "other", "color": "#999"})
        is_collecting = not layer_key.endswith("_osm")
        result[layer_key] = {
            "label": meta["label"],
            "group": meta["group"],
            "color": meta["color"],
            "source": "collecting" if is_collecting else "osm",
            "features": visible
        }

    return jsonify(result)


@app.route("/api/eta/<int:station_code>", methods=["POST"])
def api_eta(station_code):
    try:
        response = http_requests.post(
            ETA_URL,
            json={"BusStopCode": str(station_code)},
            timeout=15
        )
        if response.status_code == 200:
            data = response.json()
            return jsonify(data)
        return jsonify({"error": f"Arrival service returned {response.status_code}"}), 502
    except http_requests.Timeout:
        return jsonify({"error": "Arrival service timed out"}), 504
    except (http_requests.RequestException, ValueError):
        return jsonify({"error": "Arrival service is unavailable or returned invalid JSON"}), 502


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", host="127.0.0.1", port=5001)
