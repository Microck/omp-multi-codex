# omp-multi-codex

An OMP extension that adds a separate `maisa-codex` provider for a second ChatGPT Codex subscription. Its OAuth credential and refresh lifecycle are stored under `maisa-codex`; the built-in `openai-codex` provider is not modified.

## Requirements

- OMP v18.8.0 or newer. The extension uses OMP's runtime `registerProvider` OAuth API and the Codex Responses transport.
- A ChatGPT account that can use Codex.

## Install

In OMP, run:

```text
/marketplace add Microck/omp-multi-codex
/marketplace install omp-multi-codex@omp-multi-codex
```

Restart OMP, then authenticate the Maisa account:

```text
/login maisa-codex
```

OMP shows a device URL and one-time code. Open the URL, sign in as the intended account, and enter the code. The login flow does not switch or overwrite the `openai-codex` account.

Select a model from the new provider with `/model`. After login, choose a model shown in Maisa Codex's discovered catalog. Before login, only the known fallback model may appear.

The extension uses the same Codex Responses API and OAuth refresh endpoint as OMP's built-in Codex provider. It fetches the account's available model catalog and falls back to a known model if discovery is unavailable. OMP refreshes OAuth credentials and model catalogs through its normal mechanisms; installing new plugin releases remains a manual marketplace update.

## Security and scope

- OAuth access and refresh tokens are stored by OMP in its credential database under the distinct provider ID `maisa-codex`.
- The plugin does not read `~/.codex/auth.json`, `codex-auth` account storage, or the built-in `openai-codex` credential.
- Login uses the official OpenAI device authorization and token endpoints. It requests no API key and logs no token values.
- The public client ID is the same client ID used by OMP's built-in Codex OAuth integration. No client secret is embedded.
- This is an independent community extension, not an official OpenAI product.

## Updating

Provider model discovery refreshes through OMP's normal model cache. OAuth refresh is handled by OMP when the stored access token expires. Update the plugin from its marketplace when a release is published:

```text
/marketplace update omp-multi-codex
/marketplace upgrade omp-multi-codex@omp-multi-codex
```

## Development

The extension is `index.js`. To load it for one command without installing it:

```bash
omp models --extension ./index.js
```

Before publishing changes, test model discovery and the OAuth flow with a separate test account. Do not include credentials, device codes, or account tokens in issues or logs.

## License

MIT. See [LICENSE](./LICENSE).
