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
3. **Let the token create the batch job queue:** add **Account → Queues →
   Edit** to the same token, or create the queue once yourself (see
   [Batch jobs](#batch-jobs)).
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
| `-api URL` or `TERMINAL_API_URL` | API base URL (default `http://localhost:8787`) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Use an Access service token instead of a browser sign-in |
| `-system SYS1`, `-lu TERM0001` | Names shown on the screens |
| `-latency 150ms` | Extra delay on each response, to make the `X ()` lock easier to see |
| `-print-dir DIR` | Where Ctrl+P saves screens (default `~/terminal-prints`) |
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
Reset, PA1, PA2, PF1 to PF12 and RETRV (PF24) as buttons. The page lives in `worker/public/`
and is plain HTML, CSS and JavaScript with no build step.

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
GET    /v1/products?prefix=X    product file, ordered by SKU
GET    /v1/products?q=X         active products whose SKU or description contains X
POST   /v1/products             add a product
GET    /v1/products/{sku}
PUT    /v1/products/{sku}       update ("version" must match)
POST   /v1/jobs                 submit a batch job: {"name":"CUSAGING"}
GET    /v1/jobs                 recent jobs, newest first
GET    /v1/jobs/{id}            a job and its output listing
GET    /v1/syslog?before=N      the system log, newest first (&limit=, up to 500)
GET    /v1/schedules            the job schedule, with each job's next run
PUT    /v1/schedules/{job}      schedule a job: {"cron":"0 6 * * *","enabled":true}
DELETE /v1/schedules/{job}
GET    /v1/spool?name=X         the print spool, newest first
GET    /v1/spool/{id}           an output group and its lines
GET    /v1/spool/{id}/print     paged for the printer, as text/plain
POST   /v1/spool/{id}/print     print it on PRT1 (again, for a reprint)
DELETE /v1/spool/{id}           purge it, and its job
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

## The menu

The primary option menu (CUSM00) lists one option per module, and each opens
its own submenu; PF3 goes back up, and PF3 on the primary menu logs off.

| Option | Submenu | Options |
| --- | --- | --- |
| 1 | CUSTOMERS | 1 Browse, 2 Inquiry, 3 Add, 4 Event history |
| 2 | ORDERS | 1 Invoices, 2 Shipping, 3 EDI mailbox |
| 3 | INVENTORY | 1 Products, 2 Purchase orders, 3 Vendors |
| 4 | ACCOUNTING | 1 General ledger, 2 Reports (1 Dashboard, 2 Sales, 3 Aging, 4 Turns, 5 Credit exposure) |
| 5 | OPERATIONS | 1 Batch jobs, 2 Console/SYSLOG, 3 Job schedule, 4 Held output, 5 Transaction monitor, 6 System tables |
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

## Session

The status line shows the system name and the time next to the terminal name.
On the menus and the operator console, PF24 (Shift+F12, Esc then Up, or the
RETRV button in the browser) is RETRIEVE: it brings back the last command
you entered, and pressing it again goes further back. A terminal left without
a key pressed for 30 minutes logs itself off, as TSO does with an S522.

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
  is priced from the product file and its quantity comes out of stock at once.
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
| 850 purchase order | in | Opens an invoice for the sender and adds its lines, taking the stock. If any line can't be filled, the whole order is rejected and the stock returned. |
| 997 acknowledgment | out | Sent for every inbound interchange from a known customer: accepted, or rejected with the reason kept on the mailbox. |
| 856 ship notice | out | Sent when an invoice that came from an 850 ships. |
| 810 invoice | out | Sent when an invoice that came from an 850 is billed (PF10). |
| 820 remittance | in | Marks each invoice it names paid, if the amounts agree. |

Any customer can trade: its interchange ID (ISA06) is its customer number,
and ours is `CUSTAPI`. Interchanges arrive with `POST /v1/edi` (the raw X12
as the body), wait on the `customer-jobs` queue and are processed by its
consumer. PF6 on the mailbox submits the **EDISIM** job, which plays the
customers' side: up to three customers send purchase orders (now and then
for a product we don't carry, which is rejected), and each customer pays
the billed invoices we sent it an 810 for. EDI traffic also shows in the
customer's event history.

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
  system then picks the carrier from the invoice's ship-to, the weight and
  the order's value, and the screen shows which one and why:
  - `TRK` (company truck) when the ship-to is in the truck area: the
    warehouse's state (OH) and IN, KY, MI, PA, WV.
  - `FDX` (FedEx Freight) elsewhere for 150 lb or more, any carton over
    70 lb, or an order of $5,000 or more.
  - `UPS` ground for everything else.

  The rules are `routeFor` in `worker/src/shipping.ts`.
- **Ship:** press PF10 (`SHIPPED`, with a tracking number). A customer that
  ordered by EDI is sent an **856 ship notice** with the cartons, carrier,
  tracking number and lines.
- **Bill:** PF11 on the shipment, or PF10 on the invoice. Billing an
  invoice that has not shipped is refused.

PF6 on the list submits **CUSPICK**, which prints a pick ticket for every
shipment still in picking. Releases and shipments show in the customer's
event history. The API is under `/v1/shipments`.

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
  and the letters show in the customer's event history.

The trial balance and entries are also at `/v1/ledger`.

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
| `CUSTRIAL` | Journal the latest activity into the open period and print the trial balance. RC 0004 if the AR control account and the customer accounts disagree. |
| `CUSCLOSE` | Month-end close: STEP010 journal, STEP020 trial balance, STEP030 close the period and open the next. |
| `CUSDUNN` | Dunning letters for invoices more than 30 days old; final notices put the account on hold. RC 0004 if any letters were printed. |

In the terminal, menu option 5.1 opens **BATCH JOBS** (CUSJ01). Type a job name
at `SUBMIT JOB ===>` and press Enter, and the job is listed with its status,
like SDSF. PF5 refreshes the list, and `S` beside a job opens its output listing
(CUSJ02), which PF7 and PF8 scroll.

The deploy job creates the queue the first time, which needs
**Account → Queues → Edit** on the `CLOUDFLARE_API_TOKEN`. You can also
create it yourself with `npx wrangler queues create customer-jobs`. Wrangler
creates the workflow when it deploys.

## Operator console and job scheduler

Menu option 5.2 opens the **OPERATOR CONSOLE** (CUSO01), which shows SYSLOG,
the system log: jobs being submitted, starting and ending (`$HASP100`,
`$HASP373`, `$HASP395`), abends, the scheduler releasing jobs, logons and
logoffs, and operator commands with their responses. While it shows the end
of the log, the screen asks the terminal to redraw it every 5 seconds (the
`refresh` key in the [screen protocol](docs/screen-protocol.md)), so new
lines appear as they are written. The terminal waits while you are typing a
command. PF7 scrolls back and holds the display; PF8 back to the end, or PF5,
follows it again.

Commands go in the log with their responses, for every console to see:

| Command | What it does |
| --- | --- |
| `D T` | Display the time, local and UTC |
| `D J` | Display the jobs that are queued or executing |
| `D SCHED` | Display the job schedule |
| `S jobname` | Submit a job |
| `H jobname`, `A jobname` | Hold or release a job's schedule |

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
| `CARRIER` | Carriers: priority, service states, weight, carton and order value limits, base and per-pound charge, transit days. Carriers are tried by priority and the first whose limits all hold takes the order; the defaults are the shipping desk's routing (truck in OH IN KY MI PA WV, UPS up to 149 lb, 70 lb a carton and $4,999, FedEx Freight otherwise). |
| `TAXCODE` | Sales tax rate by ship-to state, and whether freight is taxed. |
| `HELP` | PF1 help text by `panel.field` (`BROWSE.FILTER`) or field name. A row replaces the built-in help for that field, keeping its list of valid values, or adds help where there is none. |

Menu option 5.6 (or `TABLES`) opens **SYSTEM TABLES** (CUSO04). `S` shows a
table's rows (CUSO05), where `U` changes a row (CUSO06), `D` deletes one,
PF5 adds one and PF9 twice puts the table back to its defaults. Changes are
logged on SYSLOG (`CUS0801I`-`CUS0803I`). A table nobody has changed is not
stored and reads as its defaults. KV is eventually consistent, so another
location can see the old row for up to a minute.

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
  src/               routes, auth, validation, batch jobs, scheduler, SYSLOG
  migrations/        D1 schema
  seed.sql           demo customers
  test/              API tests (vitest, Workers runtime)
```

To point the terminal at a different API, implement `host.Backend` (`Logon`,
`List`, `Get`, `Create`, `Update`, `Delete`, …) and pass it in `host.Config`.
The screens don't change.
