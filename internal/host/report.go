package host

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/sdf1jpf/terminal/internal/customer"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// report is a read-only credit exposure summary.
type report struct {
	list []customer.Customer
	msg  string
}

func (r *report) enter(s *Session) { r.refresh(s) }

func (r *report) refresh(s *Session) bool {
	list, err := s.api().List(s.ctx(), "")
	if err != nil {
		r.msg = s.fail(err)
		return false
	}
	r.list = list
	return true
}

func (r *report) Render(s *Session) *t3.Screen {
	scr := s.newScreen()
	header(scr, s, "CUSR01", "CREDIT EXPOSURE SUMMARY")

	list := slices.Clone(r.list)
	var limit, bal int
	status := map[string]int{}
	for _, c := range list {
		limit += c.Limit
		bal += c.Balance
		status[c.Status]++
	}
	label(scr, 4, 4, dots("CUSTOMERS ON FILE", 24))
	value(scr, 4, 30, fmt.Sprintf("%12d", len(list)))
	label(scr, 5, 4, dots("TOTAL CREDIT LIMIT", 24))
	value(scr, 5, 30, fmt.Sprintf("%12s", money(limit)))
	label(scr, 6, 4, dots("TOTAL OUTSTANDING", 24))
	value(scr, 6, 30, fmt.Sprintf("%12s", money(bal)))
	if limit > 0 {
		label(scr, 7, 4, dots("OVERALL UTILIZATION", 24))
		value(scr, 7, 30, fmt.Sprintf("%11d%%", bal*100/limit))
	}
	col := right(scr, 50)
	label(scr, 4, col, "ACTIVE")
	scr.Text(4, col+10, fmt.Sprintf("%5d", status["A"]), t3.WithColor(t3.Green))
	label(scr, 5, col, "ON HOLD")
	scr.Text(5, col+10, fmt.Sprintf("%5d", status["H"]), t3.WithColor(t3.Yellow))
	label(scr, 6, col, "CLOSED")
	scr.Text(6, col+10, fmt.Sprintf("%5d", status["C"]), t3.WithColor(t3.Pink))

	// The list fills rows 11 to three above the bottom, and the bars take
	// up any extra width: 10 rows of 30 on a 24x80 screen.
	top, width := scr.Rows()-14, 30+scr.Cols()-t3.MinCols
	sort.Slice(list, func(i, j int) bool { return list[i].Balance > list[j].Balance })
	scr.Text(9, 4, "TOP EXPOSURES                   BALANCE  UTILIZATION", t3.WithColor(t3.White), t3.Bright)
	scr.Text(10, 4, strings.Repeat("-", scr.Cols()-6), t3.WithColor(t3.Blue))
	for i := 0; i < top && i < len(list); i++ {
		c := list[i]
		pct := 0
		if c.Limit > 0 {
			pct = c.Balance * 100 / c.Limit
		}
		bar := min(pct*width/100, width)
		color := t3.Green
		switch {
		case pct >= 90:
			color = t3.Red
		case pct >= 70:
			color = t3.Yellow
		}
		row := 11 + i
		value(scr, row, 4, fmt.Sprintf("%-24.24s %14s %4d%%", c.Name, money(c.Balance), pct))
		scr.Text(row, 51, strings.Repeat("#", bar)+strings.Repeat(".", width-bar), t3.WithColor(color))
	}

	message(scr, r.msg)
	keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF12=CANCEL")
	scr.SetCursor(scr.Rows(), 2)
	return scr
}

func (r *report) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	switch aid {
	case t3.PF(3), t3.PF(12):
		return &menu{}
	case t3.PF(5), t3.AIDEnter, t3.AIDClear:
		if r.refresh(s) {
			r.msg = "CUS0301I REPORT REFRESHED AT " + nowHHMM()
		}
	default:
		r.msg = invalidKey(aid)
	}
	return r
}
