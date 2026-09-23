import { computeRoute, searchAlongRoute, proxyPhoto, queriesForGenre } from "./google.js";
import { pickNext } from "./jev.js";
import { generateTags, fallbackTags } from "./gemini.js";
import { handleGenerateRoute } from "./generate-route.js";

// 返す形を変えたら上げる。上げないと古いキャッシュが返り続ける
const CACHE_VERSION = "v3";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const fail = (message, status = 500) => json({ error: message }, status);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /":
          return json({
            name: "ekz-server",
            endpoints: ["POST /generate-route", "POST /search", "POST /tag", "POST /next", "GET /photo"],
          });

        case "POST /generate-route":
          return await handleGenerateRoute(request, env);

        case "POST /search":
          return await handleSearch(request, env, ctx);

        case "POST /tag":
          return await handleTag(request, env, ctx);

        case "POST /next":
          return await handleNext(request, env);

        case "GET /photo":
          return await handlePhoto(url, env);

        default:
          return fail("not found", 404);
      }
    } catch (e) {
      return fail(e.message ?? String(e));
    }
  },
};

/**
 * POST /search
 *   { origin: "35.0,135.7" | "京都駅", destination: "...", queries?: [...] }
 * ルートを引いて、沿線の候補をまとめて返す。
 *
 * 同じルートは何度も試すので、Cloudflare のキャッシュに入れておく。
 * これをやらないと Places の無料枠(1,000/月)をすぐ使い切る。
 */
async function handleSearch(request, env, ctx) {
  const body = await request.json();
  const { origin, destination, genre } = body;
  if (!origin || !destination) return fail("origin と destination が必要です", 400);

  const queries = queriesForGenre(genre);

  const cacheKey = new Request(
    `https://ekz.cache/search/${CACHE_VERSION}?o=${encodeURIComponent(origin)}&d=${encodeURIComponent(destination)}&g=${encodeURIComponent(genre ?? "any")}`,
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const route = await computeRoute(env.GOOGLE_MAPS_SERVER_KEY, origin, destination);
  const found = await searchAlongRoute(
    env.GOOGLE_MAPS_SERVER_KEY,
    route.polyline,
    queries,
    route.baseMinutes,
  );
  const candidates = found.candidates;

  candidates.sort((a, b) => a.detourMinutes - b.detourMinutes);

  const res = json({
    baseMinutes: route.baseMinutes,
    distanceKm: route.distanceKm,
    // アプリ側で現在地の進捗を出すために返す。これで走行中もサーバを呼ばずに更新できる
    polyline: route.polyline,
    count: candidates.length,
    rawCount: found.rawCount,
    errors: found.errors,
    perQuery: found.perQuery,
    polylineLength: found.polylineLength,
    candidates,
  });
  // 6時間キャッシュ
  const cached = new Response(res.body, res);
  cached.headers.set("Cache-Control", "public, max-age=21600");
  ctx.waitUntil(cache.put(cacheKey, cached.clone()));
  return cached;
}
/**
 * POST /tag
 *   { candidate: {...} }
 * その場所の特徴タグを Gemini に都度10個ほど作らせる。
 * 固定リストから選ばせると、どの場所も似たタグになって選ぶ手がかりにならない。
 */
async function handleTag(request, env, ctx) {
  const body = await request.json();
  const candidate = body.candidate ?? body.candidates?.[0];
  if (!candidate) return fail("candidate が必要です", 400);

  // 同じ場所を二度と生成しない。Gemini の無料枠は 5リクエスト/分しかない
  const cacheKey = new Request(`https://ekz.cache/tag/${CACHE_VERSION}/${encodeURIComponent(candidate.id)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let tags;
  let source = "gemini";
  let reason = null;
  try {
    tags = await generateTags(env.GEMINI_API_KEY, candidate);
  } catch (e) {
    // 429 や 503 で落ちても画面を空にしない
    tags = fallbackTags(candidate);
    source = "fallback";
    reason = String(e?.message ?? e).slice(0, 300);
  }

  const res = json({ id: candidate.id, tags, source, reason });
  if (source === "gemini") {
    const cached = new Response(res.body, res);
    cached.headers.set("Cache-Control", "public, max-age=604800");
    ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    return cached;
  }
  return res;
}


/**
 * POST /next
 *   { candidates: [...], request?: "甘いものが食べたい", badTags?: ["並ぶ"] }
 * 次に見せる1件を Jev に選ばせる。
 */
async function handleNext(request, env) {
  const body = await request.json();
  if (!Array.isArray(body.candidates)) return fail("candidates が必要です", 400);

  const req = body.request ?? "";
  const badTags = body.badTags ?? [];
  const goodTags = body.goodTags ?? [];
  const notes = body.notes ?? [];

  const picked = await pickNext(env.TYPESAFE_API_KEY, body.candidates, {
    request: req,
    badTags,
    goodTags,
    notes,
  });

  return json({
    ...(picked ?? { id: null }),
    reason: buildReason({ req, badTags, goodTags, notes }),
  });
}

/**
 * 「なぜこれを選んだか」の一言。
 *
 * Jev はテキストを作れないが、何を渡して選ばせたかはサーバが知っている。
 * 生成モデルを挟まずに、その入力をそのまま言葉にする。速いし、嘘にならない。
 */
function buildReason({ req, badTags, goodTags, notes }) {
  const parts = [];
  if (req.trim()) parts.push(`「${req.trim()}」に合わせて`);
  if (goodTags.length) parts.push(`「${goodTags.join("・")}」が好みとのことなので`);
  if (badTags.length) parts.push(`「${badTags.join("・")}」を避けて`);
  if (notes.length) parts.push(notes[0]);

  if (parts.length === 0) return "評価が高くて寄り道も少ないので、ここを選びました";
  // 全部並べると長くて読まれない。効く順に2つまで
  return parts.slice(0, 2).join("、") + "、ここを選びました";
}

/**
 * GET /photo?name=places/xxx/photos/yyy
 * Places の写真を中継する。APIキーを端末に出さないため。
 */
async function handlePhoto(url, env) {
  const name = url.searchParams.get("name");
  if (!name || !name.startsWith("places/")) return fail("name が不正です", 400);

  const upstream = await proxyPhoto(env.GOOGLE_MAPS_SERVER_KEY, name);
  if (!upstream.ok) return fail(`photo ${upstream.status}`, upstream.status);

  const res = new Response(upstream.body, upstream);
  res.headers.set("Cache-Control", "public, max-age=86400");
  return res;
}
