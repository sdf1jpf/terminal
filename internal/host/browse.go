package host

import (
	"fmt"
	"strings"

	"github.com/sdf1jpf/terminal/internal/customer"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// browse is a scrollable list of customers with a selection column, in the
// style of an ISPF member list.
type browse struct {
	filter string
	top    int
	list   []customer.Customer
	ids    []string // customer ids on the current page, by row
	msg    string
	errRow int // 1-based row index with a bad selection code, 0 for none
}

// enter re-reads the list from the API whenever the screen is shown.
func (b *browse) enter(s *Session) { b.refresh(s) }

func (b *browse) refresh(s *Session) {
	list, err := s.api().List(s.ctx(), b.filter)
	if err != nil {
		b.msg = s.fail(err)
		return
	}
	b.list = list
	b.top = min(b.top, max(len(list)-pageRows(s), 0))
}

// pageRows is how many customers fit between the column headings and the
// message line: 13 on a 24x80 screen.
func pageRows(s *Session) int { return s.rows - 11 }

func (b *browse) Render(s *Session) *t3.Screen {
	scr := s.newScreen()
	header(scr, s, "CUSM01", "CUSTOMER BROWSE")

	page := pageRows(s)
	// A wider screen gives the extra columns to the name and city.
	extra := scr.Cols() - t3.MinCols
	nameW, cityW := 24+extra*3/5, 15+extra-extra*3/5

	label(scr, 4, 2, "NAME STARTS WITH ===>")
	scr.Input(4, 24, 20, "filter", b.filter)
	if len(b.list) > 0 {
		end := min(b.top+page, len(b.list))
		scr.Text(4, right(scr, 58), fmt.Sprintf("ROW %d TO %d OF %d", b.top+1, end, len(b.list)), t3.WithColor(t3.White))
	}

	scr.Text(5, 2, "SELECT: S=SHOW  U=UPDATE  D=DELETE", t3.WithColor(t3.Blue))
	scr.Text(7, 2, fmt.Sprintf("S CUST NO  %-*s %-*s ST      BALANCE STAT", nameW, "NAME", cityW, "CITY"),
		t3.WithColor(t3.White), t3.Bright)
	scr.Text(8, 2, strings.Repeat("-", scr.Cols()-3), t3.WithColor(t3.Blue))

	b.ids = b.ids[:0]
	for i := 0; i < page && b.top+i < len(b.list); i++ {
		c := b.list[b.top+i]
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
		scr.Text(row, 4, fmt.Sprintf("%-8s %-*.*s %-*.*s %-2s %12s %s",
			c.ID, nameW, nameW, c.Name, cityW, cityW, c.City, c.State, money(c.Balance), c.Status), t3.WithColor(color))
		b.ids = append(b.ids, c.ID)
	}
	if len(b.list) == 0 {
		scr.Text(9, 4, "NO CUSTOMERS MATCH THE FILTER", t3.WithColor(t3.Yellow))
	} else if b.top+page >= len(b.list) {
		stars := strings.Repeat("*", (scr.Cols()-20)/2)
		bottom := stars + " BOTTOM OF DATA " + stars
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
	if nf := strings.ToUpper(f["filter"]); nf != b.filter && aid == t3.AIDEnter {
		b.filter, b.top = nf, 0
		b.refresh(s)
		return b
	}
	switch aid {
	case t3.AIDEnter:
		if next := b.selection(s, f); next != b {
			return next
		}
		if b.errRow == 0 {
			b.refresh(s) // Enter with nothing selected re-reads the file
		}
	case t3.PF(3), t3.PF(12):
		return &menu{}
	case t3.PF(5):
		return newAdd(b)
	case t3.PF(7):
		if b.top == 0 {
			b.msg = "CUS0101W ALREADY AT TOP OF DATA"
		}
		b.top = max(b.top-pageRows(s), 0)
	case t3.PF(8):
		if page := pageRows(s); b.top+page >= len(b.list) {
			b.msg = "CUS0102W ALREADY AT BOTTOM OF DATA"
		} else {
			b.top = min(b.top+page, len(b.list)-page) // keep the last page full
		}
	case t3.AIDClear:
		b.filter, b.top = "", 0
		b.refresh(s)
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
		if !d.load(s, id) {
			d.mode = modeInquiry
		}
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
