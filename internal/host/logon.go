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

// logon is the VTAM-style welcome and sign-on screen. Who may log on is
// decided by Cloudflare Access, so there is no userid or password to type:
// Enter signs in through the browser and the API names the userid.
type logon struct {
	msg string
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

	label(scr, 15, 12, "PRESS ENTER TO LOG ON.")
	scr.Text(16, 12, "Sign-on is through Cloudflare Access; a browser window", t3.WithColor(t3.Yellow))
	scr.Text(17, 12, "opens if you are not already signed in.", t3.WithColor(t3.Yellow))
	scr.Text(20, 12, "UNAUTHORIZED ACCESS TO THIS SYSTEM IS PROHIBITED.", t3.WithColor(t3.Red))

	message(scr, l.msg)
	keys(scr, "ENTER=LOGON  PF1=HELP  PF3=DISCONNECT")
	scr.CursorHome()
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
	who, err := s.api().Logon(s.ctx())
	switch {
	case errors.Is(err, api.ErrBadLogon):
		l.msg = "IKJ56421I LOGON NOT AUTHORIZED BY CLOUDFLARE ACCESS"
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
