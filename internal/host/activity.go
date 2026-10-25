package host

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/customer"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// account is the part of the activity and history screens that names the
// customer: a customer number field the operator can change, and the
// record it loaded.
type account struct {
	id     string
	cust   customer.Customer
	loaded bool
}

// open loads a customer, returning an error message if it can't.
func (a *account) open(s *Session, id string) string {
	a.id = padID(id)
	c, err := s.api().Get(s.ctx(), a.id)
	if err != nil {
		a.cust, a.loaded = customer.Customer{}, false
		if errors.Is(err, api.ErrNotFound) {
			return "CUS0201E CUSTOMER " + a.id + " NOT FOUND"
		}
		return s.fail(err)
	}
	a.cust, a.loaded = c, true
	return ""
}

// changed reports the customer number the operator typed over the
// current one, or "" if they didn't.
func (a *account) changed(scr *t3.Screen) string {
	if !scr.Modified()["id"] {
		return ""
	}
	id := strings.TrimSpace(scr.Fields()["id"])
	if id == "" || padID(id) == a.id {
		return ""
	}
	return id
}

func (a *account) render(scr *t3.Screen, errID bool) {
	label(scr, 4, 4, "CUSTOMER NUMBER ===>")
	opts := []t3.Opt{t3.Numeric}
	if errID {
		opts = append(opts, t3.Bright)
	}
	scr.Input(4, 25, 6, "id", a.id, opts...)
	if a.loaded {
		scr.Text(4, 33, a.cust.Name, t3.WithColor(t3.White), t3.Bright)
		status := map[string]string{"A": "ACTIVE", "H": "ON HOLD", "C": "CLOSED"}[a.cust.Status]
		scr.Text(4, right(scr, 70), fmt.Sprintf("%9s", status), t3.WithColor(statusColor(a.cust.Status)))
	}
}

func statusColor(status string) t3.Color {
	switch status {
	case "H":
		return t3.Yellow
	case "C":
		return t3.Pink
	}
	return t3.Green
}

// activity posts invoices and payments to a customer and lists the
// account's transactions, newest first.
type activity struct {
	account
	back     Program
	list     []customer.Transaction
	top      int
	vals     map[string]string // posting fields kept across a failed post
	errField string
	msg      string
}

func newActivity(s *Session, id string, back Program) *activity {
	a := &activity{back: back}
	if id != "" {
		a.load(s, id)
	}
	return a
}

// load opens a customer and reads its activity.
func (a *activity) load(s *Session, id string) {
	a.list, a.top, a.vals = nil, 0, nil
	if a.msg = a.open(s, id); a.msg != "" {
		a.errField = "id"
		return
	}
	a.refresh(s)
}

func (a *activity) refresh(s *Session) {
	list, err := s.api().Transactions(s.ctx(), a.id)
	if err != nil {
		a.msg = s.fail(err)
		return
	}
	a.list = list
	a.top = min(a.top, max(len(list)-activityRows(s), 0))
}

// activityRows is how many transactions fit on a page: 10 on 24x80.
func activityRows(s *Session) int { return s.rows - 14 }

const activityLine = "%-10s %-5s %-7s %-12s %12s %13s  %-8s"

func (a *activity) Render(s *Session) *t3.Screen {
	scr := s.newScreen()
	header(scr, s, "CUSM03", "ACCOUNT ACTIVITY")
	a.account.render(scr, a.errField == "id")

	if a.loaded {
		get := func(name string) string { return a.vals[name] }
		posting := []struct {
			name, label string
			length      int
			opt         t3.Opt
		}{
			{"type", "TYPE", 1, func(*t3.Attr) {}},
			{"amount", "AMOUNT", 9, t3.Numeric},
			{"ref", "REFERENCE", 12, func(*t3.Attr) {}},
		}
		for i, f := range posting {
			row := 6 + i
			label(scr, row, 4, dots(f.label, 19))
			opts := []t3.Opt{f.opt}
			if a.errField == f.name {
				opts = append(opts, t3.Bright)
			}
			scr.Input(row, 25, f.length, f.name, get(f.name), opts...)
		}
		scr.Text(6, 28, "I=INVOICE  P=PAYMENT", t3.WithColor(t3.Blue))

		c := a.cust
		col := right(scr, 58)
		label(scr, 6, col, "BALANCE")
		scr.Text(6, col+10, fmt.Sprintf("%11s", money(c.Balance)), t3.WithColor(t3.White))
		label(scr, 7, col, "LIMIT")
		scr.Text(7, col+10, fmt.Sprintf("%11s", money(c.Limit)), t3.WithColor(t3.Green))
		label(scr, 8, col, "AVAILABLE")
		color := t3.Green
		if c.Limit-c.Balance < c.Limit/10 {
			color = t3.Red
		}
		scr.Text(8, col+10, fmt.Sprintf("%11s", money(c.Limit-c.Balance)), t3.WithColor(color))

		page := activityRows(s)
		if len(a.list) > 0 {
			end := min(a.top+page, len(a.list))
			scr.Text(10, right(scr, 58), fmt.Sprintf("ROW %d TO %d OF %d", a.top+1, end, len(a.list)), t3.WithColor(t3.White))
		}
		scr.Text(11, 4, fmt.Sprintf(activityLine, "DATE", "TIME", "TYPE", "REFERENCE", "AMOUNT", "BALANCE", "USER"),
			t3.WithColor(t3.White), t3.Bright)
		scr.Text(12, 4, strings.Repeat("-", scr.Cols()-6), t3.WithColor(t3.Blue))
		for i := 0; i < page && a.top+i < len(a.list); i++ {
			t := a.list[a.top+i]
			kind, amount, color := "INVOICE", money(t.Amount), t3.Green
			if t.Type == "P" {
				kind, amount, color = "PAYMENT", money(-t.Amount), t3.Turquoise
			}
			when := t.Posted.Local()
			scr.Text(13+i, 4, fmt.Sprintf(activityLine, when.Format("2006-01-02"), when.Format("15:04"), kind,
				t.Reference, amount, money(t.Balance), t.By), t3.WithColor(color))
		}
		if len(a.list) == 0 {
			scr.Text(13, 4, "NO ACTIVITY ON FILE", t3.WithColor(t3.Yellow))
		}
	}

	message(scr, a.msg)
	keys(scr, "ENTER=POST  PF1=HELP  PF3=EXIT  PF6=HISTORY  PF7=UP  PF8=DOWN  PF12=CANCEL")
	switch {
	case a.errField != "":
		scr.CursorTo(a.errField)
	case a.loaded:
		scr.CursorTo("type")
	default:
		scr.CursorTo("id")
	}
	return scr
}

