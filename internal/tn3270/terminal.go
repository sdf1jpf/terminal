package tn3270

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Options configures a Terminal.
type Options struct {
	// LUName is shown in the operator information area.
	LUName string
	// Latency is an artificial host response delay, so the keyboard visibly
	// locks with "X ()" after each AID. Zero disables it.
	Latency time.Duration
}

// Terminal is a Bubble Tea model emulating a 3278 display station.
type Terminal struct {
	host   Host
	opts   Options
	scr    *Screen
	lock   Lock
	insert bool
	width  int
	height int
	styles map[styleKey]lipgloss.Style
	r      *lipgloss.Renderer
}

type hostReply struct{ scr *Screen }

// New returns a terminal connected to host.
func New(host Host, opts Options) *Terminal {
	if opts.LUName == "" {
		opts.LUName = "TERM0001"
	}
	return &Terminal{
		host:   host,
		opts:   opts,
		scr:    host.Start(),
		styles: map[styleKey]lipgloss.Style{},
		r:      lipgloss.DefaultRenderer(),
	}
}

func (t *Terminal) Init() tea.Cmd { return nil }

func (t *Terminal) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		t.width, t.height = msg.Width, msg.Height
		t.fit()
	case hostReply:
		if msg.scr == nil {
			return t, tea.Quit
		}
		t.scr = msg.scr
		t.lock = LockNone
		t.fit() // the window may have changed while the host was busy
	case tea.MouseMsg:
		if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft && t.lock == LockNone {
			x0, y0 := t.origin()
			row, col := msg.Y-y0, msg.X-x0
			if row >= 0 && row < t.scr.Rows() && col >= 0 && col < t.scr.Cols() {
				t.scr.MoveTo(row*t.scr.Cols() + col)
			}
		}
	case tea.KeyMsg:
		return t.key(msg)
	}
	return t, nil
}

var pfKeys = map[string]int{
	"f1": 1, "f2": 2, "f3": 3, "f4": 4, "f5": 5, "f6": 6,
	"f7": 7, "f8": 8, "f9": 9, "f10": 10, "f11": 11, "f12": 12,
	"f13": 13, "f14": 14, "f15": 15, "f16": 16, "f17": 17, "f18": 18,
	"f19": 19, "f20": 20,
	"shift+f1": 13, "shift+f2": 14, "shift+f3": 15, "shift+f4": 16,
	"shift+f5": 17, "shift+f6": 18, "shift+f7": 19, "shift+f8": 20,
	"shift+f9": 21, "shift+f10": 22, "shift+f11": 23, "shift+f12": 24,
	// Conveniences for keyboards without a full function-key row.
	"pgup": 7, "pgdown": 8,
}

func (t *Terminal) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := k.String()
	if s == "ctrl+c" {
		return t, tea.Quit
	}
	if t.lock == LockWait {
		return t, nil
	}
	if s == "esc" || s == "ctrl+r" {
		t.lock = LockNone
		t.insert = false
		return t, nil
	}
	if t.lock != LockNone {
		return t, nil
	}

	if n, ok := pfKeys[s]; ok {
		return t, t.send(PF(n))
	}
	switch s {
	case "enter":
		return t, t.send(AIDEnter)
	case "ctrl+l":
		t.scr = NewScreenSize(t.scr.Rows(), t.scr.Cols())
		return t, t.send(AIDClear)
	case "alt+1":
		return t, t.send(AIDPA1)
	case "alt+2":
		return t, t.send(AIDPA2)
	case "alt+3":
		return t, t.send(AIDPA3)
	case "tab":
		t.scr.Tab()
	case "shift+tab":
		t.scr.BackTab()
	case "up":
		t.scr.Move(-1, 0)
	case "down":
		t.scr.Move(1, 0)
	case "left":
		t.scr.Move(0, -1)
	case "right":
		t.scr.Move(0, 1)
	case "home":
		t.scr.CursorHome()
	case "end":
		t.scr.EndOfField()
	case "ctrl+n":
		t.scr.NewLine()
	case "insert":
		t.insert = !t.insert
	case "backspace":
		t.lock = t.scr.Backspace()
	case "delete":
		t.lock = t.scr.Delete()
	case "ctrl+e":
		t.lock = t.scr.EraseEOF()
	case "ctrl+u":
		t.scr.EraseInput()
	case " ":
		t.lock = t.scr.Type(' ', t.insert)
	default:
		if k.Type == tea.KeyRunes && !k.Alt {
			for _, r := range k.Runes {
				if t.lock = t.scr.Type(r, t.insert); t.lock != LockNone {
					break
				}
			}
		}
	}
	return t, nil
}

// send locks the keyboard and transmits the screen to the host.
func (t *Terminal) send(aid AID) tea.Cmd {
	t.lock = LockWait
	scr, host, delay := t.scr, t.host, t.opts.Latency
	return func() tea.Msg {
		if delay > 0 {
			time.Sleep(delay)
		}
		return hostReply{scr: host.Submit(aid, scr)}
	}
}

