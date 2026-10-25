package host

import (
	"fmt"
	"sort"
	"strings"

	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// report is a read-only credit exposure summary.
type report struct{ msg string }

func (r *report) Render(s *Session) *t3.Screen {
	scr := t3.NewScreen()
	header(scr, s, "CUSR01", "CREDIT EXPOSURE SUMMARY")

	list := s.cfg.Store.List("")
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
	label(scr, 4, 50, "ACTIVE")
	scr.Text(4, 60, fmt.Sprintf("%5d", status["A"]), t3.WithColor(t3.Green))
	label(scr, 5, 50, "ON HOLD")
	scr.Text(5, 60, fmt.Sprintf("%5d", status["H"]), t3.WithColor(t3.Yellow))
	label(scr, 6, 50, "CLOSED")
	scr.Text(6, 60, fmt.Sprintf("%5d", status["C"]), t3.WithColor(t3.Pink))

	sort.Slice(list, func(i, j int) bool { return list[i].Balance > list[j].Balance })
	scr.Text(9, 4, "TOP EXPOSURES                   BALANCE  UTILIZATION", t3.WithColor(t3.White), t3.Bright)
	scr.Text(10, 4, strings.Repeat("-", 74), t3.WithColor(t3.Blue))
	for i := 0; i < 10 && i < len(list); i++ {
		c := list[i]
		pct := 0
		if c.Limit > 0 {
			pct = c.Balance * 100 / c.Limit
		}
		bar := min(pct*30/100, 30)
		color := t3.Green
		switch {
		case pct >= 90:
			color = t3.Red
		case pct >= 70:
			color = t3.Yellow
		}
		row := 11 + i
		value(scr, row, 4, fmt.Sprintf("%-24.24s %14s %4d%%", c.Name, money(c.Balance), pct))
		scr.Text(row, 51, strings.Repeat("#", bar)+strings.Repeat(".", 30-bar), t3.WithColor(color))
	}

	message(scr, r.msg)
	keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF12=CANCEL")
	scr.SetCursor(24, 2)
	return scr
}

func (r *report) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	switch aid {
	case t3.PF(3), t3.PF(12):
		return &menu{}
	case t3.PF(5), t3.AIDEnter, t3.AIDClear:
		r.msg = "CUS0301I REPORT REFRESHED AT " + nowHHMM()
	default:
		r.msg = invalidKey(aid)
	}
	return r
}