func (a *activity) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	a.msg, a.errField = "", ""
	switch aid {
	case t3.AIDEnter:
		if id := a.changed(scr); id != "" || !a.loaded {
			if id == "" {
				id = scr.Fields()["id"]
			}
			if strings.TrimSpace(id) == "" {
				a.msg, a.errField = "CUS0202E ENTER A CUSTOMER NUMBER", "id"
				return a
			}
			a.load(s, id)
			return a
		}
		a.post(s, scr.Fields())
	case t3.PF(3), t3.PF(12):
		if d, ok := a.back.(*detail); ok && d.loaded {
			d.load(s, d.cust.ID) // show the new balance
		}
		return a.back
	case t3.PF(6):
		if !a.loaded {
			a.msg, a.errField = "CUS0204E DISPLAY A CUSTOMER FIRST", "id"
			return a
		}
		return newHistory(s, a.id, a)
	case t3.PF(7):
		if a.top == 0 {
			a.msg = "CUS0101W ALREADY AT TOP OF DATA"
		}
		a.top = max(a.top-activityRows(s), 0)
	case t3.PF(8):
		if page := activityRows(s); a.top+page >= len(a.list) {
			a.msg = "CUS0102W ALREADY AT BOTTOM OF DATA"
		} else {
			a.top = min(a.top+page, len(a.list)-page)
		}
	case t3.AIDClear:
		a.vals = nil
	default:
		a.msg = invalidKey(aid)
	}
	return a
}

// post sends the posting fields to the API. With nothing filled in, Enter
// just reads the account again.
func (a *activity) post(s *Session, f map[string]string) {
	a.vals = f
	typ := strings.ToUpper(strings.TrimSpace(f["type"]))
	amt, ref := strings.TrimSpace(f["amount"]), strings.TrimSpace(f["ref"])
	if typ == "" && amt == "" && ref == "" {
		a.vals = nil
		if a.msg = a.open(s, a.id); a.msg == "" {
			a.refresh(s)
		}
		return
	}
	n, err := strconv.Atoi(amt)
	if err != nil {
		a.errField = "amount"
		a.msg = postingMessage(&customer.ValidationError{Field: "amount", Message: "amount must be a whole number of dollars above zero"})
		return
	}
	t, err := s.api().Post(s.ctx(), customer.Transaction{ID: a.id, Type: typ, Amount: n, Reference: ref})
	var verr *customer.ValidationError
	switch {
	case errors.As(err, &verr):
		a.errField, a.msg = verr.Field, postingMessage(verr)
		return
	case errors.Is(err, api.ErrNotFound):
		a.loaded, a.vals, a.list = false, nil, nil
		a.msg, a.errField = "CUS0214E CUSTOMER "+a.id+" NO LONGER EXISTS", "id"
		return
	case err != nil:
		a.msg = s.fail(err)
		return
	}
	a.vals, a.top = nil, 0
	if msg := a.open(s, a.id); msg != "" {
		a.msg = msg
		return
	}
	a.refresh(s)
	kind := "INVOICE"
	if t.Type == "P" {
		kind = "PAYMENT"
	}
	a.msg = fmt.Sprintf("CUS0245I %s OF %s POSTED - BALANCE NOW %s", kind, money(t.Amount), money(t.Balance))
}

var postingMessageIDs = map[string]string{"type": "CUS0240E", "amount": "CUS0241E", "ref": "CUS0242E"}

func postingMessage(e *customer.ValidationError) string {
	id, ok := postingMessageIDs[e.Field]
	if !ok {
		id = "CUS0249E"
	}
	return id + " " + strings.ToUpper(e.Message)
}
