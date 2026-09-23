import {
  decodePolyline,
  nearestOnRoute,
  estimateDetourMinutes,
  stayMinutesFor,
} from "./polyline.js";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * ジャンルごとに投げるクエリ。
 * 1クエリでは7〜20件しか返らないので、ジャンルあたり3〜4本投げて件数を確保する。
 * 実測(京都->舞子): どのジャンルも合格20件以上。
 */
export const GENRE_QUERIES = {
  meal: ["ランチ", "ラーメン", "定食", "食堂"],
  sweets: ["カフェ", "スイーツ", "ベーカリー"],
  view: ["展望台", "海岸", "公園"],
  sightseeing: ["観光スポット", "神社", "城"],
  rest: ["道の駅", "サービスエリア", "お土産"],
};

/** おまかせ。各ジャンルから1本ずつ */
export const DEFAULT_QUERIES = ["ランチ", "カフェ", "展望台", "観光スポット", "道の駅"];

export function queriesForGenre(genre) {
  if (!genre) return DEFAULT_QUERIES;
  return GENRE_QUERIES[genre] ?? DEFAULT_QUERIES;
}

const PRICE_LABEL = {
  PRICE_LEVEL_FREE: "無料",
  PRICE_LEVEL_INEXPENSIVE: "安い",
  PRICE_LEVEL_MODERATE: "ふつう",
  PRICE_LEVEL_EXPENSIVE: "高い",
  PRICE_LEVEL_VERY_EXPENSIVE: "とても高い",
};

/** 出発地・目的地からルートと所要時間を取る */
export async function computeRoute(key, origin, destination, travelMode = "DRIVE") {
  const res = await fetch(ROUTES_URL, {
    method: "POST",
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      travelMode,
      routingPreference: travelMode === "DRIVE" ? "TRAFFIC_AWARE" : undefined,
      languageCode: "ja",
    }),
  });

  if (!res.ok) throw new Error(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error("ルートが見つかりませんでした");

  return {
    baseMinutes: Math.round(parseInt(route.duration) / 60),
    distanceKm: +(route.distanceMeters / 1000).toFixed(1),
    polyline: route.polyline.encodedPolyline,
  };
}

/** /generate-route 用。丸める前の秒・メートルを返す。既存 /search の形式は変えない。 */
export async function computeDrivingRoute(key, origin, destination, waypoints = [], departureTime) {
  let res;
  try {
    res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": [
          "routes.duration", "routes.distanceMeters", "routes.polyline.encodedPolyline",
          "routes.legs.startLocation", "routes.legs.endLocation",
        ].join(","),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin: toWaypoint(origin),
        destination: toWaypoint(destination),
        intermediates: waypoints.map((candidate) => ({ placeId: candidate.id })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime,
        languageCode: "ja",
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new GoogleRouteError("UPSTREAM_ERROR", "Routes API に接続できませんでした。");
  }
  // Google の応答本文には入力値などが含まれ得るので、そのまま利用者に返さない。
  if (!res.ok) throw new GoogleRouteError("UPSTREAM_ERROR", `Routes API がエラーを返しました（HTTP ${res.status}）。`);

  let body;
  try { body = await res.json(); } catch {
    throw new GoogleRouteError("UPSTREAM_ERROR", "Routes API の応答を読み取れませんでした。");
  }
  if (!body || typeof body !== "object" || (body.routes != null && !Array.isArray(body.routes))) {
    throw new GoogleRouteError("UPSTREAM_ERROR", "Routes API の応答形式が不正です。");
  }
  if (body.routes == null || body.routes.length === 0) {
    throw new GoogleRouteError("ROUTE_NOT_FOUND", "指定された地点を通る車のルートが見つかりませんでした。");
  }
  const route = body.routes[0];
  const validDuration = typeof route?.duration === "string" && /^\d+(?:\.\d+)?s$/.test(route.duration);
  const durationSeconds = validDuration ? Number(route.duration.slice(0, -1)) : NaN;
  if (!Number.isFinite(durationSeconds) || !Number.isInteger(route?.distanceMeters) || route.distanceMeters < 0 ||
      typeof route?.polyline?.encodedPolyline !== "string" || !route.polyline.encodedPolyline) {
    throw new GoogleRouteError("UPSTREAM_ERROR", "Routes API から時間・距離・経路を取得できませんでした。");
  }
  return {
    durationSeconds,
    distanceMeters: route.distanceMeters,
    polyline: route.polyline.encodedPolyline,
    originLocation: readLocation(route.legs?.[0]?.startLocation),
    destinationLocation: readLocation(route.legs?.at(-1)?.endLocation),
  };
}

