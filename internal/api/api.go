// Package api is the terminal's client for the customer information REST
// API, which is served by the Cloudflare Worker in worker/.
//
//	GET    /v1/health
//	POST   /v1/session              {"userid","password"} -> {"token",...}
//	DELETE /v1/session              log off
//	GET    /v1/customers?prefix=X   list, ordered by name
//	POST   /v1/customers            create
//	GET    /v1/customers/{id}
//	PUT    /v1/customers/{id}       update; "version" must match
//	DELETE /v1/customers/{id}
//
// Everything except health and logon needs "Authorization: Bearer <token>".
// Errors are returned as {"error":{"code","message","field"}}.
package api

import (
	"errors"
	"time"
)

var (
	ErrUnauthorized = errors.New("not logged on or session expired")
	ErrBadLogon     = errors.New("userid or password not authorized")
	ErrNotFound     = errors.New("record not found")
	ErrConflict     = errors.New("record was changed by another user")
	ErrUnavailable  = errors.New("host not responding")
)

// Wire types and error codes; keep in step with worker/src.

type LogonRequest struct {
	UserID   string `json:"userid"`
	Password string `json:"password"`
}

type LogonResponse struct {
	Token     string    `json:"token"`
	UserID    string    `json:"userid"`
	ExpiresAt time.Time `json:"expires_at"`
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

// Error codes used on the wire.
const (
	codeUnauthorized = "unauthorized"
	codeBadLogon     = "bad_logon"
	codeNotFound     = "not_found"
	codeConflict     = "conflict"
	codeInvalid      = "invalid"
)
