import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { computeDrivingRoute, computeRoute, searchAlongRoute, GoogleRouteError } from "../src/google.js";

// Google の encoded polyline 例。3 点を含む。
const POLYLINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const responseRoute = (duration = "2640.5s", distanceMeters = 38765) => ({ routes: [{
  duration, distanceMeters, polyline: { encodedPolyline: POLYLINE },
  legs: [{ startLocation: { latLng: { latitude: 38.5, longitude: -120.2 } },
    endLocation: { latLng: { latitude: 43.252, longitude: -126.453 } } }],
}] });

test("driving route sends Place IDs and fixed departureTime, preserves unrounded seconds and metres", async (t) => {
  let options;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    options = init;
    return Response.json(responseRoute());
  });
  const result = await computeDrivingRoute("test-key", "大阪駅", "34.68,135.18", [{ id: "place-A" }, { id: "place-B" }], "2026-09-23T01:00:00Z");
  const body = JSON.parse(options.body);
  assert.deepEqual(body.origin, { address: "大阪駅" });
  assert.deepEqual(body.destination, { location: { latLng: { latitude: 34.68, longitude: 135.18 } } });
  assert.deepEqual(body.intermediates, [{ placeId: "place-A" }, { placeId: "place-B" }]);
  assert.equal(body.travelMode, "DRIVE");
  assert.equal(body.routingPreference, "TRAFFIC_AWARE");
  assert.equal(body.departureTime, "2026-09-23T01:00:00Z");
  assert.match(options.headers["X-Goog-FieldMask"], /routes.distanceMeters/);
  assert.match(options.headers["X-Goog-FieldMask"], /routes.legs.endLocation/);
  assert.equal(result.durationSeconds, 2640.5);
  assert.equal(result.distanceMeters, 38765);
  assert.deepEqual(result.originLocation, { lat: 38.5, lng: -120.2 });
});

test("address containing commas and house numbers is not partially parsed as coordinates", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).origin, { address: "12 Main Street, 34 Example Road" });
    return Response.json(responseRoute());
  });
  await computeDrivingRoute("test", "12 Main Street, 34 Example Road", "大阪駅");
});

test("existing computeRoute continues returning the same /search fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(responseRoute()));
  assert.deepEqual(await computeRoute("test", "大阪駅", "神戸"), { baseMinutes: 44, distanceKm: 38.8, polyline: POLYLINE });
});

test("upstream error bodies are not exposed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("sensitive upstream text with test-secret", { status: 403 }));
  await assert.rejects(() => computeDrivingRoute("test-secret", "A", "B"), (error) => {
    assert.ok(error instanceof GoogleRouteError);
    assert.equal(error.code, "UPSTREAM_ERROR");
    assert.match(error.message, /403/);
    assert.ok(!error.message.includes("test-secret"));
    return true;
  });
});

test("network failure is mapped to UPSTREAM_ERROR", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network"); });
  await assert.rejects(() => computeDrivingRoute("test", "A", "B"), { code: "UPSTREAM_ERROR" });
});

test("empty route and malformed route have different error codes", async (t) => {
  const fake = t.mock.method(globalThis, "fetch", async () => Response.json({ routes: [] }));
  await assert.rejects(() => computeDrivingRoute("test", "A", "B"), { code: "ROUTE_NOT_FOUND" });
  for (const body of [null, { routes: "wrong" }, responseRoute("invalid"), responseRoute("30s", null)]) {
    fake.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(() => computeDrivingRoute("test", "A", "B"), { code: "UPSTREAM_ERROR" });
  }
});

test("partial Places network failure preserves successful searches", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (JSON.parse(init.body).textQuery === "failed") throw new Error("network");
    return Response.json({ places: [{ id: "place", displayName: { text: "公園" },
      location: { latitude: 40.7, longitude: -120.95 }, rating: 4.5, userRatingCount: 100 }] });
  });
  const result = await searchAlongRoute("test", POLYLINE, ["success", "failed"], 44, { allowPartial: true });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.errors.length, 1);
});

test("Worker registers /generate-route and uses real adapters with mocked Google HTTP", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes("routes.googleapis.com")) {
      const stops = JSON.parse(init.body).intermediates;
      return Response.json(responseRoute(`${2400 + stops.length * 300}s`, 38765 + stops.length * 1234));
    }
    if (url.includes("places.googleapis.com")) return Response.json({ places: [
      { id: "A", displayName: { text: "山頂カフェ" }, primaryTypeDisplayName: { text: "カフェ" },
        location: { latitude: 40.7, longitude: -120.95 }, rating: 4.5, userRatingCount: 100 },
      { id: "B", displayName: { text: "景色のよい公園" }, primaryTypeDisplayName: { text: "公園" },
        location: { latitude: 43.252, longitude: -126.453 }, rating: 4.4, userRatingCount: 200 },
    ] });
    throw new Error("Unexpected call: Gemini/TypeSafe must not be needed");
  });
  const response = await worker.fetch(new Request("http://local/generate-route", { method: "POST", body: JSON.stringify({
    origin: "38.5,-120.2", destination: "43.252,-126.453", preferences: ["scenic", "cafe"],
    freeText: "", timeConstraint: { type: "extra_time", minutes: 30 }, waypointCount: 2,
  }) }), { GOOGLE_MAPS_SERVER_KEY: "fake-test-key" }, {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.waypoints.length, 2);
  assert.equal(result.recommendedRoute.distanceMeters, 41233);
  const combinedCall = calls.find((call) => call.body.intermediates?.length === 2);
  assert.deepEqual(combinedCall.body.intermediates.map((item) => item.placeId), result.waypoints.map((item) => item.placeId));
  assert.ok(calls.every((call) => call.url.includes("googleapis.com")));
  const root = await worker.fetch(new Request("http://local/"), {}, {});
  assert.ok((await root.json()).endpoints.includes("POST /generate-route"));
});
