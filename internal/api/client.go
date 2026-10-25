package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sdf1jpf/terminal/internal/customer"
)

// Client calls the customer API on behalf of one logged-on user.
type Client struct {
	base   string
	http   *http.Client
	access Access      // nil when the API is not behind Cloudflare Access
	hdr    http.Header // Access headers for the logged-on user; nil when logged off
}

// NewClient returns a client for the API at baseURL. access may be nil, for
// a local `wrangler dev`.
func NewClient(baseURL string, access Access) *Client {
	return &Client{
		base:   strings.TrimRight(baseURL, "/"),
		access: access,
		http: &http.Client{
			Timeout: 10 * time.Second,
			// Access answers a missing or expired token with a redirect to
			// its login page; report that rather than following it.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Host returns the server's host:port, for display.
func (c *Client) Host() string {
	if u, err := url.Parse(c.base); err == nil && u.Host != "" {
		return u.Host
	}
	return c.base
}

// Logon signs in through Cloudflare Access, which may open a browser, and
// returns the userid the API knows the user by.
func (c *Client) Logon(ctx context.Context) (string, error) {
	hdr := http.Header{}
	if c.access != nil {
		h, err := c.access.Headers(ctx)
		if err != nil {
			return "", err
		}
		hdr = h
	}
	c.hdr = hdr
	var resp LogonResponse
	if err := c.do(ctx, http.MethodPost, "/v1/session", nil, &resp); err != nil {
		c.hdr = nil
		if errors.Is(err, ErrUnauthorized) {
			err = ErrBadLogon
		}
		return "", err
	}
	return resp.UserID, nil
}

// Logoff forgets the user locally. Access sessions end on their own.
func (c *Client) Logoff(context.Context) error {
	c.hdr = nil
	return nil
}

func (c *Client) List(ctx context.Context, prefix string) ([]customer.Customer, error) {
	var out []customer.Customer
	err := c.do(ctx, http.MethodGet, "/v1/customers?prefix="+url.QueryEscape(prefix), nil, &out)
	return out, err
}

func (c *Client) Get(ctx context.Context, id string) (customer.Customer, error) {
	var out customer.Customer
	err := c.do(ctx, http.MethodGet, "/v1/customers/"+url.PathEscape(id), nil, &out)
	return out, err
}

func (c *Client) Create(ctx context.Context, cust customer.Customer) (customer.Customer, error) {
	var out customer.Customer
	err := c.do(ctx, http.MethodPost, "/v1/customers", cust, &out)
	return out, err
}

func (c *Client) Update(ctx context.Context, cust customer.Customer) (customer.Customer, error) {
	var out customer.Customer
	err := c.do(ctx, http.MethodPut, "/v1/customers/"+url.PathEscape(cust.ID), cust, &out)
	return out, err
}

func (c *Client) Delete(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/v1/customers/"+url.PathEscape(id), nil, nil)
}

// do sends a request and decodes the response into out. API errors are
// mapped to the package's sentinel errors or a *customer.ValidationError.
func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.hdr == nil {
		return ErrUnauthorized
	}
	for k, v := range c.hdr {
		req.Header[k] = v
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		var eb errorBody
		json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&eb)
		switch {
		case eb.Error.Code == codeUnauthorized, eb.Error.Code == "" && (resp.StatusCode < 400 || resp.StatusCode == 401):
			// From the Worker, or Access redirecting to its login page.
			c.hdr = nil
			return ErrUnauthorized
		case eb.Error.Code == "" && resp.StatusCode == 403:
			return ErrBadLogon // Access policy does not allow this user
		}
		switch eb.Error.Code {
		case codeNotFound:
			return ErrNotFound
		case codeConflict:
			return ErrConflict
		case codeInvalid:
			return &customer.ValidationError{Field: eb.Error.Field, Message: eb.Error.Message}
		}
		msg := eb.Error.Message
		if msg == "" {
			msg = resp.Status
		}
		return fmt.Errorf("api: %s", msg)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("api: bad response: %w", err)
	}
	return nil
}
