import test from "node:test";
import assert from "node:assert/strict";
import { handleGenerateRoute } from "../src/generate-route.js";
import { GoogleRouteError } from "../src/google.js";

const INPUT = {
  origin: "大阪駅", destination: "神戸ハーバーランド", preferences: ["ocean", "cafe"],
  freeText: "", timeConstraint: { type: "extra_time", minutes: 30 }, waypointCount: 2,
};
const candidate = (id, values = {}) => ({
  id, name: `候補 ${id}`, lat: 34.7, lng: 135.3, category: "カフェ", rating: 4.5,
  reviewCount: 100, routeRatio: 0.5, offRouteKm: 0.3, detourMinutes: 99,
  reviews: [], photoName: "places/example/photos/example", ...values,
});
const A = candidate("A", { name: "海辺の公園", category: "公園", routeRatio: 0.7 });
const B = candidate("B", { name: "カフェ B", routeRatio: 0.3 });
const summary = (durationSeconds, distanceMeters = 38765) => ({
  durationSeconds, distanceMeters, polyline: "encoded-route", originLocation: { lat: 34.702, lng: 135.495 },
  destinationLocation: { lat: 34.68, lng: 135.18 },
});
function setup({ candidates = [A, B], durations = { "": 2641, A: 3061, B: 3121, "B,A": 3541 }, errors = [] } = {}) {
  const calls = [];
  const searches = [];
  const dependencies = {
    now: () => Date.UTC(2026, 8, 23),
    compute: async (key, origin, destination, stops, departureTime) => {
      calls.push({ key, origin, destination, stops, departureTime });
      const result = durations[stops.map((item) => item.id).join(",")];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error("Missing route fixture");
      return summary(result, stops.length === 2 ? 51023 : stops.length === 1 ? 44017 : 38765);
    },
    search: async (...args) => { searches.push(args); return { candidates, errors }; },
  };
  const request = async (input = INPUT, env = { GOOGLE_MAPS_SERVER_KEY: "local-test-only" }) => {
    const response = await handleGenerateRoute(new Request("http://127.0.0.1:8787/generate-route", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }), env, dependencies);
    return { response, body: await response.json() };
  };
  return { calls, searches, request };
}

test("returns Expo contract with recomputed combined route, metres and ordered Maps waypoints", async () => {
  const fixture = setup();
  const { response, body } = await fixture.request();
  assert.equal(response.status, 200);
  assert.deepEqual(body.normalRoute, { durationMinutes: 45, distanceMeters: 38765 });
  assert.deepEqual(body.recommendedRoute, { durationMinutes: 60, distanceMeters: 51023, extraMinutes: 15 });
  assert.deepEqual(body.waypoints.map((item) => item.placeId), ["B", "A"]);
  // 個別寄り道時間の足し算 (8 + 7) でも、既存の滞在時間込み概算 (99 + 99) でもない距離。
  assert.deepEqual(body.waypoints.map((item) => item.detourMinutes), [8, 7]);
  for (const waypoint of body.waypoints) {
    assert.deepEqual(Object.keys(waypoint).sort(), ["placeId", "name", "lat", "lng", "category", "rating", "reviewCount", "photoUrl", "tags", "detourMinutes"].sort());
    assert.equal(typeof waypoint.lat, "number");
    assert.ok(waypoint.tags.every((tag) => typeof tag === "string"));
    assert.equal(new URL(waypoint.photoUrl).pathname, "/photo");
    assert.ok(!waypoint.photoUrl.includes("local-test-only"));
  }
  const url = new URL(body.googleMapsUrl);
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.equal(url.searchParams.get("waypoint_place_ids"), "B|A");
  assert.equal(url.searchParams.get("waypoints"), body.waypoints.map((item) => `${item.lat},${item.lng}`).join("|"));
  assert.equal(url.searchParams.get("origin"), "34.702,135.495");
  assert.equal(new Set(fixture.calls.map((call) => call.departureTime)).size, 1);
  assert.equal(fixture.calls[0].departureTime, "2026-09-23T00:03:00.000Z");
  assert.deepEqual(fixture.searches[0][2], ["海岸", "カフェ"]);
  assert.match(body.reason, /滞在・待ち時間を含みません/);
});

test("two-stop duration comes from combined computation, not a sum of one-stop detours", async () => {
  const { request } = setup({ durations: { "": 2400, A: 3000, B: 3000, "B,A": 3300 } });
  const { body } = await request();
  assert.equal(body.recommendedRoute.durationMinutes, 55);
  assert.equal(body.recommendedRoute.extraMinutes, 15);
  assert.equal(body.waypoints.reduce((sum, item) => sum + item.detourMinutes, 0), 20);
});

test("falls back to one waypoint if two-stop route exceeds extra-time budget", async () => {
  const { request } = setup({ durations: { "": 2400, A: 2700, B: 2700, "B,A": 3601 } });
  const { response, body } = await request({ ...INPUT, timeConstraint: { type: "extra_time", minutes: 10 } });
  assert.equal(response.status, 200);
  assert.equal(body.waypoints.length, 1);
  assert.equal(body.recommendedRoute.durationMinutes, 45);
  assert.match(body.reason, /1 地点/);
});

