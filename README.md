# terminal

A Go application that looks and behaves like an IBM 3270 mainframe application
(think CICS or ISPF on a 3278 Model 2), running on a modern stack: Bubble Tea
for the terminal UI and Wish for an optional SSH server.

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

## Run it

```sh
go run .                     # in your terminal (needs at least 80x26)
go run . -data customers.json   # keep changes between runs
go run . -ssh :2323          # serve it; connect with: ssh -p 2323 localhost
```

Log on with **IBMUSER / SYS1** (or GUEST / GUEST).

Flags: `-ssh addr`, `-hostkey path`, `-data file.json`, `-system SYS1`,
`-latency 150ms` (simulated host response time; `0` turns it off).

## What makes it feel like a 3270

It is block mode, not a line-by-line TUI. The screen is a 24x80 buffer of
fields, and each field starts with an attribute byte that takes up a screen
position, just as on real hardware. You edit fields locally, and nothing goes
to the "host" until you press an AID key (Enter, a PF key, PA1-PA3, or Clear).
Then the whole screen is sent and the host replies with a new one.

- Protected and unprotected fields, numeric-only fields, non-display (password)
  fields, intensified fields, and the 7 extended colors.
- Auto-skip to the next field when one fills up. Input is folded to upper case.
- Keyboard locks in the operator information area (the status line):
  `X ()` while the host is busy, `X -f` when you type into a protected
  position, `X NUM` for a letter in a numeric field, and `X >` when insert mode
  runs out of room. Press Reset (Esc) to clear the lock.
- Insert mode (`^`), Erase EOF, Erase Input, Tab/Backtab, and the cursor
  address shown as `row/col`.
- IBM-style message IDs (`CUS0233E ZIP CODE MUST BE FIVE DIGITS`), with the
  failing field brightened and the cursor placed on it.

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

## The sample application

A CICS-style customer information system:

- **Logon**: a VTAM-style welcome screen.
- **Primary option menu**: ISPF style. Shortcuts like `2 105` jump straight to
  customer 000105.
- **Browse**: a paged customer list (PF7/PF8) with a name filter and line
  commands `S`, `U` and `D`.
- **Inquiry / update / add / delete**: field validation, and PF10 to confirm a
  delete.
- **Credit exposure report**, plus a **tutorial** you can reach with PF1 from
  any screen.

## Layout

```
main.go                 flags, local mode, SSH server
internal/tn3270/        the terminal: screen buffer, fields, keyboard, rendering
internal/host/          the "mainframe" programs (one per screen)
internal/store/         customer master file (in memory, optional JSON file)
```

To write your own screen, implement `host.Program`:

```go
func (p *myScreen) Render(s *Session) *tn3270.Screen {
	scr := tn3270.NewScreen()
	header(scr, s, "MYMAP1", "MY TRANSACTION")
	label(scr, 4, 2, "ACCOUNT ===>")
	scr.Input(4, 15, 8, "acct", p.acct, tn3270.Numeric)
	keys(scr, "PF3=EXIT")
	scr.CursorTo("acct")
	return scr
}

func (p *myScreen) Handle(s *Session, aid tn3270.AID, scr *tn3270.Screen) Program {
	if aid == tn3270.PF(3) {
		return &menu{}
	}
	p.acct = scr.Fields()["acct"]
	return p
}
```

`tn3270.Host` is the only thing the terminal depends on, so you can put the
same terminal in front of a different backend, such as a real API.
