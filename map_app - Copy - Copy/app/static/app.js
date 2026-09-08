"use strict";

const LAYER_GROUPS = {
    poi: { label: "Points of Interest", color: "#1787d4" },
    traffic_lights: { label: "Traffic Lights", color: "#e94560" },
    speed_cameras: { label: "Speed Cameras", color: "#f39c12" },
    bus: { label: "Bus Stops", color: "#2ecc71" }
};

const SOURCE_COLORS = {
    collecting: { main: "#0066FF", light: "#00AAFF" },
    osm: { main: "#FF6600", light: "#FF9933" }
};

const state = {
    currentCity: "Tehran",
    cityMeta: null,
    activeTypes: new Set(),
    activeCategories: new Set(),
    activeSubCategories: new Set(),
    activeSources: new Set(),
    map: null,
    markerLayers: {},
    allFeatures: [],
    etaInterval: null,
    currentStationCode: null,
    fetchTimer: null,
    categories: {},
    centerMarker: null,
    disabledSources: new Set(),
    cityRequest: 0,
    featureRequest: 0,
    featureController: null,
    etaRequest: 0
};

const els = {
    loading: document.getElementById("loading-overlay"),
    loadingText: document.getElementById("loading-text"),
    featureCount: document.getElementById("feature-count"),
    layersPanel: document.getElementById("layers-panel"),
    searchInput: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    clearFilters: document.getElementById("clear-filters"),
    etaPanel: document.getElementById("eta-panel"),
    etaStationName: document.getElementById("eta-station-name"),
    etaStationCode: document.getElementById("eta-station-code"),
    etaStatus: document.getElementById("eta-status"),
    etaList: document.getElementById("eta-list"),
    closeEta: document.getElementById("close-eta")
};

function setLoading(text) {
    els.loadingText.textContent = text;
}

function hideLoading() {
    els.loading.classList.add("hidden");
}

function showLoading() {
    els.loading.classList.remove("hidden");
}

async function fetchJSON(url, options = {}) {
    const res = await fetch(url, {
        cache: "no-store",
        ...options
    });

    if (!res.ok) {
        throw new Error(`${url}: ${res.status}`);
    }

    return res.json();
}

function initMap(centerLatLon, zoom) {
    // Leaflet coordinates use [latitude, longitude].
    if (state.map) {
        state.map.setView(centerLatLon, zoom);
        return state.map;
    }

    if (!window.L) {
        throw new Error(
            "The map library could not load. Check your internet connection and reload."
        );
    }

    const map = L.map("map", {
        center: centerLatLon,
        zoom,
        zoomControl: false
    });

    document.getElementById("map").style.background = "#111418";

        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);

    L.control.zoom({
        position: "topright"
    }).addTo(map);

    map.on("moveend", () => scheduleFetch());
    map.on("zoomend", () => scheduleFetch());

    setTimeout(() => {
        map.invalidateSize();
    }, 60);

    new ResizeObserver(() => {
        map.invalidateSize();
    }).observe(document.getElementById("map"));

    state.map = map;
    return map;
}

function getViewport() {
    const bounds = state.map.getBounds();

    return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth()
    };
}

function scheduleFetch() {
    if (state.fetchTimer) {
        clearTimeout(state.fetchTimer);
    }

    state.fetchTimer = setTimeout(fetchVisibleFeatures, 300);
}

async function fetchVisibleFeatures() {
    const requestId = ++state.featureRequest;

    state.featureController?.abort();

    if (!state.map || !state.cityMeta) {
        return;
    }

    if (
        state.activeTypes.size === 0 &&
        state.activeCategories.size === 0 &&
        state.activeSubCategories.size === 0
    ) {
        clearAllMarkers();
        return;
    }

    const viewport = getViewport();

    const bbox =
        `${viewport.west},${viewport.south},` +
        `${viewport.east},${viewport.north}`;

    const selectedLayers = new Set(state.activeTypes);

    if (
        state.activeCategories.size > 0 ||
        state.activeSubCategories.size > 0
    ) {
        selectedLayers.add("poi_collecting");
        selectedLayers.add("poi_osm");
    }

    const layers = Array.from(selectedLayers).join(",");
    const city = state.currentCity;
    const controller = new AbortController();

    state.featureController = controller;

    try {
        const url =
            `/api/features/${encodeURIComponent(city)}` +
            `?bbox=${encodeURIComponent(bbox)}` +
            `&layers=${encodeURIComponent(layers)}`;

        const data = await fetchJSON(url, {
            signal: controller.signal
        });

        if (
            requestId !== state.featureRequest ||
            city !== state.currentCity
        ) {
            return;
        }

        renderFeatures(data);
        showNotice("");
    } catch (err) {
        if (
            err.name === "AbortError" ||
            requestId !== state.featureRequest
        ) {
            return;
        }

        console.error("Fetch error:", err);
        clearAllMarkers();

        showNotice(
            "Could not load map features. Move the map or change a filter to retry."
        );
    }
}

