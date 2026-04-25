<a id="readme-top"></a>

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![project_license][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/TicketsBot-cloud">
    <img src="https://tickets.bot/assets/img/logo-trans-black.png" alt="Logo" width="128" height="128">
  </a>

<h3 align="center">Tickets Bot - Integrations</h3>

  <p align="center">
    Cloudflare Workers powering public integrations for Tickets — the simple, customisable and powerful Discord ticket system.
    <br />
    <a href="https://docs.tickets.bot"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://tickets.bot">View Hosted Version</a>
    &middot;
    <a href="https://ticketsv2.atlassian.net/jira/software/c/projects/RM/boards/3">View Roadmap</a>
    &middot;
    <a href="https://discord.com/channels/1071167333265047653/1326292607432921090">Get Support</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#integrations">Integrations</a></li>
      </ul>
    </li>
    <li><a href="#deploying">Deploying</a></li>
    <li><a href="#adding-a-new-integration">Adding a new integration</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

This repository contains the Cloudflare Workers that power Tickets' public integrations. Each folder is an independent Worker with its own `wrangler.toml` and `package.json`, deployed via a shared GitHub Actions workflow.

The `proxy` Worker sits in front of the others: callers authenticate against the proxy once, and the proxy forwards matching requests to sibling Workers via service bindings so traffic stays on Cloudflare's network rather than egressing via the public internet.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Cloudflare Workers][Workers]][Workers-url]
* [![JavaScript][JavaScript]][JavaScript-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Integrations

| Folder | Purpose |
|--------|---------|
| [`proxy/`](./proxy) | Shared auth gate and router. Forwards requests for known hosts to sibling Workers via service bindings; everything else falls through to a public `fetch()`. |
| [`fivem/`](./fivem) | Resolves a Discord user to a player on a guild's FiveM server, with a KV-backed cache. |
| [`bloxlink/`](./bloxlink) | Resolves a Discord user to their linked Roblox account via Bloxlink, with a KV-backed cache. |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DEPLOYING -->
## Deploying

Pushes to `main` trigger [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml), which:

1. Discovers every folder containing a `wrangler.toml`.
2. Runs `npm install` and `wrangler deploy` for each in parallel.

New integrations are picked up automatically — no workflow edits needed.

**Required repository secrets:**

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | API token scoped to `Workers Scripts: Edit`, `Workers KV Storage: Edit`, `Workers Observability: Edit`, `Account Settings: Read`, `User Details: Read`. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the Workers. |

**Per-Worker secrets** (set via `wrangler secret put <NAME>` from inside the folder):

| Worker | Secret | Purpose |
|--------|--------|---------|
| `proxy` | `PROXY_AUTH_HEADER` | Header name callers send the auth token in. |
| `proxy` | `PROXY_AUTH_KEY` | Shared token expected in that header. |
| `fivem` | `FIVEM_AUTH_KEY` | Static guard token; callers must send this in the `Authorization` header. |
| `bloxlink` | `BLOXLINK_AUTH_KEY` | Static guard token; callers must send this in the `Authorization` header. |

`SENTRY_DSN` for each Worker is configured in its `wrangler.toml` under `[vars]`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ADDING -->
## Adding a new integration

Before writing any code, read [`INTEGRATION_STANDARDS.md`](./INTEGRATION_STANDARDS.md) — it defines what every Worker in this repo must implement.

1. Create a new folder at the repository root (e.g. `myservice/`).
2. Add `index.js`, `wrangler.toml`, and `package.json`.
3. Commit and push to `main` — the deploy workflow auto-discovers the new folder.
4. If the Worker should be reachable via the `proxy`, add an entry to `SERVICE_BINDINGS` in `proxy/index.js` and a matching `[[services]]` block in `proxy/wrangler.toml`, then redeploy the proxy (service bindings require the target Worker to already exist).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Top contributors

<a href="https://github.com/TicketsBot-cloud/integrations/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=TicketsBot-cloud/integrations" alt="contrib.rocks image" />
</a>

<!-- LICENSE -->
## License

Distributed under the MIT license. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [TicketsBot.net](https://ticketsbot.net) For creating the original Tickets Bot

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/TicketsBot-cloud/integrations.svg?style=for-the-badge
[contributors-url]: https://github.com/TicketsBot-cloud/integrations/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/TicketsBot-cloud/integrations.svg?style=for-the-badge
[forks-url]: https://github.com/TicketsBot-cloud/integrations/network/members
[stars-shield]: https://img.shields.io/github/stars/TicketsBot-cloud/integrations.svg?style=for-the-badge
[stars-url]: https://github.com/TicketsBot-cloud/integrations/stargazers
[issues-shield]: https://img.shields.io/github/issues/TicketsBot-cloud/integrations.svg?style=for-the-badge
[issues-url]: https://github.com/TicketsBot-cloud/integrations/issues
[license-shield]: https://img.shields.io/github/license/TicketsBot-cloud/integrations.svg?style=for-the-badge
[license-url]: https://github.com/TicketsBot-cloud/integrations/blob/main/LICENSE.txt

[Workers]: https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white
[Workers-url]: https://workers.cloudflare.com/
[JavaScript]: https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[JavaScript-url]: https://developer.mozilla.org/en-US/docs/Web/JavaScript
