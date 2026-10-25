# terminal

A terminal app that looks and behaves like an IBM 3270 mainframe application
(think CICS or ISPF on a 3278 Model 2). The client is written in Go and runs
locally on your machine. It talks to a REST API that runs as a Cloudflare
Worker.

```
 CUSM01                         CUSTOMER BROWSE                      10/25/26
 SYS1 CUSTOMER INFORMATION SYSTEM                                    11:23:06

 NAME STARTS WITH ===> ____________________                ROW 1 TO 13 OF 24
 SELECT: S=SHOW  U=UPDATE  D=DELETE

 S CUST NO  NAME                     CITY            ST      BALANCE STAT
 -----------------------------------------------------------------------------
 _ 000101   ACME TOOL & DIE          DAYTON          OH      $12,450 A
 _ 000102   BLUE RIDGE MILLING       ROANOKE         VA       $3,020 A
 _ 000103   CONSOLIDATED FREIGHT     MEMPHIS         TN      $87,211 H
 ...
 PF1=HELP  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN  PF12=CANCEL
────────────────────────────────────────────────────────────────────────────────
4A      X ()                                            TERM0001         009/002
```

## Architecture

```
 your machine                                    Cloudflare
┌─────────────────────────────┐                 ┌─────────────────────────────┐
│ terminal (Go)               │   HTTPS/JSON    │ customer-api Worker (TS)    │
│   3270 screens, keyboard,   │────────────────▶│   logon / sessions          │
│   field editing (Bubble Tea)│   Bearer token  │   validation, locking       │
└─────────────────────────────┘◀────────────────│   D1 database               │
                                                └─────────────────────────────┘
```

The terminal does what a 3270 did locally: it draws screens, edits fields and
handles the keyboard. When you press Enter or a PF key, it calls the API. The
API is the system of record. It owns the data, checks logons and enforces the
edit rules, so any other client gets the same behavior.

## Quick start (everything local)

You need Go 1.24 or later and Node.js 20 or later.

```sh
# 1. Run the API locally with a local D1 database and the demo users
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev                                # http://localhost:8787

# 2. In another window, run the terminal
go run ./cmd/terminal                      # defaults to http://localhost:8787
```

Log on with **IBMUSER / SYS1** (or GUEST / GUEST).

## Deploy the API to Cloudflare

`worker/wrangler.jsonc` already points at the `customer-api` D1 database in
the project's Cloudflare account. To deploy to a different account, change
`account_id`, run `npx wrangler d1 create customer-api`, and put the new
`database_id` in `wrangler.jsonc`.

```sh
cd worker
npm ci
npx wrangler login

# 1. Create the tables, and optionally load the 24 demo customers
npm run db:migrate:remote
npm run db:seed:remote

# 2. Set who may log on (stored encrypted as a Worker secret)
npx wrangler secret put CUSTAPI_USERS      # e.g. IBMUSER:SOMEPASS,JDOE:OTHERPASS

# 3. Deploy
npm run deploy                             # prints https://customer-api.<you>.workers.dev
```

Then point the terminal at it:

```sh
go install ./cmd/terminal
terminal -api https://customer-api.<you>.workers.dev
# or: export TERMINAL_API_URL=https://customer-api.<you>.workers.dev
```

Notes:

- **Session length:** `SESSION_TTL_HOURS` in `wrangler.jsonc` sets how long a
  logon lasts (default 8).
- **Password storage:** passwords live in the `CUSTAPI_USERS` secret. Bearer
  tokens are stored only as SHA-256 hashes.
- **Brute-force protection:** the Worker doesn't throttle logon attempts. For
  a public deployment, add a Cloudflare rate-limiting rule on
  `POST /v1/session`, or put Cloudflare Access in front of the Worker.

## Terminal options

| Flag / env | Meaning |
| --- | --- |
| `-api URL` or `TERMINAL_API_URL` | API base URL (default `http://localhost:8787`) |
| `-system SYS1`, `-lu TERM0001` | Names shown on the screens |
| `-latency 150ms` | Extra delay on each response, to make the `X ()` lock easier to see |

