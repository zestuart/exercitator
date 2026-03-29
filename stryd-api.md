# Stryd PowerCenter API — Reverse-Engineered Reference

**Status**: Undocumented. Reverse-engineered from HAR captures of the Stryd
PowerCenter web UI (https://www.stryd.com) on 2026-03-29. No official API
documentation exists. Stryd does not publish a developer programme.

**Base URLs**:
- Authentication: `https://www.stryd.com/b/email/signin`
- API: `https://api.stryd.com/b/api/v1`

**CORS**: The API server (`api.stryd.com`) accepts cross-origin requests from
`https://www.stryd.com`. Third-party callers must send `Origin: https://www.stryd.com`
and `Referer: https://www.stryd.com/` headers to pass CORS checks.

---

## Authentication

### Login

```
POST https://www.stryd.com/b/email/signin
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```

**Response** (200):
```json
{
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6...",
  "id": "ed01b284-814d-5b95-52a3-c91e9fd5e86c"
}
```

- `token`: JWT used for all subsequent API calls.
- `id`: UUID identifying the authenticated user. Required for all user-scoped endpoints.

### Auth header format

```
Authorization: Bearer: <token>
```

**Note the colon after "Bearer"** — this is non-standard (RFC 6750 specifies
`Bearer <token>` without a colon). Stryd's API rejects requests using the
standard format.

### Token lifetime

Not explicitly documented. Tokens appear to be short-lived (hours). The web UI
does not refresh tokens — it re-authenticates on page load. Our client
re-authenticates before each operation.

---

## Required headers

All API requests should include browser-like headers to avoid rejection:

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
Origin: https://www.stryd.com
Referer: https://www.stryd.com/
```

---

## Endpoints

### Calendar — list activities and scheduled workouts

```
GET /users/{userId}/calendar?from={unixEpoch}&to={unixEpoch}&include_deleted=false
```

Returns activities and planned workouts within the date range. Each activity
includes basic metrics (distance, elapsed_time, average_power) plus optional
post-run report fields (rpe, feel, surface_type).

**Response** (200):
```json
{
  "activities": [
    {
      "id": 5020712412020736,
      "timestamp": 1774300800,
      "distance": 8234.5,
      "elapsed_time": 2847,
      "average_power": 267,
      "rpe": 6,
      "feel": "Good",
      "surface_type": "Road"
    }
  ]
}
```

The `activities` array may be absent or null if none exist in the range.

---

### FIT file download

Two-step process: get a signed GCS URL, then download the binary.

**Step 1 — get signed URL:**
```
GET /users/{userId}/activities/{activityId}/fit
```

**Response** (200):
```json
{
  "url": "https://storage.googleapis.com/stryd-fit-files/..."
}
```

The signed URL is on `storage.googleapis.com` or `storage.cloud.google.com`.
It expires after a short period (minutes). No auth header needed for the download.

**Step 2 — download binary:**
```
GET <signedUrl>
```

Returns raw FIT file bytes. Typical size: 50–200 KB. The FIT file contains Stryd
developer fields (Leg Spring Stiffness, Form Power, Impact Loading Rate, etc.)
that are not available through HealthKit or basic Garmin Connect exports.

---

### Critical power history

```
GET /users/{userId}/cp/history?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```

**Response** (200):
```json
[
  {
    "critical_power": 279.45,
    "created": 1774300800
  }
]
```

Array of CP assessments within the date range, sorted by `created` (Unix epoch).
The most recent entry with `created > 0` is the current authoritative CP value.
Returns an empty array if no CP assessments exist.

---

### Activity map

```
GET /users/{userId}/activities/{activityId}/map?theme=<themeId>&resolution=<WxH>
```

Returns a rendered map image of the activity route. Used by the PowerCenter UI
for calendar thumbnails. The `theme` parameter is a Mapbox style ID.

---

### Workout library

#### List all workouts

```
GET /users/workouts/library?include_content=true
```

**Note**: This is a user-scoped endpoint authenticated by the Bearer token, but
the URL does not include `{userId}`.

**Response** (200):
```json
[
  {
    "library": {
      "id": "EgsKBHVzZXIQ...",
      "title": "default",
      "content": ["collection-id-1", "collection-id-2"]
    },
    "collections": {
      "collection-id-1": {
        "id": "collection-id-1",
        "title": "Self",
        "workouts": ["6297444463181824", "4624974467203072"]
      }
    },
    "workouts": {
      "4624974467203072": {
        "workout": { ... }
      }
    }
  }
]
```

The library contains collections, which contain workout IDs. With
`include_content=true`, full workout objects are nested under `workouts`.

#### Create a workout

```
POST /workouts
Content-Type: application/json

{
  "type": "intervals",
  "title": "VO2max Intervals",
  "desc": "Workout description text",
  "blocks": [ ... ]
}
```

**Response** (200):
```json
{
  "created": 1774775355,
  "created_time": "2026-03-29T09:09:15.343539081Z",
  "updated": 1774775355,
  "updated_time": "2026-03-29T09:09:15.343539081Z",
  "id": 4624974467203072,
  "title": "VO2max Intervals",
  "objective": "",
  "desc": "Workout description text",
  "surface": "track",
  "type": "intervals",
  "tags": null,
  "goal_types": null,
  "notification_text": "",
  "blocks": [ ... ]
}
```

The returned `id` (numeric, int64) is used for scheduling and deletion.

**Additional request fields** (optional, observed in HAR):
- `surface`: e.g. "track", "road", "trail" — terrain tag
- `objective`: text field for workout objective
- `tags`: array of string tags (null if unset)
- `goal_types`: array (null if unset)

#### Delete a workout from the library

```
DELETE /workouts/{workoutId}
```

Returns 200 on success.

#### Add a workout to a collection

```
PATCH /users/workouts/library/{libraryId}/collections/{collectionId}
Content-Type: application/json

{
  "id": "collection-id",
  "title": "Self",
  "workouts": ["6297444463181824", "4624974467203072"]
}
```

The `workouts` array is the full list of workout IDs in the collection (not a
delta). Existing workouts not in the array are removed from the collection.

---

### Workout estimation (preview)

```
POST /users/workouts/estimate
Content-Type: application/json

{ "blocks": [ ... ] }
```

Called live by the PowerCenter UI as the user builds a workout. Returns per-block
stress, duration, distance, and intensity zone distribution estimates.

**Response** (200):
```json
[
  {
    "stress": 6.76,
    "duration": 1200,
    "distance": 2100.0,
    "intensity_zones": [1200, 0, 0, 0, 0],
    "segment_estimates": [
      {
        "stress": 6.76,
        "duration": 1200,
        "distance": 2100.0,
        "intensity_zones": [1200, 0, 0, 0, 0]
      }
    ]
  }
]
```

`intensity_zones` is a 5-element array: seconds spent in each Stryd power zone.
`segment_estimates` breaks down per-segment within a block (useful for
work+rest intervals).

---

### Schedule a workout on the calendar

```
POST /users/{userId}/workouts?id={workoutId}&timestamp={unixEpochMidnight}
```

**No request body.** Parameters are in the query string.

- `id`: Workout ID from the create response
- `timestamp`: Unix epoch of midnight (local time) for the target date

**Response** (200):
```json
{
  "created": 1774775986,
  "created_time": "2026-03-29T09:19:46.331084Z",
  "updated": 1774775986,
  "updated_time": "2026-03-29T09:19:46.331084Z",
  "user_id": "ed01b284-814d-5b95-52a3-c91e9fd5e86c",
  "stress": 23.7,
  "duration": 2100,
  "distance": 3868,
  "intensity_zones": [1380, 0, 0, 720, 0],
  "id": 5712906762485760,
  "id_str": "5712906762485760",
  "activity_id": "",
  "source": "stryd-workout",
  "source_id": "4624974467203072",
  "source_updated_time": "0001-01-01T00:00:00Z",
  "order": 0,
  "deleted": false,
  "date": "2026-03-29T09:00:00Z",
  "workout": { ... },
  "used_for_cp_estimation": false,
  "recommendation_id": null,
  "surface": ""
}
```

Key fields:
- `id`: Calendar entry ID (distinct from the workout ID). Used for deletion.
- `id_str`: String representation of the calendar ID (for JS safety with int64).
- `source_id`: The workout library ID this was scheduled from.
- `stress`, `duration`, `distance`: Stryd's computed estimates for the workout.
- `date`: The scheduled date (note: Stryd may offset from midnight to a
  default start time like 09:00 or 10:00).
- `workout`: Full nested workout object (blocks, segments, etc.).

### Delete a scheduled workout from the calendar

```
DELETE /users/{userId}/workouts/{calendarEntryId}
```

Returns 200 on success. The underlying workout remains in the library.

---

## Workout data model

### Block

A workout consists of an ordered array of **blocks**. Each block has:

```json
{
  "repeat": 5,
  "segments": [ ... ],
  "uuid": "28d68e21-5d43-4b02-90de-47c2192fd5d7"
}
```

- `repeat`: Number of times to execute the segments in sequence. For intervals,
  set `repeat: N` with a work segment and a rest segment.
- `segments`: Ordered array of segments executed per repeat.
- `uuid`: Client-generated UUID (used by the UI for React keys).

### Segment

```json
{
  "desc": "5×2.5min Z4 power",
  "desc_no_cp": "",
  "duration_type": "time",
  "duration_time": { "hour": 0, "minute": 2, "second": 30 },
  "duration_distance": 0,
  "distance_unit_selected": "km",
  "intensity_class": "work",
  "intensity_type": "percentage",
  "intensity_percent": { "value": 98, "min": 90, "max": 105 },
  "flexible": false,
  "incline": 0,
  "grade": 0,
  "pdc_target": 0,
  "rpe_selected": 1,
  "zone_selected": 0,
  "power_type": "",
  "uuid": "02b87ed4-02bf-4ad2-8d94-18ff7c10f48c"
}
```

**Duration fields** (mutually exclusive based on `duration_type`):
- `duration_type: "time"` → use `duration_time` (hour/minute/second object)
- `duration_type: "distance"` → use `duration_distance` + `distance_unit_selected`

**Intensity fields**:
- `intensity_class`: One of `"warmup"`, `"work"`, `"rest"`, `"cooldown"`
- `intensity_type`: `"percentage"` (of CP), `"zone"`, or `"rpe"`
- `intensity_percent`: Power target as percentage of critical power
  - `value`: Centre target
  - `min`: Floor of the target range
  - `max`: Ceiling of the target range
- `zone_selected`: Stryd power zone number (1-5) when `intensity_type: "zone"`
- `rpe_selected`: RPE value (1-10) when `intensity_type: "rpe"`

**Other fields**:
- `flexible`: Whether the segment can be adjusted (observed as always `false`)
- `incline` / `grade`: Treadmill incline settings (0 for outdoor)
- `pdc_target`: Power Duration Curve target (0 for standard workouts)
- `power_type`: Empty string in all observed payloads
- `desc_no_cp`: Description text when CP is not set (fallback)

### Intensity percentage mapping

Stryd's default power zones as percentages of CP:

| Zone | % of CP | Description |
|------|---------|-------------|
| Z1   | 0–80%   | Easy / recovery |
| Z2   | 80–90%  | Endurance |
| Z3   | 90–100% | Tempo |
| Z4   | 100–115% | Threshold / VO2max |
| Z5   | 115%+   | Anaerobic |

**Note**: Stryd's zones differ from our Praescriptor zone model (which uses
Z1=0–55%, Z2=55–75%, Z3=75–90%, Z4=90–105%, Z5=105–120%). When pushing
workouts to Stryd, we use our zone percentages directly in `intensity_percent`
rather than mapping to Stryd zone numbers — the watch displays the raw
watt range regardless.

### Interval example

A 5×2:30 work / 2:00 rest interval block:

```json
{
  "repeat": 5,
  "segments": [
    {
      "duration_type": "time",
      "duration_time": { "hour": 0, "minute": 2, "second": 30 },
      "intensity_class": "work",
      "intensity_type": "percentage",
      "intensity_percent": { "min": 90, "max": 105, "value": 98 }
    },
    {
      "duration_type": "time",
      "duration_time": { "hour": 0, "minute": 2, "second": 0 },
      "intensity_class": "rest",
      "intensity_type": "percentage",
      "intensity_percent": { "min": 0, "max": 55, "value": 28 }
    }
  ]
}
```

The watch executes: work → rest → work → rest → ... (5 cycles).

---

## Third-party integrations (observed)

Stryd's Connected Accounts support importing workouts from:
- **TrainingPeaks** (auto-sync twice daily or manual)
- **Final Surge** (auto-sync twice daily or manual)

Limitations for imported workouts:
- Only power-based structured workouts (not HR-based)
- Maximum 7 days ahead (except Stryd Training Plans)
- No ramped intervals
- Modifications must be made in the source platform

---

## Rate limiting

No explicit rate limit headers observed. The PowerCenter UI does not appear to
implement client-side throttling for workout operations. For bulk FIT downloads
(Vigil backfill), we use a 500ms delay between requests as a courtesy.

---

## Known quirks

1. **Auth header colon**: `Bearer: <token>` not `Bearer <token>`.
2. **Timestamp handling**: Calendar scheduling uses Unix epoch for midnight local
   time, but the response `date` field may show a different time (e.g. 09:00 or
   10:00 UTC) — Stryd applies a default start time.
3. **Workout IDs**: Int64 numeric IDs. The schedule response includes both `id`
   (number) and `id_str` (string) for JavaScript safety.
4. **UUID fields**: The `uuid` field on blocks and segments is client-generated
   and optional for creation — the server does not return them. Used by the
   React UI for component keys.
5. **Sport type**: All running activities in Stryd are stored as sport `"Run"`
   regardless of the actual type (trail run, virtual run, treadmill).
6. **FIT files**: Stored on Google Cloud Storage with signed URLs. The signed URL
   is short-lived (minutes) and requires no auth header.
