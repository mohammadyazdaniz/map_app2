from flask import Flask, jsonify, render_template, request
from pathlib import Path
import math
import os
import traceback
import requests as http_requests

from data_loader import (
    load_city_data,
    CITIES,
    LAYER_META,
    build_layers_response
)


BASE_DIR = Path(__file__).resolve().parent

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates")
)


ETA_URL = (
    "https://application2.irantracking.com/"
    "modsapi/api/PublicTransport/"
    "BusStopETA"
)


# -------------------------
# HOME
# -------------------------

@app.route("/")
def index():
    return render_template("index.html")


# -------------------------
# CITIES
# -------------------------

@app.route("/api/cities")
def api_cities():
    return jsonify(list(CITIES.keys()))


# -------------------------
# MAIN MAP DATA
# -------------------------

@app.route("/api/layers/<city>")
def api_layers(city):

    try:

        print("\n==============================")
        print("REQUEST CITY:", city)
        print("==============================")

        if city not in CITIES:
            return jsonify({
                "error": f"Unknown city: {city}"
            }), 400


        print("Building layers response...")

        data = build_layers_response(city)


        print("SUCCESS")
        print("==============================\n")


        return jsonify(data)


    except Exception as e:

        print("\n\n******** LAYER ERROR ********")
        print(type(e).__name__)
        print(str(e))

        traceback.print_exc()

        print("*****************************\n\n")


        return jsonify({
            "error": str(e),
            "type": type(e).__name__
        }), 500



# -------------------------
# FEATURES WITH BBOX
# -------------------------

@app.route("/api/features/<city>")
def api_features(city):

    try:

        if city not in CITIES:
            return jsonify({
                "error": f"Unknown city: {city}"
            }), 400


        bbox_str = request.args.get("bbox", "")
        layers_str = request.args.get("layers", "")


        if not bbox_str:
            return jsonify({
                "error": "Missing bbox parameter"
            }), 400


        try:

            west, south, east, north = map(
                float,
                bbox_str.split(",")
            )

        except Exception:

            return jsonify({
                "error": "Invalid bbox format"
            }), 400



        if not all(
            math.isfinite(v)
            for v in (west, south, east, north)
        ):

            return jsonify({
                "error": "Invalid bbox coordinates"
            }), 400



        requested_layers = (
            [
                x.strip()
                for x in layers_str.split(",")
                if x.strip()
            ]
            if layers_str
            else []
        )


        for layer in requested_layers:

            if layer not in LAYER_META:

                return jsonify({
                    "error": f"Unknown layer {layer}"
                }), 400



        full_world = abs(east - west) >= 360


        if not full_world:

            west = (west + 180) % 360 - 180
            east = (east + 180) % 360 - 180



        all_layers = load_city_data(city)


        result = {}


        for layer_key, features in all_layers.items():


            if requested_layers:
                if layer_key not in requested_layers:
                    continue



            visible = []


            for feature in features:

                lon = feature.get("lon")
                lat = feature.get("lat")


                if lon is None or lat is None:
                    continue


                if full_world:

                    inside_lon = True

                elif west <= east:

                    inside_lon = west <= lon <= east

                else:

                    inside_lon = (
                        lon >= west or
                        lon <= east
                    )


                if inside_lon and south <= lat <= north:

                    visible.append(feature)



            meta = LAYER_META.get(
                layer_key,
                {
                    "label": layer_key,
                    "group": "other",
                    "color": "#999999"
                }
            )


            result[layer_key] = {

                "label": meta["label"],

                "group": meta["group"],

                "color": meta["color"],

                "source":
                    "osm"
                    if layer_key.endswith("_osm")
                    else "collecting",

                "features": visible

            }



        return jsonify(result)



    except Exception as e:


        print("\n******** FEATURES ERROR ********")

        traceback.print_exc()

        print("********************************\n")


        return jsonify({
            "error": str(e)
        }), 500




# -------------------------
# BUS ETA
# -------------------------

@app.route(
    "/api/eta/<int:station_code>",
    methods=["POST"]
)
def api_eta(station_code):

    try:

        response = http_requests.post(

            ETA_URL,

            json={
                "BusStopCode": str(station_code)
            },

            timeout=15
        )


        if response.status_code == 200:

            return jsonify(
                response.json()
            )


        return jsonify({

            "error":
            f"Arrival service returned {response.status_code}"

        }), 502



    except http_requests.Timeout:


        return jsonify({

            "error":
            "Arrival service timed out"

        }), 504



    except Exception:


        return jsonify({

            "error":
            "Arrival service unavailable"

        }), 502




# -------------------------
# LOCAL RUN
# -------------------------

if __name__ == "__main__":

    app.run(

        debug=os.environ.get("FLASK_DEBUG") == "1",

        host="0.0.0.0",

        port=5001

    )
