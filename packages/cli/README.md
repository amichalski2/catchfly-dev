# `@catchfly/cli`

Run a WebMCP eval suite and send the result to Catchfly:

```bash
npx @catchfly/cli eval run \
  --url https://my-app.example.com \
  --evals evals.json \
  --endpoint https://catchfly.example.com \
  --project my-app \
  --version "$GIT_SHA" \
  --key "$CATCHFLY_EVAL_KEY"
```

The command delegates the browser run to `webmcp-evals`, then uploads the new
JSON report. Use `--model <model>` to select a model and
`--min-success-rate 0.9` to turn the run into a CI quality gate.

To upload a report produced elsewhere:

```bash
npx @catchfly/cli eval upload .evals/report.json \
  --endpoint https://catchfly.example.com \
  --project my-app \
  --version "$GIT_SHA" \
  --key "$CATCHFLY_EVAL_KEY"
```
