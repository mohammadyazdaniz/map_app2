import csv
import json
import logging
import math
import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
# Support both project/app.py and project/backend/app.py layouts.
ROOT = BASE_DIR if (BASE_DIR / "data").is_dir() else BASE_DIR.parent
DATA_DIR = Path(os.environ.get("MAP_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
logger = logging.getLogger(__name__)

_cache = {}


CITIES = {
    "Tehran": {
        "center": [51.3479, 35.6982],
        "zoom": 12
    },
    "Isfahan": {
        "center": [51.6734, 32.6683],
        "zoom": 12
    },
    "Mashhad": {
        "center": [59.5559, 36.2988],
        "zoom": 12
    }
}


DATA_SOURCES = {
    "Tehran": {
        "poi_collecting": DATA_DIR / "Tehran" / "tehran_POI.geojson",
        "poi_osm": DATA_DIR / "Tehran" / "Tehran_poi_osm.geojson",
        "traffic_lights_collecting": DATA_DIR / "Tehran" / "tehran_traffic_lights.geojson",
        "traffic_lights_osm": DATA_DIR / "Tehran" / "Tehran_traffic_signals_osm.geojson",
        "speed_cameras_collecting": DATA_DIR / "Tehran" / "tehran_speed_cameras.geojson",
        "speed_cameras_osm": DATA_DIR / "Tehran" / "tehran_speed_camera_osm.geojson",
        "bus_stops": DATA_DIR / "Tehran" / "tehran public transportation" / "bus_stations.csv"
    },
    "Isfahan": {
        "poi_collecting": DATA_DIR / "Isfahan" / "Isfahan_POI.geojson",
        "poi_osm": DATA_DIR / "Isfahan" / "Isfahan_poi_osm.geojson",
        "traffic_lights_collecting": DATA_DIR / "Isfahan" / "isfahan_traffic_lights.geojson",
        "traffic_lights_osm": DATA_DIR / "Isfahan" / "Isfahan_traffic_signals_osm.geojson",
        "speed_cameras_collecting": DATA_DIR / "Isfahan" / "isfahan_speed_cameras.geojson",
        "speed_cameras_osm": DATA_DIR / "Isfahan" / "Isfahan_speed_camera_osm.geojson",
    },
    "Mashhad": {
        "poi_collecting": DATA_DIR / "Mashhad" / "Mashhad_POI.geojson",
        "poi_osm": DATA_DIR / "Mashhad" / "Mashhad_poi_osm.geojson",
        "traffic_lights_collecting": DATA_DIR / "Mashhad" / "mashhad_traffic_lights.geojson",
        "traffic_lights_osm": DATA_DIR / "Mashhad" / "Mashhad_traffic_signals_osm.geojson",
        "speed_cameras_collecting": DATA_DIR / "Mashhad" / "mashhad_speed_cameras.geojson",
        "speed_cameras_osm": DATA_DIR / "Mashhad" / "Mashhad_speed_camera_osm.geojson",
    }
}


CATEGORY_LABELS = {
    "automotive": "Automotive Services",
    "industrial": "Industrial & Manufacturing",
    "business_office": "Business & Offices",
    "professional_service": "Professional Services",
    "general_retail": "General Retail",
    "fashion": "Fashion & Clothing",
    "beauty_accessories": "Beauty & Accessories",
    "home_goods": "Home & Furniture",
    "food_retail": "Grocery & Food Retail",
    "food_service": "Restaurants & Cafes",
    "hospital_emergency": "Hospital & Emergency",
    "medical_care": "Medical Care",
    "pharmacy_optical": "Pharmacy & Optical",
    "education": "Education",
    "finance": "Banking & Finance",
    "government_security": "Government & Security",
    "public_service": "Public Services",
    "public_transport": "Public Transportation",
    "parking_road_facility": "Parking & Road Facilities",
    "accommodation": "Accommodation",
    "sport_recreation": "Sports & Recreation",
    "culture_attraction": "Culture & Attractions",
    "religion": "Religious Places",
    "settlement_residential": "Residential & Geographic",
    "other": "Other"
}

CATEGORY_COLORS = {
    "automotive": "#2ecc71",
    "industrial": "#78523e",
    "business_office": "#4e497c",
    "professional_service": "#506aa0",
    "general_retail": "#194aa4",
    "fashion": "#194aa4",
    "beauty_accessories": "#194aa4",
    "home_goods": "#194aa4",
    "food_retail": "#b4612f",
    "food_service": "#b4612f",
    "hospital_emergency": "#d14a4a",
    "medical_care": "#d14a4a",
    "pharmacy_optical": "#d14a4a",
    "education": "#78523e",
    "finance": "#4e497c",
    "government_security": "#506aa0",
    "public_service": "#506aa0",
    "public_transport": "#1787d4",
    "parking_road_facility": "#78523e",
    "accommodation": "#78523e",
    "sport_recreation": "#067c91",
    "culture_attraction": "#067c91",
    "religion": "#78523e",
    "settlement_residential": "#78523e",
    "other": "#999",
}

CATEGORY_ICONS = {
    "automotive": "car-repair.svg",
    "industrial": "industry.svg",
    "business_office": "building.svg",
    "professional_service": "building.svg",
    "general_retail": "shop.svg",
    "fashion": "clothing-store.svg",
    "beauty_accessories": "shop.svg",
    "home_goods": "furniture.svg",
    "food_retail": "grocery.svg",
    "food_service": "restaurant.svg",
    "hospital_emergency": "hospital.svg",
    "medical_care": "doctor.svg",
    "pharmacy_optical": "pharmacy.svg",
    "education": "school.svg",
    "finance": "bank.svg",
    "government_security": "police.svg",
    "public_service": "post.svg",
    "public_transport": "bus.svg",
    "parking_road_facility": "parking.svg",
    "accommodation": "lodging.svg",
    "sport_recreation": "park.svg",
    "culture_attraction": "museum.svg",
    "religion": "place-of-worship.svg",
    "settlement_residential": "home.svg",
    "other": "marker.svg",
}


def _coordinates(lon, lat):
    try:
        if isinstance(lon, bool) or isinstance(lat, bool):
            return None
        lon, lat = float(lon), float(lat)
        if math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90:
            return lon, lat
    except (ValueError, TypeError, OverflowError):
        pass
    return None


def _points(filepath):
    if not filepath or not filepath.is_file():
        return
    with filepath.open(encoding="utf-8-sig") as stream:
        data = json.load(stream)
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise ValueError(f"Expected a GeoJSON FeatureCollection in {filepath.name}")
    for feature in data["features"]:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        if not isinstance(geometry, dict) or geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates")
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        point = _coordinates(coords[0], coords[1])
        if point is None:
            continue
        props = feature.get("properties")
        yield point, props if isinstance(props, dict) else {}


def _poi_props(props, source):
    category = str(props.get("category") or "other")
    subtype = str(props.get("sub_category") or props.get("type") or "general")
    return {
        "name": str(props.get("name") or props.get("name:fa") or ""),
        "type": subtype, "category": category,
        "category_label": CATEGORY_LABELS.get(category, category),
        "sub_category_label": str(props.get("sub_category_label") or subtype.replace("_", " ").replace("-", " ").title()),
        "icon": (props.get("icon") if source == "osm" else None) or CATEGORY_ICONS.get(category, "marker.svg"),
        "color": (props.get("color") if source == "osm" else None) or CATEGORY_COLORS.get(category, "#999"),
        "group": "poi", "source": source,
        "osm_id": props.get("osm_id", ""),
        "slug": str(props.get("slug") or "")
    }


def _load_geojson_fast(filepath, source_label="collecting"):
    return [{"lon": point[0], "lat": point[1], "props": _poi_props(props, source_label)}
            for point, props in _points(filepath)]


def _load_poi_csv_fast(filepath):
    if not filepath or not filepath.is_file():
        return []
    result = []
    with filepath.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not {"longitude", "latitude"}.issubset(reader.fieldnames or []):
            raise ValueError(f"Missing longitude/latitude columns in {filepath.name}")
        for row in reader:
            point = _coordinates(row.get("longitude"), row.get("latitude"))
            if point:
                result.append({"lon": point[0], "lat": point[1], "props": _poi_props(row, "collecting")})
    return result


def _load_osm_poi_fast(filepath, source_label):
    return _load_geojson_fast(filepath, source_label)


def _load_road_points(filepath, source_label, group, subtype, label, icon):
    result = []
    for point, props in _points(filepath):
        result.append({"lon": point[0], "lat": point[1], "props": {
            "name": str(props.get("name") or ""), "type": subtype,
            "category": group, "category_label": label,
            "sub_category_label": subtype.replace("_", " ").title(),
            "icon": icon, "color": "#FF3B30" if source_label == "collecting" else "#0066FF",
            "group": group, "source": source_label, "osm_id": props.get("osm_id", "")
        }})
    return result


def _load_traffic_lights_fast(filepath, source_label):
    return _load_road_points(filepath, source_label, "traffic_lights", "traffic_signal", "Traffic Lights", "traffic-signal.svg")


def _load_speed_cameras_fast(filepath, source_label):
    return _load_road_points(filepath, source_label, "speed_cameras", "speed_camera", "Speed Cameras", "speed-camera.svg")


def _load_bus_stops_fast(filepath):
    if not filepath or not filepath.is_file():
        return []
    result = []
    with filepath.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"StationCode", "StationName", "Longitude", "Latitude"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Missing bus station columns in {filepath.name}")
        for row in reader:
            point = _coordinates(row.get("Longitude"), row.get("Latitude"))
            code = str(row.get("StationCode") or "").strip()
            # CSV exports sometimes represent integer codes as 123.0.
            if code.endswith(".0"):
                code = code[:-2]
            if not point or not code.isascii() or not code.isdigit():
                continue
            result.append({"lon": point[0], "lat": point[1], "props": {
                "code": code, "name": str(row.get("StationName") or ""),
                "type": "bus_stop", "category": "public_transport",
                "category_label": "Public Transportation", "sub_category_label": "Bus Stop",
                "icon": "bus.svg", "color": "#2ecc71", "group": "bus", "source": "collecting"
            }})
    return result


_signatures = {}
_load_warnings = {}


def load_city_data(city):
    if city not in CITIES:
        raise ValueError(f"Unknown city: {city}")
    sources = DATA_SOURCES.get(city, {})
    signature = tuple((key, str(path), path.stat().st_mtime_ns, path.stat().st_size)
                      if path.is_file() else (key, str(path), None, None)
                      for key, path in sources.items())
    if city in _cache and _signatures.get(city) == signature:
        return _cache[city]
    layers, warnings = {}, []
    for key in LAYER_META:
        path = sources.get(key)
        layers[key] = []
        if path is None:
            continue
        if not path.is_file():
            warnings.append(f"Missing data file: {path.relative_to(DATA_DIR) if path.is_relative_to(DATA_DIR) else path.name}")
            continue
        source = "osm" if key.endswith("_osm") else "collecting"
        try:
            if key == "bus_stops":
                layers[key] = _load_bus_stops_fast(path)
            elif key.startswith("poi"):
                layers[key] = (_load_poi_csv_fast(path) if path.suffix.lower() == ".csv"
                               else _load_geojson_fast(path, source))
            elif key.startswith("traffic_lights"):
                layers[key] = _load_traffic_lights_fast(path, source)
            elif key.startswith("speed_cameras"):
                layers[key] = _load_speed_cameras_fast(path, source)
        except (OSError, ValueError, csv.Error) as exc:
            logger.warning("Unable to load %s: %s", path, exc)
            warnings.append(f"Could not load {path.name}; check its format and permissions.")
    _cache[city], _signatures[city], _load_warnings[city] = layers, signature, warnings
    return layers


LAYER_META = {
    "poi_collecting": {"label": "POI (Collecting)", "group": "poi", "color": "#0066FF"},
    "poi_osm": {"label": "POI (OSM)", "group": "poi", "color": "#FF6600"},
    "traffic_lights_collecting": {"label": "Traffic Lights (Collecting)", "group": "traffic_lights", "color": "#FF3B30"},
    "traffic_lights_osm": {"label": "Traffic Lights (OSM)", "group": "traffic_lights", "color": "#0066FF"},
    "speed_cameras_collecting": {"label": "Speed Cameras (Collecting)", "group": "speed_cameras", "color": "#FF3B30"},
    "speed_cameras_osm": {"label": "Speed Cameras (OSM)", "group": "speed_cameras", "color": "#0066FF"},
    "bus_stops": {"label": "Bus Stops", "group": "bus", "color": "#0099CC"}
}


def build_layers_response(city):
    layers = load_city_data(city)

    result = {
        "city": city,
        "center": CITIES.get(city, {}).get("center", [51.3479, 35.6982]),
        "zoom": CITIES.get(city, {}).get("zoom", 12),
        "layers": {},
        "poi_type_info": {},
        "categories": {},
        "warnings": _load_warnings.get(city, [])
    }

    for layer_key, features in layers.items():
        meta = LAYER_META.get(layer_key, {"label": layer_key, "group": "other", "color": "#999"})

        layer_info = {
            "label": meta["label"],
            "group": meta["group"],
            "color": meta["color"],
            "count": len(features),
        }

        if meta["group"] == "poi":
            type_counts = {}
            category_counts = {}
            
            for f in features:
                poi_type = f.get("props", {}).get("type", "general")
                type_counts[poi_type] = type_counts.get(poi_type, 0) + 1
                
                category = f.get("props", {}).get("category", "other")
                category_counts[category] = category_counts.get(category, 0) + 1

            layer_info["type_counts"] = type_counts
            layer_info["category_counts"] = category_counts

            for f in features:
                props = f.get("props", {})
                category = props.get("category", "other")
                sub_category = props.get("type", "general")
                
                if category not in result["categories"]:
                    result["categories"][category] = {
                        "label": CATEGORY_LABELS.get(category, category),
                        "icon": CATEGORY_ICONS.get(category, "marker.svg"),
                        "color": CATEGORY_COLORS.get(category, "#999"),
                        "sub_categories": {}
                    }
                
                if sub_category not in result["categories"][category]["sub_categories"]:
                    result["categories"][category]["sub_categories"][sub_category] = {
                        "label": props.get("sub_category_label", sub_category.replace("_", " ").replace("-", " ").title()),
                        "icon": props.get("icon", CATEGORY_ICONS.get(category, "marker.svg")),
                        "color": props.get("color", CATEGORY_COLORS.get(category, "#999")),
                        "source": props.get("source", "unknown"),
                        "count": 0,
                        "counts": {}
                    }

                sub_info = result["categories"][category]["sub_categories"][sub_category]
                sub_info["count"] += 1
                src = props.get("source", "unknown")
                sub_info["counts"][src] = sub_info["counts"].get(src, 0) + 1

                poi_type = props.get("type", "general")
                if poi_type not in result["poi_type_info"]:
                    result["poi_type_info"][poi_type] = {
                        "icon": props.get("icon", "marker.svg"),
                        "color": props.get("color", "#999"),
                        "group": props.get("group", "other"),
                        "label": props.get("sub_category_label", poi_type.replace("_", " ").title()),
                        "category": category
                    }

        result["layers"][layer_key] = layer_info

    return result
