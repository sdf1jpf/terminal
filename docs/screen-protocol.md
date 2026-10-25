# Screen protocol (v1)

The Worker owns the application's screens. A client (the Go terminal, or a
browser page) is a generic 3270 display: it draws the fields it is sent,
lets the operator edit the input fields locally, and when the operator
presses an AID key (Enter, Clear, a PA or PF key) it sends the key, the
input fields and the cursor position back. The Worker replies with the next
screen. This is how a 3270 talks to a CICS transaction, so new screens ship
with a Worker deploy and no client changes.

There are no sessions on the server. Each reply carries `state`, an opaque
string (the "commarea") that the client must send back unchanged with the
next request. It records which panel is showing and what it needs to carry
on: a filter, a scroll position, the record being edited. The Worker never
trusts it for anything the caller could not do anyway: every request is
signed in through Cloudflare Access on its own, like the rest of the API.

## Request

`POST /v1/screen`, behind Cloudflare Access like every endpoint but health.

```json
{
  "v": 1,
  "aid": "ENTER",
  "state": "…from the last response…",
  "fields": { "filter": "ACME", "sel:000101": "" },
  "modified": ["filter"],
  "cursor": { "row": 4, "col": 27, "field": "filter" },
  "rows": 24,
  "cols": 80,
  "terminal": "TERM0001",
  "system": "SYS1",
  "tz_offset": -240
}
```

| Key | Meaning |
| --- | --- |
| `v` | Protocol version, 1. |
| `aid` | The key: `ENTER`, `CLEAR`, `PA1`-`PA3`, `PF1`-`PF24`. Two more are not keys: `START` asks for the first screen after logon (send no `state`), and `REDRAW` asks for the current screen again at a new `rows`/`cols`, without acting on any input. |
| `state` | The `state` string from the previous response. Leave it out on `START`. |
| `fields` | Every named input field on the screen, as the operator left it: nulls removed and trailing blanks trimmed. |
| `modified` | Names of the input fields whose modified data tag is set (the operator typed in them). |
| `cursor` | 1-based row and column of the cursor, and the name of the input field it is in, or `""`. Field-level help (PF1 on a field) uses `field`. |
| `rows`, `cols` | Size of the presentation space. The Worker lays the screen out for it, no smaller than 24x80. |
| `terminal`, `system` | The terminal (LU) name and system name to show on screens. Optional. |
| `tz_offset` | The client's offset from UTC in minutes (east positive), so times show in local time. Optional, default 0. |

## Response

`200` with either a screen:

```json
{
  "v": 1,
  "state": "…",
  "screen": {
    "map": "CUSM01",
    "rows": 24,
    "cols": 80,
    "fields": [
      { "row": 1, "col": 2, "text": "CUSM01", "color": "blue" },
      { "row": 4, "col": 2, "text": "NAME STARTS WITH ===>", "color": "turquoise" },
      { "row": 4, "col": 24, "name": "filter", "length": 20, "value": "ACME" }
    ],
    "cursor": { "field": "filter" }
  }
}
```

or, when the operator logs off, `{"v": 1, "logoff": {"message": "IKJ56470I IBMUSER LOGGED OFF AT 11:23:06"}}`.
The client then goes back to its own logon screen and shows the message.

Errors use the API's usual envelope, `{"error": {"code", "message"}}`. A
`401` (or Access redirecting to its login page) means the sign-in has expired:
go back to the logon screen. If the API cannot be reached, keep the screen
and what the operator typed, show a message, and let Enter retry with the
same `state`.

### Fields

`fields` is applied in order to a cleared screen of `rows` x `cols`, the
way a BMS map is:

- A field starting at `row`/`col` has its attribute byte at the position
  just before it (column `col - 1`, wrapping to the previous row). The
  attribute position shows as a blank.
- After the field's data, a protected attribute (a "stopper") is placed
  unless another field already starts there.
- Everything outside a field is protected and blank.

A field with `text` is protected output. A field with `name` and `length`
is an unprotected input field, prefilled with `value`.

| Key | Applies to | Values (default first) |
| --- | --- | --- |
| `row`, `col` | all | 1-based position of the first data character. |
| `text` | output | The text. |
| `name`, `length`, `value` | input | Field name sent back in `fields`; length in characters; initial contents. |
| `color` | all | `default`, `blue`, `red`, `pink`, `green`, `turquoise`, `yellow`, `white`. |
| `bright` | all | `false`, `true`: high intensity. |
| `highlight` | all | `none` for output and `underscore` for input; also `reverse`, `blink`. |
| `hidden` | all | `false`, `true`: non-display, e.g. a password. |
| `numeric` | input | `false`, `true`: only digits may be typed. |
| `mixed` | input | `false`, `true`: keep lower case. Otherwise the client folds typed letters to upper case. |

Keys at their default are left out. With color `default` the 3270 base
colors apply: protected is blue, protected and bright is white, input is
green, input and bright is red.

### Cursor

`cursor` is `{"field": name}` (the first position of that input field),
`{"row", "col"}`, or absent (the first input field, as the Home key does).

## Conventions for screens

These keep the panels consistent; they are not enforced by the protocol.

- Rows 1 and 2 are the heading: map name at the left, title centered, date
  and time at the right edge.
- The second to last row is the message line. Message IDs end in a severity
  letter, IBM style (`E` error in red, `W` warning in yellow, `I` info in white).
- The last row is the PF key legend, in turquoise.
- Screens wider or taller than 24x80 keep right-hand fields at the right edge
  and give extra rows to lists.
- PF1 is help on every screen. PF3 goes back, PF12 cancels, PF7/PF8 scroll.

## In the Worker

The panels live in `worker/src/screens/`, one module per panel. Each one is
a `Program` with a `render` (state to screen) and a `handle` (state plus AID
and input to the next state); `screens/index.ts` registers them and
`screens/screen.ts` has the builder (`text`, `input`, `header`, `label`,
`value`, `message`, `keys`). Data access stays in plain functions outside the
screens (`worker/src/data.ts`), shared with the REST endpoints.
