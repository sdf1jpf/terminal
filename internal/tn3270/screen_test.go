package tn3270

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func form() *Screen {
	s := NewScreen()
	s.Text(2, 2, "NAME ===>")
	s.Input(2, 12, 5, "name", "")
	s.Text(3, 2, "ZIP  ===>")
	s.Input(3, 12, 3, "zip", "", Numeric)
	s.CursorHome()
	return s
}

func typeAll(t *testing.T, s *Screen, text string, insert bool) {
	t.Helper()
	for _, r := range text {
		if l := s.Type(r, insert); l != LockNone {
			t.Fatalf("typing %q: lock %v", r, l)
		}
	}
}

func TestTypeUppercasesAndAutoSkips(t *testing.T) {
	s := form()
	typeAll(t, s, "abcde", false)
	if got := s.Fields()["name"]; got != "ABCDE" {
		t.Fatalf("name = %q", got)
	}
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatalf("cursor did not skip to zip, at %v", s.Cursor())
	}
	if !s.Modified()["name"] || s.Modified()["zip"] {
		t.Fatalf("modified = %v", s.Modified())
	}
}

func TestLocks(t *testing.T) {
	s := form()
	s.Tab()
	if l := s.Type('x', false); l != LockNumeric {
		t.Fatalf("numeric field accepted a letter: %v", l)
	}
	s.SetCursor(2, 3)
	if l := s.Type('x', false); l != LockProtected {
		t.Fatalf("protected field accepted input: %v", l)
	}
	s.CursorHome()
	typeAll(t, s, "abcde", false)
	s.CursorHome()
	if l := s.Type('z', true); l != LockOverflow {
		t.Fatalf("insert into a full field: %v", l)
	}
}

func TestInsertDeleteErase(t *testing.T) {
	s := form()
	typeAll(t, s, "ace", false)
	s.CursorHome()
	s.Move(0, 1)
	typeAll(t, s, "b", true)
	if got := s.Fields()["name"]; got != "ABCE" {
		t.Fatalf("after insert: %q", got)
	}
	s.Backspace()
	if got := s.Fields()["name"]; got != "ACE" {
		t.Fatalf("after backspace: %q", got)
	}
	s.EraseEOF()
	if got := s.Fields()["name"]; got != "A" {
		t.Fatalf("after erase eof: %q", got)
	}
}

func TestTabbing(t *testing.T) {
	s := form()
	s.Tab()
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatal("tab did not reach zip")
	}
	s.Tab()
	if s.FieldName(s.Cursor()) != "name" {
		t.Fatal("tab did not wrap to name")
	}
	s.BackTab()
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatal("backtab did not wrap to zip")
	}
	s.Move(0, 2)
	s.BackTab()
	if r, c := RowCol(s.Cursor()); r != 3 || c != 12 {
		t.Fatalf("backtab inside a field should go to its start, got %d,%d", r, c)
	}
}

func TestInitialValuesAndHidden(t *testing.T) {
	s := NewScreen()
	s.Input(5, 10, 8, "pw", "SECRET", Hidden)
	if got := s.Fields()["pw"]; got != "SECRET" {
		t.Fatalf("pw = %q", got)
	}
	if !s.CursorTo("pw") {
		t.Fatal("CursorTo failed")
	}
	if r, c := RowCol(s.Cursor()); r != 5 || c != 10 {
		t.Fatalf("cursor at %d,%d", r, c)
	}
}

type echoHost struct{}

func (echoHost) Start() *Screen { return form() }
func (echoHost) Submit(aid AID, s *Screen) *Screen {
	n := NewScreen()
	n.Text(1, 2, aid.String()+" "+s.Fields()["name"])
	return n
}

func TestTerminalRoundTrip(t *testing.T) {
	term := New(echoHost{}, Options{})
	term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	_, cmd := term.Update(tea.KeyMsg{Type: tea.KeyF5})
	if term.lock != LockWait {
		t.Fatalf("keyboard not locked during host wait: %v", term.lock)
	}
	if !strings.Contains(term.View(), "X ()") {
		t.Fatal("OIA does not show the wait indicator")
	}
	term.Update(cmd())
	if term.lock != LockNone || !strings.Contains(term.View(), "PF5 HI") {
		t.Fatalf("host reply not displayed:\n%s", term.View())
	}
}
