// Package host holds the screens of the customer information application:
// a small CICS-style set of 3270 panels whose data comes from the
// customer API.
package host

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/customer"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// Backend is the API the screens talk to. *api.Client implements it.
type Backend interface {
	Host() string
	Logon(ctx context.Context) (string, error)
	Logoff(ctx context.Context) error
	List(ctx context.Context, prefix string) ([]customer.Customer, error)
	Get(ctx context.Context, id string) (customer.Customer, error)
	Create(ctx context.Context, c customer.Customer) (customer.Customer, error)
	Update(ctx context.Context, c customer.Customer) (customer.Customer, error)
	Delete(ctx context.Context, id string) error
}

// Program is one transaction screen. Render draws its current state and
// Handle processes an AID, returning the program to show next (itself to
// stay, nil to disconnect).
type Program interface {
	Render(s *Session) *t3.Screen
	Handle(s *Session, aid t3.AID, scr *t3.Screen) Program
}

// enterer is implemented by programs that (re)load their data from the
// API each time they become the current screen.
type enterer interface{ enter(s *Session) }

type Config struct {
	SystemName string // e.g. "SYS1"
	Backend    Backend
}

// Session is the terminal's connection to the application. It implements
// tn3270.Host.
type Session struct {
	cfg     *Config
	lu      string
	user    string
	prog    Program
	expired bool
}

func NewSession(cfg *Config, lu string) *Session {
	return &Session{cfg: cfg, lu: lu, prog: &logon{}}
}

func (s *Session) Start() *t3.Screen { return s.prog.Render(s) }

func (s *Session) Submit(aid t3.AID, scr *t3.Screen) *t3.Screen {
	var next Program
	if _, inHelp := s.prog.(*help); aid == t3.PF(1) && !inHelp {
		next = &help{back: s.prog} // PF1 is help on every screen
	} else {
		next = s.prog.Handle(s, aid, scr)
	}
	if next == nil {
		s.api().Logoff(s.ctx())
		return nil
	}
	if next != s.prog {
		if e, ok := next.(enterer); ok {
			e.enter(s)
		}
	}
	if s.expired {
		s.expired, s.user = false, ""
		next = &logon{msg: "IKJ56400I SESSION EXPIRED OR ENDED BY THE HOST - PLEASE LOG ON AGAIN"}
	}
	s.prog = next
	return next.Render(s)
}

func (s *Session) api() Backend { return s.cfg.Backend }

func (s *Session) ctx() context.Context { return context.Background() }

// fail turns an API error into a message for the message line. An expired
// session sends the user back to the logon screen.
func (s *Session) fail(err error) string {
	switch {
	case errors.Is(err, api.ErrUnauthorized):
		s.expired = true
		return ""
	case errors.Is(err, api.ErrUnavailable):
		return "CUS0298E HOST " + strings.ToUpper(s.api().Host()) + " NOT RESPONDING - PRESS ENTER TO RETRY"
	}
	return "CUS0299E " + strings.ToUpper(err.Error())
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
	if len(msg) > 78 {
		msg = msg[:78]
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

func nowHHMM() string { return time.Now().Format("15:04:05") }
