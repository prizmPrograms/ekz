import { stayMinutesFor } from "./polyline.js";

const PREFERENCES = new Set([
  "scenic",
  "ocean",
  "night_view",
  "mountain",
  "cafe",
  "gourmet",
  "hot_spring",
  "detour",
  "quiet",
]);

const PREFERENCE_LABELS = {
  scenic: "景色",
  ocean: "海沿い",
  night_view: "夜景",
  mountain: "山道",
  cafe: "カフェ",
  gourmet: "グルメ",
  hot_spring: "温泉",
  detour: "寄り道",
  quiet: "静かな場所",
};

const PREFERENCE_CATEGORY_PATTERNS = {
  scenic: /公園|庭園|展望|景勝|観光|自然|海岸|ビーチ|山|滝|湖|史跡|神社|寺|城/,
  ocean: /海岸|ビーチ|マリーナ|港|海浜|水族館|展望|公園|観光/,
  night_view: /展望|タワー|公園|庭園|観光/,
  mountain: /山|高原|峠|渓谷|自然|展望|公園/,
  cafe: /カフェ|喫茶|コーヒー|スイーツ|菓子|ベーカリー|パン/,
  gourmet: /レストラン|料理|食堂|飲食|ラーメン|寿司|焼肉|居酒屋|ダイニング/,
  hot_spring: /温泉|銭湯|スパ|浴場/,
};

export class RouteServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RouteServiceError";
    this.code = code;
    this.status = status;
  }
}

export async function generateRoutePlan(input, deps) {
  const request = validateGenerateRequest(input);
  const search = await deps.search(request.origin, request.destination, genreForPreferences(request.preferences));
  const pool = candidatePool(search.candidates, search.baseMinutes, request.timeConstraint, request.preferences);
  if (pool.length === 0) throw noCandidates();

  const waypointCount = search.baseMinutes < 30 ? 1 : request.waypointCount;
  const picked = await pickWaypoints(pool, waypointCount, requestText(request), deps.pick);
  const fitted = await fitGeneratedRoute(request, search, picked.candidates, pool, deps.compute);
  const waypoints = await Promise.all(fitted.candidates.map((candidate) => publicWaypoint(candidate, deps)));

  return routeResponse({
    origin: endpoint(request.origin),
    destination: endpoint(request.destination),
    normalRoute: normalSummary(search),
    recommendedRoute: fitted.route,
    waypoints,
    reason: picked.reason || defaultReason(request.preferences),
    mapsOrigin: request.origin,
    mapsDestination: request.destination,
  });
}

export async function editRoutePlan(input, deps) {
  const request = validateEditRequest(input);
  const current = request.route;
  const index = request.action.waypointIndex;

  if (request.action.type === "delete") {
    const waypoints = current.waypoints.filter((_, waypointIndex) => waypointIndex !== index);
    const recommended = waypoints.length === 0
      ? current.normalRoute
      : await deps.compute(
        endpointValue(current.origin),
        endpointValue(current.destination),
        waypoints,
      );

    return routeResponse({
      ...current,
      recommendedRoute: recommended,
      waypoints,
      reason: `${current.waypoints[index].name}を外し、ルートを再計算しました。`,
      mapsOrigin: endpointValue(current.origin),
      mapsDestination: endpointValue(current.destination),
    });
  }

  const origin = endpointValue(current.origin);
  const destination = endpointValue(current.destination);
  const search = await deps.search(origin, destination, genreForPreferences(request.preferences));
  const excluded = new Set([
    ...current.waypoints.map((waypoint) => waypoint.placeId),
    ...request.action.excludedPlaceIds,
  ]);
  const remaining = candidatePool(search.candidates, current.normalRoute.durationMinutes, request.timeConstraint, request.preferences)
    .filter((candidate) => !excluded.has(candidate.id));
  if (remaining.length === 0) throw noCandidates();

  // 消去型: 嫌だった特徴を持つ候補をまとめて外す。全部消えるなら外さず、選ぶときに避けさせるだけにする
  const badTags = request.action.badTags;
  const survivors = remaining.filter((candidate) => !matchesAnyTag(candidate, badTags));
  const pool = survivors.length > 0 ? survivors : remaining;
  const eliminatedCount = remaining.length - pool.length;

  const picked = await safePick(pool, requestText(request), deps.pick, { badTags, goodTags: request.action.goodTags });
  const ordered = picked.candidate
    ? [picked.candidate, ...pool.filter((candidate) => candidate.id !== picked.candidate.id)]
    : pool;
  const maxMinutes = maximumTotalMinutes(current.normalRoute.durationMinutes, request.timeConstraint);
  let replacement = null;
  let recommended = null;

  for (const candidate of ordered.slice(0, 8)) {
    const proposed = [...current.waypoints];
    proposed[index] = candidate;
    const exact = await deps.compute(origin, destination, proposed);
    if (totalRouteMinutes(exact, proposed) <= maxMinutes) {
      replacement = candidate;
      recommended = exact;
      break;
    }
  }
  if (!replacement || !recommended) throw noCandidates();

  const waypoints = [...current.waypoints];
  waypoints[index] = await publicWaypoint(replacement, deps);

  return {
    ...routeResponse({
      ...current,
      recommendedRoute: recommended,
      waypoints,
      reason: picked.reason || `${replacement.name}へ立ち寄るルートに更新しました。`,
      mapsOrigin: origin,
      mapsDestination: destination,
    }),
    eliminatedCount,
  };
}

