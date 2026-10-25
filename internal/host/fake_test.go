package host

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/customer"
)

// fakeAPI is an in-memory stand-in for the customer API with the same
// observable behaviour as the Worker: logon, validation, optimistic locking.
type fakeAPI struct {
	user   string
	denied bool // Access refuses the logon
	recs   map[string]customer.Customer
	next   int
	txns   []customer.Transaction // in posting order
	log    []customer.Change      // in time order
}

func newFakeAPI() *fakeAPI {
	f := &fakeAPI{recs: map[string]customer.Customer{}, next: 124}
	for n := 101; n <= 124; n++ {
		c := customer.Customer{
			ID: fmt.Sprintf("%06d", n), Name: fmt.Sprintf("CUSTOMER %03d", n), City: "DAYTON", State: "OH",
			Zip: "45402", Limit: 50000, Balance: n * 100, Status: "A", Version: 1, By: "IBMUSER",
		}
		if n == 105 {
			c.Name, c.City, c.State, c.Zip = "EVERGREEN TIMBER CO", "EUGENE", "OR", "97401"
		}
		f.recs[c.ID] = c
	}
	return f
}

func (f *fakeAPI) Host() string { return "fake:1" }

func (f *fakeAPI) Logon(context.Context) (string, error) {
	if f.denied {
		return "", api.ErrBadLogon
	}
	f.user = "IBMUSER"
	return f.user, nil
}

func (f *fakeAPI) Logoff(context.Context) error { f.user = ""; return nil }

func (f *fakeAPI) authed() error {
	if f.user == "" {
		return api.ErrUnauthorized
	}
	return nil
}

func (f *fakeAPI) List(_ context.Context, prefix string) ([]customer.Customer, error) {
	if err := f.authed(); err != nil {
		return nil, err
	}
	var out []customer.Customer
	for _, c := range f.recs {
		if strings.HasPrefix(c.Name, strings.ToUpper(prefix)) {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *fakeAPI) Get(_ context.Context, id string) (customer.Customer, error) {
	if err := f.authed(); err != nil {
		return customer.Customer{}, err
	}
	c, ok := f.recs[id]
	if !ok {
		return c, api.ErrNotFound
	}
	return c, nil
}

var (
	fakeState = regexp.MustCompile(`^[A-Z]{2}$`)
	fakeZip   = regexp.MustCompile(`^[0-9]{5}$`)
)

func (f *fakeAPI) check(c *customer.Customer) error {
	for _, p := range []*string{&c.Name, &c.Address, &c.City, &c.State, &c.Zip, &c.Phone, &c.Status} {
		*p = strings.ToUpper(strings.TrimSpace(*p))
	}
	switch {
	case c.Name == "":
		return &customer.ValidationError{Field: "name", Message: "customer name is required"}
	case !fakeState.MatchString(c.State):
		return &customer.ValidationError{Field: "state", Message: "state must be a two letter code"}
	case !fakeZip.MatchString(c.Zip):
		return &customer.ValidationError{Field: "zip", Message: "zip code must be five digits"}
	}
	return nil
}

func (f *fakeAPI) Create(_ context.Context, c customer.Customer) (customer.Customer, error) {
	if err := f.authed(); err != nil {
		return c, err
	}
	if err := f.check(&c); err != nil {
		return c, err
	}
	f.next++
	c.ID, c.Balance, c.Version, c.Updated, c.By = fmt.Sprintf("%06d", f.next), 0, 1, time.Now(), f.user
	f.recs[c.ID] = c
	f.record(c.ID, "ADD", "", "", "")
	return c, nil
}

func (f *fakeAPI) record(id, action, field, old, new string) {
	f.log = append(f.log, customer.Change{
		Seq: len(f.log) + 1, ID: id, Action: action, Field: field, Old: old, New: new, At: time.Now(), By: f.user,
	})
}

func (f *fakeAPI) Update(_ context.Context, c customer.Customer) (customer.Customer, error) {
	if err := f.authed(); err != nil {
		return c, err
	}
	if err := f.check(&c); err != nil {
		return c, err
	}
	old, ok := f.recs[c.ID]
	switch {
	case !ok:
		return c, api.ErrNotFound
	case old.Version != c.Version:
		return c, api.ErrConflict
	}
	c.Balance, c.Version, c.Updated, c.By = old.Balance, old.Version+1, time.Now(), f.user
	f.recs[c.ID] = c
	for _, d := range [][3]string{{"NAME", old.Name, c.Name}, {"CITY", old.City, c.City}, {"ZIP", old.Zip, c.Zip}} {
		if d[1] != d[2] {
			f.record(c.ID, "CHANGE", d[0], d[1], d[2])
		}
	}
	return c, nil
}

func (f *fakeAPI) Delete(_ context.Context, id string) error {
	if err := f.authed(); err != nil {
		return err
	}
	if _, ok := f.recs[id]; !ok {
		return api.ErrNotFound
	}
	delete(f.recs, id)
	f.record(id, "DELETE", "", "", "")
	return nil
}

func (f *fakeAPI) Transactions(_ context.Context, id string) ([]customer.Transaction, error) {
	if err := f.authed(); err != nil {
		return nil, err
	}
	if _, ok := f.recs[id]; !ok {
		return nil, api.ErrNotFound
	}
	var out []customer.Transaction
	for i := len(f.txns) - 1; i >= 0; i-- {
		if f.txns[i].ID == id {
			out = append(out, f.txns[i])
		}
	}
	return out, nil
}

func (f *fakeAPI) Post(_ context.Context, t customer.Transaction) (customer.Transaction, error) {
	if err := f.authed(); err != nil {
		return t, err
	}
	c, ok := f.recs[t.ID]
	switch {
	case !ok:
		return t, api.ErrNotFound
	case t.Type != "I" && t.Type != "P":
		return t, &customer.ValidationError{Field: "type", Message: "type must be I (invoice) or P (payment)"}
	case t.Amount <= 0:
		return t, &customer.ValidationError{Field: "amount", Message: "amount must be a whole number of dollars above zero"}
	case t.Type == "I" && c.Status != "A":
		return t, &customer.ValidationError{Field: "type", Message: "customer is on hold - invoices cannot be posted"}
	}
	if t.Type == "I" {
		c.Balance += t.Amount
	} else {
		c.Balance -= t.Amount
	}
	f.recs[c.ID] = c
	t.Seq, t.Balance, t.Posted, t.By = len(f.txns)+1, c.Balance, time.Now(), f.user
	t.Reference = strings.ToUpper(strings.TrimSpace(t.Reference))
	f.txns = append(f.txns, t)
	return t, nil
}

func (f *fakeAPI) History(_ context.Context, id string) ([]customer.Change, error) {
	if err := f.authed(); err != nil {
		return nil, err
	}
	var out []customer.Change
	for i := len(f.log) - 1; i >= 0; i-- {
		if f.log[i].ID == id {
			out = append(out, f.log[i])
		}
	}
	return out, nil
}
