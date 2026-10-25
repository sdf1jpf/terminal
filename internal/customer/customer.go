// Package customer defines the customer record exchanged with the API.
// The edit rules are enforced by the API (see worker/src/customer.ts).
package customer

import "time"

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

// ValidationError is the API's report of the first field that failed an
// edit rule. Field uses the terminal's field names (e.g. "addr", "limit").
type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Message }
