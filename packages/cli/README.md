# `@catchfly/cli`

Pull reviewed cases created from real traces into the repository:

```bash
npx @catchfly/cli eval pull evals.json \
  --endpoint https://catchfly.example.com \
  --project my-app \
  --key "$CATCHFLY_EVAL_KEY"
```

The command refuses to replace an existing file unless `--force` is passed. The output is a Chrome
WebMCP Evals-compatible suite, so a failure reviewed in Catchfly can become versioned regression
coverage in the same workflow.

Run that WebMCP eval suite and send the result to Catchfly:

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