## The API

```
GET    /v1/health
POST   /v1/session              {"userid","password"} → {"token","userid","expires_at"}
DELETE /v1/session              log off
GET    /v1/customers?prefix=K   list, ordered by name
POST   /v1/customers            create
GET    /v1/customers/{id}
PUT    /v1/customers/{id}       update ("version" must match the stored record)
DELETE /v1/customers/{id}
```

Every endpoint except health and logon needs `Authorization: Bearer <token>`.
Errors look like this:

```json
{"error": {"code": "invalid", "field": "zip", "message": "zip code must be five digits"}}
```

The error codes are `unauthorized`, `bad_logon`, `not_found`, `conflict`
(HTTP 409: someone else changed the record), `invalid` (HTTP 422) and
`bad_request`.

```sh
API=http://localhost:8787
TOKEN=$(curl -s -XPOST $API/v1/session \
  -d '{"userid":"ibmuser","password":"sys1"}' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" $API/v1/customers/000105
```

## How the terminal responds to the API

- **While a request is in flight**, the keyboard locks and the status line
  shows `X ()`, just like waiting on a real host.
- **API validation errors** show up as IBM-style messages, such as
  `CUS0233E ZIP CODE MUST BE FIVE DIGITS`. The field in error is brightened and
  the cursor is placed on it.
- **If someone else changed the record** (HTTP 409), you get `CUS0213E`. The
  latest copy is reloaded so you can review it and resubmit.
- **If the API is unreachable**, you get
  `CUS0298E HOST … NOT RESPONDING - PRESS ENTER TO RETRY`.
- **If your session expires**, you are sent back to the logon screen.

## What makes it feel like a 3270

The terminal is block mode, not a line-by-line TUI. The screen is a 24x80
buffer of fields, and each field starts with an attribute byte that takes up a
screen position, just as on real hardware. Fields can be protected, numeric,
non-display (for passwords), intensified, and use any of the 7 extended
colors. When a field fills up, the cursor skips to the next one, and input is
folded to upper case. The keyboard locks with `X -f` (you typed into a
protected position), `X NUM` (a letter in a numeric field) or `X >` (insert
mode ran out of room), and Reset clears the lock. You also get insert mode,
Erase EOF, Erase Input, and the cursor's row/col in the status line.

## Keyboard

| Key | 3270 function |
| --- | --- |
| Enter | ENTER |
| F1-F12, Shift+F1-F12 | PF1-PF12, PF13-PF24 |
| PgUp / PgDn | PF7 / PF8 |
| Ctrl+L | CLEAR |
| Alt+1 / Alt+2 / Alt+3 | PA1 / PA2 / PA3 |
| Tab / Shift+Tab | Next / previous field |
| Arrows, mouse click | Move the cursor |
| Home / End | First input field / end of field |
| Ctrl+N | New line |
| Insert | Insert mode |
| Ctrl+E / Ctrl+U | Erase EOF / Erase Input |
| Esc or Ctrl+R | RESET |
| Ctrl+C | Disconnect |

## Development

```sh
go test ./...                              # terminal client
cd worker && npm test && npm run typecheck # API, in the Workers runtime
```

```
cmd/terminal/        the terminal client (Go)
internal/tn3270/     terminal emulation: screen buffer, fields, keyboard, rendering
internal/host/       the application screens; they call a Backend interface
internal/api/        HTTP client for the API (implements host.Backend)
internal/customer/   the customer record exchanged with the API
worker/              the API: Cloudflare Worker + D1 (TypeScript)
  src/               routes, auth, validation
  migrations/        D1 schema
  seed.sql           demo customers
  test/              API tests (vitest, Workers runtime)
```

To point the terminal at a different API, implement `host.Backend` (`Logon`,
`List`, `Get`, `Create`, `Update`, `Delete`, …) and pass it in `host.Config`.
The screens don't change.
