package host

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/sdf1jpf/terminal/internal/store"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

type mode int

const (
	modeInquiry mode = iota
	modeUpdate
	modeAdd
	modeDelete
)

// detail displays, updates, adds or deletes a single customer.
type detail struct {
	mode     mode
	back     Program
	cust     store.Customer
	loaded   bool
	vals     map[string]string // operator input kept across a failed edit
	errField string
	msg      string
}

// messenger is implemented by programs that can show a message passed
// back to them when a child screen returns.
type messenger interface{ setMsg(string) }

func (b *browse) setMsg(m string) { b.msg = m }
func (m *menu) setMsg(msg string) { m.msg = msg }

func newAdd(back Program) *detail {
	return &detail{mode: modeAdd, back: back, loaded: true, cust: store.Customer{Status: "A"}}
}

func (d *detail) load(s *Session, id string) {
	id = padID(id)
	c, err := s.cfg.Store.Get(id)
	if err != nil {
		d.loaded = false
		d.cust = store.Customer{ID: id}
		d.msg = "CUS0201E CUSTOMER " + id + " NOT FOUND"
		d.errField = "id"
		return
	}
	d.cust, d.loaded, d.vals = c, true, nil
}

func padID(id string) string {
	id = strings.TrimSpace(id)
	if n, err := strconv.Atoi(id); err == nil && n >= 0 {
		return fmt.Sprintf("%06d", n)
	}
	return id
}

type fieldDef struct {
	name, label string
	length      int
	numeric     bool
	get         func(c store.Customer) string
}

var detailFields = []fieldDef{
	{"name", "NAME", 30, false, func(c store.Customer) string { return c.Name }},
	{"addr", "ADDRESS", 30, false, func(c store.Customer) string { return c.Address }},
	{"city", "CITY", 18, false, func(c store.Customer) string { return c.City }},
	{"state", "STATE", 2, false, func(c store.Customer) string { return c.State }},
	{"zip", "ZIP CODE", 5, true, func(c store.Customer) string { return c.Zip }},
	{"phone", "PHONE", 12, false, func(c store.Customer) string { return c.Phone }},
	{"limit", "CREDIT LIMIT", 9, true, func(c store.Customer) string {
		if c.Limit == 0 && c.ID == "" {
			return ""
		}
		return strconv.Itoa(c.Limit)
	}},
	{"status", "STATUS (A/H/C)", 1, false, func(c store.Customer) string { return c.Status }},
}

func (d *detail) editable() bool { return d.mode == modeUpdate || d.mode == modeAdd }

func (d *detail) Render(s *Session) *t3.Screen {
	scr := t3.NewScreen()
	titles := map[mode]string{
		modeInquiry: "CUSTOMER INQUIRY",
		modeUpdate:  "CUSTOMER UPDATE",
		modeAdd:     "ADD CUSTOMER",
		modeDelete:  "DELETE CUSTOMER",
	}
	header(scr, s, "CUSM02", titles[d.mode])

	label(scr, 4, 4, "CUSTOMER NUMBER ===>")
	switch {
	case d.mode == modeInquiry:
		var opts []t3.Opt
		if d.errField == "id" {
			opts = append(opts, t3.Bright)
		}
		scr.Input(4, 25, 6, "id", d.cust.ID, append(opts, t3.Numeric)...)
	case d.mode == modeAdd:
		scr.Text(4, 25, "(ASSIGNED ON ADD)", t3.WithColor(t3.Blue))
	default:
		scr.Text(4, 25, d.cust.ID, t3.WithColor(t3.White), t3.Bright)
	}

	if d.loaded {
		d.renderFields(scr)
		d.renderAccount(scr)
	}
	if d.mode == modeDelete {
		scr.Text(19, 4, "*** PRESS PF10 TO CONFIRM DELETION, OR PF12 TO CANCEL ***",
			t3.WithColor(t3.Red), t3.Bright)
	}

	message(scr, d.msg)
	switch d.mode {
	case modeInquiry:
		keys(scr, "ENTER=DISPLAY  PF1=HELP  PF3=EXIT  PF4=UPDATE  PF9=DELETE  PF12=CANCEL")
	case modeUpdate, modeAdd:
		keys(scr, "ENTER=SAVE  PF1=HELP  PF3=EXIT  PF12=CANCEL  CTRL+E=ERASE EOF")
	case modeDelete:
		keys(scr, "PF1=HELP  PF3=EXIT  PF10=CONFIRM DELETE  PF12=CANCEL")
	}

	switch {
	case d.errField != "":
		scr.CursorTo(d.errField)
	case d.editable():
		scr.CursorTo("name")
	case d.mode == modeInquiry:
		scr.CursorTo("id")
	default:
		scr.SetCursor(19, 4)
	}
	return scr
}

