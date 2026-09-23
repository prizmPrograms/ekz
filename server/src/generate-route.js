import { computeDrivingRoute, searchAlongRoute, DEFAULT_QUERIES, GoogleRouteError } from "./google.js";

// TypeSafe がなくても動く暫定選定。上限を設け、候補ごとの Routes API 呼び出しを抑える。
const SHORTLIST_LIMIT = 5;
const PAIR_LIMIT = 4;
const PREFERENCES = {
  scenic: { label: "景色", query: "展望台", words: ["展望", "景色", "眺望", "絶景"] },
  ocean: { label: "海沿い", query: "海岸", words: ["海", "ビーチ", "港"] },
  night_view: { label: "夜景", query: "夜景 展望台", words: ["夜景", "夜間"] },
  mountain: { label: "山道", query: "山 展望台", words: ["山", "高原", "峠"] },
  cafe: { label: "カフェ", query: "カフェ", words: ["カフェ", "喫茶", "コーヒー", "珈琲"] },
  gourmet: { label: "グルメ", query: "レストラン", words: ["レストラン", "食堂", "料理", "ランチ", "グルメ"] },
  hot_spring: { label: "温泉", query: "温泉", words: ["温泉", "銭湯", "スパ"] },
  detour: { label: "寄り道", query: "観光スポット", words: ["観光", "道の駅", "名所"] },
  quiet: { label: "静かな場所", query: "静かな公園", words: ["静か", "静寂", "落ち着"] },
};

class RouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

/** GenerateRouteRequest / GenerateRouteResponse は mobile/types/route.ts に合わせる。 */
export async function handleGenerateRoute(request, env, dependencies = {}) {
  try {
    let body;
    try { body = await request.json(); } catch {
      throw new RouteError("INVALID_REQUEST", "JSON 形式のリクエストを送ってください。", 400);
    }
    const input = validateInput(body);
    const key = env.GOOGLE_MAPS_SERVER_KEY;
    if (typeof key !== "string" || !key.trim()) {
      throw new RouteError("INTERNAL_ERROR", "サーバーに Google Maps API キーが設定されていません。", 503);
    }
    const result = await generateRoute(input, key, new URL(request.url).origin, dependencies);
    return json(result);
  } catch (error) {
    if (error instanceof RouteError) return json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof GoogleRouteError) {
      return json({ error: { code: error.code, message: error.message } }, error.code === "ROUTE_NOT_FOUND" ? 404 : 502);
    }
    return json({ error: { code: "INTERNAL_ERROR", message: "ルートの生成に失敗しました。" } }, 500);
  }
}

function validateInput(body) {
  const invalid = (message) => { throw new RouteError("INVALID_REQUEST", message, 400); };
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("リクエストは JSON オブジェクトにしてください。");
  for (const field of ["origin", "destination"]) {
    if (typeof body[field] !== "string" || !body[field].trim() || body[field].length > 400) {
      invalid(`${field} は 1〜400 文字の場所名・住所・緯度経度にしてください。`);
    }
    const parts = body[field].split(",").map((part) => part.trim());
    if (parts.length === 2 && parts.every((part) => part && Number.isFinite(Number(part)))) {
      if (Math.abs(Number(parts[0])) > 90 || Math.abs(Number(parts[1])) > 180) invalid(`${field} の緯度経度が範囲外です。`);
    }
  }
  const preferences = body.preferences ?? [];
  if (!Array.isArray(preferences) || preferences.length > 9 ||
      preferences.some((item) => typeof item !== "string" || !Object.hasOwn(PREFERENCES, item))) {
    invalid("preferences に指定できるのは route.ts で定義された希望条件です。");
  }
  const freeText = body.freeText ?? "";
  if (typeof freeText !== "string" || freeText.length > 500) invalid("freeText は 500 文字以内にしてください。");
  const timeConstraint = body.timeConstraint ?? { type: "none" };
  if (!timeConstraint || typeof timeConstraint !== "object" ||
      !["none", "extra_time", "total_time"].includes(timeConstraint.type)) invalid("timeConstraint が不正です。");
  if (timeConstraint.type !== "none" &&
      (typeof timeConstraint.minutes !== "number" || !Number.isFinite(timeConstraint.minutes) || timeConstraint.minutes < 0)) {
    invalid("時間条件の minutes は 0 以上の数値にしてください。");
  }
  const waypointCount = body.waypointCount ?? 2;
  if (![1, 2].includes(waypointCount)) invalid("waypointCount は 1 または 2 にしてください。");
  return { origin: body.origin.trim(), destination: body.destination.trim(),
    preferences: [...new Set(preferences)], freeText: freeText.trim(), timeConstraint, waypointCount };
}

