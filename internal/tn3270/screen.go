// Package tn3270 implements a block-mode, field-oriented display that
// behaves like an IBM 3278 terminal: a fixed 24x80 presentation space made
// of fields, each introduced by an attribute byte that occupies a screen
// position and controls protection, intensity, color and data type.
package tn3270

import "strings"

const (
	Rows = 24
	Cols = 80
	Size = Rows * Cols
)

// Color is a 3270 extended-attribute color.
type Color int

const (
	Default Color = iota
	Blue
	Red
	Pink
	Green
	Turquoise
	Yellow
	White
)

// Highlight is a 3270 extended highlighting mode.
type Highlight int

const (
	HlNone Highlight = iota
	HlUnderscore
	HlReverse
	HlBlink
)

// Attr describes a field. It is stored in the attribute-byte position that
// starts the field.
type Attr struct {
	Protected bool
	Numeric   bool
	Intense   bool
	Hidden    bool // non-display, e.g. password fields
	Mixed     bool // keep lower case; otherwise input is folded to upper
	Color     Color
	Highlight Highlight

	name     string
	modified bool // MDT
}

// Opt tweaks an Attr when building a screen.
type Opt func(*Attr)

func Bright(a *Attr)      { a.Intense = true }
func Numeric(a *Attr)     { a.Numeric = true }
func Hidden(a *Attr)      { a.Hidden = true }
func Underline(a *Attr)   { a.Highlight = HlUnderscore }
func Reverse(a *Attr)     { a.Highlight = HlReverse }
func NoUnderline(a *Attr) { a.Highlight = HlNone }
func MixedCase(a *Attr)   { a.Mixed = true }
func WithColor(c Color) Opt {
	return func(a *Attr) { a.Color = c }
}

type cell struct {
	ch     rune // 0 is a null
	isAttr bool
	attr   Attr
}

// Screen is a 3270 presentation space plus a cursor address.
type Screen struct {
	buf    [Size]cell
	cursor int
}

// NewScreen returns a cleared, formatted screen. Position 0 holds a
// protected attribute so the whole screen is protected until fields are
// defined.
func NewScreen() *Screen {
	s := &Screen{}
	s.buf[0] = cell{isAttr: true, attr: Attr{Protected: true}}
	s.cursor = 1
	return s
}

// Addr converts a 1-based row and column into a buffer address.
func Addr(row, col int) int {
	return wrap((row-1)*Cols + (col - 1))
}

func wrap(a int) int {
	a %= Size
	if a < 0 {
		a += Size
	}
	return a
}

// RowCol converts a buffer address into a 1-based row and column.
func RowCol(addr int) (int, int) { return addr/Cols + 1, addr%Cols + 1 }

func (s *Screen) setAttr(addr int, a Attr) {
	s.buf[wrap(addr)] = cell{isAttr: true, attr: a}
}

// Text places a protected field whose data begins at row/col. The
// attribute byte occupies the position immediately before it, as with a
// BMS map.
func (s *Screen) Text(row, col int, text string, opts ...Opt) {
	a := Attr{Protected: true}
	for _, o := range opts {
		o(&a)
	}
	start := Addr(row, col)
	s.setAttr(start-1, a)
	for i, r := range []rune(text) {
		s.buf[wrap(start+i)] = cell{ch: r}
	}
	s.stopper(start + len([]rune(text)))
}

// Input places a named, unprotected field of the given length. A protected
// "stopper" attribute is placed after it unless another field begins there.
func (s *Screen) Input(row, col, length int, name, value string, opts ...Opt) {
	a := Attr{Highlight: HlUnderscore, name: name}
	for _, o := range opts {
		o(&a)
	}
	start := Addr(row, col)
	s.setAttr(start-1, a)
	v := []rune(value)
	for i := 0; i < length; i++ {
		c := cell{}
		if i < len(v) {
			c.ch = v[i]
		}
		s.buf[wrap(start+i)] = c
	}
	s.stopper(start + length)
}