test("honours total_time using seconds before display rounding", async () => {
  const { request } = setup({ candidates: [A], durations: { "": 2400, A: 3000.1 } });
  const { response, body } = await request({ ...INPUT, waypointCount: 1, timeConstraint: { type: "total_time", minutes: 50 } });
  assert.equal(response.status, 422);
  assert.equal(body.error.code, "NO_CANDIDATES");
});

test("rejects total-time budget shorter than baseline before searching Places", async () => {
  const fixture = setup();
  const { response, body } = await fixture.request({ ...INPUT, timeConstraint: { type: "total_time", minutes: 20 } });
  assert.equal(response.status, 422);
  assert.equal(body.error.code, "NO_CANDIDATES");
  assert.equal(fixture.searches.length, 0);
});

test("zero extra minutes permits a stop on an equally fast route", async () => {
  const { request } = setup({ candidates: [A], durations: { "": 2400, A: 2400 } });
  const { response, body } = await request({ ...INPUT, timeConstraint: { type: "extra_time", minutes: 0 } });
  assert.equal(response.status, 200);
  assert.equal(body.recommendedRoute.extraMinutes, 0);
});

test("none imposes no implicit 60-minute budget, and waypointCount 1 makes no pair calls", async () => {
  const fixture = setup({ candidates: [A], durations: { "": 2400, A: 9000 } });
  const { response, body } = await fixture.request({ ...INPUT, waypointCount: 1, timeConstraint: { type: "none" } });
  assert.equal(response.status, 200);
  assert.equal(body.recommendedRoute.durationMinutes, 150);
  assert.equal(fixture.calls.length, 2);
});

test("preferences and freeText influence queries, shortlist keeps different preferred categories", async () => {
  const fixture = setup();
  await fixture.request({ ...INPUT, preferences: ["cafe", "ocean", "cafe"], freeText: "駐車場のあるカフェ" });
  assert.deepEqual(fixture.searches[0][2], ["カフェ", "海岸", "駐車場のあるカフェ"]);
});

test("filters bad ratings, missing coordinates and duplicates before route calculations", async () => {
  const fixture = setup({ candidates: [A, A, candidate("low", { rating: 3.7 }), candidate("few", { reviewCount: 2 }),
    candidate("missing", { lng: null }), candidate("far", { offRouteKm: 8 })] });
  const { response, body } = await fixture.request();
  assert.equal(response.status, 200);
  assert.deepEqual(body.waypoints.map((item) => item.placeId), ["A"]);
  assert.equal(fixture.calls.length, 2);
});

test("returns structured NO_CANDIDATES without inventing a stop", async () => {
  const { request } = setup({ candidates: [] });
  const { response, body } = await request();
  assert.equal(response.status, 422);
  assert.equal(body.error.code, "NO_CANDIDATES");
  assert.equal(body.waypoints, undefined);
});

test("distinguishes Places outage from an empty successful search", async () => {
  const { request } = setup({ candidates: [], errors: ["private upstream body"] });
  const { response, body } = await request();
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "UPSTREAM_ERROR");
  assert.ok(!JSON.stringify(body).includes("private upstream body"));
});

test("uses remaining candidates when one search or waypoint route fails", async () => {
  const { request } = setup({ errors: ["one query failed"], durations: {
    "": 2400, A: new GoogleRouteError("UPSTREAM_ERROR", "network"), B: 2700,
  } });
  const { response, body } = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(body.waypoints.map((item) => item.placeId), ["B"]);
});

test("baseline without route returns ROUTE_NOT_FOUND", async () => {
  const { request } = setup({ durations: { "": new GoogleRouteError("ROUTE_NOT_FOUND", "no route") } });
  const { response, body } = await request();
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ROUTE_NOT_FOUND");
});

test("missing key gives actionable structured error, no upstream call", async () => {
  const fixture = setup();
  const { response, body } = await fixture.request(INPUT, {});
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(fixture.calls.length, 0);
});

test("invalid inputs return 400 before Google calls", async (t) => {
  const badInputs = [null, [], { ...INPUT, origin: " " }, { ...INPUT, destination: "91, 181" },
    { ...INPUT, preferences: ["unknown"] }, { ...INPUT, preferences: "cafe" },
    { ...INPUT, freeText: 1 }, { ...INPUT, waypointCount: 3 },
    { ...INPUT, timeConstraint: { type: "extra_time", minutes: -1 } },
    { ...INPUT, timeConstraint: { type: "total_time", minutes: "30" } },
    { ...INPUT, timeConstraint: { type: "invalid" } }];
  for (const input of badInputs) await t.test(JSON.stringify(input), async () => {
    const fixture = setup();
    const { response, body } = await fixture.request(input);
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.equal(fixture.calls.length, 0);
  });
});

test("invalid JSON returns structured error", async () => {
  const response = await handleGenerateRoute(new Request("http://local/generate-route", { method: "POST", body: "{" }), {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("route-call budget is bounded even with many candidates", async () => {
  let count = 0;
  const response = await handleGenerateRoute(new Request("http://local/generate-route", { method: "POST", body: JSON.stringify(INPUT) }),
    { GOOGLE_MAPS_SERVER_KEY: "test" }, {
      compute: async (_key, _origin, _destination, stops) => { count++; return summary(2400 + stops.length * 300); },
      search: async () => ({ candidates: Array.from({ length: 40 }, (_, i) => candidate(`place-${i}`)), errors: [] }),
    });
  assert.equal(response.status, 200);
  assert.equal(count, 10); // 基本 1 + 単独 5 + 組み合わせ 4。
});
