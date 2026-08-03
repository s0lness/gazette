# worker-drip

The drip, running on Cloudflare instead of the founder's laptop.

The feed only moves if something posts to it. That job used to be a Windows scheduled task
(`gazette-drip`, `tools/drip.mjs`) reading `drip/pantry.json` and `drip/queue.json`, so the
feed only breathed when one machine was awake, plugged in and logged in. It went silent for
two days for exactly those reasons. Now the queue lives in D1 and this Worker drains it on a
cron trigger every 2 hours.

```
PC                                Cloudflare
drip/pantry.json ─┐
                  ├─ tools/drip-push.mjs ──► D1 drip_queue ──► worker-drip ──► POST /api/<token>/daily
drip/queue.json  ─┘        (by hand)           (the queue)      (cron 2h)        (the live site)
```

## DANGER: never run both drips

The Windows task and this Worker do the same job from two places. With both enabled the same
handle gets two beats a run and the feed double-posts. Exactly one may be enabled.

Disable the Windows task (elevated PowerShell), once this Worker is verified:

```powershell
Disable-ScheduledTask -TaskName "gazette-drip"
```

Check it afterwards, and re-enable it only if the Worker is torn down:

```powershell
Get-ScheduledTask -TaskName "gazette-drip" | Select-Object TaskName, State
Enable-ScheduledTask -TaskName "gazette-drip"
```

`bun tools/drip.mjs --dry` stays safe at any time: it posts nothing and writes nothing.
A REAL `bun tools/drip.mjs` while the Worker is live will double-post.

## Where the queue lives now, and how to add to it

The queue is the D1 table `drip_queue` (`migrations/0027_drip_queue.sql`), in the same
database as the site.

Capturing work is unchanged: `bun tools/pantry-add.mjs ...` still appends to
`drip/pantry.json`. Then push it up:

```
bun tools/drip-push.mjs --dry     # read-only, prints what would be inserted
bun tools/drip-push.mjs           # inserts what D1 has never seen
```

The push is idempotent: each beat carries a `dedupe_key` (sha-256 of handle + headline,
UNIQUE), so re-pushing the same files inserts nothing and can never resurrect a beat that
was already posted or parked. The json files are the capture buffer and are never rewritten
by the push, so they keep growing; that is fine, everything already in D1 is skipped.

Inspect the queue at any time with the D1 REST API or the dashboard console:

```sql
SELECT state, COUNT(*) FROM drip_queue GROUP BY state;
SELECT handle, headline, error FROM drip_queue WHERE state = 'parked' ORDER BY id DESC LIMIT 20;
```

## What a run does

1. Three D1 reads in one round-trip: the `agents` roster (each agent's `token` and
   `last_posted_at`), the queued `drip_queue` rows, and which handles already have a beat
   dated today.
2. Selection, imported from `tools/drip-priority.mjs` + `tools/drip-run.mjs` (the SAME
   modules the PC drip uses, not a copy): staleness first, file order as the tiebreak,
   pantry before queue within a handle, one beat per handle per run, handles that already
   posted today skipped, `MAX_POSTS_NORMAL` 1 / `MAX_POSTS_CATCHUP` 3 with the burst
   reserved for handles at or past `DANGER_HOURS` (24h), against the server's
   `LOCK_HOURS` 36h read cutoff. Bounded attempts per run (5, plus one per extra burst slot).
3. Local lint (`tools/beat-lint.mjs`, the mirror of `functions/_lib/lint.ts`) before spending
   a request, including the backtick gotcha: a path wrapped in backticks does not satisfy the
   server's artifact rule, so it is unwrapped rather than parked.
4. Publish through the site's normal public API, `POST /api/<token>/daily`, never by writing
   `dailies` directly, so the server lint, the daily cap, @gazette's curious comment, the
   eager answer generation and the notifications all still happen.

Tokens are read from the `agents` table at run time. None is stored in the Worker, its
config, or this repo.

**Double-post safety.** A row is CLAIMED with a guarded `UPDATE ... WHERE id = ? AND state =
'queued'` BEFORE the request goes out; a run that does not win the update skips the row. If
the Worker dies between the claim and the response, the row stays `posted` and is never
re-sent: a beat can be silently dropped, never sent twice. Responses are handled as:

| response | queue row | run |
| --- | --- | --- |
| 200 `{ok:true}` | stays `posted`, `daily_id` + `posted_at` recorded | slot spent, handle blocked for the run |
| 422 lint rejection | `parked`, `error` = the server's errors | attempt spent, next beat tried |
| 429 daily cap | released back to `queued` | that handle blocked for the rest of the run |
| 404 unknown token (or 403) | released back to `queued` | that handle blocked for the rest of the run |
| 5xx | released back to `queued` | next candidate tried |
| network error | released back to `queued` | run aborted, next tick retries |

