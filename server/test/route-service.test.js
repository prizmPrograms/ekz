import assert from "node:assert/strict";
import test from "node:test";
import { editRoutePlan, generateRoutePlan, genreForPreferences, matchesPreferences, RouteServiceError } from "../src/route-service.js";

const candidates = [
  {
    id: "place-a",
    name: "海辺の公園",
    category: "公園",
    lat: 34.68,
    lng: 135.2,
    rating: 4.6,
    reviewCount: 400,
    stayMinutes: 5,
    detourMinutes: 12,
    routeRatio: 0.4,
    offRouteKm: 1.2,
  },
  {
    id: "place-b",
    name: "港のカフェ",
    category: "カフェ",
    lat: 34.67,
    lng: 135.18,
    rating: 4.4,
    reviewCount: 240,
    stayMinutes: 5,
    detourMinutes: 15,
    routeRatio: 0.7,
    offRouteKm: 1.5,
  },
  {
    id: "place-c",
    name: "展望台",
    category: "観光名所",
    lat: 34.69,
    lng: 135.16,
    rating: 4.2,
    reviewCount: 180,
    stayMinutes: 5,
    detourMinutes: 20,
    routeRatio: 0.8,
    offRouteKm: 2,
  },
];

const generateInput = {
  origin: "大阪駅",
  destination: "神戸ハーバーランド",
  preferences: ["ocean", "cafe"],
  freeText: "海沿いのカフェ",
  timeConstraint: { type: "extra_time", minutes: 30 },
  waypointCount: 2,
};

function dependencies(overrides = {}) {
  return {
    search: async () => ({ baseMinutes: 44, distanceKm: 38.7, candidates }),
    compute: async (_origin, _destination, waypoints) => ({
      durationMinutes: 44 + waypoints.length * 9,
      distanceMeters: 38700 + waypoints.length * 1700,
    }),
    pick: async (pool) => ({ id: pool[0].id, reason: "希望に合う場所です。" }),
    tags: async (candidate) => [candidate.category],
    photoUrl: () => null,
    ...overrides,
  };
}

test("generateRoutePlan returns an exact route containing selected waypoints", async () => {
  const result = await generateRoutePlan(generateInput, dependencies());

  assert.equal(result.normalRoute.durationMinutes, 44);
  assert.equal(result.recommendedRoute.drivingMinutes, 62);
  assert.equal(result.recommendedRoute.durationMinutes, 72);
  assert.equal(result.recommendedRoute.distanceMeters, 42100);
  assert.equal(result.recommendedRoute.extraMinutes, 28);
  assert.deepEqual(result.waypoints.map((waypoint) => waypoint.placeId), ["place-a", "place-b"]);
  assert.match(result.googleMapsUrl, /waypoints=34\.68%2C135\.2%7C34\.67%2C135\.18/);
});

test("generateRoutePlan drops to one waypoint when two exceed the time constraint", async () => {
  const result = await generateRoutePlan(generateInput, dependencies({
    compute: async (_origin, _destination, waypoints) => ({
      durationMinutes: waypoints.length === 2 ? 80 : 58,
      distanceMeters: 41000,
    }),
  }));

  assert.equal(result.waypoints.length, 1);
  assert.equal(result.recommendedRoute.drivingMinutes, 58);
  assert.equal(result.recommendedRoute.durationMinutes, 63);
});

test("generateRoutePlan uses ranked fallback when TypeSafe selection fails", async () => {
  const result = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, dependencies({
    pick: async () => { throw new Error("service unavailable"); },
  }));

  assert.equal(result.waypoints[0].placeId, "place-a");
});

test("editRoutePlan deletes a waypoint and recalculates the route", async () => {
  const original = await generateRoutePlan(generateInput, dependencies());
  const result = await editRoutePlan({
    route: original,
    preferences: generateInput.preferences,
    freeText: generateInput.freeText,
    timeConstraint: generateInput.timeConstraint,
    action: { type: "delete", waypointIndex: 0 },
  }, dependencies());

  assert.deepEqual(result.waypoints.map((waypoint) => waypoint.placeId), ["place-b"]);
  assert.equal(result.recommendedRoute.drivingMinutes, 53);
  assert.equal(result.recommendedRoute.durationMinutes, 58);
  assert.match(result.reason, /海辺の公園を外し/);
});

test("editRoutePlan replaces a waypoint and excludes already shown candidates", async () => {
  const original = await generateRoutePlan(generateInput, dependencies());
  const result = await editRoutePlan({
    route: original,
    preferences: generateInput.preferences,
    freeText: generateInput.freeText,
    timeConstraint: generateInput.timeConstraint,
    action: { type: "replace", waypointIndex: 0, excludedPlaceIds: [] },
  }, dependencies());

  assert.equal(result.waypoints[0].placeId, "place-c");
  assert.equal(result.waypoints[1].placeId, "place-b");
});

test("generateRoutePlan rejects invalid input with a structured error", async () => {
  await assert.rejects(
    () => generateRoutePlan({ ...generateInput, preferences: ["unknown"] }, dependencies()),
    (error) => error instanceof RouteServiceError && error.code === "INVALID_REQUEST" && error.status === 400,
  );
});

test("generateRoutePlan accepts empty preferences", async () => {
  const result = await generateRoutePlan({ ...generateInput, preferences: [], freeText: "" }, dependencies());

  assert.ok(result.waypoints.length > 0);
});

