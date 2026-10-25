package host

import t3 "github.com/sdf1jpf/terminal/internal/tn3270"

// help is the keyboard tutorial. PF3 returns to the screen it was called
// from.
type help struct{ back Program }

var helpRows = [][2]string{
	{"ENTER", "Send the screen to the host (AID key)"},
	{"F1 - F12", "PF1 - PF12.  Shift+F1 - F12 are PF13 - PF24"},
	{"PGUP / PGDN", "PF7 / PF8 (scroll up / down)"},
	{"CTRL+L", "CLEAR key: blank the screen and notify the host"},
	{"ALT+1/2/3", "PA1 / PA2 / PA3"},
	{"TAB / SHIFT+TAB", "Next / previous input field"},
	{"ARROWS, MOUSE", "Move the cursor anywhere on the screen"},
	{"HOME / END", "First input field / end of current field"},
	{"CTRL+N", "New line: first input field on the next row"},
	{"INSERT", "Toggle insert mode (^ shown in the status line)"},
	{"CTRL+E", "Erase to end of field (ERASE EOF)"},
	{"CTRL+U", "Erase all input fields (ERASE INPUT)"},
	{"ESC / CTRL+R", "RESET: unlock the keyboard after an error"},
	{"CTRL+C", "Disconnect the terminal session"},
}

func (h *help) Render(s *Session) *t3.Screen {
	scr := t3.NewScreen()
	header(scr, s, "CUSH00", "TUTORIAL - USING THIS TERMINAL")

	scr.Text(4, 4, "This is a block-mode terminal. You fill in fields locally, then an AID", t3.WithColor(t3.Green))
	scr.Text(5, 4, "key sends the whole screen to the host, which replies with a new one.", t3.WithColor(t3.Green))

	for i, r := range helpRows {
		scr.Text(7+i, 4, r[0], t3.WithColor(t3.White), t3.Bright)
		scr.Text(7+i, 22, r[1], t3.WithColor(t3.Turquoise))
	}
	scr.Text(22, 4, "Status line: X () host busy   X -f protected   X NUM numeric only   X > full",
		t3.WithColor(t3.Blue))

	keys(scr, "PF3=RETURN")
	scr.SetCursor(24, 2)
	return scr
}

func (h *help) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	if h.back == nil {
		return &logon{}
	}
	return h.back
}