export function validateGenerateRequest(input) {
  if (!input || typeof input !== "object") throw invalid("リクエスト本体が必要です。");
  const origin = requiredString(input.origin, "origin");
  const destination = requiredString(input.destination, "destination");
  const preferences = validatePreferences(input.preferences);
  const freeText = typeof input.freeText === "string" ? input.freeText.trim().slice(0, 500) : "";
  const timeConstraint = validateTimeConstraint(input.timeConstraint);
  const waypointCount = input.waypointCount;
  if (waypointCount !== 1 && waypointCount !== 2) throw invalid("waypointCountは1または2で指定してください。");
  return { origin, destination, preferences, freeText, timeConstraint, waypointCount };
}

export function validateEditRequest(input) {
  if (!input || typeof input !== "object") throw invalid("リクエスト本体が必要です。");
  const route = input.route;
  if (!route || !route.origin || !route.destination || !route.normalRoute || !Array.isArray(route.waypoints)) {
    throw invalid("routeの形式が不正です。");
  }
  const action = input.action;
  if (!action || (action.type !== "delete" && action.type !== "replace")) {
    throw invalid("action.typeはdeleteまたはreplaceで指定してください。");
  }
  if (!Number.isInteger(action.waypointIndex) || action.waypointIndex < 0 || action.waypointIndex >= route.waypoints.length) {
    throw invalid("waypointIndexが範囲外です。");
  }
  return {
    route,
    preferences: validatePreferences(input.preferences),
    freeText: typeof input.freeText === "string" ? input.freeText.trim().slice(0, 500) : "",
    timeConstraint: validateTimeConstraint(input.timeConstraint),
    action: {
      type: action.type,
      waypointIndex: action.waypointIndex,
      excludedPlaceIds: Array.isArray(action.excludedPlaceIds)
        ? action.excludedPlaceIds.filter((id) => typeof id === "string").slice(0, 50)
        : [],
      badTags: validateTags(action.badTags, "badTags"),
      goodTags: validateTags(action.goodTags, "goodTags"),
    },
  };
}

export function genreForPreferences(preferences) {
  const genres = [];
  if (preferences.includes("cafe")) genres.push("sweets");
  if (preferences.includes("gourmet")) genres.push("meal");
  if (preferences.some((value) => ["scenic", "ocean", "night_view", "mountain"].includes(value))) genres.push("view");
  if (preferences.some((value) => value === "hot_spring" || value === "quiet")) genres.push("rest");
  return genres.length > 0 ? [...new Set(genres)].sort() : undefined;
}