test("generateRoutePlan requires preferences to be an array", async () => {
  await assert.rejects(
    () => generateRoutePlan({ ...generateInput, preferences: undefined }, dependencies()),
    (error) => error instanceof RouteServiceError && error.code === "INVALID_REQUEST",
  );
});

test("editRoutePlan eliminates candidates similar to the rejected tags", async () => {
  const more = [
    ...candidates,
    { id: "place-d", name: "港のカフェ2号店", category: "カフェ", lat: 34.66, lng: 135.17, rating: 4.8, detourMinutes: 10, routeRatio: 0.5 },
    { id: "place-e", name: "山の温泉", category: "温泉", lat: 34.7, lng: 135.1, rating: 4.0, detourMinutes: 25, routeRatio: 0.6 },
  ];
  let feedbackSeen = null;
  const deps = dependencies({
    search: async () => ({ baseMinutes: 44, distanceKm: 38.7, candidates: more }),
    pick: async (pool, _text, feedback) => {
      feedbackSeen = feedback;
      return { id: pool[0].id, reason: null };
    },
  });
  const original = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, deps);
  const result = await editRoutePlan({
    route: original,
    preferences: [],
    freeText: "",
    timeConstraint: { type: "none" },
    action: { type: "replace", waypointIndex: 0, excludedPlaceIds: [], badTags: ["カフェ", "展望台", "公園"] },
  }, deps);

  // 元の経由地を除いた4件のうち、温泉以外の3件が消える
  assert.equal(original.waypoints.length, 1);
  assert.deepEqual(feedbackSeen, { badTags: ["カフェ", "展望台", "公園"], goodTags: [] });
  assert.equal(result.waypoints[0].placeId, "place-e");
  assert.equal(result.eliminatedCount, 3);
});

test("editRoutePlan keeps candidates when every one matches the rejected tags", async () => {
  const cafes = candidates.map((candidate) => ({ ...candidate, category: "カフェ" }));
  const deps = dependencies({ search: async () => ({ baseMinutes: 44, distanceKm: 38.7, candidates: cafes }) });
  const original = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, deps);
  const result = await editRoutePlan({
    route: original,
    preferences: [],
    freeText: "",
    timeConstraint: { type: "none" },
    action: { type: "replace", waypointIndex: 0, excludedPlaceIds: [], badTags: ["カフェ"] },
  }, deps);

  assert.equal(result.eliminatedCount, 0);
  assert.ok(result.waypoints[0].placeId);
});

test("editRoutePlan rejects badTags that are not strings", async () => {
  const original = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, dependencies());
  await assert.rejects(
    () => editRoutePlan({
      route: original,
      preferences: [],
      freeText: "",
      timeConstraint: { type: "none" },
      action: { type: "replace", waypointIndex: 0, badTags: [1] },
    }, dependencies()),
    (error) => error instanceof RouteServiceError && error.code === "INVALID_REQUEST",
  );
});

test("editRoutePlan passes liked tags to the picker without eliminating anything", async () => {
  let feedbackSeen = null;
  const deps = dependencies({
    pick: async (pool, _text, feedback) => {
      feedbackSeen = feedback;
      return { id: pool[0].id, reason: null };
    },
  });
  const original = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, deps);
  const result = await editRoutePlan({
    route: original,
    preferences: [],
    freeText: "",
    timeConstraint: { type: "none" },
    action: { type: "replace", waypointIndex: 0, excludedPlaceIds: [], goodTags: ["景色"] },
  }, deps);

  assert.deepEqual(feedbackSeen, { badTags: [], goodTags: ["景色"] });
  assert.equal(result.eliminatedCount, 0);
});

test("route responses keep leg minutes and waypoint arrival details", async () => {
  const result = await generateRoutePlan({ ...generateInput, waypointCount: 1 }, dependencies({
    compute: async () => ({ durationMinutes: 50, distanceMeters: 40000, legMinutes: [20, 30] }),
  }));

  assert.deepEqual(result.recommendedRoute.legMinutes, [20, 30]);
  assert.equal(result.recommendedRoute.drivingMinutes, 50);
  assert.equal(result.recommendedRoute.durationMinutes, 55);
  assert.equal(typeof result.waypoints[0].stayMinutes, "number");
  assert.ok("priceRange" in result.waypoints[0]);
});

test("route total includes every stay and matches the displayed arrival time", async () => {
  const scenic = [
    { ...candidates[0], stayMinutes: 30 },
    { ...candidates[2], stayMinutes: 25 },
  ];
  const result = await generateRoutePlan({
    ...generateInput,
    preferences: ["scenic"],
    freeText: "",
    timeConstraint: { type: "none" },
  }, dependencies({
    search: async () => ({ baseMinutes: 11, distanceKm: 6.6, candidates: scenic }),
    compute: async () => ({ durationMinutes: 14, distanceMeters: 6600, legMinutes: [7, 7] }),
  }));

  assert.equal(result.waypoints.length, 1, "short routes should not receive two stops");
  assert.equal(result.recommendedRoute.drivingMinutes, 14);
  assert.equal(result.recommendedRoute.durationMinutes, 44);
  assert.equal(result.recommendedRoute.extraMinutes, 33);
});

test("preference matching rejects restaurants returned for a scenic park query", () => {
  assert.equal(matchesPreferences({ name: "桃山公園", category: "公園" }, ["scenic"]), true);
  assert.equal(matchesPreferences({ name: "魚食処 緑地公園店", category: "和食店" }, ["scenic"]), false);
  assert.deepEqual(genreForPreferences(["scenic", "cafe"]), ["sweets", "view"]);
});