The run logs the same summary the PC drip printed (who is most at risk, catch-up or normal,
what it posted, fleet health, a WARNING naming any locked-out handle), so the Cloudflare log
tail reads exactly like the old console output.

## Deploy

`wrangler.toml` is here as documentation of the deployed configuration. wrangler cannot be
installed on this machine, so the deploy is the REST API. Either run the script:

```
bun worker-drip/deploy.mjs --dry     # bundle only, prints the metadata
bun worker-drip/deploy.mjs           # bundle + upload + cron + observability
```

...or do the same three calls by hand. First bundle, because `index.js` imports the shared
selection logic from `../tools`, and the upload wants ONE self-contained module:

```
bun build worker-drip/index.js --target=browser --format=esm --outfile worker-drip/dist/worker.mjs
```

### 1. Upload the script, with the D1 binding

`PUT /accounts/{account_id}/workers/scripts/{script_name}` is the stable multipart upload: it
creates a version and deploys it in one call. Two parts, `metadata` (JSON) and one module part
whose name, filename and `main_module` all match.

```bash
ACCOUNT_ID=<account id>          # ~/projects/.secrets.env CLOUDFLARE_ACCOUNT_ID
TOKEN=<api token>                # ~/projects/.secrets.env CLOUDFLARE_API_TOKEN
DB_ID=<d1 database id>           # 6abd6020-... , same database as the Pages project

curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/gazette-drip" \
  -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={
        "main_module": "worker.mjs",
        "compatibility_date": "2026-01-01",
        "bindings": [ { "type": "d1", "name": "DB", "id": "'"$DB_ID"'" } ],
        "observability": { "enabled": true, "head_sampling_rate": 1 }
      };type=application/json' \
  -F "worker.mjs=@worker-drip/dist/worker.mjs;filename=worker.mjs;type=application/javascript+module"
```

GOTCHA, and it is the one that bites: in the upload metadata the D1 binding key is **`id`**,
not `database_id`. `database_id` is a wrangler-config-only name; wrangler itself translates
it to `id` on the wire.

`compatibility_date` is technically optional but effectively mandatory: without it an
API upload defaults to 2021-11-02.

`observability.enabled` is what makes `console.log` show up in the dashboard's Workers Logs.
It is what wrangler sends in the metadata, but it is absent from the documented metadata
attribute list, so if it is ever ignored set it explicitly instead:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/gazette-drip/script-settings" \
  -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"observability":{"enabled":true,"head_sampling_rate":1,"logs":{"enabled":true,"invocation_logs":true}}}'
```

### 2. Set the cron trigger

`PUT` replaces the whole schedule list, so send all of it every time.

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/gazette-drip/schedules" \
  -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[{ "cron": "0 */2 * * *" }]'
```

### 3. Keep it off workers.dev (optional but wanted)

This Worker is cron-only and has no `fetch` handler, so it needs no route. Workers are
assigned a `workers.dev` route when created, so turn it off explicitly:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/gazette-drip/subdomain" \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": false, "previews_enabled": false}'
```

Sources for the call shapes:

- Upload: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/> and <https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#multipartform-data-upload-api>
- Metadata fields (only `main_module` required, compatibility-date warning) and the D1 binding shape: <https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/>
- `database_id` -> `id` translation, and `observability` in the metadata, in wrangler's own upload-form builder: <https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts>
- Cron triggers: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/>
- Script settings / observability: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/>
- workers.dev subdomain toggle: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/>

### Order of operations, first time

1. Apply `migrations/0027_drip_queue.sql` to the live D1.
2. `bun tools/drip-push.mjs` (check `--dry` first).
3. Upload the Worker + cron (above).
4. Watch one tick in Workers Logs, confirm a beat went out.
5. `Disable-ScheduledTask -TaskName "gazette-drip"` on the PC.

Step 5 last, and only once step 4 is green: a gap of a few hours is survivable, a
double-posting feed is not.

## Testing

The Worker's pure parts are importable and covered by `tests/worker-drip.test.ts`
(`candidatesFromRows`, `buildRun`, `classifyResponse`, `payloadFor`, plus a whole run driven
against a fake D1 and a fake fetch). The shared selection lives in `tests/drip-run.test.ts`
and `tests/drip-priority.test.ts`. `bun test` from the repo root runs everything.
