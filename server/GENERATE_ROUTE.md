# POST /generate-route

`mobile/types/route.ts` の `GenerateRouteRequest` / `GenerateRouteResponse` に合わせた、寄り道ルート生成 API です。
Places から候補を取得し、評価・口コミ数・希望条件・追加走行時間で 1〜2 件を選びます。
TypeSafe / Jev が利用できるまでの暫定ルール選定で、AI による選定ではありません。

## 起動と確認

必要なローカル設定は `server/.dev.vars` の `GOOGLE_MAPS_SERVER_KEY` です。
既存の有効なキーを使い、キーのプロジェクトで Routes API と Places API (New) を有効にしてください。
このエンドポイント自体は `GEMINI_API_KEY` と `TYPESAFE_API_KEY` を必要としません。
既存の `/tag` と `/next` は変更していません。

```powershell
cd "C:\Users\meico\OneDrive\Desktop\ekz-main\server"
npm.cmd test
npx.cmd wrangler dev
```

別の PowerShell ウィンドウから実 API テストを行います。Wrangler のウィンドウへ貼り付けないでください。

```powershell
cd "C:\Users\meico\OneDrive\Desktop\ekz-main\server"
node .\scripts\test-generate-route.mjs
```

`npm test` は外部通信なしのテストです。`test-generate-route.mjs` はローカル Worker を経由して実際の Google API を呼び出します。
実 API テストの結果は環境、交通状況、候補検索結果により変わります。

## リクエスト

```json
{
  "origin": "大阪駅",
  "destination": "神戸ハーバーランド",
  "preferences": ["ocean", "cafe"],
  "freeText": "",
  "timeConstraint": { "type": "extra_time", "minutes": 30 },
  "waypointCount": 2
}
```

| フィールド | 仕様 |
| --- | --- |
| `origin`, `destination` | 必須。1〜400 文字の場所名・住所・`lat,lng`。空文字不可 |
| `preferences` | `scenic`, `ocean`, `night_view`, `mountain`, `cafe`, `gourmet`, `hot_spring`, `detour`, `quiet`。省略時 `[]` |
| `freeText` | 500 文字以内。Places 検索クエリとして追加。省略時 `""` |
| `timeConstraint` | `none` / `extra_time` / `total_time`。省略時 `{ "type": "none" }` |
| `timeConstraint.minutes` | `extra_time` と `total_time` の場合、0 以上の有限数値 |
| `waypointCount` | 1 または 2。省略時 2。2 件が成立しなければ 1 件を返すことがある |

## 時間と距離の意味

- 現仕様は **車での走行時間**。滞在時間・食事時間・待ち時間は含みません。希望条件の自由文は検索の手がかりであり、厳密な制約の解析はしません。
- `extra_time` は「通常ルートの走行秒数 + minutes × 60」を上限とします。
- `total_time` は経由地を含む全走行秒数の上限です。
- `none` は明示的な時間上限なしです。既存 Expo の仮処理で使う「暗黙の追加 60 分」とは異なります。
- 判定は Google が返した秒数で行い、返却する `durationMinutes` は分単位に切り上げます。
- `extraMinutes` は表示用の推奨ルート分数と通常ルート分数の差（最小 0）です。
- `waypoints[].detourMinutes` は **その 1 地点だけ経由したとき** の表示分数の差です。複数地点の値を足して総時間にしないでください。
- `distanceMeters` は Google が返した経路全体のメートル値です。直線距離からの概算ではありません。
- 通常ルートと候補ルートは同じ出発時刻（リクエスト開始時点から 3 分後）、`DRIVE`、`TRAFFIC_AWARE` で比較します。Google の予測値であり、将来の実到着時刻を保証するものではありません。
- 滞在時間込みの「旅行全体の時間」を要件にする場合は、地点ごとの滞在時間の入力・出力をチームで定義してから追加します。

## 選定と再計算

1. 出発地から目的地までの通常ルートを Routes API で計算。
2. 通常ルートの polyline を使い、Places API (New) で希望条件別に検索。
3. 口コミ 30 件以上、評価 3.8 以上、座標あり、通常ルートから概ね 6 km 以内の候補を残す。
4. 希望への一致、評価、口コミ数、ルートからの距離で最大 5 候補に絞る。複数の希望ジャンルも優先して残す。
5. 各候補を 1 地点経由する Routes API リクエストを実行し、実際の道路経路の追加時間を得る。
6. 2 件希望の場合、最大 4 組をルート上の順序で並べて、**両方を `intermediates` に指定**して再計算する。個別ルートの時間を合算しない。
7. 時間内の 2 件組を優先し、なければ時間内の 1 件を返す。成立しなければ構造化エラー。