function clearAllMarkers() {
    for (const key in state.markerLayers) {
        state.map?.removeLayer(state.markerLayers[key]);
    }

    state.markerLayers = {};
    state.allFeatures = [];

    els.searchResults.classList.remove("visible");
    updateFeatureCount();
}

function renderFeatures(data) {
    clearAllMarkers();

    for (const [layerKey, layerData] of Object.entries(data)) {
        const features = layerData.features || [];

        if (features.length === 0) {
            continue;
        }

        const source = layerData.source || "collecting";

        const sourceColor = safeColor(
            layerData.color,
            SOURCE_COLORS[source]?.main || "#999999"
        );

        const isCollecting = source === "collecting";

        // Traffic marker rings: red = Collecting, blue = OSM.
        const sourceRing = isCollecting ? "#FF3B30" : "#0066FF";

        // POI markers retain category colors.
        const poiBorderColor = isCollecting
            ? "rgba(255,255,255,0.92)"
            : "#FF6600";

        const filtered = features.filter(feature => {
            if (
                !feature ||
                !feature.props ||
                !Number.isFinite(feature.lat) ||
                !Number.isFinite(feature.lon)
            ) {
                return false;
            }

            const srcKey = feature.props.source || source;

            if (state.disabledSources.has(srcKey)) {
                return false;
            }

            if (layerData.group === "poi") {
                const category = feature.props.category;
                const subCategory = feature.props.type;
                const sourceKey = feature.props.source || "unknown";

                if (
                    !state.activeTypes.has(layerKey) &&
                    state.activeSubCategories.size === 0 &&
                    state.activeCategories.size === 0
                ) {
                    return false;
                }

                if (state.activeSubCategories.size > 0) {
                    const subKey =
                        `${category}|${subCategory}|${sourceKey}`;

                    if (!state.activeSubCategories.has(subKey)) {
                        return false;
                    }
                } else if (state.activeCategories.size > 0) {
                    if (!state.activeCategories.has(category)) {
                        return false;
                    }
                } else if (state.activeSources.size > 0) {
                    if (!state.activeSources.has(sourceKey)) {
                        return false;
                    }
                }
            }

            return true;
        });

        if (filtered.length === 0) {
            continue;
        }

        const group = L.layerGroup();

        filtered.forEach(feature => {
            const iconName = safeIcon(feature.props.icon);

            const markerColor = layerData.group === "poi"
                ? safeColor(feature.props.color, sourceColor)
                : sourceColor;

            const useSvgIcon =
                layerData.group === "traffic_lights" ||
                layerData.group === "speed_cameras";

            let html;

            if (useSvgIcon) {
                html = `
                    <div
                        class="marker-icon-svg"
                        style="
                            border-radius: 50%;
                            width: 46px;
                            height: 46px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            border: 3px solid ${sourceRing};
                            box-shadow:
                                0 0 0 3px ${sourceRing}55,
                                0 2px 6px rgba(0,0,0,0.45);
                            background: rgba(10,14,22,0.55);
                        "
                    >
                        <img
                            src="/static/icons/${iconName}"
                            alt=""
                            style="width: 34px; height: 34px;"
                        >
                    </div>
                `;
            } else {
                html = `
                    <div
                        class="marker-icon"
                        style="
                            background-color: ${markerColor};
                            border-color: ${poiBorderColor};
                        "
                    >
                        <img
                            src="/static/icons/${iconName}"
                            alt=""
                        >
                    </div>
                `;
            }

            const icon = L.divIcon({
                className: "custom-marker",
                html,
                iconSize: useSvgIcon ? [46, 46] : [32, 32],
                iconAnchor: useSvgIcon ? [23, 23] : [16, 16],
                popupAnchor: useSvgIcon ? [0, -23] : [0, -16]
            });

            state.allFeatures.push({
                geometry: {
                    coordinates: [feature.lon, feature.lat]
                },
                properties: {
                    ...feature.props,
                    color: markerColor,
                    label: layerData.label
                }
            });

            const popupHtml = `
                <div class="popup-name">
                    ${escapeHtml(feature.props.name || "Unnamed")}
                </div>

                <div class="popup-type">
                    <div
                        class="popup-type-dot"
                        style="background:${markerColor};"
                    ></div>

                    ${escapeHtml(
                        feature.props.category_label || layerData.label
                    )}
                </div>

                <div
                    class="popup-subtype"
                    style="font-size:11px;color:#93a0b4;margin-top:2px;"
                >
                    ${escapeHtml(
                        feature.props.sub_category_label ||
                        feature.props.type
                    )}
                </div>

                <div
                    class="popup-source"
                    style="font-size:10px;color:#7a8494;margin-top:2px;"
                >
                    Source:
                    <span style="color:${sourceRing};font-weight:600;">
                        ${escapeHtml(feature.props.source || source)}
                    </span>
                </div>
            `;

            const marker = L.marker(
                [feature.lat, feature.lon],
                { icon }
            );

            const popup = document.createElement("div");
            popup.innerHTML = popupHtml;

            if (
                layerData.group === "bus" &&
                /^\d+$/.test(String(feature.props.code ?? ""))
            ) {
                const button = document.createElement("button");

                button.className = "popup-eta-btn";
                button.textContent = "Show Bus Arrivals";

                button.addEventListener("click", () => {
                    window.showETA(
                        feature.props.code,
                        feature.props.name || ""
                    );
                });

                popup.appendChild(button);
            }

            marker.bindPopup(popup);
            group.addLayer(marker);
        });

        group.addTo(state.map);
        state.markerLayers[layerKey] = group;
    }

    updateFeatureCount();
}

