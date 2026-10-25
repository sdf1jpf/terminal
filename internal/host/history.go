package host

import (
	"fmt"
	"strings"

	"github.com/sdf1jpf/terminal/internal/customer"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// history lists who changed a customer record, when, and what changed,
// newest first. It works for deleted customers too, since the history
// outlives the record.
type history struct {
	account
	back     Program
	list     []customer.Change
	top      int
	errField string
	msg      string
}

func newHistory(s *Session, id string, back Program) *history {
	h := &history{back: back}
	if id != "" {
		h.load(s, id)
	}
	return h
}

func (h *history) load(s *Session, id string) {
	h.list, h.top = nil, 0
	msg := h.open(s, id)
	list, err := s.api().History(s.ctx(), h.id)
	if err != nil {
		h.msg = s.fail(err)
		return
	}
	h.list = list
	switch {
	case len(list) > 0 && !h.loaded:
		h.msg = "CUS0251I CUSTOMER " + h.id + " HAS BEEN DELETED - HISTORY ONLY"
	case msg != "":
		h.msg, h.errField = msg, "id"
	}
}

// historyRows is how many changes fit on a page: 14 on 24x80.
func historyRows(s *Session) int { return s.rows - 10 }

const historyLine = "%-10s %-5s %-8s %-6s %-7s "

func (h *history) Render(s *Session) *t3.Screen {
	scr := s.newScreen()
	header(scr, s, "CUSM04", "CHANGE HISTORY")
	h.account.render(scr, h.errField == "id")

	page := historyRows(s)
	if len(h.list) > 0 {
		end := min(h.top+page, len(h.list))
		scr.Text(5, right(scr, 58), fmt.Sprintf("ROW %d TO %d OF %d", h.top+1, end, len(h.list)), t3.WithColor(t3.White))
	}
	scr.Text(6, 4, fmt.Sprintf(historyLine, "DATE", "TIME", "USER", "ACTION", "FIELD")+"OLD VALUE > NEW VALUE",
		t3.WithColor(t3.White), t3.Bright)
	scr.Text(7, 4, strings.Repeat("-", scr.Cols()-6), t3.WithColor(t3.Blue))
	width := scr.Cols() - 4 - len(fmt.Sprintf(historyLine, "", "", "", "", "")) - 2
	for i := 0; i < page && h.top+i < len(h.list); i++ {
		c := h.list[h.top+i]
		what, color := "", t3.Green
		switch c.Action {
		case "ADD":
			what, color = "RECORD ADDED", t3.Turquoise
		case "DELETE":
			what, color = "RECORD DELETED", t3.Pink
		default:
			what = blank(c.Old) + " > " + blank(c.New)
		}
		at := c.At.Local()
		scr.Text(8+i, 4, fmt.Sprintf(historyLine, at.Format("2006-01-02"), at.Format("15:04"), c.By, c.Action, c.Field)+
			truncate(what, width), t3.WithColor(color))
	}
	if len(h.list) == 0 && h.id != "" && h.errField == "" {
		scr.Text(8, 4, "NO CHANGES ON FILE", t3.WithColor(t3.Yellow))
	}

	message(scr, h.msg)
	keys(scr, "PF1=HELP  PF3=EXIT  PF5=ACTIVITY  PF7=UP  PF8=DOWN  PF12=CANCEL")
	scr.CursorTo("id")
	return scr
}

func blank(s string) string {
	if s == "" {
		return "(BLANK)"
	}
	return s
}

func (h *history) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	h.msg, h.errField = "", ""
	switch aid {
	case t3.AIDEnter:
		id := strings.TrimSpace(scr.Fields()["id"])
		if id == "" {
			h.msg, h.errField = "CUS0202E ENTER A CUSTOMER NUMBER", "id"
			h.list, h.loaded = nil, false
			return h
		}
		h.load(s, id)
	case t3.PF(3), t3.PF(12):
		return h.back
	case t3.PF(5):
		if !h.loaded {
			h.msg, h.errField = "CUS0204E DISPLAY A CUSTOMER FIRST", "id"
			return h
		}
		if a, ok := h.back.(*activity); ok && a.id == h.id {
			a.load(s, a.id)
			return a
		}
		return newActivity(s, h.id, h)
	case t3.PF(7):
		if h.top == 0 {
			h.msg = "CUS0101W ALREADY AT TOP OF DATA"
		}
		h.top = max(h.top-historyRows(s), 0)
	case t3.PF(8):
		if page := historyRows(s); h.top+page >= len(h.list) {
			h.msg = "CUS0102W ALREADY AT BOTTOM OF DATA"
		} else {
			h.top = min(h.top+page, len(h.list)-page)
		}
	default:
		h.msg = invalidKey(aid)
	}
	return h
}
