export type Preference = 'scenic' | 'ocean' | 'night_view' | 'mountain' | 'cafe' | 'gourmet' | 'hot_spring' | 'detour' | 'quiet'

export type TimeConstraint =
  | { type: 'none' }
  | { type: 'extra_time'; minutes: number }
  | { type: 'total_time'; minutes: number }

export type RouteEndpoint = {
  name: string
  lat: number | null
  lng: number | null
}

export type RouteSummary = {
  /** 滞在時間を含む合計所要時間。通常ルートでは運転時間と同じ */
  durationMinutes: number
  /** 経由地間を運転する時間。おすすめルートで返る */
  drivingMinutes?: number
  distanceMeters: number
  /** 区間ごとの所要時間(出発→経由地1→…→目的地)。無いこともある */
  legMinutes?: number[]
}

export type RoutePreview = {
  origin: RouteEndpoint
  destination: RouteEndpoint
  normalRoute: RouteSummary
  /** ルート沿いの寄り道候補の数(最初の画面で見せる) */
  candidateCount?: number
}

export type RouteWaypoint = {
  placeId: string
  name: string
  lat: number
  lng: number
  category: string | null
  rating: number | null
  reviewCount: number | null
  photoUrl: string | null
  tags: string[]
  detourMinutes: number
  priceRange?: string | null
  /** 種別から見積もった滞在時間 */
  stayMinutes?: number
  /** 出発地からその場所に着くまでの見積もり */
  minutesToArrive?: number | null
}

export type GenerateRouteResponse = RoutePreview & {
  recommendedRoute: RouteSummary & { extraMinutes: number }
  waypoints: RouteWaypoint[]
  reason: string
  googleMapsUrl: string
  /** replace のときだけ。badTags で外した候補の数 */
  eliminatedCount?: number
}

/** POST /generate-route request sent after the shared Maps URL is parsed. */
export type GenerateRouteRequest = {
  origin: string
  destination: string
  preferences: Preference[]
  freeText: string
  timeConstraint: TimeConstraint
  waypointCount: 1 | 2
}

export type EditRouteAction =
  | { type: 'delete'; waypointIndex: number }
  | { type: 'replace'; waypointIndex: number; excludedPlaceIds: string[]; badTags?: string[]; goodTags?: string[] }

export type EditRouteRequest = {
  route: GenerateRouteResponse
  preferences: Preference[]
  freeText: string
  timeConstraint: TimeConstraint
  action: EditRouteAction
}

export type RouteApiErrorCode =
  | 'INVALID_REQUEST'
  | 'ROUTE_NOT_FOUND'
  | 'NO_CANDIDATES'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR'

export type RouteApiErrorResponse = {
  error: {
    code: RouteApiErrorCode
    message: string
  }
}

/** Input kept by the UI before it resolves a shared Google Maps URL. */
export type GenerateRouteInput = {
  googleMapsUrl: string
  preferences: Preference[]
  freeText: string
  timeConstraint: TimeConstraint
}
