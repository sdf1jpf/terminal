package host

import (
	"strings"
	"testing"

	"github.com/sdf1jpf/terminal/internal/api"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

func newSession(t *testing.T) (*Session, *t3.Screen) {
	t.Helper()
	s := NewSession(&Config{SystemName: "TEST", Backend: newFakeAPI()}, "TERM0001")
	return s, s.Start()
}

// get reads a record through the session's API client.
func get(t *testing.T, s *Session, id string) (string, error) {
	t.Helper()
	c, err := s.api().Get(s.ctx(), id)
	return c.Name + "|" + c.Zip + "|" + c.By, err
}

// fill types values into named fields, like an operator would.
func fill(t *testing.T, scr *t3.Screen, kv ...string) {
	t.Helper()
	for i := 0; i < len(kv); i += 2 {
		if !scr.CursorTo(kv[i]) {
			t.Fatalf("no field %q", kv[i])
		}
		scr.EraseEOF()
		for _, r := range kv[i+1] {
			if l := scr.Type(r, false); l != t3.LockNone {
				t.Fatalf("field %s: %v", kv[i], l)
			}
		}
	}
}

func login(t *testing.T) (*Session, *t3.Screen) {
	s, scr := newSession(t)
	scr = s.Submit(t3.AIDEnter, scr)
	if _, ok := s.prog.(*menu); !ok {
		t.Fatalf("not at menu after logon: %T", s.prog)
	}
	return s, scr
}

func TestLogonRejectedByAccess(t *testing.T) {
	s, scr := newSession(t)
	s.api().(*fakeAPI).denied = true
	s.Submit(t3.AIDEnter, scr)
	l, ok := s.prog.(*logon)
	if !ok || !strings.HasPrefix(l.msg, "IKJ56421I") {
		t.Fatalf("expected logon rejection, got %T %+v", s.prog, s.prog)
	}
}

func TestUpdateCustomerWithValidation(t *testing.T) {
	s, scr := login(t)
	fill(t, scr, "option", "2 105")
	scr = s.Submit(t3.AIDEnter, scr)
	d, ok := s.prog.(*detail)
	if !ok || d.cust.Name != "EVERGREEN TIMBER CO" {
		t.Fatalf("inquiry failed: %T %+v", s.prog, s.prog)
	}

	scr = s.Submit(t3.PF(4), scr)
	fill(t, scr, "zip", "123")
	scr = s.Submit(t3.AIDEnter, scr)
	if d.errField != "zip" || d.mode != modeUpdate {
		t.Fatalf("expected zip error, got field %q mode %v msg %q", d.errField, d.mode, d.msg)
	}

	fill(t, scr, "zip", "97402", "name", "evergreen timber")
	s.Submit(t3.AIDEnter, scr)
	if d.mode != modeInquiry || !strings.Contains(d.msg, "UPDATED") {
		t.Fatalf("update failed: %q", d.msg)
	}
	if got, _ := get(t, s, "000105"); got != "EVERGREEN TIMBER|97402|IBMUSER" {
		t.Fatalf("stored record = %s", got)
	}
}

func TestBrowseSelectAndDelete(t *testing.T) {
	s, scr := login(t)
	fill(t, scr, "option", "1")
	scr = s.Submit(t3.AIDEnter, scr)
	b := s.prog.(*browse)
	first := b.ids[0]

	fill(t, scr, "sel0", "d")
	scr = s.Submit(t3.AIDEnter, scr)
	if d, ok := s.prog.(*detail); !ok || d.mode != modeDelete {
		t.Fatalf("expected delete confirmation, got %T", s.prog)
	}
	s.Submit(t3.PF(10), scr)
	if s.prog != b || !strings.Contains(b.msg, "DELETED") {
		t.Fatalf("expected browse with message, got %T %q", s.prog, b.msg)
	}
	if _, err := get(t, s, first); err != api.ErrNotFound {
		t.Fatalf("record still present: %v", err)
	}
}

func TestPagingAndHelp(t *testing.T) {
	s, scr := login(t)
	scr = s.Submit(t3.PF(4), scr)
	b := s.prog.(*browse)
	scr = s.Submit(t3.PF(8), scr)
	// 24 records: the last page is clamped so it stays full.
	want := 24 - pageRows
	if b.top != want {
		t.Fatalf("top = %d, want %d", b.top, want)
	}
	scr = s.Submit(t3.PF(1), scr)
	if _, ok := s.prog.(*help); !ok {
		t.Fatalf("PF1 did not open help: %T", s.prog)
	}
	s.Submit(t3.PF(3), scr)
	if s.prog != b || b.top != want {
		t.Fatal("PF3 from help did not return to the same browse page")
	}
}

func TestDots(t *testing.T) {
	a, b := dots("NAME", 19), dots("ADDRESS", 19)
	if len(a) != 19 || len(b) != 19 {
		t.Fatal("wrong width")
	}
	for i := 8; i < 19; i++ {
		if a[i] != b[i] {
			t.Fatalf("leaders misaligned at %d: %q vs %q", i, a, b)
		}
	}
}

func TestUpdateConflict(t *testing.T) {
	s, scr := login(t)
	fill(t, scr, "option", "2 101")
	scr = s.Submit(t3.AIDEnter, scr)
	scr = s.Submit(t3.PF(4), scr)
	d := s.prog.(*detail)

	// Another user changes the record after this one started editing.
	other := d.cust
	other.Phone = "937-555-0199"
	if _, err := s.api().Update(s.ctx(), other); err != nil {
		t.Fatal(err)
	}

	fill(t, scr, "city", "kettering")
	s.Submit(t3.AIDEnter, scr)
	if !strings.HasPrefix(d.msg, "CUS0213E") || d.cust.Phone != "937-555-0199" {
		t.Fatalf("expected conflict and refreshed record, got %q %+v", d.msg, d.cust)
	}
}

func TestServerSideValidationAndAdd(t *testing.T) {
	s, scr := login(t)
	fill(t, scr, "option", "3")
	scr = s.Submit(t3.AIDEnter, scr)
	fill(t, scr, "name", "new co", "city", "reno", "state", "n1", "zip", "89501", "limit", "1000")
	scr = s.Submit(t3.AIDEnter, scr)
	d := s.prog.(*detail)
	if d.errField != "state" || !strings.HasPrefix(d.msg, "CUS0232E") {
		t.Fatalf("expected state error from the API, got %q %q", d.errField, d.msg)
	}
	fill(t, scr, "state", "nv")
	s.Submit(t3.AIDEnter, scr)
	if d.mode != modeInquiry || d.cust.ID != "000125" || !strings.Contains(d.msg, "ADDED") {
		t.Fatalf("add failed: %q %+v", d.msg, d.cust)
	}
}

func TestHostDown(t *testing.T) {
	s := NewSession(&Config{SystemName: "TEST", Backend: api.NewClient("http://127.0.0.1:1", nil)}, "TERM0001")
	scr := s.Start()
	s.Submit(t3.AIDEnter, scr)
	if l := s.prog.(*logon); !strings.HasPrefix(l.msg, "CUS0298E") {
		t.Fatalf("expected host-down message, got %q", l.msg)
	}
}

func TestExpiredSessionReturnsToLogon(t *testing.T) {
	s, scr := login(t)
	s.api().(*fakeAPI).user = "" // the API forgets the session
	fill(t, scr, "option", "1")
	s.Submit(t3.AIDEnter, scr)
	l, ok := s.prog.(*logon)
	if !ok || !strings.HasPrefix(l.msg, "IKJ56400I") || s.user != "" {
		t.Fatalf("expected logon with expiry message, got %T %+v", s.prog, s.prog)
	}
}
