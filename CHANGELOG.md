# Changelog

## 0.1.1

- Published from GitHub Actions with npm provenance. No change to the node.

## 0.1.0

First release.

- Image, Video and Audio > Generate: model picker with prices, prompt, media inputs from binary data or URLs (uploaded automatically), a parameter form generated from each model's schema, and a JSON box for anything else.
- Price check before every item, with a per-item limit (default $2) that stops before anything is charged.
- Deterministic Idempotency-Key per execution, node, item and input, so retries never create a second task.
- Waiting for results with backoff, optional download of results as binary data.
- Task > Get, File > Upload, Model > Get / Get Many / Get Quote, Account > Get Balance and Chat > Message a Model.
- Workflow templates in `examples/` that use only built-in nodes, for n8n Cloud.