// fit asks the host to lay the current panel out again when the window
// no longer matches the presentation space, keeping what has been typed.
// The screen fills the window except for the status line and its rule.
func (t *Terminal) fit() {
	rows, cols := t.height-2, t.width
	if t.lock == LockWait || t.width == 0 || rows < MinRows || cols < MinCols {
		return
	}
	if rows == t.scr.Rows() && cols == t.scr.Cols() {
		return
	}
	if next := t.host.Redraw(rows, cols); next != nil {
		next.Carry(t.scr)
		t.scr = next
	}
}

// origin returns the top-left corner of the 3270 screen within the window.
func (t *Terminal) origin() (int, int) {
	x := (t.width - t.scr.Cols()) / 2
	y := (t.height - (t.scr.Rows() + 2)) / 2
	return max(x, 0), max(y, 0)
}

func (t *Terminal) View() string {
	if t.width > 0 && (t.width < MinCols || t.height < MinRows+2) {
		return fmt.Sprintf("\n  Terminal too small: %dx%d.\n  A 3278 Model 2 needs at least %dx%d.\n",
			t.width, t.height, MinCols, MinRows+2)
	}
	var b strings.Builder
	for row := 0; row < t.scr.Rows(); row++ {
		t.renderRow(&b, row)
		b.WriteByte('\n')
	}
	b.WriteString(t.style(styleKey{fg: Blue}).Render(strings.Repeat("─", t.scr.Cols())))
	b.WriteByte('\n')
	b.WriteString(t.oia())

	if t.width == 0 {
		return b.String()
	}
	return t.r.Place(t.width, t.height, lipgloss.Center, lipgloss.Center, b.String(),
		lipgloss.WithWhitespaceBackground(lipgloss.Color("#000000")))
}

func (t *Terminal) oia() string {
	// The right-hand indicators keep their Model 2 places relative to the
	// right edge, so they stay in the corner of a wider screen.
	cols := t.scr.Cols()
	line := []rune(strings.Repeat(" ", cols))
	put := func(col int, s string) { copy(line[col-1:], []rune(s)) }
	put(9, t.lock.String())
	if t.insert {
		put(cols-28, "^")
	}
	put(cols-23, t.opts.LUName)
	row, col := t.scr.RowCol(t.scr.Cursor())
	put(cols-6, fmt.Sprintf("%03d/%03d", row, col))

	base := t.style(styleKey{fg: Turquoise})
	warn := t.style(styleKey{fg: White, bold: true})
	box := t.style(styleKey{fg: Turquoise, reverse: true})
	var b strings.Builder
	b.WriteString(box.Render("4"))
	b.WriteString(base.Render("A" + string(line[2:8])))
	b.WriteString(warn.Render(string(line[8:20])))
	b.WriteString(base.Render(string(line[20:])))
	return b.String()
}

type styleKey struct {
	fg        Color
	bold      bool
	underline bool
	reverse   bool
}

var palette = map[Color]string{
	Blue:      "#5F8FFF",
	Red:       "#FF4D4D",
	Pink:      "#FF75D8",
	Green:     "#3CFF5A",
	Turquoise: "#40E8E0",
	Yellow:    "#FFF35A",
	White:     "#F4F4F4",
}

func (t *Terminal) style(k styleKey) lipgloss.Style {
	if st, ok := t.styles[k]; ok {
		return st
	}
	st := t.r.NewStyle().
		Foreground(lipgloss.Color(palette[k.fg])).
		Background(lipgloss.Color("#000000")).
		Bold(k.bold).
		Underline(k.underline).
		Reverse(k.reverse)
	t.styles[k] = st
	return st
}

// cellStyle resolves the displayed color of a field, applying the 3270
// base-color rules when no extended color is set.
func cellStyle(a Attr) styleKey {
	k := styleKey{fg: a.Color, bold: a.Intense}
	if k.fg == Default {
		switch {
		case a.Protected && a.Intense:
			k.fg = White
		case a.Protected:
			k.fg = Blue
		case a.Intense:
			k.fg = Red
		default:
			k.fg = Green
		}
	}
	switch a.Highlight {
	case HlUnderscore:
		k.underline = true
	case HlReverse:
		k.reverse = true
	}
	return k
}

func (t *Terminal) renderRow(b *strings.Builder, row int) {
	var run strings.Builder
	var cur styleKey
	flush := func() {
		if run.Len() > 0 {
			b.WriteString(t.style(cur).Render(run.String()))
			run.Reset()
		}
	}
	cursor := t.scr.Cursor()
	for col := 0; col < t.scr.Cols(); col++ {
		addr := row*t.scr.Cols() + col
		c := t.scr.buf[addr]
		fa := t.scr.buf[t.scr.fieldAttr(addr)].attr
		ch := ' '
		k := styleKey{fg: Green}
		if !c.isAttr {
			k = cellStyle(fa)
			if c.ch != 0 && !fa.Hidden {
				ch = c.ch
			}
		}
		if addr == cursor {
			k.reverse = !k.reverse
			k.underline = false
			if c.isAttr {
				k.fg = Green
			}
			flush()
			cur = k
			run.WriteRune(ch)
			flush()
			continue
		}
		if k != cur {
			flush()
			cur = k
		}
		run.WriteRune(ch)
	}
	flush()
}
