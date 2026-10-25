package host

import (
	"strings"
	"time"

	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

// menu is the ISPF-style primary option menu.
type menu struct {
	option string
	msg    string
}

var menuOptions = []struct{ key, name, desc string }{
	{"1", "BROWSE", "Browse the customer master file"},
	{"2", "INQUIRY", "Display a customer by number"},
	{"3", "ADD", "Add a new customer"},
	{"4", "REPORTS", "Credit exposure summary"},
	{"T", "TUTORIAL", "Keyboard and PF key guide"},
	{"X", "EXIT", "Log off"},
}

func (m *menu) Render(s *Session) *t3.Screen {
	scr := s.newScreen()
	header(scr, s, "CUSM00", "PRIMARY OPTION MENU")

	label(scr, 4, 2, "OPTION ===>")
	scr.Input(4, 14, 40, "option", m.option)

	for i, o := range menuOptions {
		row := 6 + i
		scr.Text(row, 4, o.key, t3.WithColor(t3.White), t3.Bright)
		scr.Text(row, 7, o.name, t3.WithColor(t3.Turquoise))
		scr.Text(row, 18, o.desc, t3.WithColor(t3.Green))
	}

	info := [][2]string{
		{"USERID", s.user},
		{"TIME", time.Now().Format("15:04")},
		{"TERMINAL", s.lu},
		{"SYSTEM", s.cfg.SystemName},
		{"HOST", truncate(strings.ToUpper(s.api().Host()), 14)},
	}
	for i, kv := range info {
		label(scr, 6+i, right(scr, 56), kv[0])
		scr.Text(6+i, right(scr, 65), "- "+kv[1], t3.WithColor(t3.White))
	}

	scr.Text(14, 4, "Enter an option number, or a command such as 2 000105 to jump", t3.WithColor(t3.Blue))
	scr.Text(15, 4, "straight to a customer. Press PF1 at any time for help.", t3.WithColor(t3.Blue))

	message(scr, m.msg)
	keys(scr, "PF1=HELP  PF3=LOGOFF  PF4=BROWSE  PF12=CANCEL")
	scr.CursorTo("option")
	return scr
}

func (m *menu) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	m.msg = ""
	switch aid {
	case t3.AIDEnter:
	case t3.PF(3):
		return logoff(s)
	case t3.PF(4):
		return &browse{}
	case t3.PF(12), t3.AIDClear:
		m.option = ""
		return m
	default:
		m.msg = invalidKey(aid)
		return m
	}

	opt := strings.Fields(strings.ToUpper(scr.Fields()["option"]))
	m.option = ""
	if len(opt) == 0 {
		return m
	}
	arg := ""
	if len(opt) > 1 {
		arg = opt[1]
	}
	switch strings.TrimPrefix(opt[0], "=") {
	case "1", "BROWSE":
		return &browse{filter: arg}
	case "2", "INQUIRY":
		d := &detail{mode: modeInquiry, back: m}
		if arg != "" {
			d.load(s, arg)
		}
		return d
	case "3", "ADD":
		return newAdd(m)
	case "4", "REPORTS":
		return &report{}
	case "T", "TUTORIAL":
		return &help{back: m}
	case "X", "EXIT", "LOGOFF":
		return logoff(s)
	}
	m.option = strings.Join(opt, " ")
	m.msg = "ISPD117E INVALID OPTION " + opt[0]
	return m
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
