# Research artefacts — cross-training muscle-group awareness (2026-05-12)

Working files for the research that produced
`phase2/cross-training-muscle-group-research-2026-05-12.md` (the decision document).

Read the decision document first. This directory holds the raw inputs and the
analysis script in case the data needs to be re-run or extended.

## Files

| File | What |
|---|---|
| `research-promus-sessions.json` | All Promus strength sessions for the user, 2026-02-12 → 2026-05-13 (90 days). `GET /api/strength-sessions?serial=palaestra-ios`. Raw `StrengthSessionRow[]` with `sets: StrengthSetRow[]`. |
| `research-iv-activities.json` | All intervals.icu activities, 2026-03-13 → 2026-05-13 (60 days). Raw activity records. |
| `research-iv-wellness.json` | intervals.icu wellness records over the same 60-day window. CTL / ATL / sleep / HRV per day. |
| `research-data-summary.md` | Narrative summary: exercise vocabulary, cadence, engine-fire counterfactual. |
| `research-correlation.md` | Cross-correlation table — Palaestra strength session ↔ intervals.icu WeightTraining activity. |
| `research_analyse.py` | Python script that produced the summary. Re-runnable against the JSON files. stdlib only. |
| `research-analyse-output.txt` | Captured stdout from the script. |

## To re-run the data pull

The endpoints + auth pattern are documented in the decision doc and in the
`reference-promus-strength-sessions` auto-memory. Two-line repro:

```bash
KEY=$(grep '^promus-api=' .env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $KEY" \
  "https://promus.tail7ab379.ts.net/api/strength-sessions?serial=palaestra-ios&since=2026-02-12&until=2026-05-13&limit=200" \
  > research-promus-sessions.json
```

intervals.icu activities + wellness use the standard `INTERVALS_ICU_API_KEY` Basic auth
against `https://intervals.icu/api/v1/athlete/0/{activities,wellness}` with `oldest=`/`newest=` query params.

## Cross-references

- Decision document: `../cross-training-muscle-group-research-2026-05-12.md`
- Issue tracking: [exercitator#33](https://github.com/zestuart/exercitator/issues/33), [promus#97](https://github.com/zestuart/promus/issues/97)
- Forward workstream: weight-lifting prescription generation — see auto-memory `project-lifting-prescription`
