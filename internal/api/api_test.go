package api

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/sdf1jpf/terminal/internal/customer"
	"github.com/sdf1jpf/terminal/internal/store"
)

func TestMain(m *testing.M) {
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

func setup(t *testing.T) (*Client, *httptest.Server) {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(st, map[string]string{"IBMUSER": "SYS1"}).Handler())
	t.Cleanup(srv.Close)
	return NewClient(srv.URL), srv
}

func TestAuth(t *testing.T) {
	c, srv := setup(t)
	ctx := context.Background()
	if _, err := c.List(ctx, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("list without logon: %v", err)
	}
	if _, err := c.Logon(ctx, "ibmuser", "wrong"); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("bad password: %v", err)
	}
	if _, err := c.Logon(ctx, "nobody", "sys1"); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("unknown user: %v", err)
	}
	user, err := c.Logon(ctx, "ibmuser", "sys1")
	if err != nil || user != "IBMUSER" {
		t.Fatalf("logon: %q %v", user, err)
	}
	if list, err := c.List(ctx, "K"); err != nil || len(list) != 1 || list[0].Name != "KEYSTONE STEEL" {
		t.Fatalf("list: %v %v", list, err)
	}
	if err := c.Logoff(ctx); err != nil {
		t.Fatal(err)
	}
	// The old token must no longer work.
	req, _ := http.NewRequest("GET", srv.URL+"/v1/customers", nil)
	req.Header.Set("Authorization", "Bearer stale")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale token: %v %v", resp.Status, err)
	}
}

func TestCRUDAndConflict(t *testing.T) {
	c, _ := setup(t)
	ctx := context.Background()
	if _, err := c.Logon(ctx, "IBMUSER", "SYS1"); err != nil {
		t.Fatal(err)
	}

	_, err := c.Create(ctx, customer.Customer{Name: "x", City: "y", State: "zz", Zip: "1"})
	var verr *customer.ValidationError
	if !errors.As(err, &verr) || verr.Field != "zip" {
		t.Fatalf("expected zip validation error, got %v", err)
	}

	added, err := c.Create(ctx, customer.Customer{Name: "new co", City: "reno", State: "nv", Zip: "89501", Status: "a", Balance: 500})
	if err != nil {
		t.Fatal(err)
	}
	if added.ID != "000125" || added.Name != "NEW CO" || added.Balance != 0 || added.By != "IBMUSER" {
		t.Fatalf("created %+v", added)
	}

	first := added
	added.City = "SPARKS"
	updated, err := c.Update(ctx, added)
	if err != nil || updated.Version != 2 {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if _, err := c.Update(ctx, first); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}

	if err := c.Delete(ctx, added.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get(ctx, added.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
}

func TestRejectsUnknownFields(t *testing.T) {
	_, srv := setup(t)
	resp, err := http.Post(srv.URL+"/v1/session", "application/json", strings.NewReader(`{"userid":"a","pw":"b"}`))
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %v %v", resp.Status, err)
	}
}

func TestHostDown(t *testing.T) {
	c, srv := setup(t)
	srv.Close()
	if _, err := c.Logon(context.Background(), "IBMUSER", "SYS1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v", err)
	}
}