export class GoogleRouteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readLocation(location) {
  const lat = location?.latLng?.latitude;
  const lng = location?.latLng?.longitude;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** "lat,lng" なら座標、そうでなければ住所や場所名として扱う */
function toWaypoint(value) {
  const parts = String(value).split(",");
  if (parts.length === 2) {
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (parts.every((part) => part.trim()) && Number.isFinite(lat) && Number.isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { location: { latLng: { latitude: lat, longitude: lng } } };
    }
  }
  return { address: String(value) };
}

/** ルート沿いの候補を集める。クエリごとに1リクエスト */
/**
 * 住宅街の小さな公園のようなノイズを落とす。
 * これが無いと「正利の尾公園」のような誰も寄らない場所が上位に来る。
 */
function isWorthStopping(c) {
  if (c.reviewCount == null || c.rating == null) return false;
  return c.reviewCount >= 30 && c.rating >= 3.8;
}

export async function searchAlongRoute(key, polyline, queries = DEFAULT_QUERIES, baseMinutes = 0, options = {}) {
  const fieldMask = [
    "places.id",
    "places.displayName",
    "places.primaryTypeDisplayName",
    "places.location",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.photos",
    "places.reviews",
  ].join(",");

  const responses = await Promise.all(
    queries.map((q) =>
      fetch(PLACES_URL, {
        method: "POST",
        signal: options.signal,
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": fieldMask,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          textQuery: q,
          languageCode: "ja",
          pageSize: 20,
          searchAlongRouteParameters: { polyline: { encodedPolyline: polyline } },
        }),
      }).then(async (r) => (r.ok ? r.json() : { places: [], error: await r.text() }))
        .catch((error) => {
          if (!options.allowPartial) throw error;
          return { places: [], error: "Places API の検索に失敗しました" };
        }),
    ),
  );

  const points = decodePolyline(polyline);
  const byId = new Map();

  for (const body of responses) {
    for (const p of body.places ?? []) {
      if (byId.has(p.id)) continue;
      byId.set(p.id, toCandidate(p, points, baseMinutes));
    }
  }

  const perQuery = responses.map((b, i) => `${queries[i]}:${(b.places ?? []).length}`);
  const errors = responses
    .map((b, i) => (b.error ? `${queries[i]}: ${String(b.error).slice(0, 150)}` : null))
    .filter(Boolean);
  const all = [...byId.values()];
  return {
    candidates: all.filter(isWorthStopping),
    rawCount: all.length,
    perQuery,
    polylineLength: polyline.length,
    errors,
  };
}

function toCandidate(p, routePoints, baseMinutes) {
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  const near = lat != null ? nearestOnRoute(routePoints, lat, lng) : { km: 0, ratio: 0 };
  const off = near.km;

  // その経由地に着くまでの時間。ルート上の到達位置 + ルートから外れる分
  const minutesToArrive = Math.round(baseMinutes * near.ratio + (off / 40) * 60);

  return {
    id: p.id,
    name: p.displayName?.text ?? "名称不明",
    category: p.primaryTypeDisplayName?.text ?? "",
    lat,
    lng,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    priceRange: PRICE_LABEL[p.priceLevel] ?? null,
    photoName: p.photos?.[0]?.name ?? null,
    reviews: (p.reviews ?? []).map((r) => r.text?.text).filter(Boolean).slice(0, 3),
    detourMinutes: estimateDetourMinutes(off, stayMinutesFor(p.primaryTypeDisplayName?.text ?? "")),
    minutesToArrive,
    // ルート全体のどこにある候補か(0〜1)。現在地からの時間をアプリ側で出すのに使う
    routeRatio: +near.ratio.toFixed(4),
    offRouteKm: +off.toFixed(2),
  };
}

/** 写真を中継する。APIキーを端末に出さないため */
export async function proxyPhoto(key, photoName, maxWidthPx = 800) {
  const url =
    `https://places.googleapis.com/v1/${photoName}/media` +
    `?key=${encodeURIComponent(key)}&maxWidthPx=${maxWidthPx}`;
  return fetch(url);
}
