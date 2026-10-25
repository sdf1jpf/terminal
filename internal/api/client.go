package api

import (
	"bytes"
	"context"
	"encoding/json"
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
	base  string
	http  *http.Client
	token string
}

func NewClient(baseURL string) *Client {
	return &Client{
		base: strings.TrimRight(baseURL, "/"),
		http: &http.Client{Timeout: 10 * time.Second},
	}
}

// Host returns the server's host:port, for display.
func (c *Client) Host() string {
	if u, err := url.Parse(c.base); err == nil && u.Host != "" {
		return u.Host
	}
	return c.base
}

func (c *Client) Logon(ctx context.Context, user, password string) (string, error) {
	var resp LogonResponse
	err := c.do(ctx, http.MethodPost, "/v1/session", LogonRequest{user, password}, &resp)
	if err != nil {
		return "", err
	}
	c.token = resp.Token
	return resp.UserID, nil
}

func (c *Client) Logoff(ctx context.Context) error {
	if c.token == "" {
		return nil
	}
	err := c.do(ctx, http.MethodDelete, "/v1/session", nil, nil)
	c.token = ""
	return err
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
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		var eb errorBody
		json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&eb)
		switch eb.Error.Code {
		case codeUnauthorized:
			c.token = ""
			return ErrUnauthorized
		case codeBadLogon:
			return ErrBadLogon
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
