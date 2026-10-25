// Package host is the "mainframe" side of the system: a small CICS-style
// customer information application built from 3270 screens.
package host

import (
	"strings"
	"time"

	"github.com/sdf1jpf/terminal/internal/store"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// Program is one transaction screen. Render draws its current state and
// Handle processes an AID, returning the program to show next (itself to
// stay, nil to disconnect).
type Program interface {
	Render(s *Session) *t3.Screen
	Handle(s *Session, aid t3.AID, scr *t3.Screen) Program
}

// Config is shared by all sessions on a system.
type Config struct {
	SystemName string            // e.g. "SYS1"
	Users      map[string]string // userid -> password
	Store      *store.Store
}

// Session is one connected terminal. It implements tn3270.Host.
type Session struct {
	cfg  *Config
	lu   string
	user string
	prog Program
}

func NewSession(cfg *Config, lu string) *Session {
	return &Session{cfg: cfg, lu: lu, prog: &logon{}}
}

func (s *Session) Start() *t3.Screen { return s.prog.Render(s) }

func (s *Session) Submit(aid t3.AID, scr *t3.Screen) *t3.Screen {
	// PF1 is help on every screen except help itself.
	var next Program
	if _, inHelp := s.prog.(*help); aid == t3.PF(1) && !inHelp {
		next = &help{back: s.prog}
	} else {
		next = s.prog.Handle(s, aid, scr)
	}
	if next == nil {
		return nil
	}
	s.prog = next
	return next.Render(s)
}

// Screen layout helpers shared by the application panels.

func center(text string) int { return (t3.Cols-len(text))/2 + 1 }

// header draws the standard two-line panel heading.
func header(scr *t3.Screen, s *Session, mapID, title string) {
	now := time.Now()
	scr.Text(1, 2, mapID, t3.WithColor(t3.Blue))
	scr.Text(1, center(title), title, t3.WithColor(t3.White), t3.Bright)
	scr.Text(1, 70, now.Format("01/02/06"), t3.WithColor(t3.Blue))
	scr.Text(2, 2, s.cfg.SystemName+" CUSTOMER INFORMATION SYSTEM", t3.WithColor(t3.Blue))
	scr.Text(2, 70, now.Format("15:04:05"), t3.WithColor(t3.Blue))
}

// message draws the row-23 message line. The severity is taken from the
// last letter of the message ID, IBM style: E=error, W=warning, I=info.
func message(scr *t3.Screen, msg string) {
	if msg == "" {
		return
	}
	color := t3.White
	id, _, _ := strings.Cut(msg, " ")
	switch id[len(id)-1] {
	case 'E':
		color = t3.Red
	case 'W':
		color = t3.Yellow
	}
	scr.Text(23, 2, msg, t3.WithColor(color), t3.Bright)
}

// keys draws the row-24 PF key legend.
func keys(scr *t3.Screen, legend string) {
	scr.Text(24, 2, legend, t3.WithColor(t3.Turquoise))
}

func label(scr *t3.Screen, row, col int, text string) {
	scr.Text(row, col, text, t3.WithColor(t3.Turquoise))
}

func value(scr *t3.Screen, row, col int, text string) {
	scr.Text(row, col, text, t3.WithColor(t3.Green))
}

func invalidKey(aid t3.AID) string {
	return "CUS0000W " + aid.String() + " IS NOT ACTIVE ON THIS SCREEN"
}