function buildLayersPanel(cityMeta) {
    const panel = els.layersPanel;

    panel.innerHTML = "";
    state.categories = cityMeta.categories || {};

    if (Object.keys(state.categories).length > 0) {
        const poiGroupEl = document.createElement("div");

        poiGroupEl.className =
            "layer-group poi-category-group expanded";

        poiGroupEl.dataset.group = "poi_categories";

        const header = document.createElement("div");
        header.className = "layer-group-header";

        header.innerHTML = `
            <div class="layer-group-icon" style="background:#1787d4;">
                <img src="/static/icons/shop.svg" alt="">
            </div>
            <span class="layer-group-label">Points of Interest</span>
            <span class="layer-group-count"></span>
            <span class="layer-group-caret">&#9654;</span>
        `;

        header.addEventListener("click", event => {
            event.stopPropagation();
            poiGroupEl.classList.toggle("expanded");
        });

        const list = document.createElement("div");
        list.className = "layer-list";

        const sortedCategories = Object.entries(state.categories).sort(
            (a, b) => {
                const countA = Object.values(a[1].sub_categories).reduce(
                    (sum, sub) => sum + (sub.count || 0),
                    0
                );

                const countB = Object.values(b[1].sub_categories).reduce(
                    (sum, sub) => sum + (sub.count || 0),
                    0
                );

                return countB - countA;
            }
        );

        sortedCategories.forEach(([categoryKey, categoryInfo]) => {
            const catDiv = document.createElement("div");

            catDiv.className = "category-row";
            catDiv.dataset.category = categoryKey;

            const subCats = Object.entries(
                categoryInfo.sub_categories
            ).sort((a, b) => {
                return (b[1].count || 0) - (a[1].count || 0);
            });

            let subHtml = "";

            subCats.forEach(([subKey, subInfo]) => {
                const sources = Object.keys(subInfo.counts || {});

                if (sources.length === 0) {
                    sources.push("unknown");
                }

                sources.forEach(source => {
                    const count = (subInfo.counts || {})[source] || 0;

                    const sourceClass = source === "collecting"
                        ? "source-collecting"
                        : "source-osm";

                    const sourceLabel = source === "collecting"
                        ? "📍"
                        : "🌐";

                    const subId = `${categoryKey}|${subKey}|${source}`;

                    subHtml += `
                        <div
                            class="sub-category-row ${sourceClass}"
                            data-category="${escapeHtml(categoryKey)}"
                            data-sub="${escapeHtml(subKey)}"
                            data-source="${escapeHtml(source)}"
                        >
                            <input
                                type="checkbox"
                                class="sub-checkbox"
                                data-sub-id="${escapeHtml(subId)}"
                            >

                            <img
                                src="/static/icons/${safeIcon(subInfo.icon)}"
                                class="type-icon"
                                alt=""
                            >

                            <span class="type-label-text">
                                ${escapeHtml(subInfo.label)}
                            </span>

                            <span class="sub-source-badge">
                                ${sourceLabel}
                            </span>

                            <span class="type-count">
                                ${count.toLocaleString()}
                            </span>
                        </div>
                    `;
                });
            });

            const categoryCount = subCats.reduce(
                (sum, [, sub]) => sum + (sub.count || 0),
                0
            );

            catDiv.innerHTML = `
                <div
                    class="category-header"
                    data-category="${escapeHtml(categoryKey)}"
                >
                    <input
                        type="checkbox"
                        class="category-checkbox"
                        data-category="${escapeHtml(categoryKey)}"
                    >

                    <img
                        src="/static/icons/${safeIcon(categoryInfo.icon)}"
                        class="type-icon"
                        alt=""
                    >

                    <span class="category-label">
                        ${escapeHtml(categoryInfo.label)}
                    </span>

                    <span class="category-count">
                        ${categoryCount.toLocaleString()}
                    </span>

                    <span class="category-caret">&#9654;</span>
                </div>

                <div class="sub-category-list">
                    ${subHtml}
                </div>
            `;

            list.appendChild(catDiv);
        });

        poiGroupEl.appendChild(header);
        poiGroupEl.appendChild(list);
        panel.appendChild(poiGroupEl);
    }

    for (const [layerKey, layerData] of Object.entries(cityMeta.layers)) {
        if (!layerData.count) {
            continue;
        }

        const group = layerData.group;

        if (group === "poi") {
            continue;
        }

        const groupKey = group;

        const groupMeta = LAYER_GROUPS[groupKey] || {
            label: group,
            color: "#999"
        };

        let groupIcon = "marker.svg";

        if (groupKey === "traffic_lights") {
            groupIcon = "traffic-signal.svg";
        } else if (groupKey === "speed_cameras") {
            groupIcon = "speed-camera.svg";
        } else if (groupKey === "bus") {
            groupIcon = "bus.svg";
        }

        const groupEl = getOrCreateGroup(
            panel,
            groupKey,
            groupMeta.label,
            groupMeta.color,
            groupIcon
        );

        const list = groupEl.querySelector(".layer-list");
        const row = document.createElement("div");

        row.className = "layer-row";

        const isCollecting = layerKey.includes("collecting");
        const dotColor = isCollecting ? "#FF3B30" : "#0066FF";

        row.innerHTML = `
            <input
                type="checkbox"
                class="layer-checkbox"
                data-layer="${escapeHtml(layerKey)}"
            >

            <div
                class="layer-dot"
                style="background:${dotColor};"
            ></div>

            <span>${escapeHtml(layerData.label)}</span>

            <span class="layer-count">
                ${layerData.count.toLocaleString()}
            </span>
        `;

        const checkbox = row.querySelector(".layer-checkbox");

        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                state.activeTypes.add(layerKey);
            } else {
                state.activeTypes.delete(layerKey);
            }

            fetchVisibleFeatures();
        });

        list.appendChild(row);
    }

    const sourceBar = document.createElement("div");
    sourceBar.className = "source-toggle-bar";

    sourceBar.innerHTML = `
        <button
            class="source-chip source-chip-collecting active"
            data-source="collecting"
            title="Toggle all Collecting data"
        >
            ● Collecting
        </button>

        <button
            class="source-chip source-chip-osm active"
            data-source="osm"
            title="Toggle all OSM data"
        >
            ● OSM
        </button>
    `;

    panel.insertBefore(sourceBar, panel.firstChild);

    sourceBar.querySelectorAll(".source-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const source = chip.dataset.source;
            const isOn = chip.classList.contains("active");

            chip.classList.toggle("active", !isOn);

            if (isOn) {
                state.disabledSources.add(source);
            } else {
                state.disabledSources.delete(source);
            }

            fetchVisibleFeatures();
        });
    });

    attachCategoryListeners();
}