func (d *detail) renderFields(scr *t3.Screen) {
	for i, f := range detailFields {
		row := 6 + i
		if i >= 6 {
			row++ // a blank line between address and account fields
		}
		label(scr, row, 4, dots(f.label, 19))
		v := f.get(d.cust)
		if d.vals != nil {
			v = d.vals[f.name]
		}
		if !d.editable() {
			value(scr, row, 25, v)
			continue
		}
		opts := []t3.Opt{}
		if f.numeric {
			opts = append(opts, t3.Numeric)
		}
		if d.errField == f.name {
			opts = append(opts, t3.Bright)
		}
		scr.Input(row, 25, f.length, f.name, v, opts...)
	}
}

func (d *detail) renderAccount(scr *t3.Screen) {
	if d.mode == modeAdd {
		return
	}
	c := d.cust
	label(scr, 6, 58, "BALANCE")
	scr.Text(6, 68, fmt.Sprintf("%11s", money(c.Balance)), t3.WithColor(t3.White))
	label(scr, 7, 58, "AVAILABLE")
	avail := c.Limit - c.Balance
	color := t3.Green
	if avail < c.Limit/10 {
		color = t3.Red
	}
	scr.Text(7, 68, fmt.Sprintf("%11s", money(avail)), t3.WithColor(color))
	if c.Limit > 0 {
		pct := c.Balance * 100 / c.Limit
		label(scr, 8, 58, "UTILIZED")
		scr.Text(8, 68, fmt.Sprintf("%10d%%", pct), t3.WithColor(color))
		bar := min(pct*20/100, 20)
		scr.Text(9, 58, "["+strings.Repeat("|", bar)+strings.Repeat(".", 20-bar)+"]", t3.WithColor(color))
	}
	if !c.Updated.IsZero() {
		label(scr, 16, 4, dots("LAST UPDATED", 19))
		value(scr, 16, 25, c.Updated.Local().Format("2006-01-02 15:04")+" BY "+c.By)
	}
}

// dots pads a label with ISPF-style leader dots ("NAME . . . . ."). Dots
// fall on alternate columns so that labels of any length line up.
func dots(s string, width int) string {
	b := []byte(s)
	for i := len(b); i < width; i++ {
		if i%2 == 1 && i > len(s) && i < width-1 {
			b = append(b, '.')
		} else {
			b = append(b, ' ')
		}
	}
	return string(b[:width])
}

func (d *detail) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	d.msg, d.errField = "", ""
	switch d.mode {
	case modeInquiry:
		return d.handleInquiry(s, aid, scr)
	case modeUpdate, modeAdd:
		return d.handleEdit(s, aid, scr)
	default:
		return d.handleDelete(s, aid)
	}
}

func (d *detail) handleInquiry(s *Session, aid t3.AID, scr *t3.Screen) Program {
	switch aid {
	case t3.AIDEnter:
		id := scr.Fields()["id"]
		if strings.TrimSpace(id) == "" {
			d.msg, d.errField, d.loaded = "CUS0202E ENTER A CUSTOMER NUMBER", "id", false
			d.cust = store.Customer{}
			return d
		}
		d.load(s, id)
		if d.loaded {
			d.msg = "CUS0203I CUSTOMER " + d.cust.ID + " DISPLAYED"
		}
	case t3.PF(3), t3.PF(12):
		return d.back
	case t3.PF(4), t3.PF(9):
		if !d.loaded {
			d.msg, d.errField = "CUS0204E DISPLAY A CUSTOMER FIRST", "id"
			return d
		}
		d.load(s, d.cust.ID) // re-read for the latest copy
		d.mode = modeUpdate
		if aid == t3.PF(9) {
			d.mode = modeDelete
		}
	case t3.AIDClear:
		return &detail{mode: modeInquiry, back: d.back}
	default:
		d.msg = invalidKey(aid)
	}
	return d
}

