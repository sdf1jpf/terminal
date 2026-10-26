# terminal

A terminal app that looks and behaves like an IBM 3270 mainframe application
(think CICS or ISPF on a 3278 Model 2). The client is written in Go and runs
locally on your machine. It talks to a REST API that runs as a Cloudflare
Worker.

```
 CUSM01                         CUSTOMER BROWSE                      10/25/26
 SYS1 CUSTOMER INFORMATION SYSTEM                                    11:23:06

 NAME STARTS WITH ===> ____________________                ROW 1 TO 13 OF 24
 SELECT: S=SHOW  U=UPDATE  D=DELETE  A=EVENTS  I=INVOICES
 CITY ===> __________________  STATE ===> __  STATUS ===> _  A/H/C
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
│ terminal (Go)               │  AID + fields   │ customer-api Worker (TS)    │
│   generic 3270 display:     │────────────────▶│   checks the Access JWT     │
│   draws fields, edits them, │  Access token   │   the screens (panels)      │
│   keyboard (Bubble Tea)     │◀────────────────│   validation, locking       │
└─────────────────────────────┘   next screen   │   D1 database               │
                                                └─────────────────────────────┘
                                                  ▲ Cloudflare Access in front:
                                                    sign-in with your identity
                                                    provider, in the browser
```

The terminal does what a 3270 did locally: it draws screens, edits fields and
handles the keyboard. The screens themselves come from the API, the way a
3270 got them from CICS. When you press Enter or a PF key, the terminal sends
the key, the input fields and the cursor position to `POST /v1/screen`, and
the Worker answers with the next screen as a list of fields. So a new or
changed screen ships with a Worker deploy, and the terminal never needs
rebuilding for it. The format is in [docs/screen-protocol.md](docs/screen-protocol.md),
and the panels are in `worker/src/screens/`.

Only the logon screen is drawn by the terminal itself, since it signs you in
through Cloudflare Access before the API can be called. If the API stops
answering, the terminal keeps the screen and anything you typed and says
`HOST NOT RESPONDING`; press Enter to try again.

The API is the system of record. It owns the data, checks who is signed in and enforces the
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
go tool greenscreen                        # defaults to http://localhost:8787
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
go tool greenscreen -api https://customer-api.<you>.workers.dev
# or: export GREENSCREEN_API_URL=https://customer-api.<you>.workers.dev
# or build it: go build -o terminal github.com/sdf1jpf/greenscreen/cmd/greenscreen
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