function attachCategoryListeners() {
    document.querySelectorAll(".category-checkbox").forEach(checkbox => {
        checkbox.addEventListener("change", () => {
            const category = checkbox.dataset.category;
            const checked = checkbox.checked;
            const catDiv = checkbox.closest(".category-row");

            if (checked) {
                state.activeCategories.add(category);

                catDiv.querySelectorAll(".sub-checkbox").forEach(sub => {
                    sub.checked = true;
                    state.activeSubCategories.add(sub.dataset.subId);
                });
            } else {
                state.activeCategories.delete(category);

                catDiv.querySelectorAll(".sub-checkbox").forEach(sub => {
                    sub.checked = false;
                    state.activeSubCategories.delete(sub.dataset.subId);
                });
            }

            updateCategoryHeaderCount(catDiv);
            fetchVisibleFeatures();
        });
    });

    document.querySelectorAll(".sub-checkbox").forEach(checkbox => {
        checkbox.addEventListener("change", () => {
            const subId = checkbox.dataset.subId;
            const catDiv = checkbox.closest(".category-row");
            const category = catDiv.dataset.category;

            if (checkbox.checked) {
                state.activeSubCategories.add(subId);
            } else {
                state.activeSubCategories.delete(subId);

                const categoryCheckbox = catDiv.querySelector(
                    ".category-checkbox"
                );

                if (categoryCheckbox.checked) {
                    categoryCheckbox.checked = false;
                }

                state.activeCategories.delete(category);
            }

            updateCategoryHeaderCount(catDiv);
            fetchVisibleFeatures();
        });
    });

    document.querySelectorAll(".category-header").forEach(header => {
        header.addEventListener("click", event => {
            if (event.target.type === "checkbox") {
                return;
            }

            const catDiv = header.closest(".category-row");
            catDiv.classList.toggle("expanded");
        });
    });
}