検索と計算を有限にするための暫定アルゴリズムです。全候補・全順序を網羅する最適化ではありません。
「海沿い」「山道」などは関連する立ち寄り地点の検索・選定に使います。道路自体がすべて海沿いや山道になる保証はありません。
自由文の否定条件、営業日時、満席、駐車場の確実な有無、歩行・公共交通には未対応です。
料金・待ち時間を抑えるため、1 回の生成あたり Routes API は最大 10 回、Places 検索は最大 10 回です。
外部リクエストは各 10 秒でタイムアウトし、経路計算は同時 2 件までです。応答はキャッシュしません。

## レスポンス

以下は形式を示す架空の例です。実 API の測定結果ではありません。

```json
{
  "origin": { "name": "大阪駅", "lat": 34.702, "lng": 135.495 },
  "destination": { "name": "神戸ハーバーランド", "lat": 34.68, "lng": 135.18 },
  "normalRoute": { "durationMinutes": 45, "distanceMeters": 38765 },
  "recommendedRoute": { "durationMinutes": 55, "distanceMeters": 45123, "extraMinutes": 10 },
  "waypoints": [{
    "placeId": "example-place-id", "name": "候補のカフェ", "lat": 34.7, "lng": 135.3,
    "category": "カフェ", "rating": 4.5, "reviewCount": 100, "photoUrl": null,
    "tags": ["カフェ", "評価が高い"], "detourMinutes": 10
  }],
  "reason": "希望条件による検索結果から、評価・口コミ数・追加走行時間で候補を選びました。",
  "googleMapsUrl": "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=34.702%2C135.495&destination=34.68%2C135.18&waypoints=34.7%2C135.3&waypoint_place_ids=example-place-id"
}
```

`waypoints` は計算・表示・Google Maps URL とも同じ順序です。Maps URL に API キーは含みません。
`photoUrl` はリクエスト先サーバーの `/photo` です。画像を使う際は既存の表示仕様・帰属表示も確認してください。
`tags` はカテゴリ・評価から作る簡単な表示用タグです。Gemini の生成結果とみなさないでください。
Google Maps を開いた時点で経路・所要時間が再計算され、API で得た予測値と異なる場合があります。

| HTTP | `error.code` | 意味 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | JSON や入力条件が不正 |
| 404 | `ROUTE_NOT_FOUND` | 通常の車ルートが得られない |
| 422 | `NO_CANDIDATES` | 検討した候補で条件内のルートが成立しない |
| 502 | `UPSTREAM_ERROR` | Google API の接続・応答に失敗 |
| 503 | `INTERNAL_ERROR` | サーバーの Maps キー未設定 |
| 500 | `INTERNAL_ERROR` | その他の予期しない処理エラー |

```json
{ "error": { "code": "NO_CANDIDATES", "message": "検討した候補では指定時間内の寄り道ルートが見つかりませんでした。時間や希望条件を変更してください。" } }
```

## Expo 担当者への引き継ぎ

アップロードされた `mobile/services/api.ts` は、現在 `/search` → `/next` → `/tag` を呼び、端末側で時間・距離を概算しています。
新エンドポイントを追加するだけでは、この呼び出し先は変わりません。
`generateRoute()` で `request: GenerateRouteRequest` を構築した直後から、その関数の終わりまでを、次の処理へ置き換えられます。

```ts
return postJson<GenerateRouteResponse>('/generate-route', request)
```

これは接続箇所の案で、この提出物にはフロントの変更は含めていません。
`getRoutePreview()` の従来処理と新 API では丸め・交通状況により通常時間が違う場合があります。
画面には生成結果の `normalRoute` と `recommendedRoute` を一緒に反映してください。
API の「走行時間のみ」「none に時間上限なし」の意味が画面と一致するかも確認してください。
端末から本番 API を使うには、レビュー後のサーバーデプロイと Expo の `EXPO_PUBLIC_API_URL` の設定が必要です。

## 検証状況

- `npm test`: 36 テスト成功（Google HTTP はモック）。入力検証、時間制約、組み合わせの再計算、Maps URL の地点順、部分障害、上流エラー、既存ルート計算形式を確認。
- 実際のユーザーの Google API キーを使った `/generate-route` のテストは未実施。添付のスモークテストで確認してください。
- Cloudflare へのデプロイ、Expo 実機接続、GitHub への push / PR 作成は未実施。

## Google の仕様確認先

- [経由地の指定](https://developers.google.com/maps/documentation/routes/intermed_waypoints)
- [Compute Routes リファレンス](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)
- [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)
