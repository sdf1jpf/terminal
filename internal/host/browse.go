package host

import (
	"fmt"
	"strings"

	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

const pageRows = 13

// browse is a scrollable list of customers with a selection column, in the
// style of an ISPF member list.
type browse struct {
	filter string
	top    int
	ids    []string // customer ids on the current page, by row
	msg    string
	errRow int // 1-based row index with a bad selection code, 0 for none
}

func (b *browse) Render(s *Session) *t3.Screen {
	scr := t3.NewScreen()
	header(scr, s, "CUSM01", "CUSTOMER BROWSE")

	list := s.cfg.Store.List(b.filter)
	b.top = min(b.top, max(len(list)-pageRows, 0))

	label(scr, 4, 2, "NAME STARTS WITH ===>")
	scr.Input(4, 24, 20, "filter", b.filter)
	if len(list) > 0 {
		end := min(b.top+pageRows, len(list))
		scr.Text(4, 58, fmt.Sprintf("ROW %d TO %d OF %d", b.top+1, end, len(list)), t3.WithColor(t3.White))
	}

	scr.Text(5, 2, "SELECT: S=SHOW  U=UPDATE  D=DELETE", t3.WithColor(t3.Blue))
	scr.Text(7, 2, "S CUST NO  NAME                     CITY            ST      BALANCE STAT",
		t3.WithColor(t3.White), t3.Bright)
	scr.Text(8, 2, strings.Repeat("-", 77), t3.WithColor(t3.Blue))

	b.ids = b.ids[:0]
	for i := 0; i < pageRows && b.top+i < len(list); i++ {
		c := list[b.top+i]
		row := 9 + i
		var opts []t3.Opt
		if b.errRow == i+1 {
			opts = append(opts, t3.Bright)
		}
		scr.Input(row, 2, 1, fmt.Sprintf("sel%d", i), "", opts...)
		color := t3.Green
		switch c.Status {
		case "H":
			color = t3.Yellow
		case "C":
			color = t3.Pink
		}
		scr.Text(row, 4, fmt.Sprintf("%-8s %-24.24s %-15.15s %-2s %12s %s",
			c.ID, c.Name, c.City, c.State, money(c.Balance), c.Status), t3.WithColor(color))
		b.ids = append(b.ids, c.ID)
	}
	if len(list) == 0 {
		scr.Text(9, 4, "NO CUSTOMERS MATCH THE FILTER", t3.WithColor(t3.Yellow))
	} else if b.top+pageRows >= len(list) {
		bottom := strings.Repeat("*", 30) + " BOTTOM OF DATA " + strings.Repeat("*", 30)
		scr.Text(9+len(b.ids), 4, bottom, t3.WithColor(t3.Blue))
	}

	message(scr, b.msg)
	keys(scr, "PF1=HELP  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN  PF12=CANCEL")
	if b.errRow > 0 {
		scr.CursorTo(fmt.Sprintf("sel%d", b.errRow-1))
	} else if len(b.ids) > 0 && b.filter == "" {
		scr.CursorTo("sel0")
	} else {
		scr.CursorTo("filter")
	}
	return scr
}

func (b *browse) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	b.msg, b.errRow = "", 0
	f := scr.Fields()
	if nf := strings.ToUpper(f["filter"]); nf != b.filter {
		b.filter, b.top = nf, 0
	}
	switch aid {
	case t3.AIDEnter:
		return b.selection(s, f)
	case t3.PF(3), t3.PF(12):
		return &menu{}
	case t3.PF(5):
		return newAdd(b)
	case t3.PF(7):
		if b.top == 0 {
			b.msg = "CUS0101W ALREADY AT TOP OF DATA"
		}
		b.top = max(b.top-pageRows, 0)
	case t3.PF(8):
		n := len(s.cfg.Store.List(b.filter))
		if b.top+pageRows >= n {
			b.msg = "CUS0102W ALREADY AT BOTTOM OF DATA"
		} else {
			b.top += pageRows
		}
	case t3.AIDClear:
		b.filter, b.top = "", 0
	default:
		b.msg = invalidKey(aid)
	}
	return b
}

func (b *browse) selection(s *Session, f map[string]string) Program {
	for i, id := range b.ids {
		code := strings.ToUpper(strings.TrimSpace(f[fmt.Sprintf("sel%d", i)]))
		if code == "" {
			continue
		}
		d := &detail{back: b}
		switch code {
		case "S":
			d.mode = modeInquiry
		case "U":
			d.mode = modeUpdate
		case "D":
			d.mode = modeDelete
		default:
			b.msg = fmt.Sprintf("CUS0103E INVALID SELECTION CODE %q", code)
			b.errRow = i + 1
			return b
		}
		d.load(s, id)
		return d
	}
	return b
}

// money formats whole dollars with thousands separators.
func money(n int) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if neg {
		s = "-" + s
	}
	return "$" + s
}
