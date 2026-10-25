// Package customer defines the customer record shared by the API server
// and its clients, and the edit rules the server enforces.
package customer

import (
	"regexp"
	"strings"
	"time"
)

type Customer struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Address string    `json:"address"`
	City    string    `json:"city"`
	State   string    `json:"state"`
	Zip     string    `json:"zip"`
	Phone   string    `json:"phone"`
	Limit   int       `json:"credit_limit"`
	Balance int       `json:"balance"`
	Status  string    `json:"status"` // A=active, H=hold, C=closed
	Version int       `json:"version"`
	Updated time.Time `json:"updated"`
	By      string    `json:"updated_by"`
}

// ValidationError reports the first field that failed an edit rule.
type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Message }

var (
	reState = regexp.MustCompile(`^[A-Z]{2}$`)
	reZip   = regexp.MustCompile(`^[0-9]{5}$`)
	rePhone = regexp.MustCompile(`^[0-9]{3}-[0-9]{3}-[0-9]{4}$`)
)

// Normalize trims and upper-cases the text fields.
func (c *Customer) Normalize() {
	for _, f := range []*string{&c.Name, &c.Address, &c.City, &c.State, &c.Zip, &c.Phone, &c.Status} {
		*f = strings.ToUpper(strings.TrimSpace(*f))
	}
}

// Validate normalizes c and applies the edit rules, returning nil or the
// first field in error.
func Validate(c *Customer) *ValidationError {
	c.Normalize()
	bad := func(field, msg string) *ValidationError { return &ValidationError{field, msg} }
	switch {
	case c.Name == "":
		return bad("name", "customer name is required")
	case len(c.Name) > 30:
		return bad("name", "customer name is limited to 30 characters")
	case len(c.Address) > 30:
		return bad("addr", "address is limited to 30 characters")
	case c.City == "":
		return bad("city", "city is required")
	case len(c.City) > 18:
		return bad("city", "city is limited to 18 characters")
	case !reState.MatchString(c.State):
		return bad("state", "state must be a two letter code")
	case !reZip.MatchString(c.Zip):
		return bad("zip", "zip code must be five digits")
	case c.Phone != "" && !rePhone.MatchString(c.Phone):
		return bad("phone", "phone must be in the form NNN-NNN-NNNN")
	case c.Limit < 0 || c.Limit > 999_999_999:
		return bad("limit", "credit limit must be a whole, positive number")
	case c.Status != "A" && c.Status != "H" && c.Status != "C":
		return bad("status", "status must be A (active), H (hold) or C (closed)")
	}
	return nil
}
