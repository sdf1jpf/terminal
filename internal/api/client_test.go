package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sdf1jpf/terminal/internal/customer"
)

// stub answers like the Worker does for a few fixed requests.
func stub(t *testing.T, access Access) *Client {
	t.Helper()
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	fail := func(w http.ResponseWriter, status int, code, field string) {
		reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": "msg " + code, "field": field}})
	}
	// Like Access: no token is redirected to login, a token for someone the
	// policy does not allow is refused with a bare 403.
	gate := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			switch r.Header.Get("CF-Access-Client-Id") {
			case "":
				http.Redirect(w, r, "https://team.cloudflareaccess.com/cdn-cgi/access/login", http.StatusFound)
			case "id":
				next(w, r)
			default:
				http.Error(w, "Forbidden", http.StatusForbidden)
			}
		}
	}

	mux.HandleFunc("POST /v1/session", gate(func(w http.ResponseWriter, r *http.Request) {
		reply(w, 201, map[string]string{"userid": "IBMUSER"})
	}))
	mux.HandleFunc("GET /v1/customers", gate(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("prefix") != "A&B" {
			t.Errorf("prefix not escaped: %q", r.URL.RawQuery)
		}
		reply(w, 200, []map[string]any{{"id": "000101", "name": "A&B CO", "credit_limit": 5, "updated": "2026-10-25T11:52:00.123Z"}})
	}))
	mux.HandleFunc("GET /v1/expired", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://team.cloudflareaccess.com/cdn-cgi/access/login", http.StatusFound)
	})
	mux.HandleFunc("GET /v1/customers/{id}", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "") })
	mux.HandleFunc("PUT /v1/customers/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "000102" {
			fail(w, 409, "conflict", "")
			return
		}
		fail(w, 422, "invalid", "zip")
	})
	mux.HandleFunc("DELETE /v1/customers/{id}", func(w http.ResponseWriter, r *http.Request) { fail(w, 500, "internal", "") })

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return NewClient(srv.URL+"/", access)
}

func TestClient(t *testing.T) {
	c := stub(t, ServiceToken{"id", "secret"})
	ctx := context.Background()

	if _, err := c.List(ctx, "A&B"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("list before logon: %v", err)
	}
	if user, err := c.Logon(ctx); err != nil || user != "IBMUSER" {
		t.Fatalf("logon: %q %v", user, err)
	}

	list, err := c.List(ctx, "A&B")
	if err != nil || len(list) != 1 || list[0].Name != "A&B CO" || list[0].Limit != 5 || list[0].Updated.IsZero() {
		t.Fatalf("list: %+v %v", list, err)
	}
	if _, err := c.Get(ctx, "999999"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get: %v", err)
	}
	if _, err := c.Update(ctx, customer.Customer{ID: "000102"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict: %v", err)
	}
	var verr *customer.ValidationError
	if _, err := c.Update(ctx, customer.Customer{ID: "000101"}); !errors.As(err, &verr) || verr.Field != "zip" {
		t.Fatalf("validation: %v", err)
	}
	if err := c.Delete(ctx, "000101"); err == nil || err.Error() != "api: msg internal" {
		t.Fatalf("other errors keep the API's message: %v", err)
	}
	if err := c.Logoff(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.List(ctx, "A&B"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("headers kept after logoff: %v", err)
	}
	if c.Host() == "" {
		t.Fatal("no host")
	}
}

func TestClientAccessRefusals(t *testing.T) {
	ctx := context.Background()
	if _, err := stub(t, nil).Logon(ctx); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("redirected to Access login: %v", err)
	}
	if _, err := stub(t, ServiceToken{"other", "secret"}).Logon(ctx); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("refused by Access policy: %v", err)
	}

	c := stub(t, ServiceToken{"id", "secret"})
	if _, err := c.Logon(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.do(ctx, http.MethodGet, "/v1/expired", nil, nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Access token expired: %v", err)
	}
	if _, err := c.List(ctx, "A&B"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("headers kept after expiry: %v", err)
	}
}

func TestClientHostDown(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", nil)
	if _, err := c.Logon(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v", err)
	}
}