export function candidatePool(candidates, baseMinutes, constraint, preferences = []) {
  const maximum = maximumExtraMinutes(baseMinutes, constraint);
  return [...(candidates ?? [])]
    .filter((candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng))
    .filter((candidate) => {
      const ratio = candidate.routeRatio ?? 0.5;
      return ratio >= 0.08
        && ratio <= 0.96
        && (candidate.offRouteKm ?? 0) <= 6
        && (candidate.detourMinutes ?? 0) <= maximum;
    })
    .filter((candidate) => matchesPreferences(candidate, preferences))
    .sort((a, b) => {
      const ratingScore = (b.rating ?? 0) - (a.rating ?? 0);
      if (ratingScore !== 0) return ratingScore;
      const reviewScore = (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
      if (reviewScore !== 0) return reviewScore;
      return (a.detourMinutes ?? 0) - (b.detourMinutes ?? 0);
    });
}

export function maximumTotalMinutes(baseMinutes, constraint) {
  if (constraint.type === "none") return Number.POSITIVE_INFINITY;
  if (constraint.type === "extra_time") return baseMinutes + constraint.minutes;
  return constraint.minutes;
}

export function buildGoogleMapsUrl(origin, destination, waypoints) {
  const params = new URLSearchParams({ api: "1", travelmode: "driving", origin, destination });
  if (waypoints.length > 0) {
    params.set("waypoints", waypoints.map((waypoint) => `${waypoint.lat},${waypoint.lng}`).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

async function pickWaypoints(pool, count, text, pick) {
  const selected = [];
  const reasons = [];
  let remaining = pool;

  while (selected.length < count && remaining.length > 0) {
    const choice = await safePick(remaining, text, pick);
    const candidate = choice.candidate ?? remaining[0];
    selected.push(candidate);
    if (choice.reason) reasons.push(choice.reason);
    remaining = remaining.filter((item) => item.id !== candidate.id);
  }
  return { candidates: selected.sort(routeOrder), reason: reasons[0] ?? null };
}

async function safePick(candidates, text, pick, feedback = {}) {
  if (!pick) return { candidate: candidates[0], reason: null };
  try {
    const result = await pick(candidates.slice(0, 40), text, feedback);
    return {
      candidate: candidates.find((candidate) => candidate.id === result?.id) ?? candidates[0],
      reason: result?.reason ?? null,
    };
  } catch {
    return { candidate: candidates[0], reason: null };
  }
}

async function fitGeneratedRoute(request, search, selected, pool, compute) {
  const maximum = maximumTotalMinutes(search.baseMinutes, request.timeConstraint);
  const attempts = [selected];
  for (const candidate of [...selected, ...pool.slice(0, 6)]) {
    if (!attempts.some((attempt) => attempt.length === 1 && attempt[0].id === candidate.id)) attempts.push([candidate]);
  }

  for (const candidates of attempts) {
    const ordered = [...candidates].sort(routeOrder);
    const route = await compute(request.origin, request.destination, ordered);
    if (totalRouteMinutes(route, ordered) <= maximum) return { candidates: ordered, route };
  }
  throw noCandidates();
}

async function publicWaypoint(candidate, deps) {
  let tags = [];
  try {
    tags = await deps.tags(candidate);
  } catch {
    tags = candidate.category ? [candidate.category] : [];
  }
  return {
    placeId: candidate.id ?? candidate.placeId,
    name: candidate.name,
    lat: Number(candidate.lat),
    lng: Number(candidate.lng),
    category: candidate.category || null,
    rating: candidate.rating ?? null,
    reviewCount: candidate.reviewCount ?? null,
    photoUrl: candidate.photoUrl ?? (candidate.photoName ? deps.photoUrl(candidate.photoName) : null),
    tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
    detourMinutes: Math.max(0, Math.round(candidate.detourMinutes ?? 0)),
    priceRange: candidate.priceRange ?? null,
    stayMinutes: candidate.stayMinutes ?? stayMinutesFor(candidate.category ?? ""),
    minutesToArrive: Number.isFinite(candidate.minutesToArrive) ? Math.round(candidate.minutesToArrive) : null,
  };
}

function routeResponse({ origin, destination, normalRoute, recommendedRoute, waypoints, reason, mapsOrigin, mapsDestination }) {
  const normal = normalizedSummary(normalRoute);
  const driving = normalizedSummary(recommendedRoute);
  const durationMinutes = totalRouteMinutes(driving, waypoints);
  return {
    origin,
    destination,
    normalRoute: normal,
    recommendedRoute: {
      ...driving,
      drivingMinutes: driving.durationMinutes,
      durationMinutes,
      extraMinutes: Math.max(0, durationMinutes - normal.durationMinutes),
    },
    waypoints,
    reason,
    googleMapsUrl: buildGoogleMapsUrl(mapsOrigin, mapsDestination, waypoints),
  };
}

function totalRouteMinutes(route, waypoints) {
  const drivingMinutes = Math.max(0, Math.round(route.durationMinutes ?? route.baseMinutes ?? 0));
  const stayMinutes = waypoints.reduce((total, waypoint) => total + waypointStayMinutes(waypoint), 0);
  return drivingMinutes + stayMinutes;
}

function waypointStayMinutes(waypoint) {
  return Math.max(0, Math.round(waypoint.stayMinutes ?? stayMinutesFor(waypoint.category ?? "")));
}

export function matchesPreferences(candidate, preferences) {
  const concrete = preferences.filter((preference) => PREFERENCE_CATEGORY_PATTERNS[preference]);
  if (concrete.length === 0) return true;
  const category = candidate.category ?? "";
  return concrete.some((preference) => PREFERENCE_CATEGORY_PATTERNS[preference].test(category));
}

function normalizedSummary(route) {
  const summary = {
    durationMinutes: Math.max(0, Math.round(route.durationMinutes ?? route.baseMinutes ?? 0)),
    distanceMeters: Math.max(0, Math.round(route.distanceMeters ?? (route.distanceKm ?? 0) * 1000)),
  };
  if (Array.isArray(route.legMinutes) && route.legMinutes.every(Number.isFinite)) summary.legMinutes = route.legMinutes;
  return summary;
}

function normalSummary(search) {
  return normalizedSummary(search);
}

function endpoint(value) {
  const parts = String(value).split(",").map(Number);
  const coordinates = parts.length === 2 && parts.every(Number.isFinite);
  return {
    name: coordinates ? `${parts[0].toFixed(5)}, ${parts[1].toFixed(5)}` : String(value),
    lat: coordinates ? parts[0] : null,
    lng: coordinates ? parts[1] : null,
  };
}

function endpointValue(value) {
  if (Number.isFinite(value?.lat) && Number.isFinite(value?.lng)) return `${value.lat},${value.lng}`;
  return requiredString(value?.name, "route endpoint");
}

function validatePreferences(value) {
  if (!Array.isArray(value)) throw invalid("preferencesは配列で指定してください。");
  if (value.some((item) => typeof item !== "string")) throw invalid("preferencesに不正な値が含まれています。");
  const preferences = [...new Set(value)];
  if (preferences.some((item) => !PREFERENCES.has(item))) {
    throw invalid("preferencesに不正な値が含まれています。");
  }
  return preferences;
}

function validateTags(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`action.${field}は文字列の配列で指定してください。`);
  }
  return [...new Set(value.map((item) => item.trim()).filter((item) => item !== "" && item.length <= 20))].slice(0, 10);
}

/** 名前か種別にその語を含む候補を「似ている」とみなす。口コミまで見ると広く消えすぎる */
export function matchesAnyTag(candidate, tags) {
  const text = `${candidate.name ?? ""} ${candidate.category ?? ""}`;
  return tags.some((tag) => text.includes(tag));
}

function validateTimeConstraint(value) {
  if (!value || typeof value !== "object") throw invalid("timeConstraintが必要です。");
  if (value.type === "none") return { type: "none" };
  if ((value.type === "extra_time" || value.type === "total_time") && Number.isInteger(value.minutes) && value.minutes > 0) {
    return { type: value.type, minutes: value.minutes };
  }
  throw invalid("timeConstraintの形式が不正です。");
}

function maximumExtraMinutes(baseMinutes, constraint) {
  const total = maximumTotalMinutes(baseMinutes, constraint);
  return Number.isFinite(total) ? Math.max(0, total - baseMinutes) : Number.POSITIVE_INFINITY;
}

function requestText(request) {
  if (request.freeText) return request.freeText;
  return preferenceLabels(request.preferences);
}

function defaultReason(preferences) {
  if (preferences.length === 0) return "ルート沿いで評価が高い場所を選びました。";
  return `${preferenceLabels(preferences)}の希望に合う、ルート沿いの評価が高い場所を選びました。`;
}

function preferenceLabels(preferences) {
  return preferences.map((value) => PREFERENCE_LABELS[value] ?? value).join("・");
}

function routeOrder(a, b) {
  return (a.routeRatio ?? 0.5) - (b.routeRatio ?? 0.5);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${field}が必要です。`);
  return value.trim();
}

function invalid(message) {
  return new RouteServiceError("INVALID_REQUEST", message, 400);
}

function noCandidates() {
  return new RouteServiceError("NO_CANDIDATES", "条件に合う寄り道候補が見つかりませんでした。", 404);
}
