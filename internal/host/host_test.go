package host

import (
	"strings"
	"testing"

	"github.com/sdf1jpf/terminal/internal/store"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

func newSession(t *testing.T) (*Session, *t3.Screen) {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	s := NewSession(&Config{
		SystemName: "TEST",
		Users:      map[string]string{"IBMUSER": "SYS1"},
		Store:      st,
	}, "TERM0001")
	return s, s.Start()
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
	fill(t, scr, "userid", "ibmuser", "password", "sys1")
	scr = s.Submit(t3.AIDEnter, scr)
	if _, ok := s.prog.(*menu); !ok {
		t.Fatalf("not at menu after logon: %T", s.prog)
	}
	return s, scr
}

func TestLogonRejectsBadPassword(t *testing.T) {
	s, scr := newSession(t)
	fill(t, scr, "userid", "ibmuser", "password", "nope")
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
	c, _ := s.cfg.Store.Get("000105")
	if c.Name != "EVERGREEN TIMBER" || c.Zip != "97402" || c.By != "IBMUSER" {
		t.Fatalf("stored record = %+v", c)
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
	if _, err := s.cfg.Store.Get(first); err == nil {
		t.Fatal("record still present")
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