async function generateRoute(input, key, apiOrigin, dependencies) {
  const compute = dependencies.compute ?? computeDrivingRoute;
  const search = dependencies.search ?? searchAlongRoute;
  const now = dependencies.now ?? Date.now;
  // 全候補を同じ出発時刻で比較する。時刻が計算中に過去にならないよう 3 分先を使う。
  const departureTime = new Date(now() + 3 * 60 * 1000).toISOString();
  const calculate = (stops) => compute(key, input.origin, input.destination, stops, departureTime);
  const normal = await calculate([]);
  const limit = input.timeConstraint.type === "none" ? Infinity
    : input.timeConstraint.type === "extra_time" ? normal.durationSeconds + input.timeConstraint.minutes * 60
      : input.timeConstraint.minutes * 60;
  if (normal.durationSeconds > limit) {
    throw new RouteError("NO_CANDIDATES", "通常ルートだけで指定の合計時間を超えています。時間条件を広げてください。", 422);
  }

  const queries = [...new Set(input.preferences.length
    ? input.preferences.map((item) => PREFERENCES[item].query) : DEFAULT_QUERIES)];
  if (input.freeText && !queries.includes(input.freeText)) queries.push(input.freeText);
  let found;
  try {
    found = await search(key, normal.polyline, queries, normal.durationSeconds / 60, {
      signal: AbortSignal.timeout(10000), allowPartial: true,
    });
  } catch {
    throw new RouteError("UPSTREAM_ERROR", "Places API から候補を取得できませんでした。", 502);
  }
  if (!Array.isArray(found?.candidates)) throw new RouteError("UPSTREAM_ERROR", "Places API の候補データを読み取れませんでした。", 502);

  const candidates = selectShortlist(found.candidates, input);
  if (!candidates.length) {
    if (found.errors?.length) throw new RouteError("UPSTREAM_ERROR", "候補検索の一部または全部に失敗しました。時間を置いて再度お試しください。", 502);
    throw new RouteError("NO_CANDIDATES", "ルート付近に条件を満たす寄り道候補が見つかりませんでした。", 422);
  }

  let upstreamFailed = Boolean(found.errors?.length);
  const evaluate = async (stops) => {
    try {
      const route = await calculate(stops);
      return { stops, route, score: groupScore(stops, input.preferences) - Math.max(0, route.durationSeconds - normal.durationSeconds) / 600 };
    } catch (error) {
      if (!(error instanceof GoogleRouteError)) throw error;
      if (error.code !== "ROUTE_NOT_FOUND") upstreamFailed = true;
      return null;
    }
  };
  // 直線距離や「滞在時間込みの推定寄り道時間」ではなく、実際の道路経路で検証する。
  const singles = (await mapLimited(candidates, 2, (candidate) => evaluate([candidate]))).filter(Boolean);
  let chosen;
  if (input.waypointCount === 2 && singles.length >= 2) {
    const pairs = [];
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        const stops = [singles[i].stops[0], singles[j].stops[0]].sort((a, b) => a.routeRatio - b.routeRatio || a.id.localeCompare(b.id));
        const estimatedExtra = Math.max(0, singles[i].route.durationSeconds - normal.durationSeconds,
          singles[j].route.durationSeconds - normal.durationSeconds);
        pairs.push({ stops, score: groupScore(stops, input.preferences) - estimatedExtra / 600 });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const evaluated = await mapLimited(pairs.slice(0, PAIR_LIMIT), 2, (pair) => evaluate(pair.stops));
    chosen = bestFeasible(evaluated, limit);
  }
  chosen ??= bestFeasible(singles, limit);
  if (!chosen) {
    if (upstreamFailed) throw new RouteError("UPSTREAM_ERROR", "候補の経路計算に失敗したため、条件に合うルートを確定できませんでした。", 502);
    throw new RouteError("NO_CANDIDATES", "検討した候補では指定時間内の寄り道ルートが見つかりませんでした。時間や希望条件を変更してください。", 422);
  }

  const normalMinutes = Math.ceil(normal.durationSeconds / 60);
  const recommendedMinutes = Math.ceil(chosen.route.durationSeconds / 60);
  const waypoints = chosen.stops.map((candidate) => {
    const single = singles.find((item) => item.stops[0].id === candidate.id);
    const photo = candidate.photoName?.startsWith("places/")
      ? `${apiOrigin}/photo?${new URLSearchParams({ name: candidate.photoName })}` : null;
    return {
      placeId: candidate.id, name: candidate.name, lat: candidate.lat, lng: candidate.lng,
      category: candidate.category || null, rating: candidate.rating, reviewCount: candidate.reviewCount,
      photoUrl: photo,
      tags: [...new Set([candidate.category, candidate.rating >= 4.3 ? "評価が高い" : null].filter(Boolean))],
      // この 1 地点だけを経由した場合の追加走行時間。2 件分を足して合計時間にはしない。
      detourMinutes: Math.max(0, Math.ceil(single.route.durationSeconds / 60) - normalMinutes),
    };
  });
  const origin = { name: input.origin, lat: normal.originLocation?.lat ?? null, lng: normal.originLocation?.lng ?? null };
  const destination = { name: input.destination, lat: normal.destinationLocation?.lat ?? null, lng: normal.destinationLocation?.lng ?? null };
  const notes = ["希望条件による検索結果から、評価・口コミ数・追加走行時間で候補を選びました。",
    "時間・距離は経由地を含めて再計算しています。所要時間は走行のみで、滞在・待ち時間を含みません。"];
  if (waypoints.length < input.waypointCount) notes.push("今回の検索・計算では条件を満たす 2 地点の組み合わせを確定できなかったため、1 地点を提案しています。");
  return {
    origin, destination,
    normalRoute: { durationMinutes: normalMinutes, distanceMeters: normal.distanceMeters },
    recommendedRoute: { durationMinutes: recommendedMinutes, distanceMeters: chosen.route.distanceMeters,
      extraMinutes: Math.max(0, recommendedMinutes - normalMinutes) },
    waypoints, reason: notes.join(""), googleMapsUrl: buildMapsUrl(origin, destination, waypoints),
  };
}

