# terminal

A terminal app that looks and behaves like an IBM 3270 mainframe application
(think CICS or ISPF on a 3278 Model 2). The client is written in Go and runs
locally on your machine. It talks to a REST API that runs as a Cloudflare
Worker.

```
 CUSM01                         CUSTOMER BROWSE                      10/25/26
 SYS1 CUSTOMER INFORMATION SYSTEM                                    11:23:06

 NAME STARTS WITH ===> ____________________                ROW 1 TO 13 OF 24
 SELECT: S=SHOW  U=UPDATE  D=DELETE  A=ACTIVITY  H=HISTORY

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
│   3270 screens, keyboard,   │────────────────▶│   checks the Access JWT     │
│   field editing (Bubble Tea)│  Access token   │   validation, locking       │
└─────────────────────────────┘◀────────────────│   D1 database               │
                                                └─────────────────────────────┘
                                                  ▲ Cloudflare Access in front:
                                                    sign-in with your identity
                                                    provider, in the browser
```

The terminal does what a 3270 did locally: it draws screens, edits fields and
handles the keyboard. When you press Enter or a PF key, it calls the API. The
API is the system of record. It owns the data, checks who is signed in and enforces the
edit rules, so any other client gets the same behavior.

## Quick start (everything local)

You need Go 1.24 or later and Node.js 20 or later.

```sh
# 1. Run the API locally with a local D1 database
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev                                # http://localhost:8787

# 2. In another window, run the terminal
go run ./cmd/terminal                      # defaults to http://localhost:8787
```

Press Enter on the logon screen. Locally there is no Cloudflare Access, so
you are logged on as `DEV_USER` from `.dev.vars` (IBMUSER).

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

# 2. Put Cloudflare Access in front (see "Who can log on" below) and set
#    ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc

# 3. Deploy
npm run deploy                             # prints https://customer-api.<you>.workers.dev
```

Then point the terminal at it. It signs in with
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(`brew install cloudflared`), which opens your browser the first time and
caches the token after that.

```sh
go install ./cmd/terminal
terminal -api https://customer-api.<you>.workers.dev
# or: export TERMINAL_API_URL=https://customer-api.<you>.workers.dev
```

### Who can log on

There are no passwords in the app. [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
sits in front of the Worker and signs people in with your identity provider
(one-time PIN by email, Google, GitHub and so on). The Access policy decides who
gets in. Access forwards each allowed request with a signed JWT, and the Worker
checks that JWT itself as well, so a request that bypasses Access is still refused.

1. **Turn on Access for the Worker:** Workers & Pages → `customer-api` →
   Settings → Domains & Routes → `workers.dev` → enable Cloudflare Access.
   Then click **Manage Cloudflare Access** and set the policy to allow the
   emails or groups you want. (Or, in Zero Trust → Access → Applications, add
   a self-hosted application for `customer-api.<you>.workers.dev`.)
2. **Copy the two values the Worker checks** into `vars` in
   `worker/wrangler.jsonc`:
   - `ACCESS_TEAM_DOMAIN`: your team domain, e.g. `example.cloudflareaccess.com`
     (Zero Trust → Settings → Custom Pages).
   - `ACCESS_AUD`: the application's Audience (AUD) tag (Zero Trust → Access →
     Applications → the app → Overview).
   Until both are set, every request except health gets a 500 saying Access
   is not configured.
3. **For CI and scripts, add a service token:** Zero Trust → Access → Service
   Auth → Create service token, then add a policy to the application with
   action **Service Auth** that includes it. The terminal uses one if
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set.

The userid shown on the screens and stored in `updated_by` is the part of the
email before the `@`, upper case, letters and digits only, at most 8
characters (`j.doe@example.com` becomes `JDOE`). Service tokens log on as
`SERVICE`. How long a logon lasts is the Access application's session
duration.

## Continuous integration and deployment

`.github/workflows/ci.yml` runs on every push and pull request:

- **Terminal client:** `gofmt`, `go vet`, `go test -race`, and a build of `cmd/terminal`.
- **API:** `npm ci`, the TypeScript typecheck, and the Worker tests in the Workers runtime.

When both pass on a push to `main`, the **Deploy API** job applies any new D1
migrations to the remote database and deploys the Worker. It then checks that
the deployed URL refuses a request with no Access token, and that a logon with
the CI service token works.

One-time setup:

1. **Create a Cloudflare API token** (Cloudflare dashboard → My Profile → API
   Tokens → Create Token → "Edit Cloudflare Workers" template). Add
   **Account → D1 → Edit** to it, and limit it to the Justin Frank account.
2. **Add it to GitHub** as a repository secret named `CLOUDFLARE_API_TOKEN`
   (Settings → Secrets and variables → Actions → New repository secret).
3. **Set up Cloudflare Access** as in [Who can log on](#who-can-log-on), and
   add the service token to GitHub as repository secrets
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
4. **Optionally load the demo customers** with `npm run db:seed:remote`.

The deploy job uses a GitHub environment named `production`. To require
approval before each deploy, add required reviewers to that environment
(Settings → Environments → production).

## Terminal options

| Flag / env | Meaning |
| --- | --- |
| `-api URL` or `TERMINAL_API_URL` | API base URL (default `http://localhost:8787`) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Use an Access service token instead of a browser sign-in |
| `-system SYS1`, `-lu TERM0001` | Names shown on the screens |
| `-latency 150ms` | Extra delay on each response, to make the `X ()` lock easier to see |
| `-print-dir DIR` | Where Ctrl+P saves screens (default `~/terminal-prints`) |

