package customer

import "time"

// Transaction is an invoice or payment posted to a customer's account.
type Transaction struct {
	Seq       int       `json:"seq"`
	ID        string    `json:"customer_id"`
	Type      string    `json:"type"`   // I=invoice, P=payment
	Amount    int       `json:"amount"` // whole dollars, always positive
	Reference string    `json:"reference"`
	Balance   int       `json:"balance"` // customer balance after posting
	Posted    time.Time `json:"posted"`
	By        string    `json:"posted_by"`
}

// Change is one entry in a customer's change history: an add, a delete,
// or one field changed by an update.
type Change struct {
	Seq    int       `json:"seq"`
	ID     string    `json:"customer_id"`
	Action string    `json:"action"` // ADD, CHANGE or DELETE
	Field  string    `json:"field"`  // CHANGE only, e.g. CITY
	Old    string    `json:"old_value"`
	New    string    `json:"new_value"`
	At     time.Time `json:"at"`
	By     string    `json:"by"`
}
