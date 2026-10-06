# SpicyAPI node for n8n

[n8n](https://n8n.io) community node for [SpicyAPI (spicyapi.ai)](https://spicyapi.ai): 200+ image, video, audio and chat models behind one API, with a price check before every paid run.

This package is published by SpicyAPI (spicyapi.ai) and talks only to `api.spicyapi.ai`. Other packages with similar names belong to unrelated services.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Generating images, video and audio](#generating-images-video-and-audio)
- [Cost control and retries](#cost-control-and-retries)
- [Long-running tasks](#long-running-tasks)
- [Chat](#chat)
- [n8n Cloud: workflow templates](#n8n-cloud-workflow-templates)
- [Compatibility](#compatibility)
- [Development](#development)

## Installation

Community nodes that are not verified by n8n can be installed on **self-hosted** n8n.

1. Go to **Settings > Community Nodes** and select **Install**.
2. Enter `@spicyapi/n8n-nodes-spicyapi` and confirm.

For queue mode or manual installs, run `npm install @spicyapi/n8n-nodes-spicyapi` in `~/.n8n/nodes` and restart n8n. See the [n8n guide](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

On n8n Cloud, use the [workflow templates](#n8n-cloud-workflow-templates) instead: they call the same API with the built-in HTTP Request node.

## Credentials

Create a **SpicyAPI (spicyapi.ai) API** credential:

| Field | Value |
| --- | --- |
| API Key | A key from [spicyapi.ai/console/keys](https://spicyapi.ai/console/keys). It starts with `sk-spicy-`. |
| Base URL | Leave `https://api.spicyapi.ai` unless support tells you otherwise. |

Saving the credential checks it against your account balance. Consider giving the key used by n8n its own daily or monthly spending cap in the console: automations can run far more often than a person clicks.

## Operations

| Resource | Operation | What it does |
| --- | --- | --- |
| Image | Generate | Text to image, image editing, upscaling, background removal and other image models |
| Video | Generate | Text to video, image to video and other video models |
| Audio | Generate | Text to speech, music, transcription and other audio models |
| Task | Get | Read a task by ID, optionally wait for it and download its files |
| File | Upload | Upload a binary file and get a `spicy://` URI to use as model input |
| Model | Get Many | The model catalogue with prices, filtered by modality and keyword |
| Model | Get | One model with its input schema and examples |
| Model | Get Quote | The exact price of a request, without running it |
| Account | Get Balance | Available, held and total balance in US dollars |
| Chat | Message a Model | One chat completion from a text model |

## Generating images, video and audio

1. **Model**: pick from the list (it shows the models of the selected resource with their starting price) or enter a model ID such as `alibaba/z-image-turbo/text-to-image`. Every model and its parameters are listed at [spicyapi.ai/models](https://spicyapi.ai/models).
2. **Prompt**: the model's main text input. For speech models this is the text to speak. Leave it empty for models without a prompt, such as upscalers.
3. **Media Inputs**: images, videos or audio the model reads. Pick the field (the list shows the selected model's file inputs), then either a binary field from the previous node or a URL. Binary files are uploaded to SpicyAPI automatically. Add several inputs for the same field to fill list fields such as reference images.
4. **Model Parameters**: a form generated from the selected model's schema (aspect ratio, resolution, duration, seed and so on). Fields left empty are not sent, so the model uses its own default. Less common fields can be added from the parameter list.
5. **Additional Parameters (JSON)**: any other input fields as a JSON object. They override the fields above.

The result contains the task record (`taskId`, `state`, `cost`, `settled`, `output`) and, with **Download Output** on (the default), the files as binary data in `data`, `data_1` and so on. Result links in `output.assets[].url` expire after about 20 minutes; the binary copies do not.

Large videos are held in memory unless n8n stores binary data on disk. On self-hosted n8n, set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` when you work with video.

## Cost control and retries

- **Every item is priced first.** The node asks for a quote, and when the quote is above **Max Cost per Item (USD)** (default $2) it stops with an error before anything is created. Nothing is charged in that case. Set the limit to 0 to remove it.
- **The task is created with the quoted price.** If the price changes between the quote and the submission, the node quotes again, checks the limit again and resubmits.
- **Retries do not charge twice.** Each item is sent with an `Idempotency-Key` derived from the execution, the node, the item and its input. When n8n retries the node (Retry On Fail) or a request times out and is resent, SpicyAPI returns the task it already created instead of creating a second one. A new execution, a changed input or another loop pass is new work and gets a new key.
- **Failures are normally free.** Failed and expired tasks release their hold. A model that declines a request reports `content_rejected`; it is not charged unless the model page says refusals are billed.

## Long-running tasks

By default the node waits for the result: image and audio models usually answer within one request, video is polled with backoff until the task's own deadline. You can set **Max Wait Time** to stop earlier. When the node stops waiting, the task keeps running and is charged if it succeeds, so fetch it later with **Task > Get** instead of submitting it again.

For long videos you can avoid holding an execution open:

- Turn off **Wait for Completion**, then use a **Wait** node and **Task > Get** (with **Wait for Completion** on, or in a loop).
- Or set **Callback URL** to `{{ $execution.resumeUrl }}` and follow with a **Wait** node set to resume on a webhook call. Your n8n instance must be reachable over public HTTPS. After it resumes, read the task with **Task > Get** rather than trusting the callback body.

## Chat

**Chat > Message a Model** sends one non-streaming chat completion and returns the answer as `text`, with `usage` and the `taskId` of the call. Use **Additional Body Fields (JSON)** for a whole conversation (`messages`), tools or other OpenAI-compatible fields.

For AI Agent workflows you can also use n8n's built-in OpenAI nodes: create an **OpenAI** credential with your SpicyAPI key and set its **Base URL** to `https://api.spicyapi.ai/v1`. The model list then shows every SpicyAPI model; pick a text model (their IDs end in `/chat`). If a request fails with the Responses API, turn off **Use Responses API** in the OpenAI Chat Model node.

## n8n Cloud: workflow templates

n8n Cloud can only install verified community nodes. The [`examples`](examples) folder has workflows that use only built-in nodes:

| File | What it does |
| --- | --- |
| [`http-request-image.json`](examples/http-request-image.json) | Quote, check a price limit, create a task, poll until it finishes and download the image |
| [`http-request-chat.json`](examples/http-request-chat.json) | One chat completion through the OpenAI-compatible endpoint |

Import a file with **Workflow menu > Import from File**, create a **Bearer Auth** credential with your SpicyAPI key as the token, and select it in the HTTP Request nodes.

## Compatibility

Tested with n8n 2.42 (self-hosted) on Node.js 24. The package has no runtime dependencies and follows the n8n community node lint rules.

Use of the models is subject to the [SpicyAPI terms](https://spicyapi.ai/legal/terms) and to the terms of the n8n edition you run.

## Development

```bash
npm ci --ignore-scripts
npm run lint      # n8n community node rules
npm test          # builds, then runs the unit tests in test/
npm run dev       # starts n8n with this node and rebuilds on change
```

Releases are published from GitHub Actions with npm provenance when a `vX.Y.Z` tag is pushed (see [`.github/workflows/publish.yml`](.github/workflows/publish.yml)).

## License

[MIT](LICENSE)
