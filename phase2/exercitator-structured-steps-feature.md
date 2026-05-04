# Exercitator: Structured Workout Steps in `create_event`

**Date:** 2026-03-23
**Priority:** Low
**Status:** Backlog

## Problem

When `create_event` creates a WORKOUT event with only a `description` field, Intervals.icu wraps it in a `workout_doc` with an empty `steps: []` array. This causes Suunto workout sync to fail:

```
400 Bad Request: Invalid 'guide.steps': collection has less items than the allowed minimum (1)
```

The workout appears correctly on the Intervals.icu calendar but cannot be pushed to connected platforms (Suunto, Garmin) that require structured step data.

## Current Behaviour

```json
"workout_doc": {
  "steps": [],
  "duration": 0,
  "distance": 0,
  "description": "Warm-up: 5 min walk → ..."
}
```

Suunto rejects this. Garmin upload is also disabled (`icu_garmin_upload_workouts: false`) but would likely have the same issue if enabled.

## Proposed Enhancement

Add an optional `steps` parameter to `create_event` that accepts structured workout steps in Intervals.icu workout doc format. Example schema:

```json
{
  "steps": [
    {
      "type": "warmup",
      "duration": 600,
      "power": { "min": 0, "max": 160, "units": "w" },
      "cadence": { "min": 0, "max": 82 }
    },
    {
      "type": "interval",
      "duration": 1800,
      "power": { "min": 160, "max": 219, "units": "w" },
      "hr": { "max": 145 },
      "cadence": { "min": 78, "max": 82 }
    },
    {
      "type": "cooldown",
      "duration": 600,
      "power": { "min": 0, "max": 160, "units": "w" }
    }
  ]
}
```

When `steps` is provided, the connector should build the full `workout_doc` before POSTing to the Intervals.icu API. When omitted, current behaviour (description-only) is preserved.

## References

- Intervals.icu workout doc format: see API docs or inspect any structured workout event via `GET /api/v1/athlete/{id}/events/{eventId}`
- Suunto guide step requirements: minimum 1 step with type and duration
- Observed push error from `list_events` response on event id `100337651`

## Impact

Without this, workouts created via Exercitator are calendar-only — they won't sync to watch platforms. For the current use case (Claude-prescribed workouts pushed to Intervals.icu), this means manual recreation on the watch or in the Intervals.icu UI to get structured steps.