func (s *Screen) stopper(addr int) {
	addr = wrap(addr)
	if !s.buf[addr].isAttr {
		s.buf[addr] = cell{isAttr: true, attr: Attr{Protected: true}}
	}
}

// SetCursor positions the cursor at a 1-based row and column.
func (s *Screen) SetCursor(row, col int) { s.cursor = Addr(row, col) }

// CursorTo places the cursor at the first position of the named field.
// It reports whether the field exists.
func (s *Screen) CursorTo(name string) bool {
	for i := range s.buf {
		if s.buf[i].isAttr && s.buf[i].attr.name == name {
			s.cursor = wrap(i + 1)
			return true
		}
	}
	return false
}

// CursorHome moves the cursor to the first unprotected field, as the Home
// key and the host's default cursor placement do.
func (s *Screen) CursorHome() {
	if a, ok := s.nextUnprotected(Size - 1); ok {
		s.cursor = a
	}
}

// Cursor returns the cursor address.
func (s *Screen) Cursor() int { return s.cursor }

// fieldAttr returns the address of the attribute byte governing addr.
func (s *Screen) fieldAttr(addr int) int {
	for i := 0; i < Size; i++ {
		a := wrap(addr - i)
		if s.buf[a].isAttr {
			return a
		}
	}
	return 0
}

// fieldBounds returns the first data address and the length of the field
// governed by the attribute at fa.
func (s *Screen) fieldBounds(fa int) (start, length int) {
	start = wrap(fa + 1)
	for i := 0; i < Size-1; i++ {
		if s.buf[wrap(start+i)].isAttr {
			return start, i
		}
	}
	return start, Size - 1
}

// nextUnprotected returns the first data address of the next unprotected
// field strictly after addr.
func (s *Screen) nextUnprotected(addr int) (int, bool) {
	for i := 1; i <= Size; i++ {
		a := wrap(addr + i)
		if s.buf[a].isAttr && !s.buf[a].attr.Protected {
			if _, n := s.fieldBounds(a); n > 0 {
				return wrap(a + 1), true
			}
		}
	}
	return 0, false
}

// prevUnprotected returns the data start of the closest unprotected field
// beginning strictly before addr.
func (s *Screen) prevUnprotected(addr int) (int, bool) {
	for i := 1; i <= Size; i++ {
		a := wrap(addr - i)
		if s.buf[a].isAttr && !s.buf[a].attr.Protected && wrap(a+1) != addr {
			if _, n := s.fieldBounds(a); n > 0 {
				return wrap(a + 1), true
			}
		}
	}
	return 0, false
}

// Fields returns the current contents of every named input field, with
// nulls removed and trailing blanks trimmed, as the host would see them
// after a Read Modified.
func (s *Screen) Fields() map[string]string {
	out := map[string]string{}
	for i := range s.buf {
		c := s.buf[i]
		if !c.isAttr || c.attr.Protected || c.attr.name == "" {
			continue
		}
		out[c.attr.name] = s.fieldText(i)
	}
	return out
}

// Modified reports which named fields have their modified data tag set.
func (s *Screen) Modified() map[string]bool {
	out := map[string]bool{}
	for i := range s.buf {
		c := s.buf[i]
		if c.isAttr && c.attr.name != "" && c.attr.modified {
			out[c.attr.name] = true
		}
	}
	return out
}

func (s *Screen) fieldText(fa int) string {
	start, n := s.fieldBounds(fa)
	var b strings.Builder
	for i := 0; i < n; i++ {
		if r := s.buf[wrap(start+i)].ch; r != 0 {
			b.WriteRune(r)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

// FieldName returns the name of the field under addr, if it is a named
// input field.
func (s *Screen) FieldName(addr int) string {
	return s.buf[s.fieldAttr(addr)].attr.name
}