func (d *detail) handleEdit(s *Session, aid t3.AID, scr *t3.Screen) Program {
	switch aid {
	case t3.AIDEnter:
	case t3.PF(3):
		return d.back
	case t3.PF(12):
		if d.mode == modeAdd {
			return d.back
		}
		d.mode, d.vals = modeInquiry, nil
		d.msg = "CUS0210I UPDATE CANCELLED, NO CHANGES MADE"
		return d
	default:
		d.msg = invalidKey(aid)
		return d
	}

	d.vals = scr.Fields()
	if len(scr.Modified()) == 0 && d.mode == modeUpdate {
		d.msg = "CUS0211W NO FIELDS WERE CHANGED"
		return d
	}
	c, field, msg := validate(d.cust, d.vals)
	if field != "" {
		d.errField, d.msg = field, msg
		return d
	}
	saved, err := s.cfg.Store.Put(c, s.user)
	if err != nil {
		d.msg = "CUS0299E FILE ERROR: " + strings.ToUpper(err.Error())
		return d
	}
	verb := "UPDATED"
	if d.mode == modeAdd {
		verb = "ADDED"
	}
	d.cust, d.vals, d.mode = saved, nil, modeInquiry
	d.msg = "CUS0212I CUSTOMER " + saved.ID + " " + verb
	return d
}

func (d *detail) handleDelete(s *Session, aid t3.AID) Program {
	switch aid {
	case t3.PF(10):
		if err := s.cfg.Store.Delete(d.cust.ID); err != nil {
			d.msg = "CUS0299E FILE ERROR: " + strings.ToUpper(err.Error())
			return d
		}
		msg := "CUS0220I CUSTOMER " + d.cust.ID + " DELETED"
		if m, ok := d.back.(messenger); ok {
			m.setMsg(msg)
			return d.back
		}
		return &detail{mode: modeInquiry, back: d.back, msg: msg}
	case t3.PF(3):
		return d.back
	case t3.PF(12):
		d.mode = modeInquiry
		d.msg = "CUS0221I DELETE CANCELLED"
	default:
		d.msg = invalidKey(aid)
	}
	return d
}

var (
	reState = regexp.MustCompile(`^[A-Z]{2}$`)
	reZip   = regexp.MustCompile(`^[0-9]{5}$`)
	rePhone = regexp.MustCompile(`^[0-9]{3}-[0-9]{3}-[0-9]{4}$`)
)

// validate applies the edit rules and returns the updated record, or the
// name of the first field in error with its message.
func validate(c store.Customer, v map[string]string) (store.Customer, string, string) {
	get := func(k string) string { return strings.ToUpper(strings.TrimSpace(v[k])) }
	c.Name, c.Address, c.City = get("name"), get("addr"), get("city")
	c.State, c.Zip, c.Phone, c.Status = get("state"), get("zip"), get("phone"), get("status")
	switch {
	case c.Name == "":
		return c, "name", "CUS0230E CUSTOMER NAME IS REQUIRED"
	case c.City == "":
		return c, "city", "CUS0231E CITY IS REQUIRED"
	case !reState.MatchString(c.State):
		return c, "state", "CUS0232E STATE MUST BE A TWO LETTER CODE"
	case !reZip.MatchString(c.Zip):
		return c, "zip", "CUS0233E ZIP CODE MUST BE FIVE DIGITS"
	case c.Phone != "" && !rePhone.MatchString(c.Phone):
		return c, "phone", "CUS0234E PHONE MUST BE IN THE FORM NNN-NNN-NNNN"
	}
	limit, err := strconv.Atoi(get("limit"))
	if err != nil || limit < 0 {
		return c, "limit", "CUS0235E CREDIT LIMIT MUST BE A WHOLE, POSITIVE NUMBER"
	}
	c.Limit = limit
	if !strings.Contains("AHC", c.Status) || c.Status == "" {
		return c, "status", "CUS0236E STATUS MUST BE A (ACTIVE), H (HOLD) OR C (CLOSED)"
	}
	return c, "", ""
}
