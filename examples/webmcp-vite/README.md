# Vite integration reference

1. Install `@catchfly/sdk` in the WebMCP app.
2. Copy `.env.example` to `.env.local` and use the values shown by Catchfly onboarding.
3. Import `src/catchfly.ts` before the app registers any WebMCP tools.
4. Open the app in a WebMCP-capable browser and invoke a tool. Onboarding completes only after
   Catchfly can read the first session, so an accepted-but-incomplete event cannot produce a false
   success screen.

After turning a real failure into a reviewed case, pull the current suite and run it:

```bash
npx @catchfly/cli eval pull evals.json \
  --endpoint "$CATCHFLY_ENDPOINT" \
  --project "$CATCHFLY_PROJECT" \
  --key "$CATCHFLY_EVAL_KEY" \
  --force

npx @catchfly/cli eval run \
  --url http://localhost:5173 \
  --evals evals.json \
  --endpoint "$CATCHFLY_ENDPOINT" \
  --project "$CATCHFLY_PROJECT" \
  --version "$GIT_SHA" \
  --key "$CATCHFLY_EVAL_KEY"
```

The ingest key belongs in the browser and can only write telemetry. Keep the eval key in CI; it
can create runs and pull reviewed cases.