- **Terminal client:** verifies the pinned greenscreen client and builds it.
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
3. **Let the token create the batch job queue:** add **Account → Queues →
   Edit** to the same token, or create the queue once yourself (see
   [Batch jobs](#batch-jobs)).
   Likewise for the HELP facility's index: add **Account → Vectorize →
   Edit** and **Account → Workers AI → Read**, or create the index yourself
   (see [Asking the system](#asking-the-system)).
4. **Set up Cloudflare Access** as in [Who can log on](#who-can-log-on), and
   add the service token to GitHub as repository secrets
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
5. **Optionally load the demo customers** with `npm run db:seed:remote`.

The deploy job uses a GitHub environment named `production`. To require
approval before each deploy, add required reviewers to that environment
(Settings → Environments → production).

## Terminal options

| Flag / env | Meaning |
| --- | --- |
| `-api URL` or `GREENSCREEN_API_URL` | API base URL (default `http://localhost:8787`) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Use an Access service token instead of a browser sign-in |
| `-system SYS1`, `-lu TERM0001` | Names shown on the screens |
| `-latency 150ms` | Extra delay on each response, to make the `X ()` lock easier to see |
| `-print-dir DIR` | Where Ctrl+P saves screens, and PDFs the host sends (default `~/terminal-prints`) |
| `-idle 30m` | Log off after this long without a key pressed (`0` never) |

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

## In a browser

The Worker also serves a browser version of the terminal at its root URL,
for example https://customer-api.justin-frank.workers.dev/. Cloudflare Access
signs you in the usual way, and the page then talks to `POST /v1/screen`
([docs/screen-protocol.md](docs/screen-protocol.md)) like the Go client does:
the same screens, colors, field editing and status line. The screen fills the
window (never smaller than 24x80; the font shrinks instead) and is laid out
again when you resize it, keeping what you typed.

Keys are the same as the Go client's (see [Keyboard](#keyboard)), with
Shift+Enter for New Line. Browsers keep some function keys for themselves
(F11 and F12 usually), so the key bar under the screen has Enter, Clear,
Reset, PA1, PA2, PF1 to PF12, RETRV (PF24) and SNAP (a picture of the screen)
as buttons. The page is greenscreen's browser terminal
([`@greenscreen-dev/web`](https://github.com/sdf1jpf/greenscreen/tree/main/packages/web)),
served from `worker/node_modules`: plain HTML, CSS and JavaScript with no
build step.

## The API

```
GET    /v1/health
POST   /v1/session              logon → {"userid"}
GET    /v1/live                 WebSocket: pushes that tell a terminal to redraw
GET    /v1/customers?prefix=K   list, ordered by name
POST   /v1/customers            create
GET    /v1/customers/{id}
PUT    /v1/customers/{id}       update ("version" must match the stored record)
DELETE /v1/customers/{id}
GET    /v1/customers/{id}/transactions   invoices and payments, newest first
POST   /v1/customers/{id}/transactions   post one: {"type":"I"|"P","amount","reference"}
GET    /v1/customers/{id}/history        change history, newest first
GET    /v1/products?prefix=X    product file, ordered by SKU
GET    /v1/products?q=X         active products whose SKU or description contains X
POST   /v1/products             add a product
GET    /v1/products/{sku}
PUT    /v1/products/{sku}       update ("version" must match)
POST   /v1/jobs                 submit a batch job: {"name":"CUSAGING"}
GET    /v1/jobs                 recent jobs, newest first
GET    /v1/jobs/{id}            a job and its output listing
POST   /v1/jobs/{id}/explain    why it failed, from Workers AI → {"explanation"}
POST   /v1/ask                  ask the HELP facility: {"question"} → {"answer","topics"}
GET    /v1/search/natural?q=X   a search in plain English → {"filter","description","hits"}
GET    /v1/syslog?before=N      the system log, newest first (&limit=, up to 500)
GET    /v1/schedules            the job schedule, with each job's next run
PUT    /v1/schedules/{job}      schedule a job: {"cron":"0 6 * * *","enabled":true}
DELETE /v1/schedules/{job}
GET    /v1/spool?name=X         the print spool, newest first
GET    /v1/spool/{id}           an output group and its lines
GET    /v1/spool/{id}/print     paged for the printer, as text/plain
POST   /v1/spool/{id}/print     print it on PRT1 (again, for a reprint)
DELETE /v1/spool/{id}           purge it, and its job
GET    /v1/spool/{id}/pdf       printed on green-bar paper, as a PDF
GET    /v1/spool/{id}/png?page=N   one printed page as a picture
POST   /v1/snapshot             a PNG or PDF of a screen as a terminal shows it
GET    /v1/invoices/{id}/pdf    the invoice as a PDF (a pro forma while open)
GET    /v1/customers/{id}/statement   a 30-day statement, as a PDF
GET    /v1/archive?name=X&kind=K      archived output and documents
GET    /v1/archive/{key}        one entry; {key}.pdf and {key}.txt are its files
POST   /v1/archive/restore      put an archived listing back on the spool: {"key"}
GET    /v1/mail?ref=X           the mail log: statements and letters sent, vendor mail received
GET    /v1/mail/{seq}
GET    /v1/tables               the system tables, with their row counts
GET    /v1/tables/{t}           a table's columns and rows
PUT    /v1/tables/{t}/{key}     add or change a row
DELETE /v1/tables/{t}/{key}     delete a row
DELETE /v1/tables/{t}           put a table back to its defaults
GET    /v1/monitor?minutes=N    transaction statistics: 5, 15, 60, 240 or 1440 minutes
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
(HTTP 409: someone else changed the record), `invalid` (HTTP 422),
`bad_request`, and `unavailable` (HTTP 503: Workers AI could not answer).

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

## The menu

The primary option menu (CUSM00) lists one option per module, and each opens
its own submenu; PF3 goes back up, and PF3 on the primary menu logs off.

| Option | Submenu | Options |
| --- | --- | --- |
| 1 | CUSTOMERS | 1 Browse, 2 Inquiry, 3 Add, 4 Event history |
| 2 | ORDERS | 1 Invoices, 2 Shipping, 3 EDI mailbox, 4 Order timeline, 5 EDI exceptions, 6 Shipment tracking |
| 3 | INVENTORY | 1 Products, 2 Purchase orders, 3 Vendors |
| 4 | ACCOUNTING | 1 General ledger, 2 Reports (1 Dashboard, 2 Sales, 3 Aging, 4 Turns, 5 Credit exposure) |
| 5 | OPERATIONS | 1 Batch jobs, 2 Console/SYSLOG, 3 Job schedule, 4 Held output, 5 Transaction monitor, 6 System tables |
| 6 | SELLING | 1 Customer pricing, 2 Territories, 3 Salespeople, 4 Sales by territory, 5 Sales and commission by salesperson, 6 Quantity breaks, 7 Promotions |
| 7 | FREIGHT | 1 Trucks, 2 Drivers, 3 Load planning, 4 Dispatch board, 5 Freight costs |
| T, X | | Tutorial, log off |

A fast path such as `1.2` or `=1.2` goes straight to an option from any menu,
and option names (`INQUIRY`, `EDI`, `SYSLOG`, ...) work anywhere too. A second
word is passed to the option, so `1.2 000105` shows that customer. `=` alone
goes back to the primary menu, and `=X` logs off. An option returns to its own
submenu when you leave it.

## Searching and help

The browse list (menu option 1.1) searches by name, city, state and status
together: fill in any of the fields and press Enter. Clear empties them all.
The API takes the same search as `GET /v1/customers?prefix=&city=&state=&status=`.

PF1 with the cursor in an input field explains that field (CUSH01). PF1
again, or PF1 anywhere else, shows the keyboard tutorial. PF3 goes back, and
whatever you had typed on the screen is still there.

Fields with a fixed set of values list them under the help, the way ISPF
prompts do: status codes, selection codes, states, carriers, job names,
vendors, the options on a menu. Type S beside one and press Enter to go back
with it in the field.

**Search** (option 1.5, or `FIND text` on any command line) looks for a name
or number across customers, invoices, purchase orders, shipments, vendors and
products, with an optional type (C, I, O, S, V or P) to narrow it. S beside a
hit opens it, and PF3 comes back to the list. The API has the same search as
`GET /v1/search?q=text&type=C,I`.

## Asking the system

The HELP facility runs on [Workers AI](https://developers.cloudflare.com/workers-ai/)
and a [Vectorize](https://developers.cloudflare.com/vectorize/) index.

- **HELP and a question** on any command line, such as
  `HELP HOW DO I PUT A CUSTOMER ON HOLD`, opens **HELP - ASK THE SYSTEM**
  (CUSH02) with the answer. PF5 on the tutorial opens it empty. The answer is
  drawn from the system's own help topics, and the topics it used are listed
  below it: `S` beside one goes to its screen. PF24 brings back earlier
  questions.
- **Plain-English search:** a search that matches no name or number and reads
  like a sentence, such as `FIND CUSTOMERS IN OHIO OVER THEIR CREDIT LIMIT` or
  `FIND OPEN INVOICES OVER 5000`, is turned into a filter on one type of
  record, which the message line spells out. Start a search with `?` to
  always search this way. Products are also found by meaning, so
  `?PARTS FOR A CONVEYOR` can find chain and bearings whose descriptions
  never say "conveyor".
- **Abend analysis:** `E` beside a job on the batch jobs list, or PF6 on the
  output of one that ended with an abend or a non-zero return code, opens
  **ABEND ANALYSIS** (CUSJ03): what failed, the likely cause, and what to do.

The help topics are built from the code: every menu option, every field's
PF1 help, the PF keys, the job library, and a few pages on how invoices,
shipping, EDI, purchasing and the close work (`worker/src/knowledge.ts`).
The cron trigger embeds them and the product file into the `customer-help`
index whenever they change. Until it has, help finds topics by matching
words, and if Workers AI cannot be reached the screens say so and list the
nearest topics.

The deploy job creates the index the first time, which needs
**Account → Vectorize → Edit** on the `CLOUDFLARE_API_TOKEN`. To create it
yourself:

```sh
npx wrangler vectorize create customer-help --dimensions=768 --metric=cosine
```

The Worker tests stand in for Workers AI and Vectorize (`worker/test/ai.ts`),
so they run without a Cloudflare login.

## Session

The status line shows the system name and the time next to the terminal name.
On the menus and the operator console, PF24 (Shift+F12, Esc then Up, or the
RETRV button in the browser) is RETRIEVE: it brings back the last command
you entered, and pressing it again goes further back. A terminal left without
a key pressed for 30 minutes logs itself off, as TSO does with an S522.

Each logon is a TSO session (TSU00042), kept by a
[Durable Object](https://developers.cloudflare.com/durable-objects/)
(`worker/src/sessions.ts`) along with the records it holds:

- **Record locking.** While you are changing or deleting a customer, or
  changing a product, the record is yours. Anyone else who tries, or you on
  another terminal, gets `CUS1201E RECORD IN USE BY IBMUSER ON TERM0001`.
  Leaving the screen, logging off or timing out lets it go, and so does a
  session that has not been seen for 30 minutes. The REST API refuses to
  change a locked record with `423 Locked`.
- **SEND.** Type TSO's SEND on any command line: `SEND 'LUNCH AT NOON?'
  USER(JFRANK)`, several users as `USER(A,B)`, everyone signed on as
  `USER(*)`, `LOGON` to keep it for someone who is not on yet, or no `USER`
  to tell the operator (it goes in SYSLOG). It shows on their message line
  with your userid, at once if their terminal is idle.

## Products and stock

Menu option 3.1 opens the **PRODUCT LIST** (CUSP01): the product file with
price, quantity on hand and reorder point, searchable by SKU. Active products
at or below their reorder point are flagged `LOW` in yellow, and discontinued
products show in pink. `S` shows a product and `U` updates it, and PF5 adds
one (CUSP02). Products are never deleted, only discontinued (status `D`).
`seed.sql` loads 15 demo products.

## Invoices

Menu option 2.1 (`2.1 000105`), or the selection code `I` on the browse list,
opens the **INVOICE LIST** (CUSI01) for a customer, newest first, with the
account's balance, credit limit, available credit and unpaid invoices; leave
the customer number blank to list every invoice. `S` shows an invoice and
`P` marks a billed one paid. PF5 opens a new invoice for an
active customer, and `S` shows one on the **INVOICE** screen (CUSI02).

An invoice goes OPEN, then BILLED, then PAID:

- **Open:** type a SKU and quantity on the add line and press Enter. The line
  is priced from the product file, less the customer's discount (see
  [Sales](#sales-pricing-territories-and-commission)), and its quantity comes
  out of stock at once. A discounted line is marked `*`.
  Overtype a line's quantity to change it, or type `D` beside it to remove
  it; stock moves by the difference. PF9 twice cancels the invoice and
  returns all its stock.
- **Finding a SKU:** PF4 opens **PRODUCT SEARCH** (CUSI03), which lists the
  active products whose SKU or description contains what you type, with
  price and stock on hand. `S` beside one carries its SKU back to the add
  line. Typing part of a SKU or description with a `?` (such as `GLOVE?`) and
  pressing Enter searches too, and so does a SKU that is not on file but
  matches some products.
- **Addresses:** every invoice has its own bill-to and ship-to, copied from
  the customer when it is opened (an EDI order's `N1*ST` loop sets the
  ship-to). PF5 shows them on **INVOICE ADDRESSES** (CUSI04): overtype one and
  press Enter, PF5 copies the bill-to to the ship-to, and PF6 resets them
  from the customer. The ship-to can be changed until the invoice is released
  to the warehouse, the bill-to until it is billed. The ship-to goes on the
  invoice screen, the pick ticket, the shipment and the 856; both go on the
  810. Changing the customer's address later does not change its invoices.
- **PF10 bills it:** the total is posted to the customer's account as an
  invoice (`I`) transaction, and the lines can no longer be changed.
- **PF11 marks it paid:** a payment (`P`) for the total is posted.

The same steps are in the API under `/v1/invoices` (see the route list in
`worker/src/index.ts`).

Each step runs as one D1 transaction, so stock, the invoice and the
customer's balance always move together.

## Sales: pricing, territories and commission

Option 6 opens the **SALES MENU** (CUSM60). The tables are in migration 0040
and the rules in `worker/src/sales.ts`.

- **6.1 PRICING** (CUSC01, `6.1 000105`) shows who sells to a customer and
  its pricing agreements. An agreement is a discount off list (`12.5`) or a
  contract price, for one SKU (`BRG-6204`), a product line (the part of the
  SKU before the dash, `BRG`) or `*` for everything. When a line is added to
  an invoice, by hand or from an 850, the most specific agreement prices it:
  the SKU, then its product line, then `*`. The net price is rounded to the
  dollar. The line keeps its list price and the agreement that priced it.
  The invoice screen marks the line with `*` and shows the total discount, the
  PDF prints the list price under the line and a TOTAL AT LIST / LESS YOUR
  DISCOUNTS before the total, and the 810 sends the line at list with an
  `SAC*A*C310` allowance, so the TDS is still what the customer owes.
  Typing a territory or salesperson here assigns the customer to it; leave
  them blank for the territory of its state and that territory's salesperson.
  Changes go on the customer's event history.
- **6.2 TERRITORIES** (CUSG01): each state belongs to one territory, and each
  territory has a salesperson. Type a code, name, salesperson and states on
  the top line to add or change one (`U` fills it from a row); the states
  listed move to it. `D` twice deletes a territory with no states left.
  Customers in a state with no territory, or a territory with no
  salesperson, are house accounts.
- **6.3 SALESPEOPLE** (CUSG02): name, commission rate (such as `3.5`) and
  status. A salesperson still covering a territory or customer cannot be made
  inactive.
- **6.4 BYTERRITORY / 6.5 COMMISSIONS** (CUSG03): the invoices billed in a
  month, totalled by the territory and salesperson recorded on each invoice
  when it was opened, so reassigning a customer does not move past sales.
  Shows invoices, discounts given, net sales and the discount rate, and by
  salesperson the commission (rate times net sales). PF6 switches views,
  PF10/PF11 move a month, and PF9 prints it to the spool.

- **6.6 BREAKS** (CUSC02): a quantity break takes an extra percentage off a
  line of that many or more, after the customer's price. Breaks are for a
  SKU, a product line or `*`; the most specific item with breaks decides, and
  the largest break the line reaches applies. Changing a line's quantity
  prices it again.
- **6.7 PROMOTIONS** (CUSC03): a discount off list, or a promotional price for
  one SKU, open to every customer from one date to another. A line gets the
  promotion or the customer's own price, whichever is lower (shown as
  `PROMO PR001`), then any quantity break. Running promotions show in green,
  coming ones in yellow and past ones in blue.

- **Sales tax:** an invoice is taxed when it is billed, at the rate for its
  ship-to state in the `TAXCODE` system table (option 5.6), unless the
  customer has an exemption certificate on file (the TAX EXEMPT field on
  6.1). Amounts are whole dollars, so the tax is rounded to the dollar. Until
  billing, the invoice screen shows an estimate. The total charged to the
  account is the lines plus the tax. The PDF shows SUBTOTAL and SALES TAX,
  the 810 carries a `TXI*ST` segment, and the month-end close credits the tax
  to 2200 SALES TAX PAYABLE instead of sales. Sales reports and commission
  leave tax out.

- **Early-payment terms:** every invoice is due in 30 days. The EARLY PAY
  field on 6.1 (`2/10`) offers a customer a discount on the lines for paying
  within that many days of billing, so its invoices read `2% 10 NET 30`. The
  terms are fixed on each invoice when it is billed. Marking it paid within
  the window takes the discount: the payment still clears the whole
  invoice, and the close debits the discount to 4100 SALES DISCOUNTS
  instead of cash. An 820 for the total less the discount is accepted
  within the window. The PDF shows the discounted amount and its date, and
  the 810 carries an `ITD` segment.

The API has the same under `/v1/customers/{id}/sales`,
`/v1/customers/{id}/pricing/{item}`, `/v1/territories`, `/v1/salespeople`
and `/v1/sales`.

## Event history

From the menu, option 1.4 (`1.4 000105`) opens the customer's **EVENT HISTORY**
(CUSM03): every record change (including credit limit and status changes),
invoice opened, invoice billed, payment posted and EDI interchange, newest first, with the account's balance, limit and available
credit above. Each line is numbered: type a number in `SHOW LINE` and press
Enter to see that event on **EVENT DETAIL** (CUSM05), including the
invoice and its lines; PF4 there opens the invoice. The screen is read only:
charges and payments come from the invoice screens (option 2.1).

It also works for a deleted customer, whose events outlive the record. On
the inquiry screen it is PF5 (PF6 is the customer's invoices), and on the
browse list the selection code `A`. It replaces the old change history:
the command `HISTORY` and the code `H` still lead here.

## EDI with customers' systems

Customers' systems can trade with us in ANSI X12 (004010), simulated end to
end. Menu option 2.3 (`2.3 000105` for one customer) opens the **EDI MAILBOX**
(CUSE01): every interchange in and out, newest first. `S` shows one on
**EDI INTERCHANGE** (CUSE02), segment by segment, with PF4 to its invoice.

| Set | Direction | What happens |
| --- | --- | --- |
| 850 purchase order | in | Opens an invoice for the sender and adds its lines, taking the stock. A line for a product we don't carry is held for an operator (see below). If any other line can't be filled, such as for want of stock, the whole order is rejected and the stock returned. |
| 997 acknowledgment | out | Sent for every inbound interchange from a known customer: accepted, or rejected with the reason kept on the mailbox. |
| 856 ship notice | out | Sent when an invoice that came from an 850 ships. |
| 810 invoice | out | Sent when an invoice that came from an 850 is billed (PF10). |
| 820 remittance | in | Marks each invoice it names paid, if the amounts agree. |

Any customer can trade: its interchange ID (ISA06) is its customer number,
and ours is `CUSTAPI`. Interchanges arrive with `POST /v1/edi` (the raw X12
as the body), wait on the `customer-jobs` queue and are processed by its
consumer. PF6 on the mailbox submits the **EDISIM** job, which plays the
customers' side: up to three customers send purchase orders (now and then
for a product we don't carry, which is held), and each customer pays
the billed invoices we sent it an 810 for. EDI traffic also shows in the
customer's event history.

### EDI exceptions

An 850 line whose product is missing, not on file or discontinued no longer
rejects the order. The rest of the order becomes an invoice and the line
waits on **EDI EXCEPTIONS** (CUSE03, menu option 2.5; the mailbox shows how
many are waiting). For each held line, either:

- type a SKU under `NEW SKU` and press Enter, which adds that product to the
  invoice for the quantity ordered, at its current price; `F` beside the
  line finds one with the product search (CUSI03);
- `D` drops the line from the order; or
- `R`, entered twice, rejects the whole order: the invoice is cancelled,
  its stock returned, and the 850 marked rejected on the mailbox.

The invoice can't be released to the warehouse while any of its lines are
held, and its [lifecycle](#order-lifecycles) waits for them, then carries on.
The held lines and what became of them show on its timeline. Over REST:
`GET /v1/edi/exceptions`, and `POST /v1/edi/exceptions/{n}/correct`
(`{"sku"}`), `/drop` and `/reject`.

## Purchasing

Stock is bought from vendors (simulated suppliers) on purchase orders, sent
to them by EDI. Menu option 3.2 (`3.2 V00002` for one vendor) opens **PURCHASE
ORDERS** (CUSV01), newest first; PF4 lists the **VENDORS** (CUSV03). Each
product names its vendor and unit cost on the product screen (option 3.1),
which also shows how many are on order.

- **PF5 opens a PO** for the vendor in the `VENDOR` field. On **PURCHASE
  ORDER** (CUSV02), add lines by SKU and quantity: only products the vendor
  supplies, costed at their unit cost. `D` removes a line, PF9 twice
  cancels the PO.
- **PF10 sends it** to the vendor as an 850. The vendor answers with an 855
  (`CONFIRMED`, with a ship date) and an 856 ship notice (`IN TRANSIT`).
- **Receiving puts the goods in stock.** Type what came in under `RCV` and
  press Enter, or PF11 (or `R` on the list) to receive everything still due.
  Each receipt is kept for the ledger. The PO is `RECEIVED` once every line
  is in.
- **History:** **VENDOR HISTORY** (CUSV04) numbers a vendor's events, newest
  first: POs opened, sent and received in full, each receipt at cost, and
  the EDI interchanges with its system. Fill in `PURCHASE ORDER` to see one
  PO's events. Type a line number to open that PO or interchange. You can
  open the history from option 3.4 (`3.4 V00002 PO00003`), with `H` beside a
  vendor, or with PF5 on a PO.

PF6 on the list submits **CUSREORD**, which orders every active product at
or below its reorder point back up to twice that point, counting what is
already on order, with one PO per vendor, and sends them. PF10 submits
**VENDSIM**, which plays the vendors: they confirm sent POs and ship
confirmed ones. Vendors trade under their vendor number as interchange ID,
and their traffic shows on the EDI mailbox (`E V00002`).

The same steps are in the API under `/v1/vendors` and `/v1/purchase-orders`.

## Shipping

An invoice ships before it is billed. On an open invoice, **PF6 releases it
to the warehouse**: a shipment opens in `PICKING` and the invoice's lines are
frozen (cancelling the shipment unfreezes them). Menu option 2.2 (`2.2 P` for
just one status) opens **SHIPPING** (CUSS01), and `S` beside a shipment
opens **SHIPMENT** (CUSS02): its pick ticket, with each line's bin, in bin
order.

- **Pack:** type the cartons and weight and press PF10 (`PACKED`). The
  system then picks the carrier from the invoice's ship-to, the weight, the
  heaviest carton and the order's value, using the **CARRIER** system table
  (option 5.6). It takes the first carrier, by priority, whose service area
  and limits fit, and the screen shows which one and why. The default table:
  - `UPS` ground by default: up to 149 lb, 70 lb a carton and $4,999.
  - `TRK` (company truck) for freight beyond that when the ship-to is in
    the truck area: the warehouse's state (OH) and IN, KY, MI, PA, WV.
  - `FDX` (FedEx Freight) for everything else.
- **Ship:** press PF10 (`SHIPPED`, with a tracking number). A customer that
  ordered by EDI is sent an **856 ship notice** with the cartons, carrier,
  tracking number and lines.
- **Bill:** PF11 on the shipment, or PF10 on the invoice. Billing an
  invoice that has not shipped is refused.

PF6 on the list submits **CUSPICK**, which prints a pick ticket for every
shipment still in picking. Releases and shipments show in the customer's
event history. The API is under `/v1/shipments`.

### Shipment tracking

Once a shipment has gone, the system asks its carrier where it is: every
half hour for each shipment on its way (the minute cron trigger), and
whenever someone looks. Every carrier scan is kept, and the shipment carries
its delivery status (`IN TRANSIT`, `OUT FOR DELIVERY`, `DELIVERED`, or
`EXCEPTION` when the carrier reports a delay), the date the carrier promises
and, once delivered, when and who signed for it.

- Option **2.6 TRACKING** (CUSS03, also `TRACK 1Z...`) finds a shipment by
  its number, its invoice or its tracking number and lists the scans, newest
  first. PF5 asks the carrier again, PF4 opens the shipment and PF6 the
  order timeline. `T` beside a shipment on the shipping list, or PF5 on a
  shipped one, opens it too.
- The shipping list's status column says where shipped ones are (`INTRANS`,
  `OUTDLVY`, `DELIVRD`, `EXCEPTN`), and the shipment and invoice screens show
  it next to the tracking number.
- Company truck drivers have no scanner, so a truck delivery can be signed
  off by hand: type who signed and press PF10 on CUSS03.
- Out for delivery, delivered and exceptions wake the order's lifecycle, so
  they land on its timeline (option 2.4). An exception also writes
  `CUS1701W` to SYSLOG. Deliveries show in the customer's event history.

Each carrier is reached through a `TrackingProvider` (`worker/src/tracking.ts`).
**For now every carrier is simulated**: the simulator plays out a believable
trip for each tracking number (label, pickup, the carrier's hub, destination,
out for delivery, signed), timed by the CARRIER table's transit days, and
holds about one shipment in ten up a day. Real tracking needs, per carrier:

- **UPS:** a UPS developer account (developer.ups.com) with an app that has
  the Tracking API, and its OAuth client ID and secret, stored as Worker
  secrets `UPS_CLIENT_ID` and `UPS_CLIENT_SECRET`. The UPS account number
  that ships is needed if the app is to see our shipments' full detail.
- **FedEx:** a FedEx Developer Portal project (developer.fedex.com) with the
  Track API, its API key and secret key as `FEDEX_API_KEY` and
  `FEDEX_SECRET_KEY`, and the shipping account number. New projects start
  on the sandbox; production keys follow FedEx's approval.

With those in place, a provider for each is registered with
`registerProvider` and the simulator steps aside for that carrier.

The API: `GET /v1/shipments/{id}/tracking` (`POST` to ask the carrier
first), `GET /v1/track/{number}` by shipment, invoice or tracking number, and
`POST /v1/shipments/{id}/delivered` with `{"signed_by"}` for the truck.

## Freight operations

Freight to OH, IN, KY, MI, PA and WV goes on the company's own trucks
(carrier `TRK`, chosen when the shipment is packed). Menu option **7 FREIGHT**
runs that fleet (`worker/src/fleet.ts`, migration 0031).

- **7.1 TRUCKS** (CUSF01) lists the trucks: capacity, the license class it
  takes to drive (A for the tractor-trailer, B for the box trucks), odometer,
  status and when the next service is due, every 15,000 miles or 90 days,
  whichever comes first. `S` shows one (CUSF02), `U` or PF4 there changes it,
  PF6 adds one, and `V` (or PF5 on CUSF02) records a service. A truck that is
  due, in the shop or retired is not planned.
- **7.2 DRIVERS** (CUSF03) lists the drivers with their license class and
  expiry, and their hours on duty in the last 7 days against the 60 allowed.
- **7.3 LOADS** (CUSF05) plans a day: PF6 takes the packed truck shipments
  waiting and groups them into loads. It sweeps round the warehouse by
  compass direction, splitting where the directions leave a gap, so a load
  runs one road out; a load is no heavier than the biggest free truck and
  fits in a day's hours of service (11 hours driving, 14 on duty), or, for a
  stop too far for a day, as an overnight run. If there are more loads than
  trucks, the neighbouring loads that merge for the fewest extra miles are
  merged. Each load goes on the smallest truck it fits, with the driver with
  the narrowest license that takes that truck who has the hours left this
  week, and its stops are put in the order that drives the fewest miles.
  Shipments that cannot go (too heavy for every truck, or no truck or driver
  left) keep waiting, with the reason. PF9 submits `CUSLOAD` for manifests.
- **CUSF06 LOAD** (`S` on a load, or `LOAD 7`) shows the crew, which can be
  changed while it is planned, and the stops with their miles and when the
  plan has the truck there. PF10 dispatches it: its shipments ship (an 856
  goes to EDI customers) and are out for delivery on the truck, and shipping
  one by hand is refused while it is on a planned load. PF9 cancels a
  planned load and its shipments wait again.
- **Proof of delivery**, on CUSF06 while the load is out: type who signed
  (and the cartons they took, if not all) and put `D` beside the stop; or
  type why it was not delivered (`RECEIVER CLOSED`, `REFUSED`) and put `X`.
  Delivered is the shipment's delivery, with who signed and any shortage,
  on its tracking (2.6) and its order's timeline (2.4). Not delivered is an
  exception there, and the shipment rides back and waits for the next load
  (`REDELIVER`), which takes it out again without shipping it twice. Signing
  off a truck delivery from the tracking screen signs off its stop. Drivers
  can also post it to the API. When the truck is back, with every stop
  signed off, type the miles (blank for the planned miles) and press PF10:
  the load is complete and the truck's odometer goes up.
- **7.4 DISPATCH** (CUSF07) is the dispatch board: each truck's load, its
  stops delivered (`*`), not delivered (`X`), the next (`>`) and still to go
  (`.`), the next stop's city and when the truck should be there, from the
  last stop signed off (red when the truck is behind), and when
  it is due back; then the trucks that are free, in the shop or due for
  service.
- **Freight costs.** Each truck has a cost per mile (fuel, tires,
  maintenance) and each driver an hourly rate (with benefits), set on 7.1
  and 7.2 (migration 0033). When the truck is back, the load costs its
  miles at the truck's rate and the driver's hours on duty at theirs; the
  cost is shared over its shipments by weight, and the load records what
  UPS or FedEx would have charged for the same shipments from the `CARRIER`
  table. CUSF06 shows both once the load is complete. A shipment packed for
  UPS or FedEx carries the carrier's charge from the same table.
- **7.5 COSTS** (CUSF08, or `FREIGHTCOST`) is freight cost by route for a
  month: each completed load with its truck, miles, cost, cost per mile and
  the carrier equivalent, the totals per truck, and what went by carrier.
  The month-end journal posts the carriers' charges to 5200 against 2100
  Accrued freight, and the trucks' costs to 5210 against 2110 Accrued fleet
  costs.

There is no map service: the cities the truck serves are in
`worker/src/geo.ts`, and road miles are the great-circle distance times 1.2,
at 50 mph, with 30 minutes at each stop. Planning, dispatch, a truck's return
and services are logged on SYSLOG as `CUS19xx`.

The API: `/v1/trucks`, `/v1/drivers`, `/v1/loads` (`POST /v1/loads/plan`,
`POST /v1/loads/{id}/dispatch`, `POST /v1/loads/{id}/stops/{shipment}/delivered`
with `{"signed_by", "cartons", "note"}`, `.../missed` with `{"reason"}`,
`POST /v1/loads/{id}/return` with `{"miles"}`), `GET /v1/dispatch` and
`GET /v1/freight/costs?month=YYYY-MM`.

## Accounts receivable and the general ledger

Menu option 4.1 opens the **GENERAL LEDGER** (CUSA01): the trial balance
for the open period (or any period typed at `PERIOD`), each account's
balance as of the period's end and its activity in the period, and a check
that the receivables control account agrees with what customers owe. `S`
beside an account lists its entries on **ACCOUNT LEDGER** (CUSA02).

The ledger is fed in batch from the subledgers:

| Source | Debit | Credit |
| --- | --- | --- |
| Invoice posted to a customer | 1200 Accounts receivable | 4000 Sales |
| Payment posted | 1000 Cash | 1200 Accounts receivable |
| Cost of a billed invoice (at product unit cost) | 5000 Cost of goods sold | 1300 Inventory |
| Goods received on a purchase order | 1300 Inventory | 2000 Accounts payable |
| Stock gained by hand (a new product's stock, or a higher on hand or unit cost on the product screen) | 1300 Inventory | 5100 Inventory adjustments |
| Stock lost by hand (a lower on hand or unit cost) | 5100 Inventory adjustments | 1300 Inventory |
| Shipment shipped by UPS or FedEx (the carrier's charge) | 5200 Freight - carriers | 2100 Accrued freight |
| Company truck load back (miles and driver's hours) | 5210 Freight - company truck | 2110 Accrued fleet costs |

Each hand edit that changes the stock's value at cost is recorded in
`stock_adjustments`, and the product screen's message shows the amount.

The first run also posts opening balances against 3000 Retained earnings
for the customer balances and the stock that were on file before the
ledger began. Each source row is journaled once.

- **PF10** submits **CUSTRIAL**: journal the latest activity and print the
  trial balance.
- **PF5** (twice) submits **CUSCLOSE**, the month-end close: journal, print
  the trial balance, close the period and open the next. Later activity
  goes to the new period.
- **PF6** submits **CUSDUNN**: a dunning letter to each customer with an
  invoice billed more than 30 days ago (terms net 30). Each invoice gets a
  reminder, a second notice once it is 30 days past due, and a final notice
  after 60, which also puts the account on hold. Each level goes out once,
  and the letters show in the customer's event history. Invoices with an
  [order lifecycle](#order-lifecycles) are dunned by it instead, on the day
  each letter is due, so the job only writes about invoices without one.

The trial balance and entries are also at `/v1/ledger`.

## Order lifecycles

Each invoice's life, from order to cash, runs as one `OrderLifecycle`
[Workflow](https://developers.cloudflare.com/workflows/) named after the
invoice (`src/lifecycle.ts`):

1. Opened, on a screen, by REST or by a customer's 850.
2. Released to the warehouse, picked and packed, shipped (an 856 for EDI orders).
3. **Billed when it ships**, as `CUSORDER` (an 810 for EDI orders). Billing by
   hand with PF10 still works; the lifecycle sees it and carries on. If the
   customer is on hold, billing waits until the account is active again.
4. Waits for payment, by hand or by a customer's 820.
5. If unpaid, a **reminder** when payment is due (net 30), a **second notice**
   30 days later and a **final notice** 30 days after that, which puts the
   account on hold. Each letter is filed in the archive as a PDF and mailed
   if mail is set up. The workflow sleeps until each date rather than waiting
   for a nightly run.
6. Paid, or cancelled: the lifecycle is complete.

D1 stays the record. The screens and REST endpoints change invoices and
shipments as before and read status from D1, and each turn of the workflow
reads the same rows, records what happened on the order's timeline and
does what the order is waiting on the system for. Every step can run twice.

Changes reach the workflows through an outbox. Triggers on `invoices`,
`shipments` and `customers` (migration 0027) add a row to `order_signals` on
every change, however it was made, and the cron trigger delivers them every
minute: an order's first signal starts its workflow, the rest wake it, and a
workflow that failed is restarted. The migration signalled every invoice
that was open or billed at the time, so those picked up from where they were.

Purchase orders have lifecycles too (`src/polifecycle.ts`), in the same
workflow: opened, sent as an 850, confirmed by the vendor's 855 with a ship
date, in transit after its 856, received (perhaps in parts, each receipt
going into stock) and received in full. Here the vendor is the one who has
to act, so the lifecycle watches the clock: with no 855 two days after
sending, no 856 by the day after the promised ship date, or no goods within
the vendor's lead time (plus two days) of the 856, it raises an **expedite
alert** (`CUS1620W` on SYSLOG and `EXPEDITE` on the timeline), once for each.
Triggers on `purchase_orders` and `receipts` (migration 0029) signal it.

Menu option 2.4 `TIMELINE` (or `T` beside an invoice on the list, or 3.5
`POTIMELINE` for a purchase order, such as `3.5 12`) opens
**ORDER TIMELINE** (CUSL01): where the lifecycle is, what it waits for and
by when, and every event it has seen: opened, released, packed, shipped,
each EDI document, billed, each letter, paid; or for a PO, sent, confirmed,
in transit, each receipt, received. PF4 opens the invoice or PO. The same
is at `GET /v1/invoices/{id}/timeline` and `GET /v1/purchase-orders/{id}/timeline`.

## Reports and dashboard

Menu option 4.2 opens the **REPORTS MENU** (CUSM42). The reports are drawn as
character charts, the way a report writer on a 3270 would draw them, and PF9
prints the whole of any of them to the spool at 80 columns.

| Option | Panel | Shows |
|---|---|---|
| 4.2.1 `DASHBOARD` | CUSR05 | Sales this month, last month and a 12-month trend line; receivables with a bar split by aging bucket; inventory value, turns and products at their reorder point; accounts on hold or near their limit. PF4, PF6 and PF10 open the sales, aging and turns reports. |
| 4.2.2 `SALES` | CUSR02 | Invoices posted (`##`) and payments collected (`==`) per month for the last 12 months as a bar chart, with the figures under it. |
| 4.2.3 `AGING` | CUSR03 | Receivables in the CURRENT, 31-60, 61-90 and OVER 90 buckets as bars, then every account with a balance, oldest money first. Aged the same way as the `CUSAGING` job. |
| 4.2.4 `TURNS` | CUSR04 | Inventory at cost, cost of sales and turns a year, then each product's turns as a bar: red under 1, yellow under 4. |
| 4.2.5 `CREDIT` | CUSR01 | The credit exposure summary. |

Turns are annualized from the last 365 days of billed invoice lines and
goods received, or from the days since the first of them if that is
shorter (but at least 30). Opening stock is today's stock plus what was
sold less what was received, and turns are the cost of sales over the
average of opening and closing stock.

## Batch jobs

Batch work runs the way it would under JES. Submitting a job records it as
`QUEUED` and puts it on the `customer-jobs`
[Cloudflare Queue](https://developers.cloudflare.com/queues/), the input
queue. The queue's consumer starts a `JobRunner`
[Workflow](https://developers.cloudflare.com/workflows/) for the job. Each job
step is a durable workflow step that is retried if it fails. The job shows as
`EXECUTING` while it runs, then `OUTPUT` with its highest condition code
(`0000`, `0004`, or `ABEND`) and a JES-style output listing.

| Job | What it does |
| --- | --- |
| `CUSAGING` | Aged balances report. Payments are applied to the oldest invoices first, and each balance is split into current, 31-60, 61-90 and over 90 days. RC 0004 if anything is over 90 days. |
| `CUSCRREV` | Credit review. STEP010 lists active accounts at 90% of their limit or more. STEP020 puts active accounts that are over their limit on hold, and records each hold in the change history as made by `CUSCRREV`. RC 0004 if it held any. |
| `CUSSTMT` | Statements for every open account with a balance, with the last 30 days of activity. |
| `EDISIM` | EDI trading partner simulator: customers send 850 purchase orders and pay invoices sent as 810s with 820 remittances. |
| `CUSREORD` | Reorder: purchase orders to vendors for every product at or below its reorder point, sent as 850s. RC 0004 if a low product has no vendor. |
| `VENDSIM` | EDI vendor simulator: STEP010 vendors confirm sent POs with 855s, STEP020 they ship confirmed ones with 856s. |
| `CUSPICK` | Pick tickets for every shipment waiting in the warehouse, lines in bin order. |
| `CUSLOAD` | STEP010 plans today's [company truck loads](#freight-operations), STEP020 prints a driver manifest for each load not dispatched yet. RC 0004 if any shipment was left waiting. |
| `CUSTRIAL` | Journal the latest activity into the open period and print the trial balance. RC 0004 if the AR control account and the customer accounts disagree. |
| `CUSCLOSE` | Month-end close: STEP010 journal, STEP020 trial balance, STEP030 close the period and open the next. |
| `CUSDUNN` | Dunning letters for invoices more than 30 days old that have no [order lifecycle](#order-lifecycles); final notices put the account on hold. RC 0004 if any letters were printed. |

In the terminal, menu option 5.1 opens **BATCH JOBS** (CUSJ01). Type a job name
at `SUBMIT JOB ===>` and press Enter, and the job is listed with its status,
like SDSF. PF5 refreshes the list, and `S` beside a job opens its output listing
(CUSJ02), which PF7 and PF8 scroll. `E` beside a failed job, or PF6 on its
output, explains the failure (see [Asking the system](#asking-the-system)).

The deploy job creates the queue the first time, which needs
**Account → Queues → Edit** on the `CLOUDFLARE_API_TOKEN`. You can also
create it yourself with `npx wrangler queues create customer-jobs`. Wrangler
creates the workflows when it deploys.

## Operator console and job scheduler

Menu option 5.2 opens the **OPERATOR CONSOLE** (CUSO01), which shows SYSLOG,
the system log: jobs being submitted, starting and ending (`$HASP100`,
`$HASP373`, `$HASP395`), abends, the scheduler releasing jobs, logons and
logoffs, and operator commands with their responses. While it shows the end
of the log it is live: the terminals keep a WebSocket open to `GET /v1/live`,
and a watcher in the TSO Durable Object tells them within a second when the
log moves, so new lines appear as they are written. A terminal without the
connection redraws every 5 seconds instead (the `refresh` key in the
[screen protocol](docs/screen-protocol.md)). Either way it waits while you
are typing a command. PF7 scrolls back and holds the display; PF8 back to the end, or PF5,
follows it again.

Commands go in the log with their responses, for every console to see:

| Command | What it does |
| --- | --- |
| `D T` | Display the time, local and UTC |
| `D J` | Display the jobs that are queued or executing |
| `D SCHED` | Display the job schedule |
| `S jobname` | Submit a job |
| `H jobname`, `A jobname` | Hold or release a job's schedule |
| `D TS` | Display the TSO users: session, terminal, screen and idle time |
| `D GRS` | Display the records locked for update, and by whom |
| `SEND 'text' USER(id)` | Send a message (see [Session](#session)) |

PF6 opens the **JOB SCHEDULE** (CUSO02). A Worker
[cron trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
runs every minute and submits each active job whose cron expression (five
fields, in UTC) matches that minute, as `SCHEDULR`. The schedule starts with
the nightly run at 1-2 AM US Eastern:

| Job | Cron (UTC) | |
| --- | --- | --- |
| `CUSCRREV` | `0 6 * * *` | active |
| `CUSAGING` | `15 6 * * *` | active |
| `CUSSTMT` | `30 6 * * *` | active |
| `EDISIM` | `0 * * * *` | held |

Type a job and a cron and press Enter to add a job or change its cron. Beside
a job, `H` holds it, `R` releases it, `S` submits it now and `D` takes it off
the schedule. Any job in the job library can be scheduled. The log keeps the
newest 10,000 lines.

## Print spool

Job output and printed reports are held on the spool until someone deals
with them, as under JES. Every job's output listing goes there under the
job's ID when the job ends, and PF9 on any of the reports (option 4.2) prints
the report to it under a TSU ID, as from a TSO session.

Menu option 5.4 (`5.4 CUS` for jobs starting CUS) opens the **HELD OUTPUT
QUEUE** (CUSQ01), like SDSF's H panel. Beside an output group, `S` browses it
(CUSQ02, where PF4 prints it), `O` prints it on `PRT1`, and `P` purges it.
Printed output stays on the spool marked `PRINTED` with a copy count, so `O`
again is a reprint. Each print is logged on SYSLOG as `$HASP150` and each
purge as `$HASP250`. Purging a job's output removes the job from the batch
job list too. `PRT1` is simulated: `GET /v1/spool/{id}/print` returns the
listing paged for it, 60 lines to a page with a heading and a form feed
between pages.

## PDFs and the archive

Documents come out as PDFs, drawn the way an impact printer fills
preprinted forms: Courier at 10 characters to the inch on a letter page
under the company heading.

- **Listings**: `D` beside output on CUSQ01, or PF10 on CUSQ02, sends it on
  14 7/8 x 11 inch green-bar paper, tractor holes and all.
- **Invoices**: PF2 on an invoice (CUSI02). An open one prints as a pro forma,
  a paid one is stamped PAID.
- **Statements**: PF2 on customer inquiry (CUSM02), the last 30 days with an
  aging line.

The file arrives with the screen (see `download` in
[docs/screen-protocol.md](docs/screen-protocol.md)): the Go terminal saves it
in `~/terminal-prints` and says where on the message line; the browser
downloads it. The same PDFs are at `GET /v1/spool/{id}/pdf`,
`GET /v1/invoices/{id}/pdf` and `GET /v1/customers/{id}/statement`.

The **archive** is an R2 bucket, `customer-archive`. Each entry is a text
file and a PDF:

| What | Filed by | Key |
| --- | --- | --- |
| Spool output more than 7 days old, moved off the spool | **CUSARCH**, daily at 05:00 UTC | `spool/2026-10/JOB00012` |
| Each customer's statement | **CUSSTMT** | `statements/2026-10/000101` |
| Each dunning letter | **CUSDUNN** | `letters/2026-10-26/000101-L2` |
| The trial balance and aging of a closed month | **CUSCLOSE** (STEP040) | `month-end/2026-10/TRIALBAL` |

Option 5.7 opens **ARCHIVE** (CUSQ03; PF6 from held output gets there too):
filter by name or reference and by kind, `S` browses an entry (CUSQ04), `D`
sends its PDF, and `R` restores an archived listing to the spool, held,
under its old ID. The API is `GET /v1/archive?name=&kind=`,
`GET /v1/archive/{key}` (`.pdf` and `.txt` for the files) and
`POST /v1/archive/restore {"key"}`.
## Transaction monitor

Every request the Worker answers is timed and written to
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
(dataset `customer_transactions`). A screen request counts as the transaction
of the screen it sends back (`CUSM00`, `CUSO01`), an API call as its route
(`GET /v1/customers/:id`).

Menu option 5.5 (or `MONITOR`) opens the **TRANSACTION MONITOR** (CUSO03),
like CICS statistics: the total, transactions per minute, average and
maximum response time and abends (status 500 and up) for the window, then
by transaction with count, rate, average, 95th percentile and maximum. PF6
switches to the rate over time with a bar per interval, PF10 and PF11
shorten and lengthen the window (5 minutes to 24 hours), and the screen
refreshes every 30 seconds. `GET /v1/monitor` returns the same figures.

Writing needs only the binding. Reading uses the Analytics Engine SQL API,
which needs an API token with **Account → Account Analytics → Read**, set as
a Worker secret: `cd worker && npx wrangler secret put AE_API_TOKEN`. Until
it is set, the screen says so and `GET /v1/monitor` answers 503.

## System tables

Small reference tables live in [Workers KV](https://developers.cloudflare.com/kv/)
(namespace `customer-api-tables`, binding `TABLES`) so every request can read
them from the edge cache:

| Table | What it holds |
| --- | --- |
| `CARRIER` | Carriers: priority, service states, weight, carton and order value limits, base and per-pound charge, transit days. Carriers are tried by priority and the first whose limits all hold takes the order; the defaults are the shipping desk's routing (UPS up to 149 lb, 70 lb a carton and $4,999; freight beyond that on the truck in OH IN KY MI PA WV, FedEx Freight otherwise). |
| `TAXCODE` | Sales tax rate by ship-to state, and whether freight is taxed. |
| `HELP` | PF1 help text by `panel.field` (`BROWSE.FILTER`) or field name. A row replaces the built-in help for that field, keeping its list of valid values, or adds help where there is none. |

Menu option 5.6 (or `TABLES`) opens **SYSTEM TABLES** (CUSO04). `S` shows a
table's rows (CUSO05), where `U` changes a row (CUSO06), `D` deletes one,
PF5 adds one and PF9 twice puts the table back to its defaults. Changes are
logged on SYSLOG (`CUS0801I`-`CUS0803I`). A table nobody has changed is not
stored and reads as its defaults. KV is eventually consistent, so another
location can see the old row for up to a minute.

## Email

Mail goes through Cloudflare Email Routing on **parkerfrank.com**. The demo's
customers aren't real, so every outbound message goes to one verified
address (`MAIL_TO` in `worker/wrangler.jsonc`, and the `send_email` binding's
`destination_address`) and its subject names the customer it is for.

- **CUSSTMT** STEP020 mails each statement it filed as a PDF. A statement is
  filed once per customer per month, and each one is mailed once, so customers
  get one statement a month however often the job runs.
- **CUSDUNN** STEP020 mails each new dunning letter.
- `M` beside an entry on ARCHIVE (5.7) mails that PDF.

Mail sent to the domain and routed to the Worker (an Email Routing rule such
as `po@parkerfrank.com` -> Worker `customer-api`) is read as a vendor's reply.
A subject like `PO00012 CONFIRMED SHIP 2026-11-05` confirms the purchase order
the way an 855 would, and `PO00012 SHIPPED` puts it in transit the way an 856
would. Anything else is bounced with the reason.

Option 5.8 **MAIL LOG** (CUSQ05) lists everything sent and received; `S` shows
one message (CUSQ06). The API is `GET /v1/mail?ref=` and `GET /v1/mail/{seq}`.

Setup, once, in the Cloudflare dashboard: enable Email Routing on
parkerfrank.com, verify the `MAIL_TO` address under Destination addresses, and
add the routing rule for inbound vendor mail.

## Printing a screen

Ctrl+P saves the screen as a text file, like a 3270 local copy, and the status
line shows `PRINTED`. Files go to `~/terminal-prints` (change it with
`-print-dir`) and are named `PRINT-20261025-112306.txt`.

Ctrl+S saves a **snapshot**: a picture of the screen, colors, typed input and
cursor included, drawn by Cloudflare Browser Rendering. Ctrl+S makes a PNG and
Esc then S a PDF; the status line shows `SNAP...` and then `SNAPPED`, and the
file (`CUSM00-202610261112.png`) goes in the same folder. In the browser it is
Ctrl+S (Ctrl+Shift+S for a PDF) or the SNAP button, and the file downloads.
The terminal sends the screen as it shows it to `POST /v1/snapshot`
([docs/screen-protocol.md](docs/screen-protocol.md#snapshots)).

Printed output can be pictured too: `I` beside an output group on the spool
(option 5.4) sends its first page as a PNG on green-bar paper, and PF11 while
browsing a listing sends the page you are looking at. The API is
`GET /v1/spool/{id}/png?page=N`.

Browser Rendering needs nothing set up beyond the `browser` binding in
`wrangler.jsonc`; it is billed by browser time, a second or two a snapshot.

## Keyboard

| Key | 3270 function |
| --- | --- |
| Enter | ENTER |
| F1-F12, Shift+F1-F12 | PF1-PF12, PF13-PF24 |
| PgUp / PgDn | PF7 / PF8 |
| Esc, then 1-9, 0, -, = | PF1-PF9, PF10, PF11, PF12 (for when macOS keeps the F keys) |
| Shift+F12, or Esc then Up | PF24, RETRIEVE the last command |
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
| Ctrl+S / Esc then S | Snapshot: a PNG / PDF of the screen |
| Ctrl+C | Disconnect |

## Development

```sh
cd worker && npm test && npm run typecheck # API, in the Workers runtime
```

```
.github/workflows/   CI: test both halves, deploy the Worker from main
go.mod               pins the terminal client, greenscreen's (go tool greenscreen)
worker/              the API: Cloudflare Worker + D1 (TypeScript)
  src/               routes, auth, validation, batch jobs, scheduler, SYSLOG
  migrations/        D1 schema
  seed.sql           demo customers
  test/              API tests (vitest, Workers runtime)
```

The terminal client, the browser terminal and the screen engine come from
[greenscreen](https://github.com/sdf1jpf/greenscreen): the Go client is pinned
in `go.mod`, and `@greenscreen-dev/worker` and `@greenscreen-dev/web` are in
`worker/package.json`. Everything specific to this system (the panels, the
data, the console watcher in `worker/src/sessions.ts`) lives here.