function matches(candidate, preference) {
  const text = [candidate.name, candidate.category, ...(candidate.reviews ?? [])].join(" ");
  return PREFERENCES[preference].words.some((word) => text.includes(word));
}

function candidateScore(candidate, preferences) {
  return candidate.rating * 2 + Math.log10(1 + candidate.reviewCount) * 0.4
    + preferences.filter((item) => matches(candidate, item)).length * 4 - candidate.offRouteKm * 0.3;
}

function groupScore(stops, preferences) {
  const coverage = preferences.filter((preference) => stops.some((candidate) => matches(candidate, preference))).length;
  return stops.reduce((sum, candidate) => sum + candidateScore(candidate, preferences), 0) / stops.length + coverage * 3;
}

function selectShortlist(candidates, input) {
  const byId = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id ||
        typeof candidate.name !== "string" || !candidate.name ||
        !Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng) ||
        Math.abs(candidate.lat) > 90 || Math.abs(candidate.lng) > 180 ||
        !Number.isFinite(candidate.rating) || candidate.rating < 3.8 ||
        !Number.isFinite(candidate.reviewCount) || candidate.reviewCount < 30 ||
        !Number.isFinite(candidate.offRouteKm) || candidate.offRouteKm > 6 ||
        !Number.isFinite(candidate.routeRatio) || candidate.routeRatio < 0 || candidate.routeRatio > 1 ||
        candidate.name === input.origin || candidate.name === input.destination) continue;
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  const ranked = [...byId.values()].sort((a, b) => candidateScore(b, input.preferences) - candidateScore(a, input.preferences) || a.id.localeCompare(b.id));
  // 先頭がすべて同じジャンルにならないよう、各希望に合う候補も優先して残す。
  const shortlist = new Map();
  for (const preference of input.preferences) {
    const candidate = ranked.find((item) => matches(item, preference));
    if (candidate) shortlist.set(candidate.id, candidate);
    if (shortlist.size === SHORTLIST_LIMIT) break;
  }
  for (const candidate of ranked) {
    if (shortlist.size === SHORTLIST_LIMIT) break;
    shortlist.set(candidate.id, candidate);
  }
  return [...shortlist.values()];
}

function bestFeasible(results, limit) {
  return results.filter((result) => result && result.route.durationSeconds <= limit)
    .sort((a, b) => b.score - a.score || a.route.durationSeconds - b.route.durationSeconds)[0];
}

async function mapLimited(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

function buildMapsUrl(origin, destination, waypoints) {
  const location = (endpoint) => endpoint.lat != null && endpoint.lng != null
    ? `${endpoint.lat},${endpoint.lng}` : endpoint.name;
  const params = new URLSearchParams({ api: "1", travelmode: "driving",
    origin: location(origin), destination: location(destination),
    waypoints: waypoints.map((item) => `${item.lat},${item.lng}`).join("|"),
    waypoint_place_ids: waypoints.map((item) => item.placeId).join("|"),
  });
  return `https://www.google.com/maps/dir/?${params}`;
}
