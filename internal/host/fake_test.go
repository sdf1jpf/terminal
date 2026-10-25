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
	user string
	recs map[string]customer.Customer
	next int
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

func (f *fakeAPI) Logon(_ context.Context, user, password string) (string, error) {
	if strings.ToUpper(user) != "IBMUSER" || strings.ToUpper(password) != "SYS1" {
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
	return c, nil
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
	return nil
}