function updateCategoryHeaderCount(catDiv) {
    const category = catDiv.dataset.category;

    const subCheckboxes = catDiv.querySelectorAll(".sub-checkbox");

    const checkedCount = catDiv.querySelectorAll(
        ".sub-checkbox:checked"
    ).length;

    const totalCount = subCheckboxes.length;

    const categoryCheckbox = catDiv.querySelector(
        ".category-checkbox"
    );

    if (totalCount > 0 && checkedCount === totalCount) {
        categoryCheckbox.checked = true;
        categoryCheckbox.indeterminate = false;
        state.activeCategories.add(category);
    } else if (checkedCount > 0) {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = true;
        state.activeCategories.delete(category);
    } else {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = false;
        state.activeCategories.delete(category);
    }
}

function getOrCreateGroup(panel, key, label, color, icon) {
    const existing = panel.querySelector(
        `.layer-group[data-group="${key}"]`
    );

    if (existing) {
        return existing;
    }

    const groupEl = document.createElement("div");

    groupEl.className = "layer-group";
    groupEl.dataset.group = key;

    const header = document.createElement("div");
    header.className = "layer-group-header";

    header.innerHTML = `
        <div class="layer-group-icon" style="background:${color};">
            <img src="/static/icons/${icon}" alt="">
        </div>

        <span class="layer-group-label">${label}</span>
        <span class="layer-group-count"></span>
        <span class="layer-group-caret">&#9654;</span>
    `;

    header.addEventListener("click", event => {
        event.stopPropagation();
        groupEl.classList.toggle("expanded");
    });

    const list = document.createElement("div");
    list.className = "layer-list";

    groupEl.appendChild(header);
    groupEl.appendChild(list);
    panel.appendChild(groupEl);

    return groupEl;
}

function updateFeatureCount() {
    const total = state.allFeatures.length;

    const hasActive =
        state.activeTypes.size > 0 ||
        state.activeCategories.size > 0 ||
        state.activeSubCategories.size > 0;

    els.featureCount.textContent = hasActive
        ? `${total.toLocaleString()} features visible`
        : "Map is empty - toggle layers to show data";
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    }[character]));
}

function safeColor(value, fallback = "#999999") {
    return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(String(value))
        ? value
        : fallback;
}

