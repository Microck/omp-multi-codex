# OMP Multi Codex

An OMP extension that adds a separately authenticated ChatGPT Codex account under a provider ID you choose. It leaves OMP's built-in `openai-codex` provider and credentials unchanged.

## Requirements

- OMP v18.8.0 or newer.
- A ChatGPT account with Codex access.

## Install

In OMP, add and install the marketplace plugin:

```text
/marketplace add Microck/omp-multi-codex
/marketplace install omp-multi-codex@omp-multi-codex
```

The provider ID defaults to `codex-secondary`. To choose another ID, set `OMP_MULTI_CODEX_PROVIDER_ID` in the environment before starting OMP. For example:

```bash
OMP_MULTI_CODEX_PROVIDER_ID=codex-work omp
```

Keep the same provider ID for later OMP sessions. OMP stores the OAuth credentials under that ID. Changing it creates a new credential namespace; authenticate again with the new ID. The old credential is not deleted.

Restart OMP after installation, then sign in to the ChatGPT account you want associated with that provider ID:

```text
/login codex-secondary
```

If you chose another ID, use it in place of `codex-secondary`. OMP opens the normal ChatGPT OAuth sign-in page. Complete sign-in in your browser. When it redirects to `localhost`, copy the full callback URL from the address bar and paste it into OMP's authorization-code prompt. This manual callback flow also works when OMP runs on a remote host, without a tunnel.

Choose a model from the provider with `/model`. The provider fetches that account's model catalog and uses a known fallback model if discovery is unavailable.

## Updates

OMP refreshes OAuth credentials when needed and refreshes model catalogs through its normal mechanisms. Plugin releases are updated separately through the marketplace:

```text
/marketplace update omp-multi-codex
/marketplace upgrade omp-multi-codex@omp-multi-codex
```

## Security and scope

- OAuth access and refresh tokens are stored by OMP under the configured provider ID.
- The plugin does not read `~/.codex/auth.json`, `codex-auth` account storage, or the built-in `openai-codex` credential.
- Login uses OpenAI's browser OAuth and token endpoints with PKCE. It requests no API key and does not log token values.
- This is an independent community extension, not an official OpenAI product.

## Development

The extension entry point is `index.js`. Load it for a single command without installing it:

```bash
OMP_MULTI_CODEX_PROVIDER_ID=codex-work omp models codex-work -e ./index.js
```

Before publishing changes, test model discovery and the OAuth flow with a separate test account. Do not include credentials, device codes, or account tokens in issues or logs.

## License

MIT. See [LICENSE](./LICENSE).
