# A2A Inspector

<div align="center" width="800">
   <img src="https://raw.githubusercontent.com/a2aproject/A2A/refs/heads/main/docs/assets/a2a_logo/color/SVG/a2a_color.svg" width="600" alt="Agent2Agent Protocol Logo"/>
   <h3>
       Inspect, debug and validate A2A agents from your browser.
   </h3>
</div>

<p align="center">
  <a href="https://github.com/a2aproject/a2a-inspector/releases/latest"><img src="https://img.shields.io/github/v/release/a2aproject/a2a-inspector?sort=semver" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/a2aproject/a2a-inspector" alt="License: Apache-2.0"></a>
</p>

The **A2A Inspector** (`a2a-inspector`) is a web-based tool for developers of [A2A (Agent2Agent) agents](https://a2a-protocol.org/latest/), maintained by the **A2A Project Team**. It's a single Go binary with the web UI embedded, and it talks to agents through [a2a-go](https://github.com/a2aproject/a2a-go).

## Features

- **Agent cards:** fetches a card, detects whether it's v1.0 or v0.3, lists its interfaces and checks it against the specification.
- **All bindings:** talks to agents over JSON-RPC, HTTP+JSON and gRPC, in v1.0 and v0.3, also through an interface entered by hand.
- **Chat:** sends or streams messages with text, files, data and metadata, or a raw message. Conversations and tasks waiting for input continue across messages.
- **Tasks and push notifications:** gets, lists, cancels and subscribes to tasks, manages push notification configs and receives notifications at its own webhook.
- **Auth:** bearer, basic and API key presets and custom headers. Secrets stay in the inspector's backend.
- **Traffic:** every HTTP exchange and gRPC call as it went over the wire, with each response validated.
- **Saved agents and AI Catalogs:** agents are saved in the browser as an [AI Catalog](https://ai-catalog.io/), export and import as a catalog file, and can be added from any catalog URL.
- **Card editor:** writes and edits cards with suggestions and documentation from the card schema and the inspector's checks as you type, and serves a card as a local echo agent to talk to.

Built on [A2A Protocol v1.0](https://a2a-protocol.org/v1.0.0/specification/), and works with v0.3 agents too.

## Installation

**From source** (Go 1.26 or later)

```bash
go install github.com/a2aproject/a2a-inspector@latest
```

Or run it from a clone of this repository with `go run .`.

**Docker**

```bash
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/a2aproject/a2a-inspector
```

Arguments after the image name go to the inspector, such as `-a <agent card URL>`. Inside the container, `localhost` is the container itself: reach an agent on your machine at `host.docker.internal` (on Linux, add `--add-host host.docker.internal:host-gateway`). To build the image yourself, run `docker build -t a2a-inspector .`.

## Usage

```bash
# Serve on 127.0.0.1:8080 and open the browser
a2a-inspector

# Open with an agent's card
a2a-inspector -a localhost:9999

# Connect to an interface without a card
a2a-inspector -e localhost:50051 --transport grpc --a2a-version 0.3

# Send credentials and other headers to the agent
a2a-inspector -a localhost:9999 --auth "Bearer $TOKEN" --svc-param X-Tenant=acme

# List the agents of an AI Catalog for every user
a2a-inspector --catalog ai-catalog.json
```

The inspector prints a URL with a per-run token, which the browser exchanges for a session cookie. Run with `--help` for all the flags.

Push notifications go to the inspector's webhook receiver at `/hooks/<id>`, which takes requests from anywhere without the session cookie; each webhook has a random ID and token. Agents reach it at the inspector's own address by default. For an agent that can't reach that address, such as one on another machine, give a URL that does, such as a tunnel to the inspector's port, with `--webhook-url` or in the UI.

## Saved agents and AI Catalogs

The inspector saves the agents you add in the browser, as an [AI Catalog](https://ai-catalog.io/) document, with the interface you picked and the connection settings but never secrets: after a reload, you enter those again. Browser storage belongs to the address, so the agents come back at the same host and port. **Export** downloads them as `ai-catalog.json`, and **Import** adds the agents of any AI Catalog file.

**Add from an AI Catalog** lists the A2A agents of a catalog URL, such as a host's `/.well-known/ai-catalog.json`, with those of the catalogs nested in it, to add one or all of them. The request for a catalog can carry credentials, which go only to the catalog's own origin. Agents added from a catalog are fetched when you first select them.

`--catalog <file or URL>` lists a catalog's agents for every user, marked as shared, and they can't be removed.

## Writing and serving cards

**New card** opens a v1.0 card template in the editor, and **Edit card** opens one you wrote before; for a card fetched from an agent, **Edit a copy** starts from it. Ctrl+Space, or ⌥Space on a Mac, suggests the fields and values the card's version allows, the pointer resting on a field shows its documentation, and the inspector's findings appear in place as you type. Cards are saved with your agents, as catalog entries that hold the card.

**Serve** runs the card as an echo agent on this machine and opens it: the agent answers every message with the message's text, so you can try the card with the rest of the inspector. The inspector has no serving code of its own: it starts [a2a-cli](https://github.com/a2aproject/a2a-cli) as `a2a server --card <file> --echo` on a free `127.0.0.1` port, with `a2a` or `a2a-cli` from the `PATH`, and stops it when you do or when the inspector exits. The card it serves has a single interface, on that port, with the binding and version you pick in place of the card's. Echo agents are listed above the saved agents while the inspector runs them. With `--egress=public`, Serve needs `--egress-allow 127.0.0.1`, since echo agents listen on loopback. A shared instance has no Serve.

## Running a shared instance

`a2a-inspector --hosted` runs the inspector as a service for multiple users:

- **Sessions:** every browser gets its own session, from a cookie set on its first API call, with its own connections, credentials and traffic. Sessions live in memory and end after `--session-idle-timeout` (10 minutes) without an open tab, or after `--session-max-age` (8 hours). Run a single instance.
- **Access:** the inspector doesn't sign users in. Who can reach it is up to where you deploy it, for example your platform's access control or an authenticating proxy in front of it. Serve it over HTTPS: the session cookie is `Secure`, which browsers keep over plain HTTP only on `localhost`.
- **Egress:** it connects only to public addresses, so users can't reach the network it runs in or a cloud metadata server. `--egress-allow` adds exceptions: CIDR blocks, IP addresses, host names or `*.example.com`. The check applies to every transport and redirect. Requests go through `HTTPS_PROXY` when it's set; the proxy resolves names again, so it should apply its own egress rules too. Locally, `--egress=public` turns on the same policy.
- **Switches:** the webhook receiver is off, since agents can't reach an instance behind access control, secrets can't refer to the server's environment variables, and Serve is off.
- **Shared agents:** `--catalog` preloads agents for every user, with no credentials: users enter their own for agents that need them.
- **Limits:** `--max-sessions` (500), and per session `--max-connections` (20), `--max-streams` (8), `--traffic-buffer-mib` (4), `--request-rate` (5 per second) and `--session-egress-rate` (10 requests to agents per second). `--egress-rate` (200 per second) caps requests to agents over all sessions, and `--max-stream-duration` (30 minutes) ends long streams.
- **Limits per client:** a client that drops its cookie gets a new session, so per-session limits alone don't stop one client from using up the shared ones. `--client-header` names a header the proxy in front of the inspector sets to identify the client: `X-Forwarded-For` for its address, or a header with the signed-in user from an authenticating proxy. A client then has at most `--client-max-sessions` (10) sessions, starts 10 at once and then one every 10 seconds, and makes up to `--client-egress-rate` (50 per second) requests to agents. `--trusted-proxies` (1) is how many proxies add an entry to the header; the client is the entry that many from the end, so entries a client adds itself are ignored. IPv6 addresses count per /64. Use a header clients can't set past the proxy, and leave this off when many users share an address, such as event attendees on one network.
- **Listening:** on all addresses and on `$PORT`, or 8080. The log has session counts and blocked destinations, never traffic.

## Development

`main.go` is the command, `inspector/` the public package it runs, `internal/` the backend, and `ui/` the React UI. The built UI in `ui/dist` is committed, so building the binary needs only Go.

```bash
go test ./...
golangci-lint run   # golangci-lint v2, configured in .golangci.yml; `golangci-lint fmt` formats
```

To work on the UI, install its dependencies once (`npm install` in `ui/`), then:

- `npm run dev` starts a dev server that proxies the API to an inspector on port 8080 (set `A2A_INSPECTOR_URL` for another one). Open the inspector's printed URL first so the browser has the session cookie, then the dev server's URL.
- `npm run lint`, `npm run typecheck` and `npm test` check the UI.
- `npm run build` rebuilds `ui/dist`. Commit it together with the UI change; CI fails when it's out of date.

`scripts/gen-schemas.sh` regenerates the A2A JSON Schemas the validator embeds, and `npm run gen:types` in `ui/` the TypeScript types generated from them.

## How to Contribute & Provide Feedback

Open an issue or pull request to share suggestions, questions or bugs. See the **[Contributing guide](CONTRIBUTING.md)**.

## License

The A2A Inspector is open-source and licensed under the [**Apache License 2.0**](LICENSE).