function safeIcon(value) {
    return /^[a-zA-Z0-9_-]+\.svg$/.test(String(value))
        ? value
        : "marker.svg";
}

function showNotice(message) {
    const notice = document.getElementById("map-notice");

    notice.textContent = message;
    notice.hidden = !message;
}

function addCityCenterMarker(city, center) {
    if (state.centerMarker) {
        state.map.removeLayer(state.centerMarker);
        state.centerMarker = null;
    }

    const icon = L.divIcon({
        className: "center-marker-icon",
        html: `
            <div
                class="center-dot"
                title="${escapeHtml(city)} center"
            ></div>
        `,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11]
    });

    const marker = L.marker(
        [center[1], center[0]],
        { icon }
    );

    marker.bindPopup(`
        <div class="popup-name">
            ${escapeHtml(city)} — City Center
        </div>

        <div class="popup-subtype">
            ${center[1].toFixed(4)}, ${center[0].toFixed(4)}
        </div>
    `);

    marker.addTo(state.map);
    state.centerMarker = marker;
}

async function loadCity(city) {
    const requestId = ++state.cityRequest;

    ++state.featureRequest;
    state.featureController?.abort();

    clearTimeout(state.fetchTimer);

    state.cityMeta = null;
    state.activeTypes.clear();
    state.activeCategories.clear();
    state.activeSubCategories.clear();

    closeETA();

    if (state.map) {
        clearAllMarkers();
    }

    els.layersPanel.replaceChildren();
    els.searchInput.value = "";

    showNotice("");
    showLoading();
    setLoading(`Loading ${city}...`);

    state.currentCity = city;

    document.querySelectorAll(".city-btn").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.city === city
        );
    });

    try {
        const meta = await fetchJSON(
            `/api/layers/${encodeURIComponent(city)}`
        );

        if (requestId !== state.cityRequest) {
            return;
        }

        state.cityMeta = meta;
        state.activeTypes.clear();
        state.activeCategories.clear();
        state.activeSubCategories.clear();
        state.activeSources.clear();
        state.disabledSources.clear();

        // API coordinates use [longitude, latitude].
        initMap(
            [meta.center[1], meta.center[0]],
            meta.zoom
        );

        addCityCenterMarker(city, meta.center);
        buildLayersPanel(meta);
        clearAllMarkers();
        hideLoading();

        showNotice((meta.warnings || []).join("\n"));
    } catch (err) {
        if (requestId !== state.cityRequest) {
            return;
        }

        console.error(err);
        hideLoading();

        showNotice(
            "Could not load " + city + ": " + err.message +
            " Select a city to retry."
        );
    }
}

window.showETA = function(code, name) {
    state.currentStationCode = String(code);

    els.etaList.replaceChildren();

    document.getElementById("eta-modal").style.display = "flex";

    els.etaStationName.textContent = name;
    els.etaStationCode.textContent = code;

    if (state.etaInterval) {
        clearInterval(state.etaInterval);
    }

    fetchETA(code);

    state.etaInterval = setInterval(() => {
        fetchETA(code);
    }, 30000);
};

async function fetchETA(code) {
    const requestId = ++state.etaRequest;

    els.etaStatus.textContent = "Loading...";
    els.etaStatus.className = "status loading";
    els.etaStatus.style.display = "block";

    try {
        const res = await fetch(`/api/eta/${code}`, {
            method: "POST"
        });

        const data = await res.json();

        if (
            requestId !== state.etaRequest ||
            String(code) !== state.currentStationCode
        ) {
            return;
        }

        if (!res.ok) {
            throw new Error(
                data.error || "Arrival service unavailable"
            );
        }

        if (!Array.isArray(data)) {
            throw new Error("Unexpected arrival service response");
        }

        els.etaStatus.style.display = "none";

        if (data.length === 0) {
            els.etaList.innerHTML = `
                <p style="color:#aaa;font-size:12px;">
                    No buses arriving
                </p>
            `;
            return;
        }

        let html = "";

        data.forEach(item => {
            const details = Array.isArray(item?.Details)
                ? item.Details
                : [];

            if (!item) {
                return;
            }

            const etaHtml = details.map(detail => {
                return `
                    <span class="eta-time">
                        ${escapeHtml(detail?.ETA ?? "N/A")}
                    </span>
                `;
            }).join(", ");

            html += `
                <div class="eta-item">
                    <span class="eta-route-badge">
                        ${escapeHtml(item.RouteCode)}
                    </span>

                    <span class="eta-destination">
                        ${escapeHtml(item.OriginationName)}
                        &rarr;
                        ${escapeHtml(item.DestinationName)}
                    </span>

                    ${etaHtml}
                </div>
            `;
        });

        els.etaList.innerHTML = html;
    } catch (err) {
        if (
            requestId !== state.etaRequest ||
            String(code) !== state.currentStationCode
        ) {
            return;
        }

        els.etaList.replaceChildren();

        els.etaStatus.textContent =
            err.message || "Error loading ETA";

        els.etaStatus.className = "status error";
        els.etaStatus.style.display = "block";
    }
}