## Mac app launcher

To get a double-clickable app for the Dock, Launchpad and Spotlight, run this
on your Mac from the repo:

```sh
scripts/make-mac-app.sh            # uses the live API
scripts/make-mac-app.sh http://localhost:8787   # or any other API URL
```

It builds `~/Applications/Mainframe Terminal.app`. Opening it starts a
Terminal window sized 100x32 with the `GoTerm` Terminal profile (or your
default profile if there is no `GoTerm`) and runs the client inside it. Use
`PROFILE="Other Name" scripts/make-mac-app.sh` to pick another profile. The first time,
macOS asks whether the app may control Terminal; allow it. Run the script
again after pulling changes to rebuild the client inside the app.

## The API

```
GET    /v1/health
POST   /v1/session              logon → {"userid"}
GET    /v1/customers?prefix=K   list, ordered by name
POST   /v1/customers            create
GET    /v1/customers/{id}
PUT    /v1/customers/{id}       update ("version" must match the stored record)
DELETE /v1/customers/{id}
GET    /v1/customers/{id}/transactions   invoices and payments, newest first
POST   /v1/customers/{id}/transactions   post one: {"type":"I"|"P","amount","reference"}
GET    /v1/customers/{id}/history        change history, newest first
```

Posting an invoice (`I`) adds to the balance and a payment (`P`) takes from it,
in whole dollars. Invoices are refused for customers on hold or closed;
payments are always taken. The change history has a row for each add and
delete and one for each field an update changed, with who and when. It is
kept after the customer is deleted.

Everything goes through Cloudflare Access, which needs a `cf-access-token`
header (from `cloudflared access token`) or a service token's
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Errors look like this:

```json
{"error": {"code": "invalid", "field": "zip", "message": "zip code must be five digits"}}
```

The error codes are `unauthorized`, `not_found`, `conflict`
(HTTP 409: someone else changed the record), `invalid` (HTTP 422) and
`bad_request`.

```sh
API=https://customer-api.<you>.workers.dev
cloudflared access login $API
curl -s -H "cf-access-token: $(cloudflared access token -app=$API)" $API/v1/customers/000105
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
- **If your Access session expires**, you are sent back to the logon screen.
  Enter signs you in again.
- **If the Access policy doesn't allow you**, you get `IKJ56421I`.

## What makes it feel like a 3270

The terminal is block mode, not a line-by-line TUI. The screen is a buffer
of fields, and each field starts with an attribute byte that takes up a
screen position, just as on real hardware. Fields can be protected, numeric,
non-display (for passwords), intensified, and use any of the 7 extended
colors. When a field fills up, the cursor skips to the next one, and input is
folded to upper case. The keyboard locks with `X -f` (you typed into a
protected position), `X NUM` (a letter in a numeric field) or `X >` (insert
mode ran out of room), and Reset clears the lock. You also get insert mode,
Erase EOF, Erase Input, and the cursor's row/col in the status line.

The screen fills your terminal window and follows it as you resize, the way
emulators like QWS3270 do. The smallest size is a 3278 Model 2 (24x80, plus
two lines for the status area); a bigger window gets a bigger presentation
space. Panels keep their 24x80 layout and spread into the extra room: the
message and PF key lines stay at the bottom, the date and time stay at the
right edge, and the browse list and the credit report show as many rows as
fit. Anything you have typed but not yet sent survives a resize. If the window
changes while the host is busy, the screen is redrawn when the reply arrives.

## Account activity and change history

From the menu, option 5 (`5 000105`) opens **ACCOUNT ACTIVITY**: type `I` or
`P`, an amount and an optional reference, and press Enter to post. The list
below shows each posting with the balance it left. Option 6 opens **CHANGE
HISTORY**, which also works for a deleted customer. On the inquiry screen
these are PF5 and PF6, and on the browse list the selection codes `A` and `H`.

## Printing a screen

Ctrl+P saves the screen as a text file, like a 3270 local copy, and the status
line shows `PRINTED`. Files go to `~/terminal-prints` (change it with
`-print-dir`) and are named `PRINT-20261025-112306.txt`.

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
| Ctrl+P | PRINT (save the screen to a text file) |
| Ctrl+C | Disconnect |

## Development

```sh
go test ./...                              # terminal client
cd worker && npm test && npm run typecheck # API, in the Workers runtime
```

```
.github/workflows/   CI: test both halves, deploy the Worker from main
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
