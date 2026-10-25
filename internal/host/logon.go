package host

import (
	"errors"
	"strings"

	"github.com/sdf1jpf/terminal/internal/api"
	t3 "github.com/sdf1jpf/terminal/internal/tn3270"
)

var banner = []string{
	` ######  ######  #####   ##   ##  ######  ##   ##    ###    ##     `,
	`   ##    ##      ##  ##  ### ###    ##    ###  ##   ## ##   ##     `,
	`   ##    #####   #####   ## # ##    ##    ## # ##  ##   ##  ##     `,
	`   ##    ##      ##  ##  ##   ##    ##    ##  ###  #######  ##     `,
	`   ##    ######  ##   ## ##   ##  ######  ##   ##  ##   ##  ###### `,
}

// logon is the VTAM-style welcome and sign-on screen.
type logon struct {
	userid string
	msg    string
}

func (l *logon) Render(s *Session) *t3.Screen {
	scr := t3.NewScreen()
	for i, line := range banner {
		scr.Text(3+i, 7, line, t3.WithColor(t3.Blue), t3.Bright)
	}
	tag := "M O D E R N   M A I N F R A M E   E X P E R I E N C E"
	scr.Text(9, center(tag), tag, t3.WithColor(t3.Turquoise))

	scr.Text(11, 12, "SYSTEM . . . . : "+s.cfg.SystemName, t3.WithColor(t3.Blue))
	scr.Text(12, 12, "TERMINAL . . . : "+s.lu, t3.WithColor(t3.Blue))
	scr.Text(13, 12, "HOST . . . . . : "+strings.ToUpper(s.api().Host()), t3.WithColor(t3.Blue))

	label(scr, 15, 12, "USERID   ===>")
	scr.Input(15, 26, 8, "userid", l.userid)
	label(scr, 16, 12, "PASSWORD ===>")
	scr.Input(16, 26, 8, "password", "", t3.Hidden)

	scr.Text(18, 12, "Demo credentials: IBMUSER / SYS1", t3.WithColor(t3.Yellow))
	scr.Text(20, 12, "UNAUTHORIZED ACCESS TO THIS SYSTEM IS PROHIBITED.", t3.WithColor(t3.Red))

	message(scr, l.msg)
	keys(scr, "ENTER=LOGON  PF1=HELP  PF3=DISCONNECT")
	if l.userid != "" {
		scr.CursorTo("password")
	} else {
		scr.CursorHome()
	}
	return scr
}

func (l *logon) Handle(s *Session, aid t3.AID, scr *t3.Screen) Program {
	switch aid {
	case t3.AIDEnter:
	case t3.PF(3):
		return nil
	case t3.AIDClear:
		return &logon{}
	default:
		l.msg = invalidKey(aid)
		return l
	}
	f := scr.Fields()
	user := strings.ToUpper(strings.TrimSpace(f["userid"]))
	pass := strings.TrimSpace(f["password"])
	l.userid = user
	switch {
	case user == "":
		l.msg = "IKJ56700A ENTER USERID"
		return l
	case pass == "":
		l.msg = "IKJ56714A ENTER CURRENT PASSWORD FOR " + user
		return l
	}
	who, err := s.api().Logon(s.ctx(), user, pass)
	switch {
	case errors.Is(err, api.ErrBadLogon):
		l.msg = "IKJ56421I PASSWORD NOT AUTHORIZED FOR USERID " + user
		return l
	case err != nil:
		l.msg = s.fail(err)
		return l
	}
	s.user = who
	return &menu{msg: "IKJ56455I " + who + " LOGON IN PROGRESS AT " + nowHHMM()}
}

func logoff(s *Session) Program {
	user := s.user
	s.api().Logoff(s.ctx())
	s.user = ""
	return &logon{msg: "IKJ56470I " + user + " LOGGED OFF AT " + nowHHMM()}
}