document.querySelectorAll(".city-btn").forEach(button => {
    button.addEventListener("click", () => {
        loadCity(button.dataset.city);
    });
});

els.clearFilters.addEventListener("click", () => {
    ++state.featureRequest;

    state.featureController?.abort();
    clearTimeout(state.fetchTimer);

    document.querySelectorAll(
        ".type-checkbox, .layer-checkbox, " +
        ".category-checkbox, .sub-checkbox"
    ).forEach(checkbox => {
        checkbox.checked = false;
        checkbox.indeterminate = false;
    });

    state.activeTypes.clear();
    state.activeCategories.clear();
    state.activeSubCategories.clear();
    state.activeSources.clear();
    state.disabledSources.clear();

    document.querySelectorAll(".source-chip").forEach(chip => {
        chip.classList.add("active");
    });

    clearAllMarkers();
});

function closeETA() {
    ++state.etaRequest;

    document.getElementById("eta-modal").style.display = "none";

    clearInterval(state.etaInterval);

    state.etaInterval = null;
    state.currentStationCode = null;
}

els.closeEta.addEventListener("click", closeETA);

document.getElementById("eta-modal").addEventListener(
    "click",
    event => {
        if (event.target.id === "eta-modal") {
            closeETA();
        }
    }
);

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeETA();
    }
});

let searchTimeout = null;

els.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);

    searchTimeout = setTimeout(() => {
        const query = els.searchInput.value.trim().toLowerCase();

        if (query.length < 2) {
            els.searchResults.classList.remove("visible");
            return;
        }

        const matches = state.allFeatures.filter(feature => {
            return String(feature.properties.name || "")
                .toLowerCase()
                .includes(query);
        }).slice(0, 10);

        if (matches.length === 0) {
            els.searchResults.classList.remove("visible");
            return;
        }

        let html = "";

        matches.forEach(feature => {
            html += `
                <div
                    class="search-result"
                    data-lon="${feature.geometry.coordinates[0]}"
                    data-lat="${feature.geometry.coordinates[1]}"
                >
                    <div
                        class="popup-type-dot"
                        style="background:${feature.properties.color};"
                    ></div>

                    <span>
                        ${escapeHtml(
                            feature.properties.name || "Unnamed"
                        )}
                    </span>

                    <span class="type-label">
                        ${escapeHtml(
                            feature.properties.category_label || ""
                        )}
                    </span>
                </div>
            `;
        });

        els.searchResults.innerHTML = html;
        els.searchResults.classList.add("visible");

        els.searchResults.querySelectorAll(
            ".search-result"
        ).forEach(result => {
            result.addEventListener("click", () => {
                state.map.setView(
                    [
                        parseFloat(result.dataset.lat),
                        parseFloat(result.dataset.lon)
                    ],
                    16
                );

                els.searchResults.classList.remove("visible");

                els.searchInput.value =
                    result.querySelector("span").textContent.trim();
            });
        });
    }, 200);
});

document.addEventListener("click", event => {
    if (
        !document.getElementById("search-box")?.contains(event.target)
    ) {
        els.searchResults.classList.remove("visible");
    }
});

document.addEventListener("error", event => {
    const img = event.target;

    if (
        img instanceof HTMLImageElement &&
        img.getAttribute("src")?.startsWith("/static/icons/")
    ) {
        const fallback = document.createElement("span");

        fallback.textContent = "●";
        fallback.className = "icon-fallback";

        img.replaceWith(fallback);
    }
}, true);

loadCity("Tehran");