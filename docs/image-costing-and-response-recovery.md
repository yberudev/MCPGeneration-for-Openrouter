# Image cost estimates and local response recovery

This document describes the checks performed before image generation and what can be recovered after an HTTP 200 response. It does not authorize a paid request by itself. `allow_paid: true`, local spend limits and the durable reservation are still required.

## Estimate classes

Each image estimate reports its catalog source, observation timestamp (`sourceDate`), confidence, request parameters, assumptions and limitations. `kind` is one of:

- `fixed_price`: a current OpenRouter per-output-image price applies to the selected variant.
- `grounded_estimate`: published billing rules provide a calculated estimate.
- `defensible_upper_bound`: current published rate and quantity ceilings provide a conservative authorization bound.
- `unknown`: required current data is absent or conflicting; `estimateUsd` is `null`.

The estimate is refreshed from public OpenRouter catalog endpoints immediately before a worker reserves the budget for its first POST. A queued job with incomplete or conflicting pricing is blocked while `ALLOW_UNKNOWN_COST=false`. A job that already sent a POST keeps the estimate used for that call; it is not repriced after the response.

## Gemini 3.1 Flash Lite Image

The special case is only `google/gemini-3.1-flash-lite-image`; it does not apply to `google/gemini-3.1-flash-lite` or `google/gemini-3.1-flash-image`. Supported generation is 1K and the OpenRouter image catalog lists `n.max=1`, with at most 14 reference images. Google's exact [Gemini 3.1 Flash Lite Image pricing entry](https://ai.google.dev/gemini-api/docs/pricing.md) sets image output at `$30` per million image tokens and states that a 1K image uses 1,120 tokens, or `$0.0336` per image. OpenRouter's current [model endpoint metadata](https://openrouter.ai/google/gemini-3.1-flash-lite-image/endpoints) supplies input/output token rates, context length, max completion tokens, and image-output token rate. The estimator requires those live OpenRouter fields plus the Google-documented 1K token quantity; otherwise it returns `unknown`.

The current conservative per-image reserve is:

```text
(context_length × input_token_rate)
+ (max_completion_tokens × text_output_token_rate)
+ (1,120 image_tokens × image_output_token_rate)
```

Using the live values checked on 2026-10-23:

```text
(65,536 × $0.00000025) + (58,982 × $0.0000015) + (1,120 × $0.00003)
= $0.138457 per 1K output image
```

This deliberately reserves the full published input context (including prompt and reference images), the full published completion ceiling, and the image tokens separately. It is a conservative local authorization bound, not an OpenRouter price guarantee. Google publishes the 1K image amount and price, but no separate Lite image-token schedule by aspect ratio; the estimator applies the published per-1K price to ratios accepted by the live OpenRouter model catalog and invents no higher-resolution amount. A variation count multiplies the bound, and the live catalog's `n.max=1` is enforced. If the endpoint stops publishing any required rate/limit, the estimate becomes unknown and `ALLOW_UNKNOWN_COST=false` blocks it.

## FLUX 3 Image

The [OpenRouter model endpoint metadata for FLUX 3 Image](https://openrouter.ai/black-forest-labs/flux-3-image/endpoints) publishes per-output-image `variant` prices; the [BFL pricing page](https://bfl.ai/pricing) provides the provider's resolution calculator. The estimator selects the exact requested OpenRouter variant, multiplies by output count and, if providers report inconsistent current prices for that same variant, reserves the highest. When the request omits resolution, it uses the highest currently published variant as an upper bound.

| Resolution | OpenRouter / BFL reference price per output |
| --- | ---: |
| 768 | $0.041 |
| 1K | $0.048 |
| 1.5K | $0.070 |
| 2K | $0.100 |
| 4K | $0.607 |

BFL states that the same resolution-based output charge applies to text-to-image and image-to-image, and reference images do not add an output-image fee. Current OpenRouter data is required for authorization; if the selected variant is missing, the price is unknown and the request is blocked under the current policy.

## Limits and actual cost

`MAX_COST_PER_REQUEST_USD`, `MAX_TOTAL_SPEND_USD` and `max_cost_usd` are local authorization controls. They are not hard caps enforced by the supplier. OpenRouter may report an actual cost above the estimate; the worker records that actual cost from the response without changing the original estimate or silently discarding the charge. If actual cost is absent, it remains unknown (`null`), not zero. The current project configuration remains `ALLOW_UNKNOWN_COST=false`; no spend limit is changed by this implementation.

## HTTP 200 response preservation

After receiving a successful HTTP status, the OpenRouter client reads the response under `MAX_HTTP_RESPONSE_BYTES`. Before JSON or image interpretation, the worker inserts the full bytes into the private SQLite `image_job_raw_responses` table in a durable transaction and records its SHA-256, length, MIME and safe structural metadata. The default aggregate raw-response quota is 512 MiB. A response that cannot fit the quota is not parsed or delivered, its financial outcome remains conservative, and the paid POST is never repeated.

Only after parsed images and output hashes have been committed does the worker clear the raw BLOB atomically. If parsing, MIME/signature validation or local persistence fails, the response bytes and any known provider cost remain available for inspection. A hash and byte-length check runs before recovery. No age-based deletion is performed for failed responses. On a later worker start or explicit `recover_image_job_response`, the worker can parse/deliver the preserved bytes without a network POST. This tool cannot recover an old response that the previous version never stored.

Job status exposes only allowlisted response metadata: status, MIME type, hash, byte length, parsing state, data-array shape/count, item field names/types/encoded lengths, and a recognized usage cost. It never exposes raw response content, base64, prompts or keys. SQLite files are private (directory mode `0700`, DB/WAL/SHM mode `0600`); backups must be kept private because they can include prompts and image data.

The older FLUX incident `6b3e4e37-e038-4422-bfee-de93aadc43f7` predates response-body preservation. Its local record retains HTTP 200 and `$0.10`, with no stored outputs or raw response. The old `outputCount=0` records the old worker's persisted result after its exception path; it does not establish what the original HTTP response contained. There is no local body available for parser recovery. The record, reservation and charge remain unchanged, and no repeat request is made.

The OpenRouter [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation) and [generation content](https://openrouter.ai/docs/api/api-reference/generations/list-generation-content) endpoints do not promise that the original binary image body from synchronous `/images` calls can be recovered. Treat uncertain POSTs without a locally preserved body as potentially irrecoverable.
