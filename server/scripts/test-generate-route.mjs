// 在 server 文件夹运行：node .\scripts\test-generate-route.mjs
// 只测试本机服务，不读取或显示任何 API 密钥。Google API 由你运行的后端调用。
import assert from "node:assert/strict";

const baseUrl = "http://127.0.0.1:8787";
const input = {
  origin: "大阪駅",
  destination: "神戸ハーバーランド",
  preferences: ["ocean", "cafe"],
  freeText: "",
  timeConstraint: { type: "extra_time", minutes: 30 },
  waypointCount: 2,
};

try {
  const health = await fetch(baseUrl + "/", { signal: AbortSignal.timeout(5000) });
  const info = await health.json();
  if (!info.endpoints?.includes("POST /generate-route")) {
    throw new Error("当前运行的服务还没有 /generate-route。请确认文件已替换，并在 server 文件夹重新启动 Wrangler。");
  }

  console.log("正在请求 /generate-route；此步骤会通过你的后端调用真实 Google API，请稍等。");
  const response = await fetch(baseUrl + "/generate-route", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(90000),
  });
  const body = await response.json();
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok) {
    throw new Error(body.error?.message ?? "接口返回错误。请把错误码和错误信息发给协作者，不要发送密钥。");
  }
  assert.ok(body.waypoints.length >= 1 && body.waypoints.length <= 2, "途经地点数应为 1～2");
  for (const route of [body.normalRoute, body.recommendedRoute]) {
    assert.ok(Number.isFinite(route.durationMinutes) && route.durationMinutes >= 0, "缺少路线时间");
    assert.ok(Number.isInteger(route.distanceMeters) && route.distanceMeters >= 0, "缺少路线距离");
  }
  assert.ok(body.recommendedRoute.durationMinutes <= body.normalRoute.durationMinutes + 30, "返回时间超出预算");
  const url = new URL(body.googleMapsUrl);
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.searchParams.get("waypoint_place_ids"), body.waypoints.map((item) => item.placeId).join("|"));
  console.log("\n本地真实 API 测试通过。请打开上面的 googleMapsUrl，核对途经地点及顺序。");
  console.log("这表示后端接口已跑通；Expo / Demo 界面还需要改为调用这个接口。");
} catch (error) {
  console.error("\n测试未通过：" + error.message);
  if (error.message === "fetch failed") {
    console.error("请先在第一个 PowerShell 窗口启动 npx.cmd wrangler dev，并保持该窗口运行。");
  }
  process.exitCode = 1;
}
